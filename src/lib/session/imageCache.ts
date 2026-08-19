import type { RecognitionDraft } from '../recognition/detectCheckmarks';

/**
 * Caches the rendered images of a review batch so a refresh can restore the
 * originals and the field crops, not just the values.
 *
 * localStorage cannot hold them -- a batch measures ~30MB against a measured
 * 10MB ceiling, and cookies failed at 4KB and would ride along on every
 * request. IndexedDB stored the same 30MB in 4ms with a 9.9GB quota, so that is
 * where the images go while the value snapshot stays in localStorage.
 *
 * These are scanned student responses, including the name and phone number that
 * never reach the spreadsheet, so the cache is deliberately short-lived: every
 * entry carries the time it was written and anything older than the TTL is
 * deleted on the next load. Accounts are planned, and until they exist the TTL
 * is what bounds exposure on a shared computer.
 */
const DB_NAME = 'kpga-review-images';
const DB_VERSION = 1;
const STORE = 'draftImages';

/** Four hours: long enough to finish a class, short enough to bound exposure. */
export const IMAGE_CACHE_TTL_MS = 4 * 60 * 60 * 1000;

export interface CachedDraftImages {
  cagiImageDataUrl?: string;
  satisfactionImageDataUrl?: string;
  cropDataUrls?: Record<string, string>;
  cropDebugDataUrls?: Record<string, string>;
}

interface CacheEntry {
  jobId: string;
  index: number;
  savedAt: number;
  images: CachedDraftImages;
}

const IMAGE_KEYS = [
  'cagiImageDataUrl',
  'satisfactionImageDataUrl',
  'cropDataUrls',
  'cropDebugDataUrls',
] as const;

function isAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase | null> {
  if (!isAvailable()) return Promise.resolve(null);

  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

const entryKey = (jobId: string, index: number) => `${jobId}::${index}`;

/** Pulls only the rendered images out of a draft; values stay in localStorage. */
export function extractDraftImages(draft: RecognitionDraft): CachedDraftImages {
  const source = (draft.source || {}) as Record<string, unknown>;
  const images: CachedDraftImages = {};
  for (const key of IMAGE_KEYS) {
    if (source[key] !== undefined) {
      (images as Record<string, unknown>)[key] = source[key];
    }
  }
  return images;
}

export function mergeDraftImages(draft: RecognitionDraft, images?: CachedDraftImages): RecognitionDraft {
  if (!images) return draft;
  return {
    ...draft,
    source: { ...(draft.source || {}), ...images },
  } as RecognitionDraft;
}

export async function saveDraftImages(jobId: string, drafts: RecognitionDraft[]): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;

  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const savedAt = Date.now();
      drafts.forEach((draft, index) => {
        const images = extractDraftImages(draft);
        if (Object.keys(images).length === 0) return;
        const entry: CacheEntry & { key: string } = {
          key: entryKey(jobId, index),
          jobId,
          index,
          savedAt,
          images,
        };
        store.put(entry);
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return true;
  } catch {
    // A full quota must never break the review screen; values still persist.
    return false;
  } finally {
    db.close();
  }
}

/**
 * Returns the cached images for a job, dropping and deleting anything past the
 * TTL. Entries belonging to other jobs are purged at the same time so an
 * abandoned batch cannot sit on disk indefinitely.
 */
export async function loadDraftImages(jobId: string): Promise<Map<number, CachedDraftImages>> {
  const result = new Map<number, CachedDraftImages>();
  const db = await openDb();
  if (!db) return result;

  try {
    const entries = await new Promise<Array<CacheEntry & { key: string }>>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });

    const now = Date.now();
    const expiredKeys: string[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry.savedAt !== 'number' || now - entry.savedAt > IMAGE_CACHE_TTL_MS) {
        if (entry?.key) expiredKeys.push(entry.key);
        continue;
      }
      if (entry.jobId === jobId) {
        result.set(entry.index, entry.images);
      }
    }

    if (expiredKeys.length > 0) {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        expiredKeys.forEach((key) => store.delete(key));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    }
  } catch {
    // fall through with whatever was read
  } finally {
    db.close();
  }

  return result;
}

/** Removes one job's images, or the whole cache when no job is given. */
export async function clearDraftImages(jobId?: string): Promise<void> {
  const db = await openDb();
  if (!db) return;

  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      if (!jobId) {
        store.clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        return;
      }
      const request = store.getAll();
      request.onsuccess = () => {
        (request.result || []).forEach((entry: CacheEntry & { key: string }) => {
          if (entry?.jobId === jobId) store.delete(entry.key);
        });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore
  } finally {
    db.close();
  }
}
