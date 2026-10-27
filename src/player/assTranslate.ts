// Pure ASS/HLS rewriting for the Korean subtitle track (no DOM / no libass). The track's playlist
// URI carries a `#hdtrans` fragment: fetch() never sends it, so both tracks read the same files.

export const KOREAN_TRACK_NAME = '한국어 (자동번역)';
export const KOREAN_STYLE = 'HdTransKo';
/** Family name (name ID 1) of public/fonts/NanumSquareRoundB.woff2. */
export const KOREAN_FONT_NAME = 'NanumSquareRound Bold';
const MARK = '#hdtrans';

// NanumSquareRound scaled to WadaLab's kanji height and nudged onto its row centres.
const KOREAN_SCALE = 109;
const KOREAN_SPACING = 2;
const KOREAN_DY = -2;
const HANGUL_PX = 32.4;
/** ARIB rows are 60px apart on the 960x540 PlayRes grid. */
const ROW_PITCH = 60;
const PLAY_W = 960;
const WRAP = 22;
const MAX_LINE = PLAY_W - 40;

const JAPANESE = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ]/;
const HALFWIDTH: Record<string, string> = { '｡': '。', '｢': '「', '｣': '」', '､': '、', '･': '・' };

/** A gap of 90px or more between rows starts another block (measured on live captions). */
const BLOCK_GAP = 90;
/** Ruby rows are small: \fs ≤ 24, \fscy50 or \rssz (\fscx50 alone is a half-width glyph). */
const RUBY_FS = 24;
const RUBY = /\\fscy50(?!\d)|\\rssz/;
const ROW_FS = 36;
const RUBY_ABOVE = 60;
const KANJI = /[\p{Script=Han}々〆]/u;
const ARROW = /[➡￫→⇒]$/;
const MUSIC = /^[♬♪〜～\s]+$/;
/** (名), 名(俳優), 名≫ or ≫; the name may carry its ruby as a reading: （恭(きょう)）. */
const NAME_PART = String.raw`(?:[^（）()]|\([^（）()]{1,12}\))`;
const SPEAKER_LABEL = String.raw`[（(]${NAME_PART}{1,12}[）)]|(?:[\p{L}\p{N}・･ー]|\([\p{L}ー]{1,12}\)){1,10}(?:[（(][^（）()]{1,12}[）)]|≫)|≫`;
/** A new voice: a speaker label, a turn mark (leading 》, －, ―), ⚟, or a narration bracket. */
const SPEAKER = new RegExp(String.raw`^[♬〓]?〜?\s*(?:${SPEAKER_LABEL}|[》⚟－―＜<《〈⟨［｟])`, 'u');
const LABEL = new RegExp(String.raw`^(?:${SPEAKER_LABEL})$`, 'u');
const CLOSED = /[。．.！？!?」』）)》〉＞>］\]】〕｠♪♬…‥]$/;

const CONTEXT_CAPTIONS = 3;
const CONTEXT_SEC = 15;
const CHAIN_CAPTIONS = 6;
const CHAIN_SEC = 30;
const SILENCE_SEC = 30;

export function addKoreanRendition(master: string): string {
  if (master.includes(`NAME="${KOREAN_TRACK_NAME}"`)) return master;
  return master.replace(/^#EXT-X-MEDIA:(.*TYPE=SUBTITLES.*)$/gm, (line, attrs: string) => {
    if (!/LANGUAGE="(ja|jpn)"/i.test(attrs)) return line;
    const ko = attrs
      .replace(/NAME="[^"]*"/, `NAME="${KOREAN_TRACK_NAME}"`)
      .replace(/LANGUAGE="[^"]*"/, 'LANGUAGE="ko"')
      .replace(/DEFAULT=YES/, 'DEFAULT=NO')
      .replace(/AUTOSELECT=YES/, 'AUTOSELECT=NO')
      .replace(/URI="([^"#]*)[^"]*"/, `URI="$1${MARK}"`);
    return `${line}\n#EXT-X-MEDIA:${ko}`;
  });
}

