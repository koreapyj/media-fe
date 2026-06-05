// Pure ASS-event parsing (no DOM / no libass) so the timing logic is unit-testable.
//
// ARIB-over-HLS delivers each `.ass` segment with timestamps restarting at 0. Each segment carries its
// own [Events] `Format:` line, so Dialogue fields are read BY NAME from that line (never by fixed
// position). An empty End means the caption is open-ended (closed when a later caption starts).

/** One parsed Dialogue event, rebased to absolute presentation time (milliseconds). */
export interface AssEvent {
  /** Absolute presentation start (ms) = segmentStart*1000 + the line's relative Start. */
  startMs: number;
  /** Absolute presentation end (ms), or null when the Dialogue's End field is empty (open-ended). */
  endMs: number | null;
  layer: number;
  /** Style name as written in the Dialogue (resolved to a libass index by the renderer). */
  style: string;
  name: string;
  marginL: number;
  marginR: number;
  marginV: number;
  effect: string;
  text: string;
}

/** Parse an ASS timestamp `H:MM:SS.cc` to milliseconds; NaN if malformed/empty. */
export function parseAssTimeMs(t: string): number {
  const m = t.trim().match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!m) return NaN;
  const cs = (m[4] ?? '').padEnd(3, '0').slice(0, 3); // centi/milli digits → ms
  return Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(cs);
}

const num = (v: string | undefined): number => {
  const n = Number((v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
};

/**
 * Parse the Dialogue events of one segment, rebased to `segmentStartSec`. Fields are read by name from
 * the segment's own `[Events]` `Format:` line; the last format field absorbs the remainder of the line
 * so a Text/last field containing commas is preserved.
 */
export function parseDialogueLines(text: string, segmentStartSec: number): AssEvent[] {
  const baseMs = segmentStartSec * 1000;
  const out: AssEvent[] = [];
  let section: string | null = null;
  let fields: string[] | null = null;

  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      continue;
    }
    if (section !== 'Events') continue;

    if (/^Format:/i.test(line)) {
      fields = line.slice(line.indexOf(':') + 1).split(',').map((f) => f.trim());
      continue;
    }
    if (!/^Dialogue:/i.test(line) || !fields) continue;

    // Split the body into exactly fields.length parts; the last field keeps any remaining commas.
    const body = line.slice(line.indexOf(':') + 1);
    const parts = splitFields(body, fields.length);
    const row: Record<string, string> = {};
    for (let i = 0; i < fields.length; i++) row[fields[i]] = (parts[i] ?? '').trim();

    const relStart = parseAssTimeMs(row['Start']);
    const endRaw = row['End'] ?? '';
    const relEnd = endRaw === '' ? NaN : parseAssTimeMs(endRaw);

    out.push({
      startMs: baseMs + (Number.isFinite(relStart) ? relStart : 0),
      endMs: endRaw === '' || !Number.isFinite(relEnd) ? null : baseMs + relEnd,
      layer: num(row['Layer']),
      style: (row['Style'] ?? '').trim(),
      name: row['Name'] ?? '',
      marginL: num(row['MarginL']),
      marginR: num(row['MarginR']),
      marginV: num(row['MarginV']),
      effect: row['Effect'] ?? '',
      text: row['Text'] ?? '',
    });
  }
  return out;
}

/** Split `body` into `count` comma fields; the final field retains the rest of the string (commas). */
function splitFields(body: string, count: number): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < count - 1; i++) {
    const comma = body.indexOf(',', start);
    if (comma === -1) {
      parts.push(body.slice(start));
      return parts;
    }
    parts.push(body.slice(start, comma));
    start = comma + 1;
  }
  parts.push(body.slice(start));
  return parts;
}

/** Duration (ms) an open event should get once the next caption's start is known. */
export function closeDuration(openStartMs: number, nextStartMs: number): number {
  return nextStartMs - openStartMs;
}
