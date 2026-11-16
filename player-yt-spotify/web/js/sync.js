// Sincronizzazione delle playlist Spotify nella libreria (a senso unico, da Spotify a qui).
// Ogni playlist Spotify tua o collaborativa diventa una playlist della libreria; ci si possono
// aggiungere brani YouTube, che restano anche dopo i sync successivi.
// `snapshot_id` evita di riscaricare le playlist che non sono cambiate.
import * as spotify from './spotify.js';
import { store, isReadOnly } from './store.js';
import { load, save } from './storage.js';

const LAST_KEY = 'hp.sync.last';
const MIN_GAP_MS = 5 * 60_000;

let running = null;
const listeners = new Set();
export const onSyncChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const isSyncing = () => !!running;

/** Sincronizza se loggato. `force` ignora l'intervallo minimo. */
export function syncSpotify({ force = false, full = false } = {}) {
  // Senza libreria letta non si sincronizza: si ricreerebbero le playlist da zero.
  if (!spotify.isLoggedIn() || isReadOnly()) return Promise.resolve(null);
  if (running) return running;
  if (!force && Date.now() - load(LAST_KEY, 0) < MIN_GAP_MS) return Promise.resolve(null);
  if (full) store.prepareFullSync();
  running = run(full).finally(() => { running = null; listeners.forEach((fn) => fn(false)); });
  listeners.forEach((fn) => fn(true));
  return running;
}

async function run(full) {
  const me = await spotify.me();
  const lists = await spotify.myPlaylists();
  let changed = 0;
  // Dalla più vecchia alla più recente: le nuove finiscono in cima alla libreria.
  for (const remote of lists.slice().reverse()) {
    // In Development Mode si leggono solo le playlist tue o collaborative.
    if (remote.ownerId !== me.id && !remote.collaborative) continue;
    if (store.isIgnored(remote.id)) continue;
    const local = store.bySpotifyId(remote.id);
    if (!full && local && local.spotify.snapshot === remote.snapshot) continue;
    try {
      const tracks = await spotify.playlistTracks(remote.id);
      store.applySync(remote, tracks);
      changed++;
    } catch (e) {
      if (e.status === 401) throw e;
      console.warn('Sync playlist', remote.name, e);
    }
  }
  save(LAST_KEY, Date.now());
  return changed;
}