export function withKoreanStyle(header: string): string {
  if (header.includes(`Style: ${KOREAN_STYLE},`)) return header;
  const format = header.match(/^\[V4\+? Styles\][\s\S]*?^Format:(.*)$/im);
  const first = header.match(/^Style:(.*)$/im);
  if (!format || !first) return header;
  const names = format[1].split(',').map((f) => f.trim());
  const values = first[1].split(',').map((v) => v.trim());
  const set = (name: string, value: string) => {
    const i = names.indexOf(name);
    if (i !== -1) values[i] = value;
  };
  set('Name', KOREAN_STYLE);
  set('Fontname', KOREAN_FONT_NAME);
  set('ScaleX', String(KOREAN_SCALE));
  set('ScaleY', String(KOREAN_SCALE));
  set('Spacing', String(KOREAN_SPACING));
  return header.replace(first[0], `${first[0]}\nStyle: ${values.join(',')}`);
}

interface Glyph {
  c: string;
  x0: number;
  x1: number;
}

interface Row {
  x: number;
  y: number;
  colour: string | null;
  ruby: boolean;
  glyphs: Glyph[];
  plain: string;
  line: string;
}

const isWide = (c: string) => c.codePointAt(0)! >= 0x2e80 && !(c >= '｡' && c <= 'ﾟ');

/** Glyph extents as WadaLab draws them: \fs per full-width glyph, half per half-width one. */
function glyphsOf(text: string, x: number): Glyph[] {
  const glyphs: Glyph[] = [];
  let size = ROW_FS;
  let scale = 100;
  let spacing = 0;
  for (const part of text.split(/(\{[^}]*\})/)) {
    if (part.startsWith('{')) {
      for (const [, tag, value] of part.matchAll(/\\(fscx|fsp|fs)([\d.]+)/g)) {
        if (tag === 'fscx') scale = Number(value);
        else if (tag === 'fsp') spacing = Number(value);
        else size = Number(value);
      }
      continue;
    }
    for (const c of part.replace(/\\[Nn]/g, '').replace(/\\h/g, ' ')) {
      const width = ((isWide(c) ? size : size / 2) * scale) / 100 + spacing;
      glyphs.push({ c: HALFWIDTH[c] ?? c, x0: x, x1: x + width });
      x += width;
    }
  }
  while (glyphs.length && /\s/.test(glyphs[0].c)) glyphs.shift();
  while (glyphs.length && /\s/.test(glyphs[glyphs.length - 1].c)) glyphs.pop();
  return glyphs;
}

function parseRow(text: string, line: string): Row {
  const pos = text.match(/\\pos\(([\d.]+),([\d.]+)\)/);
  const fs = text.match(/\\fs([\d.]+)/);
  const colour = text.match(/\\1?c(&H[0-9A-Fa-f]+&?)/);
  const x = pos ? Number(pos[1]) : 0;
  const glyphs = glyphsOf(text, x);
  return {
    x,
    y: pos ? Number(pos[2]) : 450,
    colour: colour ? colour[1] : null,
    ruby: (fs !== null && Number(fs[1]) <= RUBY_FS) || RUBY.test(text),
    glyphs,
    plain: glyphs.map((g) => g.c).join(''),
    line,
  };
}

function rowRight(r: Row): number {
  return r.glyphs.length ? r.glyphs[r.glyphs.length - 1].x1 : r.x;
}

// Ruby over a label's name becomes its reading: （恭） + きょう → （恭(きょう)）. Ruby over the speech
// is dropped: joined into the sentence it garbles the translation.
function readLabels(rows: readonly Row[]): void {
  const label = new RegExp(String.raw`^(?:[♬〓]?〜?\s*)(?:${SPEAKER_LABEL})`, 'u');
  for (const row of rows) {
    if (row.ruby) continue;
    const m = row.plain.match(label);
    if (!m) continue;
    const glyphs = row.glyphs.slice(0, [...m[0]].length);
    const runs: { end: number; x0: number; x1: number; reading: string[] }[] = [];
    glyphs.forEach((g, i) => {
      if (!KANJI.test(g.c)) return;
      const run = runs[runs.length - 1];
      if (run && run.end === i) {
        run.end = i + 1;
        run.x1 = g.x1;
      } else runs.push({ end: i + 1, x0: g.x0, x1: g.x1, reading: [] });
    });
    if (!runs.length) continue;
    const ruby = rows
      .filter((r) => r.ruby && r.glyphs.length && r.y < row.y && row.y - r.y <= RUBY_ABOVE)
      .sort((a, b) => a.x - b.x);
    for (const r of ruby) {
      const x0 = r.glyphs[0].x0;
      const x1 = rowRight(r);
      const middle = (x0 + x1) / 2;
      if (middle < glyphs[0].x0 || middle > glyphs[glyphs.length - 1].x1) continue;
      let best = null;
      let most = 0;
      for (const run of runs) {
        const overlap = Math.min(x1, run.x1) - Math.max(x0, run.x0);
        if (overlap > most) {
          best = run;
          most = overlap;
        }
      }
      best?.reading.push(r.plain);
    }
    const chars = row.glyphs.map((g) => g.c);
    for (const run of [...runs].reverse())
      if (run.reading.length) chars.splice(run.end, 0, `(${run.reading.join('')})`);
    row.plain = chars.join('');
  }
}

