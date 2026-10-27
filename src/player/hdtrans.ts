import { asset } from '../base';
import { translateAss, type CaptionHistory, type TranslationJob } from './assTranslate';

let worker: Worker | null = null;
let ready: Promise<void> | null = null;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (lines: string[]) => void; reject: (e: Error) => void }
>();
/** Keyed by caption and context: the context changes the reading. */
const cache = new Map<string, string>();
const CACHE_LIMIT = 5000;

export function preloadHdTrans(): Promise<void> {
  if (ready) return ready;
  const w = new Worker(new URL('./hdtransWorker.ts', import.meta.url), { type: 'module' });
  worker = w;
  ready = new Promise<void>((resolve, reject) => {
    w.addEventListener('message', (e: MessageEvent) => {
      const m = e.data as { type: string; id?: number; lines?: string[]; message?: string };
      if (m.type === 'ready') {
        resolve();
        return;
      }
      if (m.type === 'fatal') {
        reject(new Error(m.message));
        return;
      }
      const p = pending.get(m.id!);
      pending.delete(m.id!);
      if (m.type === 'result') p?.resolve(m.lines!);
      else p?.reject(new Error(m.message ?? 'hdTrans worker error'));
    });
    w.addEventListener('error', (e) => reject(new Error(e.message)));
  });
  ready.catch((err) => {
    console.error('hdTrans failed to load', err);
    worker?.terminate();
    worker = null;
    ready = null;
  });
  const abs = (path: string) => new URL(asset(path), location.href).href;
  w.postMessage({
    type: 'init',
    engineUrl: abs('hdtrans/hdtrans_engine.js'),
    runtimeUrl: abs('hdtrans/runtime.js'),
    dictUrl: abs('hdtrans/dicts.hdsnap'),
  });
  return ready;
}

const cacheKey = (job: TranslationJob) => `${job.context.join('\n')}\u0000${job.text}`;

async function translateJobs(jobs: TranslationJob[]): Promise<string[]> {
  const missing = jobs.filter((job) => !cache.has(cacheKey(job)));
  if (missing.length) {
    await preloadHdTrans();
    const id = nextId++;
    const result = await new Promise<string[]>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker!.postMessage({ type: 'translate', id, jobs: missing });
    });
    missing.forEach((job, i) => cache.set(cacheKey(job), result[i]));
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  }
  return jobs.map((job) => cache.get(cacheKey(job))!);
}

/** Segments of a track must come in order. On failure the Japanese is shown. */
export async function translateSegment(
  text: string,
  segmentStartSec: number,
  history: CaptionHistory,
): Promise<string> {
  try {
    return await translateAss(text, segmentStartSec, history, translateJobs);
  } catch (err) {
    console.error('hdTrans translation failed', err);
    return text;
  }
}
