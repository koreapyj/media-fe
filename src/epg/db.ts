import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Programme } from './xmltv';

interface EpgMeta {
  key: string;
  source: string;
  lastLoaded: number;
}

interface EpgDB extends DBSchema {
  programmes: {
    // Composite key [channel, start] keeps each channel's programmes contiguous and time-ordered.
    key: [string, number];
    value: Programme;
  };
  meta: {
    key: string;
    value: EpgMeta;
  };
}

const DB_NAME = 'tv-epg';
const DB_VERSION = 1;
const META_KEY = 'epg';

let dbPromise: Promise<IDBPDatabase<EpgDB>> | null = null;

function db(): Promise<IDBPDatabase<EpgDB>> {
  if (!dbPromise) {
    dbPromise = openDB<EpgDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        database.createObjectStore('programmes', { keyPath: ['channel', 'start'] });
        database.createObjectStore('meta', { keyPath: 'key' });
      },
    });
  }
  return dbPromise;
}

/** Replace all stored programmes with a fresh set and stamp the metadata. */
export async function replaceProgrammes(programmes: Programme[], source: string): Promise<void> {
  const database = await db();
  const tx = database.transaction(['programmes', 'meta'], 'readwrite');
  const store = tx.objectStore('programmes');
  await store.clear();
  for (const p of programmes) {
    // Guard against duplicate [channel, start] keys within the feed.
    await store.put(p);
  }
  await tx.objectStore('meta').put({ key: META_KEY, source, lastLoaded: Date.now() });
  await tx.done;
}

/** Metadata about the last successful EPG load, if any. */
export async function getEpgMeta(): Promise<EpgMeta | undefined> {
  return (await db()).get('meta', META_KEY);
}

/**
 * Return the programmes for a channel that overlap a window around `at` (epoch ms).
 * Bounded to [at − 1 day, at + 2 days] to keep reads small.
 */
export async function getProgrammesAround(channel: string, at: number): Promise<Programme[]> {
  const DAY = 86_400_000;
  const range = IDBKeyRange.bound([channel, at - DAY], [channel, at + 2 * DAY]);
  return (await db()).getAll('programmes', range);
}