function koreanWidth(line: string): number {
  return [...line].reduce(
    (w, c) => w + (c.codePointAt(0)! >= 0x1100 ? HANGUL_PX : HANGUL_PX / 2) + KOREAN_SPACING,
    0,
  );
}

function colourKey(colour: string | null): string {
  return colour
    ? colour
        .replace(/^&H|&$/gi, '')
        .toLowerCase()
        .padStart(6, '0')
    : 'ffffff';
}

/** Rows laid out together in one voice; a label-only row joins the next row's line. */
interface Block {
  rows: Row[];
  lines: string[];
  drawn: Row[];
  colour: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
  passThrough: boolean;
}

function captionBlocks(rows: readonly Row[]): Block[] {
  const blocks: Block[] = [];
  let prev: Row | null = null;
  let rubyBetween = false;
  let label: Row | null = null;
  for (const row of rows) {
    if (row.ruby) {
      rubyBetween = true;
      continue;
    }
    if (row.plain === '') continue;
    const gap = prev ? row.y - prev.y : 0;
    const apart =
      !prev || (gap >= BLOCK_GAP && !rubyBetween) || (gap === 0 && row.x !== prev.x) || gap < 0;
    rubyBetween = false;
    if (label && apart) {
      // A lone label is a sound description such as (鳴き声).
      blocks.push(newBlock(label, label.plain));
      label = null;
    }
    if (LABEL.test(row.plain)) {
      if (label) blocks.push(newBlock(label, label.plain));
      label = row;
      prev = row;
      continue;
    }
    const text = label ? label.plain + row.plain : row.plain;
    const last = blocks[blocks.length - 1];
    if (
      !label &&
      !apart &&
      last &&
      colourKey(row.colour) === last.colour &&
      !SPEAKER.test(row.plain) &&
      MUSIC.test(row.plain) === last.passThrough
    ) {
      addRow(last, row, text);
    } else {
      const block = newBlock(row, text);
      if (label) block.drawn.unshift(label);
      blocks.push(block);
    }
    label = null;
    prev = row;
  }
  if (label) blocks.push(newBlock(label, label.plain));
  for (const b of blocks) {
    b.passThrough = !b.lines.some((l) => JAPANESE.test(l));
    b.left = Math.min(...b.drawn.map((r) => r.x));
    b.right = Math.max(...b.drawn.map(rowRight));
  }
  return blocks;
}

function newBlock(row: Row, text: string): Block {
  return {
    rows: [row],
    lines: [text],
    drawn: [row],
    colour: colourKey(row.colour),
    top: row.y,
    bottom: row.y,
    left: row.x,
    right: row.x,
    passThrough: MUSIC.test(row.plain),
  };
}

function addRow(block: Block, row: Row, text: string): void {
  block.rows.push(row);
  block.drawn.push(row);
  block.lines.push(text);
  block.bottom = row.y;
}

interface PastBlock {
  lines: string[];
  colour: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
  arrow: boolean;
  closed: boolean;
}

interface PastCaption {
  start: number;
  blocks: PastBlock[];
}

/** A track's recent captions, sent along as context (the engine keeps no state). */
export class CaptionHistory {
  private captions: PastCaption[] = [];
  /** Once a track uses arrows, a caption without one is complete. */
  private arrows = false;

  reset(): void {
    this.captions = [];
    this.arrows = false;
  }

