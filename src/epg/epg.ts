import type { Programme } from './xmltv';
import { getEpgMeta, getProgrammesAround, getProgrammesInRange } from './db';

/** Longest programme we expect, so a still-running programme that started before the window is caught. */
const GUIDE_LOOKBACK_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Re-download the EPG only if the cached copy is older than this (ms) or from another source. */
const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Bump when the parsed Programme shape changes (e.g. a new field) to invalidate stale caches. */
const EPG_FORMAT_VERSION = 2;

export interface NowNext {
  now?: Programme;
  next?: Programme;
}

// --- EPG worker client (fetch + parse + IndexedDB write happen off the main thread) ---

let worker: Worker | null = null;
let nextLoadId = 1;
let inFlight: Promise<void> | null = null;
const pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
const updateListeners = new Set<() => void>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./epgWorker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as { type: string; id: number; message?: string };
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.type === 'done') {
      p?.resolve();
      for (const cb of updateListeners) cb();
    } else if (m.type === 'error') {
      const err = new Error(m.message ?? 'EPG worker error');
      if (p) p.reject(err);
      else console.error('EPG worker error', err);
    }
  });
  worker.addEventListener('error', (e) => console.error('EPG worker crashed', e.message));
  return worker;
}

/** Post one load to the worker, coalescing concurrent requests onto a single in-flight load. */
function load(url: string): Promise<void> {
  if (inFlight) return inFlight;
  const id = nextLoadId++;
  const w = getWorker();
  inFlight = new Promise<void>((resolve, reject) => {
    pending.set(id, {
      resolve: () => ((inFlight = null), resolve()),
      reject: (e) => ((inFlight = null), reject(e)),
    });
    w.postMessage({ type: 'load', id, url, formatVersion: EPG_FORMAT_VERSION });
  });
  return inFlight;
}

/** Subscribe to "EPG data updated" (a load finished); returns an unsubscribe fn. */
export function onEpgUpdated(listener: () => void): () => void {
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}

/**
 * Ensure the EPG is loaded into IndexedDB, refreshing from `url` (via the worker) when the cache is
 * stale. Network/parse failures are non-fatal if a usable cache already exists.
 */
export async function ensureEpg(url: string | undefined): Promise<void> {
  if (!url) return;
  const meta = await getEpgMeta();
  const fresh =
    meta &&
    meta.source === url &&
    meta.formatVersion === EPG_FORMAT_VERSION &&
    Date.now() - meta.lastLoaded < REFRESH_AFTER_MS;
  if (fresh) return;
  try {
    await load(url);
  } catch (err) {
    if (meta) console.warn('EPG refresh failed; using cached data.', err);
    else console.error('EPG load failed and no cache available.', err);
  }
}

/** Force an EPG re-download via the worker (used by the hourly refresh). */
export async function refreshEpg(url: string | undefined): Promise<void> {
  if (!url) return;
  try {
    await load(url);
  } catch (err) {
    console.warn('EPG refresh failed.', err);
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

/** Programmes for a channel that overlap [from, to] (epoch ms), start-ordered — for the guide grid. */
export async function programmesInRange(
  tvgId: string | undefined,
  from: number,
  to: number,
): Promise<Programme[]> {
  if (!tvgId) return [];
  const list = await getProgrammesInRange(tvgId, from - GUIDE_LOOKBACK_MS, to);
  return list.filter((p) => p.stop > from && p.start < to).sort((a, b) => a.start - b.start);
}
