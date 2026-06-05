import type { Programme } from './xmltv';
import { getEpgMeta, getProgrammesAround, getProgrammesInRange, removeSourcesNotIn } from './db';

/** Longest programme we expect, so a still-running programme that started before the window is caught. */
const GUIDE_LOOKBACK_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Re-download the EPG only if the cached copy is older than this (ms) or from another source. */
const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Bump when the parsed Programme shape changes (e.g. a new field) to invalidate stale caches. */
const EPG_FORMAT_VERSION = 3;

export interface NowNext {
  now?: Programme;
  next?: Programme;
}

// --- EPG worker client (fetch + parse + IndexedDB write happen off the main thread) ---

let worker: Worker | null = null;
let nextLoadId = 1;
/** One in-flight load per source URL, so different feeds load in parallel but the same feed isn't double-loaded. */
const inFlight = new Map<string, Promise<void>>();
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

/** Post one source's load to the worker, coalescing concurrent requests for the same URL. */
function load(url: string): Promise<void> {
  const existing = inFlight.get(url);
  if (existing) return existing;
  const id = nextLoadId++;
  const w = getWorker();
  const p = new Promise<void>((resolve, reject) => {
    pending.set(id, {
      resolve: () => (inFlight.delete(url), resolve()),
      reject: (e) => (inFlight.delete(url), reject(e)),
    });
    w.postMessage({ type: 'load', id, url, formatVersion: EPG_FORMAT_VERSION });
  });
  inFlight.set(url, p);
  return p;
}

/** Subscribe to "EPG data updated" (a feed finished loading); returns an unsubscribe fn. */
export function onEpgUpdated(listener: () => void): () => void {
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}

/** Load one EPG source if its cache is stale; failures are non-fatal (keep any cached data). */
async function ensureOne(url: string): Promise<void> {
  const meta = await getEpgMeta(url);
  const fresh =
    meta &&
    meta.formatVersion === EPG_FORMAT_VERSION &&
    Date.now() - meta.lastLoaded < REFRESH_AFTER_MS;
  if (fresh) return;
  try {
    await load(url);
  } catch (err) {
    if (meta) console.warn(`EPG refresh failed for ${url}; using cached data.`, err);
    else console.error(`EPG load failed for ${url} and no cache available.`, err);
  }
}

/**
 * Ensure every configured EPG source is loaded into IndexedDB (each independently, off-thread), and drop
 * any stored source no longer in the list. Stale-but-cached sources are skipped; failures are non-fatal.
 */
export async function ensureEpg(urls: string[]): Promise<void> {
  await removeSourcesNotIn(urls);
  await Promise.all(urls.map(ensureOne));
}

/** Force a re-download of every EPG source via the worker (used by the hourly refresh). */
export async function refreshEpg(urls: string[]): Promise<void> {
  await Promise.all(
    urls.map((url) => load(url).catch((err) => console.warn(`EPG refresh failed for ${url}.`, err))),
  );
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
