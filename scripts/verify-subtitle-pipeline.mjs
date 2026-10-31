// Exercise the real player/renderer with stubbed browser, Shaka and libass boundaries.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';

const instances = [];
class Octopus {
  constructor(options) {
    this.options = options;
    this.events = [];
    this.pendingStyles = [];
    instances.push(this);
  }
  getStyles(resolve) {
    if (this.holdStyles) this.pendingStyles.push(resolve);
    else resolve([
      { Name: 'Default', _index: 0, FontSize: 18 },
      { Name: 'Default', _index: 1, FontSize: 36 },
      ...(this.options.subContent.includes('Style: HdTransKo,')
        ? [{ Name: 'HdTransKo', _index: 2, FontSize: 36 }] : []),
    ]);
  }
  createEvent(event) { this.events.push(event); }
  setEvent(props, index) { Object.assign(this.events[index], props); }
  setStyle() {}
  setTrack() { this.events = []; }
  dispose() { this.disposed = true; }
}
let holdStyles = false;
class FakeOctopus extends Octopus {
  constructor(options) { super(options); this.holdStyles = holdStyles; }
}
globalThis.__subtitleOctopus = FakeOctopus;
globalThis.__subtitleShaka = {};
const sources = {
  'libass-wasm': 'export default globalThis.__subtitleOctopus;',
  'shaka-player/dist/shaka-player.ui.js': 'export default globalThis.__subtitleShaka;',
  '/base.ts': 'export const asset = path => "/" + path;',
  '/player/hdtrans.ts': 'export const preloadHdTrans = async () => {}; export const translateSegment = (...args) => globalThis.__translateSegment(...args);',
  '/player/assTextParser.ts': 'export const ASS_MIME_TYPES = ["text/x-ssa"]; export const registerAssParser = () => {}; export const setAssSink = () => {};',
  '/ui/borderTypeMenu.ts': 'export const registerBorderTypeMenu = () => {};',
  '/ui/epgGuide.ts': 'export const registerEpgButton = () => {};',
  '/ui/liveButton.ts': 'export const registerLiveButton = () => {};',
  '/epg/epg.ts': 'export const nowNext = async () => ({});',
};
registerHooks({
  resolve(specifier, context, next) {
    if (sources[specifier]) return { url: `mock:${specifier}`, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts') && !specifier.endsWith('.ts')) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const source = sources[url.slice(5)] ?? Object.entries(sources).find(([key]) => url.endsWith(key))?.[1];
    if (source) return { format: 'module', source, shortCircuit: true };
    if (url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return next(url, context);
  },
});
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
const { LibassRenderer } = await import('../src/player/libassRenderer.ts');
const { TvPlayer } = await import('../src/player/shakaPlayer.ts');
const { KOREAN_TRACK_NAME } = await import('../src/player/assTranslate.ts');
const HEADER = `[Script Info]
PlayResX: 960
PlayResY: 540
[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,WadaLabChuMaruGo2004ARIB,36
`;
const SEGMENT = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,,HdTransKo,,0,0,0,,한국어
`;
const tick = () => new Promise(resolve => setImmediate(resolve));

// Shaka may already have selected the restored track, so selectTextTrack emits no change event.
const koTrack = { language: 'ko', label: KOREAN_TRACK_NAME, active: true, mimeType: 'text/x-ssa' };
const tv = Object.create(TvPlayer.prototype);
Object.assign(tv, {
  video: {}, libass: null, activeTextTrack: null, textGeneration: 0,
  koreanChain: Promise.resolve(), fetchedHeaders: new Set(), discontinuityBoundaries: new Map(),
  dvrAccumulators: new Map(), startContentTitle() {},
  player: { configure() {}, load: async () => {}, getTextTracks: () => [koTrack], selectTextTrack() {} },
});
storage.set('tv:subtitleLang', JSON.stringify('ko'));
for (const streamUrl of ['first', 'reload', 'next-channel']) {
  await tv.playChannel({ name: streamUrl, streamUrl });
  assert.equal(tv.libass.korean, true, `${streamUrl}: restored Korean track enables its font without a textchanged event`);
  tv.libass.setHeader(HEADER);
  await tick();
  assert.match(instances.at(-1).options.subContent, /Style: HdTransKo,NanumSquareRound Bold,/);
  assert.deepEqual(instances.at(-1).options.fonts, ['/fonts/NanumSquareRoundB.woff2']);
  tv.libass.appendSegment(SEGMENT, 10, 16);
  assert.equal(instances.at(-1).events[0].Style, 2, 'Korean events resolve to the Korean style, not Default');
}
tv.teardownSubtitles();

// Replacing a worker while its initial getStyles request is pending must not block the new worker.
holdStyles = true;
const renderer = new LibassRenderer({});
renderer.setHeader(HEADER);
const old = instances.at(-1);
holdStyles = false;
renderer.enableKorean();
renderer.appendSegment(SEGMENT, 20, 26);
await tick();
assert.notEqual(instances.at(-1), old, 'enabling Korean immediately replaces a still-initializing Japanese worker');
assert.equal(instances.at(-1).events[0]?.Style, 2, 'buffered Korean events flush with the replacement worker styles');
// A stale callback must not overwrite the replacement renderer's resolved styles.
old.pendingStyles.forEach(resolve => resolve([{ Name: 'Default', _index: 0, FontSize: 18 }]));
await tick();
assert.equal(renderer.styleIndexByName.get('HdTransKo'), 2);
renderer.dispose();

// Source timing must close a displayed caption before the next translation completes.
await tv.playChannel({ name: 'timing', streamUrl: 'timing' });
tv.libass.setHeader(HEADER);
await tick();
globalThis.__translateSegment = async text => text;
tv.appendSegment(SEGMENT, 100, 102, 'first.ass');
await tv.koreanChain;
const timingOctopus = instances.at(-1);
let finishTranslation;
globalThis.__translateSegment = text => new Promise(resolve => { finishTranslation = () => resolve(text); });
tv.appendSegment(SEGMENT, 102, 108, 'second.ass');
await tick();
assert.equal(timingOctopus.events[0].Duration, 2000, 'previous caption ends at 102s while the next translation is pending');
assert.equal(timingOctopus.events.length, 1, 'untranslated text is not rendered');
finishTranslation();
await tv.koreanChain;
assert.equal(timingOctopus.events[1].Start, 102000, 'translation keeps the original presentation timestamp');

// Future timing can arrive before either translated segment, including a clear-only segment.
let finishFirst;
globalThis.__translateSegment = text => new Promise(resolve => { finishFirst = () => resolve(text); });
tv.appendSegment(SEGMENT, 108, 114, 'third.ass');
await tick();
const clearSegment = SEGMENT.replace('한국어', '');
tv.appendSegment(clearSegment, 110, 116, 'clear.ass');
finishFirst();
globalThis.__translateSegment = async text => text;
await tv.koreanChain;
assert.equal(timingOctopus.events[2].Duration, 2000, 'late translated caption uses an already-known clear time');

// A program-header reset must retain timing already received for queued translations.
await tv.playChannel({ name: 'boundary', streamUrl: 'boundary' });
tv.libass.setHeader(HEADER);
tv.loadHeader = async () => tv.libass.setHeader(HEADER);
await tick();
const finishes = [];
globalThis.__translateSegment = text => new Promise(resolve => { finishes.push(() => resolve(text)); });
tv.discontinuityBoundaries.set('boundary.ass', 'init.ass');
tv.appendSegment(SEGMENT, 100, 102, 'boundary.ass');
await tick();
tv.appendSegment(clearSegment, 102, 108, 'following.ass');
finishes[0]();
await tick();
assert.equal(instances.at(-1).events[0]?.Duration, 2000, 'discontinuity retains the following clear time before its translation finishes');
finishes[1]();
await tv.koreanChain;

// A seek outside Shaka's text buffer drops the old position's captions with Shaka's buffer.
const line = (start, text) => `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,${start},,HdTransKo,,0,0,0,,${text}
`;
await tv.playChannel({ name: 'seek', streamUrl: 'seek' });
tv.libass.setHeader(HEADER);
await tick();
const seekOctopus = instances.at(-1);
let textBuffer = [];
tv.player.getBufferedInfo = () => ({ text: textBuffer });
globalThis.__translateSegment = async text => text;
tv.appendSegment(line('0:00:01.00', 'live'), 600, 606, 'live.ass');
await tv.koreanChain;
textBuffer = [{ start: 600, end: 606 }];
tv.video.currentTime = 603;
tv.dropCaptionsOutsideBuffer();
assert.equal(seekOctopus.events.length, 1, 'a seek inside the text buffer keeps its captions: Shaka does not fetch them again');
let finishLive;
globalThis.__translateSegment = text => new Promise(resolve => { finishLive = () => resolve(text); });
tv.appendSegment(line('0:00:01.00', 'live 2'), 606, 612, 'live2.ass'); // translation still running
await tick();
tv.video.currentTime = 300;
tv.dropCaptionsOutsideBuffer();
assert.equal(seekOctopus.events.length, 0, 'a seek outside the text buffer clears libass');
globalThis.__translateSegment = async text => text;
textBuffer = [];
tv.appendSegment(line('0:00:04.00', 'past A'), 300, 306, 'pastA.ass');
await tv.koreanChain;
finishLive();
await tick();
assert.deepEqual(seekOctopus.events.map(e => e.Text), ['past A'], 'a translation of the old position finishing late is dropped');
tv.appendSegment(line('0:00:01.00', 'past B'), 306, 312, 'pastB.ass');
await tv.koreanChain;
assert.equal(seekOctopus.events[0].Duration, 3000, 'the past caption ends at the next past caption, not at the live one');
// Seeking forward (or back to live) from there: past B is cleared, so it cannot stay on screen.
tv.video.currentTime = 450;
tv.dropCaptionsOutsideBuffer();
tv.appendSegment(line('0:00:01.00', 'later'), 450, 456, 'later.ass');
await tv.koreanChain;
assert.deepEqual(seekOctopus.events.map(e => e.Text), ['later'], 'nothing from the past position is left after a forward seek');

// A destination channel must not wait for a discarded source-channel translation.
let finishOld;
globalThis.__translateSegment = text => new Promise(resolve => { finishOld = () => resolve(text); });
tv.appendSegment(SEGMENT, 120, 126, 'old.ass');
await tick();
const oldChain = tv.koreanChain;
await tv.playChannel({ name: 'destination', streamUrl: 'destination' });
tv.libass.setHeader(HEADER);
await tick();
globalThis.__translateSegment = async text => text;
tv.appendSegment(SEGMENT, 200, 206, 'new.ass');
await tick();
assert.equal(instances.at(-1).events[0]?.Start, 200000, 'new channel progresses without waiting for old work');
finishOld();
await oldChain;
assert.equal(instances.at(-1).events.length, 1, 'stale translation never enters the new renderer');
tv.teardownSubtitles();

// An interrupted load must not release a newer channel's preference-restoration guard.
const loads = [];
tv.player.load = () => new Promise((resolve, reject) => { loads.push({ resolve, reject }); });
const interrupted = tv.playChannel({ name: 'interrupted', streamUrl: 'interrupted' });
const rejected = assert.rejects(interrupted, /interrupted/);
const destination = tv.playChannel({ name: 'latest', streamUrl: 'latest' });
loads[0].reject(new Error('interrupted'));
await rejected;
assert.equal(tv.suppressSubtitlePersist, true, 'old load cannot release the newer load guard');
const jaTrack = { language: 'ja', label: 'Japanese', active: true, mimeType: 'text/x-ssa' };
koTrack.active = false;
tv.player.getTextTracks = () => [jaTrack, koTrack];
tv.player.selectTextTrack = track => {
  jaTrack.active = track === jaTrack;
  koTrack.active = track === koTrack;
};
tv.persistSubtitleSelection();
assert.equal(storage.get('tv:subtitleLang'), JSON.stringify('ko'), 'automatic Japanese selection cannot overwrite the Korean preference');
loads[1].resolve();
await destination;
assert.equal(tv.libass.korean, true, 'latest load still restores Korean');
assert.equal(tv.suppressSubtitlePersist, false);
tv.player.load = async () => { throw new Error('failed'); };
await assert.rejects(tv.playChannel({ name: 'failed', streamUrl: 'failed' }), /failed/);
assert.equal(tv.suppressSubtitlePersist, false, 'a current load failure releases its own guard');
tv.teardownSubtitles();

// Clearing while the header is still loading must also clear buffered events.
const uninitialized = new LibassRenderer({});
uninitialized.appendSegment(SEGMENT, 0, 6);
uninitialized.clear();
uninitialized.setHeader(HEADER);
await tick();
assert.equal(instances.at(-1).events.length, 0, 'captions cleared before initialization stay cleared');
uninitialized.dispose();

console.log('verify-subtitle-pipeline: all checks passed.');
