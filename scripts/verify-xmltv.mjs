// Headless verification of the (non-DOM) XMLTV parser used by the EPG worker.
// Exercises the real pure module src/epg/xmltv.ts via Node type-stripping + fast-xml-parser.
import { parseXMLTV } from '../src/epg/xmltv.ts';

let failures = 0;
const ok = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); failures++; } };

// Real-world ARIB programme: full-width text, emoji, entities, multi-line desc, attributed children.
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
<channel id="ch1"><display-name lang="ja">アニメTV</display-name><icon src="http://x/logo.png"/></channel>
<programme start="20260605100000 +0000" stop="20260605103000 +0000" channel="ch1">
  <title>とある科学の超電磁砲　＃０４　🈑</title>
  <sub-title>＃０４　都市伝説【全２４話】２００９年－２０１０年放送作品</sub-title>
  <desc>line1&apos;s
line2</desc>
  <category lang="en">Children&apos;s / Youth programs</category>
</programme>
<programme start="20260605103000 +0000" channel="ch1"><title>0400</title></programme>
<programme channel="ch1"><title>no start - skipped</title></programme>
</tv>`;

const { channels, programmes } = parseXMLTV(XML);

ok(channels.length === 1 && channels[0].id === 'ch1', 'channel id parsed');
ok(channels[0].names[0] === 'アニメTV', 'display-name (attributed) text parsed');
ok(channels[0].icon === 'http://x/logo.png', 'icon @src parsed');

ok(programmes.length === 2, `2 programmes (the one without start is skipped), got ${programmes.length}`);
const p = programmes[0];
ok(p.channel === 'ch1', 'programme @channel parsed');
ok(p.start === Date.parse('2026-06-05T10:00:00Z'), 'start parsed to epoch ms (UTC offset)');
ok(p.stop === Date.parse('2026-06-05T10:30:00Z'), 'stop parsed to epoch ms');
ok(p.title === 'とある科学の超電磁砲　＃０４　🈑', 'title (emoji/full-width) preserved');
ok(p.subTitle === '＃０４　都市伝説【全２４話】２００９年－２０１０年放送作品', 'sub-title parsed');
ok(p.desc === "line1's\nline2", 'desc: apos entity decoded and newline preserved');
ok(p.category === "Children's / Youth programs", 'category (attributed) text parsed');

// A numeric-looking title must stay a string, not be coerced to a number.
ok(programmes[1].title === '0400', `numeric-looking title kept as string, got ${JSON.stringify(programmes[1].title)}`);
// A still-running programme with no stop falls back to start.
ok(programmes[1].stop === programmes[1].start, 'missing stop falls back to start');

if (failures) { console.error(`\n${failures} XMLTV check(s) failed.`); process.exit(1); }
console.log('PASS: XMLTV parsing — non-DOM parser, attributed nodes, entities, multi-line desc, numeric title kept as string');
