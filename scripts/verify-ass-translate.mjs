// Headless verification of the Korean subtitle track: src/player/assTranslate.ts via Node
// type-stripping, with a fake translator that tags each line (no browser, no engine).
import {
  CaptionHistory,
  KOREAN_STYLE,
  KOREAN_TRACK_NAME,
  addKoreanRendition,
  translateAss,
  withKoreanStyle,
  wrap,
} from '../src/player/assTranslate.ts';

import { parseDialogueLines } from '../src/player/assDocument.ts';

let failures = 0;
const ok = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); failures++; } };

// --- Master playlist: a Korean copy follows the Japanese subtitle rendition. ---
const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="audio_1",DEFAULT=YES,LANGUAGE="ja",URI="audio_ja/stream.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="arib",NAME="subtitle_3",DEFAULT=YES,LANGUAGE="ja",URI="arib_ass/stream.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"
1080p/stream.m3u8`;
const master = addKoreanRendition(MASTER);
const ko = master.split('\n').find((l) => l.includes(KOREAN_TRACK_NAME));
ok(ko?.includes('TYPE=SUBTITLES') && ko.includes('GROUP-ID="arib"'), 'Korean rendition joins the same subtitle group');
ok(ko?.includes('LANGUAGE="ko"') && ko.includes('DEFAULT=NO'), `Korean rendition is ko and not default: ${ko}`);
ok(ko?.includes('URI="arib_ass/stream.m3u8#hdtrans"'), `Korean rendition URI carries the mark: ${ko}`);
ok(master.split('\n').filter((l) => l.includes('TYPE=AUDIO')).length === 1, 'audio renditions are not copied');
ok(addKoreanRendition(master) === master, 'adding twice is a no-op');
ok(addKoreanRendition(MASTER.replace(/LANGUAGE="ja",URI="arib/, 'LANGUAGE="en",URI="arib')) === MASTER.replace(/LANGUAGE="ja",URI="arib/, 'LANGUAGE="en",URI="arib'), 'no Japanese subtitles → unchanged');

// --- Header: a Korean style cloned from the first style. ---
const HEADER = `[Script Info]
PlayResX: 960
PlayResY: 540

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,WadaLabChuMaruGo2004ARIB,36,&Hffffff,&Hffffff,&H0,&H0,0,0,0,0,100,100,0,0,4,0,4,2,10,10,10,0
`;
const styled = withKoreanStyle(HEADER);
const koStyle = styled.split('\n').find((l) => l.startsWith(`Style: ${KOREAN_STYLE},`))?.split(',');
ok(koStyle?.[1] === 'NanumSquareRound Bold' && koStyle[2] === '36', `Korean style: Korean face, same size: ${koStyle}`);
ok(koStyle?.[3] === '&Hffffff' && koStyle[15] === '4', 'Korean style keeps colours and border style');
ok(styled.includes('Style: Default,WadaLab'), 'authored style kept');
ok(withKoreanStyle(styled) === styled, 'adding the style twice is a no-op');

// --- Segments: blocks, context and layout, on short real captions. ---
const calls = [];
const fake = async (jobs) => {
  calls.push(...jobs);
  return jobs.map((j) => j.text.split('\n').map((l) => (l ? `KO[${l}]` : '')).join('\n'));
};
const HEAD = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
const seg = (...dialogues) => HEAD + dialogues.map((d) => `Dialogue: 0,${d}`).join('\n');
const dialoguesOf = (text) => text.split('\n').filter((l) => l.startsWith('Dialogue:'));
const run = async (history, start, text) => {
  calls.length = 0;
  const out = await translateAss(text, start, history, fake);
  return { jobs: calls.slice(), out: dialoguesOf(out) };
};
const tail = (list, n) => JSON.stringify(list.slice(-n));

// Rows of a block go as consecutive lines; speaker marks and colours start blocks; ♬ passes through.
{
  const { jobs, out } = await run(
    new CaptionHistory(),
    0,
    seg(
      String.raw`0:00:01.55,,Default,,0,0,0,,{\an7}{\pos(190,390)}{\fsp4}{\bord3}先生… 医療訴訟を`,
      String.raw`0:00:01.55,,Default,,0,0,0,,{\an7}{\pos(190,450)}{\fsp4}{\bord3}抱えてらっしゃるんですよね？`,
      String.raw`0:00:02.56,,Default,,0,0,0,,{\an7}{\pos(270,240)}{\fsp4}{\bord3}⚟え〜 会長まで!?`,
      String.raw`0:00:02.56,,Default,,0,0,0,,{\an7}{\pos(270,300)}{\fsp4}{\bord3}(店長)よく来られます｡`,
      String.raw`0:00:05.00,,Default,,0,0,0,,{\an7}{\pos(170,450)}{\fsp4}{\bord3}♬〜`,
    ),
  );
  ok(jobs[0]?.text === '先生… 医療訴訟を\n抱えてらっしゃるんですよね？', `rows of a block stay lines: ${jobs[0]?.text}`);
  ok(jobs[1]?.text === '⚟え〜 会長まで!?\n\n(店長)よく来られます。', `voices split by a blank line, ｡ normalised: ${jobs[1]?.text}`);
  ok(jobs.length === 2, 'a caption without Japanese is not translated');
  const first = out.filter((l) => l.includes(',0:00:01.55,,'));
  ok(first.length === 2 && first.every((l) => l.includes(`,${KOREAN_STYLE},`)), `Korean style, one line per row: ${first}`);
  ok(/\\pos\(\d+,388\)/.test(first[0]) && /\\pos\(\d+,448\)/.test(first[1]), `lines sit on their rows: ${first}`);
  ok(first.every((l) => l.includes('{\\an8}')), 'lines are centred');
  const music = out.find((l) => l.includes('♬'));
  ok(music?.includes(',Default,') && music.includes('{\\pos(170,450)}'), `untranslated caption passes through: ${music}`);
}

// Two blocks in different colours: each keeps its own row and colour.
{
  const { jobs, out } = await run(
    new CaptionHistory(),
    0,
    seg(
      String.raw`0:00:02.89,,Default,,0,0,0,,{\an7}{\pos(140,389)}{\fsp4}{\bord3}{\1c&H00ffff&}ふ〜ん｡`,
      String.raw`0:00:02.89,,Default,,0,0,0,,{\an7}{\pos(140,449)}{\fsp4}{\bord3}{\1c&H00ff00&}あれ？水の種類まで調べてるんすね!`,
    ),
  );
  ok(jobs[0]?.text === 'ふ〜ん。\n\nあれ？水の種類まで調べてるんすね!', `colour change splits blocks: ${jobs[0]?.text}`);
  ok(out.length === 2 && out[0].includes(',387)}{\\c&H00ffff&}KO[ふ〜ん。]'), `first block: own row and colour: ${out[0]}`);
  ok(out[1].includes(',447)}{\\c&H00ff00&}KO[あれ？'), `second block: own row and colour: ${out[1]}`);
}

// Ruby rows are dropped: not read into the sentence, not drawn; a ruby row between keeps a block.
{
  const { jobs, out } = await run(
    new CaptionHistory(),
    0,
    seg(
      String.raw`0:00:04.49,0:00:08.79,Default,,0,0,0,,{\an7}{\pos(530,270)}{\fs18}{\fsp2}{\bord3}わけ`,
      String.raw`0:00:04.49,0:00:08.79,Default,,0,0,0,,{\an7}{\pos(310,300)}{\fsp4}{\bord3}DAZN見てる 若え！`,
      String.raw`0:00:04.49,0:00:08.79,Default,,0,0,0,,{\an7}{\pos(310,360)}{\fsp4}{\bord3}DAZN知ってんだ！`,
      String.raw`0:00:10.22,,Default,,0,0,0,,{\an7}{\pos(80,389)}{\fsp4}{\bord3}{\1c&Hffff00&}なんで`,
      String.raw`0:00:10.22,,Default,,0,0,0,,{\an7}{\pos(280,419)}{\fs18}{\fsp2}{\bord3}{\1c&Hffff00&}ゼロ`,
      String.raw`0:00:10.22,,Default,,0,0,0,,{\an7}{\pos(80,449)}{\fsp4}{\bord3}{\1c&Hffff00&}｢アタックZERO｣は とことん研究しています｡`,
    ),
  );
  ok(jobs[0]?.text === 'DAZN見てる 若え！\nDAZN知ってんだ！', `ruby row not read: ${jobs[0]?.text}`);
  ok(!out.some((l) => l.includes('わけ')) && out.filter((l) => l.includes(',0:00:04.49,')).length === 2, `ruby row not drawn: ${out}`);
  ok(jobs[1]?.text === 'なんで\n「アタックZERO」は とことん研究しています。', `rows around a ruby row stay one block: ${jobs[1]?.text}`);
}

// A label-only row is read with the row after it; the empty clear event passes through.
{
  const { jobs, out } = await run(
    new CaptionHistory(),
    0,
    seg(
      '0:00:03.16,,Default,,0,0,0,,',
      String.raw`0:00:04.31,,Default,,0,0,0,,{\an7}{\pos(78,359)}{\fs18}{\fsp2}{\bord3}よしだ`,
      String.raw`0:00:04.31,,Default,,0,0,0,,{\an7}{\pos(58,389)}{\fsp4}{\bord3}(吉田)`,
      String.raw`0:00:04.31,,Default,,0,0,0,,{\an7}{\pos(58,449)}{\fsp4}{\bord3}≪ゆったりしたい生理の夜に≫`,
    ),
  );
  ok(jobs.length === 1 && jobs[0].text === '(吉田(よしだ))≪ゆったりしたい生理の夜に≫', `label, with its ruby, joins the next row: ${jobs[0]?.text}`);
  const label = out.filter((l) => l.includes(',0:00:04.31,'));
  ok(label.length === 1 && /\\pos\(\d+,447\)/.test(label[0]), `drawn on the row after the label: ${label}`);
  ok(out[0] === 'Dialogue: 0,0:00:03.16,,Default,,0,0,0,,', `clear event kept: ${out[0]}`);
}

// Ruby over a speaker label's name becomes its reading; ruby over the speech is dropped.
{
  const { jobs, out } = await run(
    new CaptionHistory(),
    0,
    seg(
      String.raw`0:00:32.67,0:00:35.97,Default,,0,0,0,,{\pos(220,442)\c&H00FFFF00\fscx50\fscy50}きょう`,
      String.raw`0:00:32.67,0:00:35.97,Default,,0,0,0,,{\pos(220,496)\c&H00FFFF00\fscx50}（{\fscx100}恭{\fscx50}）{\fscx100}今日は{\fscx50}　{\fscx100}青の日だよな！`,
      String.raw`0:00:41.47,,Default,,0,0,0,,{\an7}{\pos(360,269)}{\fs18}{\fsp2}{\bord3}{\1c&H00ffff&}かく`,
      String.raw`0:00:41.47,,Default,,0,0,0,,{\an7}{\pos(460,269)}{\fs18}{\fsp2}{\bord3}{\1c&H00ffff&}かおう`,
      String.raw`0:00:41.47,,Default,,0,0,0,,{\an7}{\pos(320,299)}{\fsp4}{\bord3}{\1c&H00ffff&}(賀来)花王の研究所に…｡`,
    ),
  );
  ok(jobs[0]?.text === '（恭(きょう)）今日は　青の日だよな！', `label ruby read inline, \\fscx50 alone is no ruby: ${jobs[0]?.text}`);
  ok(jobs[1]?.text === '(賀来(かく))花王の研究所に…。', `ruby over the speech dropped: ${jobs[1]?.text}`);
  ok(!out.some((l) => /きょう|かおう/.test(l) && !l.includes('KO[')), `ruby rows not drawn: ${out}`);
}

// An arrow chain over three captions: each part reads after the parts before it.
{
  const history = new CaptionHistory();
  const { jobs } = await run(
    history,
    50782,
    seg(
      String.raw`0:00:00.51,,Default,,0,0,0,,{\an7}{\pos(330,389)}{\fsp4}{\3a&Hff&}魔力量を増やすため`,
      String.raw`0:00:00.51,,Default,,0,0,0,,{\an7}{\pos(350,449)}{\fsp4}{\3a&Hff&}寝るとき以外は➡`,
      String.raw`0:00:02.51,,Default,,0,0,0,,{\an7}{\pos(270,449)}{\fsp4}{\3a&Hff&}エンチャントを維持しているし➡`,
      String.raw`0:00:04.51,,Default,,0,0,0,,{\an7}{\pos(210,389)}{\fsp4}{\3a&Hff&}走り込みや模擬戦では`,
      String.raw`0:00:04.51,,Default,,0,0,0,,{\an7}{\pos(230,449)}{\fsp4}{\3a&Hff&}限界まで 魔力を消費している｡`,
    ),
  );
  ok(tail(jobs[1].context, 2) === '["魔力量を増やすため","寝るとき以外は➡"]', `second part follows the first: ${tail(jobs[1].context, 3)}`);
  ok(tail(jobs[2].context, 3) === '["魔力量を増やすため","寝るとき以外は➡","エンチャントを維持しているし➡"]', `third part follows the chain: ${tail(jobs[2].context, 4)}`);

  // Across segments: the arrow part ends one segment, the rest starts the next.
  const a = await run(
    history,
    50821,
    seg(
      String.raw`0:00:01.22,,Default,,0,0,0,,{\an7}{\pos(370,449)}{\fsp4}{\3a&Hff&}天型って なんだよ？`,
      String.raw`0:00:03.22,,Default,,0,0,0,,{\an7}{\pos(230,449)}{\fsp4}{\3a&Hff&}でも なんでだろ？ 俺の心は➡`,
    ),
  );
  ok(tail(a.jobs[1].context, 3) === '["天型って なんだよ？","",""]', `a caption without an arrow is whole: ${tail(a.jobs[1].context, 3)}`);
  const b = await run(
    history,
    50827,
    seg(String.raw`0:00:00.65,0:00:03.15,Default,,0,0,0,,{\an7}{\pos(190,449)}{\fsp4}{\3a&Hff&}天にしろって言ってるんだよな｡`),
  );
  ok(tail(b.jobs[0].context, 3) === '["天型って なんだよ？","","でも なんでだろ？ 俺の心は➡"]', `chain continues across segments: ${tail(b.jobs[0].context, 3)}`);

  // 30 s without captions, or a jump back, starts afresh.
  const c = await run(history, 50900, seg(String.raw`0:00:00.00,,Default,,0,0,0,,{\an7}{\pos(330,449)}{\fsp4}登録されました｡`));
  ok(c.jobs[0].context.length === 0, `silence resets the history: ${c.jobs[0].context}`);
  history.reset();
}

// News without arrows: a caption with no end mark goes on into the next one in the same block.
{
  const history = new CaptionHistory();
  const { jobs } = await run(
    history,
    52790,
    seg(
      String.raw`0:00:02.70,,Default,,0,0,0,,{\an7}{\pos(170,90)}{\fsp4}{\bord3}{\1c&H00ffff&}サイバー攻撃というのは、技術で`,
      String.raw`0:00:02.70,,Default,,0,0,0,,{\an7}{\pos(170,150)}{\fsp4}{\bord3}{\1c&H00ffff&}防ぐことができるんですけれど`,
      String.raw`0:00:05.82,,Default,,0,0,0,,{\an7}{\pos(170,90)}{\fsp4}{\bord3}{\1c&H00ffff&}セキュリティー上のリスクを`,
      String.raw`0:00:05.82,,Default,,0,0,0,,{\an7}{\pos(170,150)}{\fsp4}{\bord3}{\1c&H00ffff&}どう判断するかというのは`,
      String.raw`0:00:06.20,,Default,,0,0,0,,{\an7}{\pos(170,150)}{\fsp4}{\bord3}{\1c&Hffff00&}防ぐことができるんですけれど`,
    ),
  );
  ok(tail(jobs[1].context, 2) === '["サイバー攻撃というのは、技術で","防ぐことができるんですけれど"]', `unpunctuated caption goes on: ${tail(jobs[1].context, 3)}`);
  ok(jobs[2].context.at(-1) === '' && jobs[2].context.at(-2) === '', `another colour does not go on: ${tail(jobs[2].context, 3)}`);
}

// Translation preserves source timestamps, including fractional bases and reordered fields.
for (const text of [
  seg(
    String.raw`0:00:01.55,,Default,,0,0,0,,{\pos(170,390)}今日はいい天気ですね。`,
    String.raw`0:00:03.25,0:00:05.50,Default,,0,0,0,,{\pos(170,450)}おはようございます。`,
    '0:00:05.75,,Default,,0,0,0,,',
  ),
  '[Events]\nFormat: Start, End, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
    String.raw`Dialogue: 0:00:01.55,0:00:03.25,0,Default,,0,0,0,,{\pos(170,390)}今日はいい天気ですね。`,
]) {
  const translated = await translateAss(text, 1234.567, new CaptionHistory(), fake);
  const timing = s => parseDialogueLines(s, 1234.567).map(e => [e.startMs, e.endMs]);
  ok(JSON.stringify(timing(translated)) === JSON.stringify(timing(text)), 'Japanese and translated presentation timestamps match');
}

// --- Wrapping. ---
ok(wrap('짧은 문장').length === 1, 'short line is not wrapped');
ok(wrap('[사랑하는 손녀를 유괴당한 마닐라의 미겔]').join('|') === '[사랑하는 손녀를|유괴당한 마닐라의 미겔]', 'lines are balanced');
for (const arrow of ['➡', '￫', '→', '⇒'])
  ok(wrap(`[kiDnap GAME의 너무나 잔혹함  ${arrow}`).at(-1).endsWith(`잔혹함 ${arrow}`), `a trailing ${arrow} stays with its word`);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('verify-ass-translate: all checks passed.');
