import type { Channel, Playlist } from './types';

/**
 * Order two channel numbers numerically, segment by segment (so `11.2` < `11.10` and `011` == `11`).
 * A missing number sorts last.
 */
export function compareChno(a?: string, b?: string): number {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  const pa = a.split('.');
  const pb = b.split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = Number(pa[i] ?? 0);
    const y = Number(pb[i] ?? 0);
    if (x !== y) return x - y;
  }
  return 0;
}

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
  let name: string | undefined;
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

    if (line.startsWith('#PLAYLIST:')) {
      name = line.slice('#PLAYLIST:'.length).trim() || name;
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

      const chnoRaw = (attrs['tvg-chno'] ?? attrs['channel-number'] ?? '').trim();

      pending = {
        name: name || attrs['tvg-name'] || 'Unnamed',
        streamUrl: '',
        xUrl: attrs['x-url'] ?? '',
        tvgId: attrs['tvg-id'] || undefined,
        chno: chnoRaw || undefined,
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

  return { epgUrl, name, channels };
}

/** Fetch and parse the playlist from a URL. */
export async function loadPlaylist(url: string): Promise<Playlist> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load playlist (${res.status}) from ${url}`);
  const playlist = parseM3U(await res.text());
  // Resolve a relative `url-tvg` against the playlist's own (absolute, post-redirect) URL — not the
  // app page. `res.url` is always absolute; an already-absolute EPG URL passes through unchanged.
  if (playlist.epgUrl) playlist.epgUrl = new URL(playlist.epgUrl, res.url).href;
  return playlist;
}

/** One playlist to load, with optional per-playlist options from the config manifest. */
export interface PlaylistSource {
  url: string;
  /** Live seek-window override in seconds (→ Shaka `manifest.availabilityWindowOverride`). */
  availabilityWindow?: number;
}

/** The merged result of loading several playlists. */
export interface MergedPlaylists {
  channels: Channel[];
  /** Distinct XMLTV EPG URLs (one per playlist's `url-tvg`). */
  epgUrls: string[];
}

/**
 * Load several playlists and merge them: channels concatenated in manifest order, EPG URLs collected
 * from each playlist's `url-tvg` (de-duplicated). Failed playlists are skipped with a warning; throws
 * only if every playlist fails. A final uniqueness pass guarantees route slugs stay distinct across
 * playlists (collisions aren't expected, but must never break routing).
 */
export async function loadPlaylists(sources: PlaylistSource[]): Promise<MergedPlaylists> {
  const results = await Promise.allSettled(sources.map((s) => loadPlaylist(s.url)));
  const loaded: Array<{ source: PlaylistSource; playlist: Playlist }> = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') loaded.push({ source: sources[i], playlist: r.value });
    else console.warn(`Skipping playlist ${sources[i].url}:`, r.reason);
  });
  if (!loaded.length) throw new Error('No playlists could be loaded');

  const epgUrls = [
    ...new Set(loaded.map((l) => l.playlist.epgUrl).filter((u): u is string => !!u)),
  ];

  const seen = new Set<string>();
  const channels: Channel[] = [];
  for (const { source, playlist } of loaded) {
    // Category = the `#PLAYLIST:` name, else the file name without extension.
    const category = playlist.name || fileStem(source.url);
    for (const ch of playlist.channels) {
      let xUrl = ch.xUrl;
      let n = 2;
      while (seen.has(xUrl)) xUrl = `${ch.xUrl}-${n++}`;
      seen.add(xUrl);
      channels.push({ ...ch, xUrl, playlist: category, availabilityWindow: source.availabilityWindow });
    }
  }

  return { channels, epgUrls };
}

/** Last path segment of a URL without its extension (e.g. `…/地上.m3u?x=1` → `地上`). */
function fileStem(url: string): string {
  const path = url.split(/[?#]/)[0];
  let base = path.slice(path.lastIndexOf('/') + 1);
  try {
    base = decodeURIComponent(base);
  } catch {
    /* keep raw */
  }
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base) || url;
}
