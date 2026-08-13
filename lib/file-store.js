'use client';

/**
 * lib/file-store.js
 * ---------------------------------------------------------------------------
 * Browser-side storage for attachment binaries, on IndexedDB.
 *
 * ## Why not localStorage
 *
 * Everything else in this app persists to localStorage, which is capped at
 * roughly 5 MB across the whole origin and stores strings only — so a base64
 * PDF would blow the budget shared with leads and templates and take them down
 * with it. Attachments were therefore kept in memory and vanished on every
 * refresh, which is a poor answer for a file you just spent a minute uploading.
 *
 * IndexedDB has no practical size cap (browsers grant a large share of free
 * disk), stores Blobs natively rather than base64, and is on its own quota. So
 * files live here and survive a reload; the metadata list still rides along in
 * React state.
 *
 * Everything degrades to a no-op when IndexedDB is unavailable — private
 * windows, hardened profiles, SSR. The app then behaves exactly as it did
 * before: files work for the session and are gone on refresh.
 */

const DB_NAME = 'coldmail-files';
const DB_VERSION = 1;
const STORE = 'attachments';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the file store.'));
    // Fires when another tab holds an older version open. Nothing useful to do
    // beyond failing softly — the caller falls back to memory-only.
    request.onblocked = () => reject(new Error('The file store is locked by another tab.'));
  });
}

function runTransaction(mode, work) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let result;

        try {
          result = work(store);
        } catch (error) {
          tx.abort();
          db.close();
          reject(error);
          return;
        }

        tx.oncomplete = () => {
          db.close();
          // A request's `.result` is only populated once the transaction
          // completes, so it is read here rather than inside `work`.
          resolve(result && typeof result.result !== 'undefined' ? result.result : result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error || new Error('File store transaction failed.'));
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error || new Error('File store transaction aborted.'));
        };
      }),
  );
}

/**
 * Saves one file.
 *
 * @param {{id: string, filename: string, contentType: string, size: number, blob: Blob}} record
 * @returns {Promise<boolean>} false when storage is unavailable or full
 */
export async function putFile(record) {
  try {
    await runTransaction('readwrite', (store) => store.put(record));
    return true;
  } catch (error) {
    // QuotaExceededError is the interesting one, but the response is the same
    // either way: keep the file in memory for this session and carry on.
    console.warn('[file-store] Could not persist file:', error?.name || error);
    return false;
  }
}

/** Every stored file, oldest first. Returns `[]` when unavailable. */
export async function listFiles() {
  try {
    const records = await runTransaction('readonly', (store) => store.getAll());
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}

export async function deleteFile(id) {
  try {
    await runTransaction('readwrite', (store) => store.delete(id));
    return true;
  } catch {
    return false;
  }
}

export async function clearFiles() {
  try {
    await runTransaction('readwrite', (store) => store.clear());
    return true;
  } catch {
    return false;
  }
}

/**
 * Base64 for a Blob, without the `data:` prefix — the shape `sendMail` wants.
 *
 * Read on demand rather than held alongside the Blob: base64 is a third larger
 * than the bytes it encodes, and keeping both doubles the memory cost of a
 * library that is now allowed to reach tens of megabytes.
 */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(blob);
  });
}

/** Rough number of bytes IndexedDB will still accept, when the browser says. */
export async function estimateRemainingBytes() {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    return Math.max(0, quota - usage);
  } catch {
    return null;
  }
}
