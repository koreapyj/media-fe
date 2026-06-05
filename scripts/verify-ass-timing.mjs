// Headless verification of the ARIB ASS parsing/timing logic (no browser).
// Exercises the real pure module src/player/assDocument.ts via Node type-stripping.
import { parseDialogueLines, closeDuration, parseAssTimeMs } from '../src/player/assDocument.ts';

let failures = 0;
const ok = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); failures++; } };

// --- Two consecutive segments; ASS clock restarts at 0 in each; End empty (open). ---
const SEG1 = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,,Default,,0,0,0,,{\\an7}{\\pos(170,390)}それとも今は
Dialogue: 0,0:00:00.00,,Default,,0,0,0,,{\\an7}{\\pos(190,450)}ただの傭兵稼業に逆戻りかな？》`;

const SEG2 = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,,Default,,0,0,0,,{\\an7}{\\pos(100,100)}次のセリフ`;

const s1 = parseDialogueLines(SEG1, 0);
const s2 = parseDialogueLines(SEG2, 22.022);

ok(s1.length === 2, `seg1 should yield 2 events, got ${s1.length}`);
ok(s1.every((e) => e.startMs === 0), 'seg1 events rebase to startMs 0');
ok(s1.every((e) => e.endMs === null), 'empty End must yield endMs=null (open)');
ok(s1[0].text.includes('{\\pos(170,390)}'), 'Text with internal comma must survive the field split');
ok(s1[0].style === 'Default' && s1[0].layer === 0, 'Style/Layer read by name');

ok(s2.length === 1 && s2[0].startMs === 22022, `seg2 rebases to 22022, got ${s2[0]?.startMs}`);

// Open caption closes at the next distinct start.
ok(closeDuration(s1[0].startMs, s2[0].startMs) === 22022, 'closeDuration = nextStart - openStart');

// --- Explicit End is respected. ---
const SEG3 = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,hi`;
const s3 = parseDialogueLines(SEG3, 0);
ok(s3[0].startMs === 1000 && s3[0].endMs === 3500, `explicit End → endMs 3500, got ${s3[0]?.endMs}`);

// --- Fields read BY NAME from the segment's own Format line (reordered, Text still last). ---
const REORDERED = `[Events]
Format: Start, End, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0:00:01.00,0:00:02.50,5,Sub,,0,0,0,,Hello, world {\\pos(1,2)}`;
const r = parseDialogueLines(REORDERED, 0)[0];
ok(r.startMs === 1000, `reordered Start by name → 1000, got ${r?.startMs}`);
ok(r.endMs === 2500, `reordered End by name → 2500, got ${r?.endMs}`);
ok(r.layer === 5, `reordered Layer by name → 5, got ${r?.layer}`);
ok(r.style === 'Sub', `reordered Style by name → "Sub", got ${r?.style}`);
ok(r.text === 'Hello, world {\\pos(1,2)}', `reordered Text keeps commas, got ${JSON.stringify(r?.text)}`);

// --- parseAssTimeMs sanity. ---
ok(parseAssTimeMs('0:00:22.02') === 22020, `parseAssTimeMs cc, got ${parseAssTimeMs('0:00:22.02')}`);
ok(parseAssTimeMs('1:01:01.5') === 3661500, `parseAssTimeMs, got ${parseAssTimeMs('1:01:01.5')}`);

if (failures === 0) console.log('PASS: ASS parsing — Format-by-name, ms rebasing, empty/explicit End, comma-safe Text');
else process.exitCode = 1;
