/**
 * EPG worker: fetch the (large) XMLTV feed, parse it, and write programmes to IndexedDB — all off the
 * main thread. The worker owns the DB write so the parsed array never crosses the thread boundary; the
 * main thread re-reads via the normal db helpers after a `done` message.
 */
import { parseXMLTV } from './xmltv';
import { upsertProgrammesForSource } from './db';

interface LoadMessage {
  type: 'load';
  id: number;
  url: string;
  formatVersion: number;
}

// Typed minimally to avoid pulling in the conflicting "webworker" lib alongside "dom".
const ctx = globalThis as unknown as {
  postMessage(msg: unknown): void;
  addEventListener(type: 'message', cb: (e: MessageEvent<LoadMessage>) => void): void;
};

ctx.addEventListener('message', async (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'load') return;
  try {
    const res = await fetch(msg.url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`EPG fetch failed (${res.status})`);
    const { programmes } = parseXMLTV(await res.text());
    await upsertProgrammesForSource(msg.url, programmes, msg.formatVersion);
    ctx.postMessage({ type: 'done', id: msg.id, count: programmes.length });
  } catch (err) {
    ctx.postMessage({ type: 'error', id: msg.id, message: (err as Error).message });
  }
});
