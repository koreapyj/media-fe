import type { Channel, Playlist } from './types';

/** Parse the `key="value"` (and bare `key=value`) attribute pairs found on EXT lines. */
function parseAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z0-9_-]+)=(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

/** Lowercase, slug-safe fallback identifier derived from a channel name. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'channel';
}

/**
 * Parse an M3U / M3U8 playlist into channels + the EPG URL.
 *
 * Expected shape (IPTV convention):
 *   #EXTM3U url-tvg="https://…/epg.xml"
 *   #EXTINF:-1 tvg-id="cnn" tvg-chno="201" tvg-logo="…" thumb="…" x-url="cnn",CNN
 *   https://…/cnn/master.m3u8
 */
export function parseM3U(text: string): Playlist {
  const lines = text.split(/\r?\n/);
  const channels: Channel[] = [];
  let epgUrl: string | undefined;
  let pending: Channel | null = null;
  const seenXUrls = new Set<string>();

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;

    if (line.startsWith('#EXTM3U')) {
      const attrs = parseAttributes(line.slice('#EXTM3U'.length));
      epgUrl = attrs['url-tvg'] ?? attrs['x-tvg-url'] ?? epgUrl;
      continue;
    }

    if (line.startsWith('#EXTINF')) {
      // `#EXTINF:<duration> <attrs>,<name>`
      const comma = line.indexOf(',');
      const name = comma >= 0 ? line.slice(comma + 1).trim() : '';
      const head = comma >= 0 ? line.slice(0, comma) : line;
      // Drop the `#EXTINF:<duration>` prefix before reading attributes.
      const attrPart = head.replace(/^#EXTINF:\s*-?\d+(\.\d+)?/, '');
      const attrs = parseAttributes(attrPart);

      const chnoRaw = attrs['tvg-chno'] ?? attrs['channel-number'];
      const chno = chnoRaw != null && chnoRaw !== '' ? Number(chnoRaw) : undefined;

      pending = {
        name: name || attrs['tvg-name'] || 'Unnamed',
        streamUrl: '',
        xUrl: attrs['x-url'] ?? '',
        tvgId: attrs['tvg-id'] || undefined,
        chno: Number.isFinite(chno) ? chno : undefined,
        logo: attrs['tvg-logo'] || undefined,
        thumb: attrs['thumb'] || undefined,
      };
      continue;
    }

    // Skip other directives/comments (e.g. #EXTGRP, #EXTVLCOPT, #KODIPROP).
    if (line.startsWith('#')) continue;

    // First non-comment line after an #EXTINF is the stream URL.
    if (pending) {
      pending.streamUrl = line;
      if (!pending.xUrl) pending.xUrl = slugify(pending.name);
      // Guarantee a unique route slug even if x-url collides or is missing.
      let xUrl = pending.xUrl;
      let n = 2;
      while (seenXUrls.has(xUrl)) xUrl = `${pending.xUrl}-${n++}`;
      pending.xUrl = xUrl;
      seenXUrls.add(xUrl);
      channels.push(pending);
      pending = null;
    }
  }

  return { epgUrl, channels };
}

/** Fetch and parse the playlist from a URL. */
export async function loadPlaylist(url: string): Promise<Playlist> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load playlist (${res.status}) from ${url}`);
  return parseM3U(await res.text());
}
