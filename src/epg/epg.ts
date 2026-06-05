import { parseXMLTV, type Programme } from './xmltv';
import { getEpgMeta, getProgrammesAround, replaceProgrammes } from './db';

/** Re-download the EPG only if the cached copy is older than this (ms) or from another source. */
const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface NowNext {
  now?: Programme;
  next?: Programme;
}

/**
 * Ensure the EPG is loaded into IndexedDB, refreshing from `url` when the cache is stale.
 * Network/parse failures are non-fatal if a usable cache already exists.
 */
export async function ensureEpg(url: string | undefined): Promise<void> {
  if (!url) return;
  const meta = await getEpgMeta();
  const fresh =
    meta && meta.source === url && Date.now() - meta.lastLoaded < REFRESH_AFTER_MS;
  if (fresh) return;

  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`EPG fetch failed (${res.status})`);
    const { programmes } = parseXMLTV(await res.text());
    await replaceProgrammes(programmes, url);
  } catch (err) {
    if (meta) {
      console.warn('EPG refresh failed; using cached data.', err);
    } else {
      console.error('EPG load failed and no cache available.', err);
    }
  }
}

/** Find the current and upcoming programme for a channel id at time `at` (default: now). */
export async function nowNext(tvgId: string | undefined, at = Date.now()): Promise<NowNext> {
  if (!tvgId) return {};
  const list = await getProgrammesAround(tvgId, at);
  list.sort((a, b) => a.start - b.start);

  let now: Programme | undefined;
  let next: Programme | undefined;
  for (const p of list) {
    if (p.start <= at && at < p.stop) now = p;
    else if (p.start > at) {
      next = p;
      break;
    }
  }
  return { now, next };
}
