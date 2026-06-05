/** A programme entry parsed from XMLTV. */
export interface Programme {
  /** Channel id (matches a channel `tvg-id`). */
  channel: string;
  /** Start time, epoch ms. */
  start: number;
  /** Stop time, epoch ms. */
  stop: number;
  title: string;
  desc?: string;
  category?: string;
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

/** Parse an XMLTV document (string or Document) into channels + programmes. */
export function parseXMLTV(input: string | Document): ParsedEpg {
  const doc =
    typeof input === 'string'
      ? new DOMParser().parseFromString(input, 'application/xml')
      : input;

  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error('Invalid XMLTV: ' + parseError.textContent);

  const channels: EpgChannel[] = [];
  for (const el of Array.from(doc.getElementsByTagName('channel'))) {
    const id = el.getAttribute('id');
    if (!id) continue;
    const names = Array.from(el.getElementsByTagName('display-name'))
      .map((n) => n.textContent?.trim() ?? '')
      .filter(Boolean);
    const icon = el.getElementsByTagName('icon')[0]?.getAttribute('src') ?? undefined;
    channels.push({ id, names, icon });
  }

  const programmes: Programme[] = [];
  for (const el of Array.from(doc.getElementsByTagName('programme'))) {
    const channel = el.getAttribute('channel');
    const start = parseXmltvDate(el.getAttribute('start'));
    const stop = parseXmltvDate(el.getAttribute('stop'));
    if (!channel || Number.isNaN(start)) continue;
    programmes.push({
      channel,
      start,
      stop: Number.isNaN(stop) ? start : stop,
      title: el.getElementsByTagName('title')[0]?.textContent?.trim() ?? '',
      desc: el.getElementsByTagName('desc')[0]?.textContent?.trim() || undefined,
      category: el.getElementsByTagName('category')[0]?.textContent?.trim() || undefined,
    });
  }

  return { channels, programmes };
}