  private linked(prev: PastCaption, block: PastBlock): PastBlock | null {
    let best: PastBlock | null = null;
    let bestDistance = Infinity;
    for (const p of prev.blocks) {
      if (p.colour !== block.colour) continue;
      if (p.top > block.bottom + ROW_PITCH / 2 || block.top > p.bottom + ROW_PITCH / 2) continue;
      const distance = Math.abs(p.left + p.right - block.left - block.right);
      if (distance < bestDistance) {
        best = p;
        bestDistance = distance;
      }
    }
    return best;
  }

  private open(block: PastBlock): boolean {
    return block.arrow || (!this.arrows && !block.closed);
  }

  private chain(block: PastBlock, start: number): PastBlock[] {
    const blocks: PastBlock[] = [];
    let current = block;
    for (let i = this.captions.length - 1; i >= 0; i--) {
      const prev = this.captions[i];
      const p = this.linked(prev, current);
      if (!p || !this.open(p)) break;
      const limit = p.arrow ? [CHAIN_CAPTIONS, CHAIN_SEC] : [CONTEXT_CAPTIONS, CONTEXT_SEC];
      if (this.captions.length - i > limit[0] || start - prev.start > limit[1]) break;
      blocks.unshift(p);
      current = p;
    }
    return blocks;
  }

  /** A continuing block goes first, right after its sentence in the context. */
  jobs(start: number, blocks: Block[]): { jobs: TranslationJob[]; order: Block[][] } {
    const last = this.captions[this.captions.length - 1];
    if (last && (start < last.start - 1 || start - last.start > SILENCE_SEC)) this.captions = [];
    const translated = blocks.filter((b) => !b.passThrough);
    const past = translated.map(toPast);
    const chains = past.map((b) => this.chain(b, start));
    const recent = this.captions
      .slice(-CONTEXT_CAPTIONS)
      .filter((c) => start - c.start <= CONTEXT_SEC);
    const going = translated.filter((_, i) => chains[i].length);
    const others = translated.filter((_, i) => !chains[i].length);
    const groups = going.length
      ? [[going[0], ...others], ...going.slice(1).map((b) => [b])]
      : others.length
        ? [others]
        : [];

    const jobs = groups.map((group): TranslationJob => {
      const chain = chains[translated.indexOf(group[0])];
      const context: string[] = [];
      for (const b of recent.flatMap((c) => c.blocks)) {
        if (chain.includes(b)) continue;
        if (context.length) context.push('');
        context.push(...b.lines);
      }
      if (chain.length) {
        if (context.length) context.push('');
        for (const b of chain) context.push(...b.lines);
      } else if (context.length) {
        // One trailing '' only ends the last line; two end the sentence.
        context.push('', '');
      }
      const text = group.map((b) => b.lines.join('\n')).join('\n\n');
      return { text, context };
    });

    if (past.length) {
      if (past.some((b) => b.arrow)) this.arrows = true;
      this.captions.push({ start, blocks: past });
      const keep = Math.max(CHAIN_CAPTIONS, CONTEXT_CAPTIONS);
      if (this.captions.length > keep) this.captions.splice(0, this.captions.length - keep);
    }
    return { jobs, order: groups };
  }
}

function toPast(b: Block): PastBlock {
  const end = b.lines[b.lines.length - 1];
  return {
    lines: b.lines,
    colour: b.colour,
    top: b.top,
    bottom: b.bottom,
    left: b.left,
    right: b.right,
    arrow: ARROW.test(end),
    closed: CLOSED.test(end),
  };
}

export interface TranslationJob {
  text: string;
  context: string[];
}

