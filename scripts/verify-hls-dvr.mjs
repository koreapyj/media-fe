// Headless verification of the client-side DVR accumulator (src/player/hlsDvr.ts) via Node
// type-stripping. Drives synthetic sliding-window live playlists and asserts the accumulated
// playlist grows, caps at the window, preserves original media-sequence numbers, recomputes
// discontinuity-sequence consistently, re-emits EXT-X-KEY only at rotations, resets on a backward
// sequence jump, and bypasses LL-HLS / delta / ENDLIST playlists.
import { HlsWindowAccumulator } from '../src/player/hlsDvr.ts';

let failures = 0;
const ok = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); failures++; } };

const DUR = 10;
const tag = (name, text) => {
  const m = text.match(new RegExp(`^#${name}:(.*)$`, 'im'));
  return m ? m[1].trim() : null;
};
const segUris = (text) => text.split('\n').filter((l) => l && !l.startsWith('#'));
const countTag = (name, text) =>
  (text.match(new RegExp(`^#${name}\\b`, 'gim')) || []).length;
const countLine = (line, text) => text.split('\n').filter((l) => l === line).length;

// Build a 5-segment window starting at media-sequence `msn`. `discAt` = absolute seq that carries an
// inline DISCONTINUITY (with a fresh key); `keyForSeq(seq)` returns the active key line.
function playlist(msn, { discAt, keyForSeq } = {}) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10'];
  lines.push(`#EXT-X-MEDIA-SEQUENCE:${msn}`);
  // discontinuity-sequence before the first segment = number of discontinuities strictly before msn.
  const dsn = discAt != null && msn > discAt ? 1 : 0;
  lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${dsn}`);
  let lastKey = null;
  for (let i = 0; i < 5; i++) {
    const seq = msn + i;
    if (discAt != null && seq === discAt) lines.push('#EXT-X-DISCONTINUITY');
    const key = keyForSeq ? keyForSeq(seq) : null;
    if (key && key !== lastKey) { lines.push(key); lastKey = key; }
    lines.push(`#EXTINF:${DUR}.0,`);
    lines.push(`/ts/seg${seq}.ts`);
  }
  return lines.join('\n') + '\n';
}

// --- 1) Growth then cap, with preserved media-sequence numbers ---
{
  const acc = new HlsWindowAccumulator(60); // 60s window = at most 6 segments
  let out = '';
  for (let msn = 100; msn < 100 + 10; msn++) out = acc.ingest(playlist(msn));
  const uris = segUris(out);
  ok(uris.length === 6, `capped at 6 segments (60s/10s), got ${uris.length}`);
  // After ingesting playlists up to msn=109 (covering seg100..seg113), the newest seg is 113,
  // so the kept window is seg108..seg113.
  ok(uris[0] === '/ts/seg108.ts', `oldest kept is seg108, got ${uris[0]}`);
  ok(uris[uris.length - 1] === '/ts/seg113.ts', `newest is seg113, got ${uris[uris.length - 1]}`);
  ok(tag('EXT-X-MEDIA-SEQUENCE', out) === '108', `MEDIA-SEQUENCE = 108, got ${tag('EXT-X-MEDIA-SEQUENCE', out)}`);
  ok(!/#EXT-X-ENDLIST/.test(out), 'stays live (no ENDLIST)');
}

// --- 2) Fill phase keeps MEDIA-SEQUENCE constant while the list grows ---
{
  const acc = new HlsWindowAccumulator(3600); // effectively uncapped here
  const a = acc.ingest(playlist(200));
  ok(segUris(a).length === 5 && tag('EXT-X-MEDIA-SEQUENCE', a) === '200', 'first ingest: 5 segs @ MSN 200');
  const b = acc.ingest(playlist(201));
  ok(segUris(b).length === 6, `grew to 6 segs, got ${segUris(b).length}`);
  ok(tag('EXT-X-MEDIA-SEQUENCE', b) === '200', 'MEDIA-SEQUENCE stays 200 during fill');
  const c = acc.ingest(playlist(201)); // idempotent re-ingest
  ok(segUris(c).length === 6, 're-ingesting the same playlist adds nothing');
}

// --- 3) Discontinuity-sequence recomputation across a boundary ---
{
  const acc = new HlsWindowAccumulator(3600);
  const keyForSeq = (seq) => (seq >= 305 ? '#EXT-X-KEY:METHOD=AES-128,URI="k2",IV=0x2' : '#EXT-X-KEY:METHOD=AES-128,URI="k1",IV=0x1');
  let out = '';
  for (let msn = 301; msn <= 306; msn++) out = acc.ingest(playlist(msn, { discAt: 305, keyForSeq }));
  // Window seg301..seg310 not reached; we ingested up to msn=306 → newest seg310. All kept (uncapped).
  ok(segUris(out)[0] === '/ts/seg301.ts', 'oldest kept seg301');
  ok(tag('EXT-X-DISCONTINUITY-SEQUENCE', out) === '0', 'header DISCONTINUITY-SEQUENCE = 0 (first seg before boundary)');
  ok(countLine('#EXT-X-DISCONTINUITY', out) === 1, `exactly one inline DISCONTINUITY, got ${countLine('#EXT-X-DISCONTINUITY', out)}`);
  // The DISCONTINUITY must sit right before seg305.
  const idxDisc = out.split('\n').indexOf('#EXT-X-DISCONTINUITY');
  const idxSeg = out.split('\n').indexOf('/ts/seg305.ts');
  ok(idxDisc !== -1 && idxDisc < idxSeg, 'DISCONTINUITY precedes seg305');
  // Key rotates exactly once (k1 -> k2), and k1 is emitted for the oldest kept segment.
  ok(countTag('EXT-X-KEY', out) === 2, `KEY emitted exactly twice (rotation), got ${countTag('EXT-X-KEY', out)}`);
  ok(/URI="k1"/.test(out) && /URI="k2"/.test(out), 'both keys present');
}

// --- 4) Reset on backward media-sequence jump (encoder restart) ---
{
  const acc = new HlsWindowAccumulator(3600);
  for (let msn = 500; msn <= 505; msn++) acc.ingest(playlist(msn));
  const out = acc.ingest(playlist(10)); // far backward
  const uris = segUris(out);
  ok(uris[0] === '/ts/seg10.ts', `reset to fresh window, oldest = seg10, got ${uris[0]}`);
  ok(uris.length === 5, `reset window is 5 segs, got ${uris.length}`);
  ok(tag('EXT-X-MEDIA-SEQUENCE', out) === '10', 'MEDIA-SEQUENCE follows the reset');
}

// --- 5) Bypass LL-HLS / delta / ENDLIST verbatim ---
{
  const acc = new HlsWindowAccumulator(3600);
  const ll = playlist(700).replace('#EXT-X-TARGETDURATION:10', '#EXT-X-TARGETDURATION:10\n#EXT-X-PART-INF:PART-TARGET=1');
  ok(acc.ingest(ll) === ll, 'LL-HLS (EXT-X-PART-INF) passed through unchanged');
  const skip = playlist(700) + '#EXT-X-SKIP:SKIPPED-SEGMENTS=3\n';
  ok(acc.ingest(skip) === skip, 'delta (EXT-X-SKIP) passed through unchanged');
  const ended = playlist(700) + '#EXT-X-ENDLIST\n';
  ok(acc.ingest(ended) === ended, 'ENDLIST passed through unchanged');
}

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('verify-hls-dvr: all checks passed');
