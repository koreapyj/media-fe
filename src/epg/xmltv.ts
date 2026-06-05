import { XMLParser } from 'fast-xml-parser';

/** A programme entry parsed from XMLTV. */
export interface Programme {
  /** Channel id (matches a channel `tvg-id`). */
  channel: string;
  /** Start time, epoch ms. */
  start: number;
  /** Stop time, epoch ms. */
  stop: number;
  title: string;
  /** Secondary title (XMLTV `<sub-title>`). */
  subTitle?: string;
  desc?: string;
  category?: string;
  /** EPG source URL this programme came from (assigned at store time, not parsed). */
  source?: string;
}

export interface EpgChannel {
  id: string;
  names: string[];
  icon?: string;
}

export interface ParsedEpg {
  channels: EpgChannel[];
  programmes: Programme[];
}

/**
 * Parse an XMLTV date: `YYYYMMDDHHMMSS[ +HHMM]` (seconds and timezone optional).
 * Returns epoch ms, or NaN if unparseable.
 */
export function parseXmltvDate(value: string | null | undefined): number {
  if (!value) return NaN;
  const m = value.trim().match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*([+-]\d{4}))?$/,
  );
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s, tz] = m;
  // Build an ISO string with the parsed (or UTC) offset and let Date handle it.
  const offset = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : 'Z';
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}${offset}`;
  return Date.parse(iso);
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false, // keep all text as strings (don't coerce "0400" → 400)
  parseAttributeValue: false,
  processEntities: true, // decode &amp; &apos; etc.
  trimValues: true,
  isArray: (name) => name === 'programme' || name === 'channel' || name === 'display-name',
});

/** Text content of a fast-xml-parser node: string, `{ '#text', '@_lang' }`, or an array of those. */
function nodeText(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) return nodeText(v[0]);
  if (typeof v === 'object') {
    const t = (v as Record<string, unknown>)['#text'];
    return t == null ? undefined : String(t).trim() || undefined;
  }
  const s = String(v).trim();
  return s || undefined;
}

/** `@_src` of an `<icon>` node (object or array). */
function iconSrc(v: unknown): string | undefined {
  const first = Array.isArray(v) ? v[0] : v;
  if (first && typeof first === 'object') {
    const s = (first as Record<string, unknown>)['@_src'];
    return s != null ? String(s) : undefined;
  }
  return undefined;
}

/** Parse an XMLTV string into channels + programmes (pure; works in a worker and in Node). */
export function parseXMLTV(input: string): ParsedEpg {
  const root = xmlParser.parse(input) as {
    tv?: { programme?: Array<Record<string, unknown>>; channel?: Array<Record<string, unknown>> };
  };
  const tv = root.tv ?? {};

  const channels: EpgChannel[] = [];
  for (const c of tv.channel ?? []) {
    const id = c['@_id'] != null ? String(c['@_id']) : '';
    if (!id) continue;
    const raw = c['display-name'];
    const names = (Array.isArray(raw) ? raw : [raw])
      .map(nodeText)
      .filter((s): s is string => !!s);
    channels.push({ id, names, icon: iconSrc(c['icon']) });
  }

  const programmes: Programme[] = [];
  for (const p of tv.programme ?? []) {
    const channel = p['@_channel'] != null ? String(p['@_channel']) : '';
    const start = parseXmltvDate(p['@_start'] as string);
    const stop = parseXmltvDate(p['@_stop'] as string);
    if (!channel || Number.isNaN(start)) continue;
    programmes.push({
      channel,
      start,
      stop: Number.isNaN(stop) ? start : stop,
      title: nodeText(p['title']) ?? '',
      subTitle: nodeText(p['sub-title']),
      desc: nodeText(p['desc']),
      category: nodeText(p['category']),
    });
  }

  return { channels, programmes };
}