function greedy(text: string, width: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(' ')) {
    if (cur && cur.length + 1 + word.length > width) {
      lines.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Lines of even length, at most WRAP where words allow; a trailing arrow stays with its word. */
export function wrap(text: string): string[] {
  text = text.replace(/\s+([➡￫→⇒])/g, ' $1');
  if (text.length <= WRAP) return [text];
  let lines = greedy(text, WRAP);
  for (let width = Math.ceil(text.length / Math.ceil(text.length / WRAP)); width < WRAP; width++) {
    const tried = greedy(text, width);
    if (tried.length <= lines.length) {
      lines = tried;
      break;
    }
  }
  return lines;
}

function splitFields(body: string, count: number): string[] | null {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < count - 1; i++) {
    const comma = body.indexOf(',', start);
    if (comma === -1) return null;
    parts.push(body.slice(start, comma));
    start = comma + 1;
  }
  parts.push(body.slice(start));
  return parts;
}

function seconds(t: string): number {
  const m = t.trim().match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

interface Caption {
  key: string;
  fields: string[];
  rows: Row[];
  blocks: Block[];
  korean: Map<Block, string[]>;
}

/**
 * One engine call per caption, blocks split by a blank line; the Korean comes back line for line
 * and is laid out per block. Start/End are kept, so open-caption handling is unchanged.
 */
export async function translateAss(
  text: string,
  segmentStartSec: number,
  history: CaptionHistory,
  translate: (jobs: TranslationJob[]) => Promise<string[]>,
): Promise<string> {
  const out: (string | Caption)[] = [];
  let format: string[] | null = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^Format:/i.test(line))
      format = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((f) => f.trim());
    const fields =
      format && /^Dialogue:/i.test(line)
        ? splitFields(line.slice(line.indexOf(':') + 1).trimStart(), format.length)
        : null;
    if (!format || !fields) {
      out.push(line);
      continue;
    }
    const key = ['Layer', 'Start', 'End', 'Style'].map((n) => fields[format!.indexOf(n)]).join('|');
    const last = out[out.length - 1];
    const row = parseRow(fields[fields.length - 1], line);
    if (typeof last === 'object' && last.key === key) last.rows.push(row);
    else out.push({ key, fields, rows: [row], blocks: [], korean: new Map() });
  }

  const captions = out.filter((c): c is Caption => typeof c === 'object');
  const jobs: TranslationJob[] = [];
  const order: Block[][] = [];
  for (const c of captions) {
    if (!c.rows.some((r) => !r.ruby && JAPANESE.test(r.plain))) continue;
    readLabels(c.rows);
    c.blocks = captionBlocks(c.rows);
    const start = segmentStartSec + seconds(c.fields[format!.indexOf('Start')] ?? '');
    const calls = history.jobs(start, c.blocks);
    jobs.push(...calls.jobs);
    order.push(...calls.order);
  }
  const translated = jobs.length ? await translate(jobs) : [];
  translated.forEach((ko, i) => {
    const lines = ko.split('\n');
    const blocks = order[i];
    const expected = blocks.reduce((n, b) => n + b.lines.length, blocks.length - 1);
    if (lines.length !== expected) {
      console.warn('hdTrans changed the line count; caption left in Japanese', jobs[i].text);
      return;
    }
    let at = 0;
    for (const b of blocks) {
      captions
        .find((c) => c.blocks.includes(b))!
        .korean.set(b, lines.slice(at, at + b.lines.length));
      at += b.lines.length + 1;
    }
  });

  return out
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item.blocks.length) return item.rows.map((r) => r.line).join('\n');
      return item.blocks
        .flatMap((b) => {
          const ko = item.korean.get(b);
          return ko ? layOut(item.fields, format!, b, ko) : b.drawn.map((r) => r.line);
        })
        .join('\n');
    })
    .join('\n');
}

/** A block too wide for the screen is rewrapped and stacked up from its last row. */
function layOut(source: string[], format: string[], block: Block, ko: string[]): string[] {
  let lines = ko.map((l) => l.trim());
  let ys = block.rows.map((r) => r.y);
  if (lines.some((l) => koreanWidth(l) > MAX_LINE)) {
    lines = wrap(lines.join(' '));
    ys = lines.map((_, i) => block.bottom - (lines.length - 1 - i) * ROW_PITCH);
  }
  const half = Math.max(...lines.map(koreanWidth)) / 2;
  const centre = (block.left + block.right) / 2;
  const x = Math.round(Math.min(PLAY_W - 10 - half, Math.max(10 + half, centre)));
  const colour = block.rows[0].colour;
  const fields = source.slice();
  const set = (name: string, value: string) => {
    const i = format.indexOf(name);
    if (i !== -1) fields[i] = value;
  };
  set('Style', KOREAN_STYLE);
  for (const m of ['MarginL', 'MarginR', 'MarginV']) set(m, '0');
  return lines.flatMap((l, i) => {
    if (l === '') return [];
    fields[fields.length - 1] =
      `{\\an8}{\\pos(${x},${ys[i] + KOREAN_DY})}${colour ? `{\\c${colour}}` : ''}${l}`;
    return [`Dialogue: ${fields.join(',')}`];
  });
}
