// localStorage con try/catch (modalità privata, quota piena...).
export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    if (value === undefined || value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('Salvataggio fallito', key, e);
  }
}

// ---------- IndexedDB: per i dati grandi (playlist) ----------
// localStorage su iPhone tiene circa 5 MB: con una libreria Spotify grande si riempie e i
// salvataggi falliscono in silenzio. IndexedDB ha spazio molto più ampio ed è persistente.

const DB_NAME = 'duetto';
const DB_STORE = 'kv';
const AUDIO_STORE = 'audio'; // audio dei brani YouTube scaricati sul telefono
let dbPromise = null;

function db() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB non disponibile'));
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(DB_STORE)) d.createObjectStore(DB_STORE);
      if (!d.objectStoreNames.contains(AUDIO_STORE)) d.createObjectStore(AUDIO_STORE);
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
      resolve(req.result);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
export const audioGet = (id) => tx(AUDIO_STORE, 'readonly', (s) => s.get(id));
export const audioPut = (id, value) => tx(AUDIO_STORE, 'readwrite', (s) => s.put(value, id));
export const audioDelete = (id) => tx(AUDIO_STORE, 'readwrite', (s) => s.delete(id));
export const audioKeys = () => tx(AUDIO_STORE, 'readonly', (s) => s.getAllKeys());

export async function idbGet(key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbSet(key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
