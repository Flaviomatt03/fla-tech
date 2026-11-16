import { load, save, idbGet, idbSet } from './storage.js';
import { uid, trackUri, mergeSync, move } from './util.js';

const KEY = 'hp.playlists';
const IGNORED_KEY = 'hp.sync.ignored'; // playlist Spotify eliminate qui: non tornano col sync
const listeners = new Set();
const errorListeners = new Set();

let playlists = [];
let ignored = new Set(load(IGNORED_KEY, []));
let useIdb = true;
let readOnly = false;          // libreria non letta: niente scritture, per non sovrascriverla
const BACKUP_KEY = 'hp.playlists.bak';
const BACKUP_EVERY = 6 * 3600_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function idbGetRetry(key) {
  let err;
  for (const wait of [0, 300, 900]) {
    if (wait) await sleep(wait);
    try { return await idbGet(key); } catch (e) { err = e; }
  }
  throw err;
}

/**
 * Caricamento all'avvio. Le playlist stanno in IndexedDB, con una copia di sicurezza
 * aggiornata ogni qualche ora. Se la lettura fallisce si riprova; se fallisce ancora la
 * libreria resta in sola lettura (niente sync, niente scritture) invece di ripartire vuota e
 * sovrascrivere i dati veri.
 */
export const ready = (async () => {
  try {
    const [saved, backup, savedIgnored] = await Promise.all([
      idbGetRetry(KEY), idbGetRetry(BACKUP_KEY).catch(() => null), idbGetRetry(IGNORED_KEY).catch(() => null),
    ]);
    const legacy = load(KEY, null);
    if (Array.isArray(saved) && saved.length) playlists = saved;
    else if (Array.isArray(legacy) && legacy.length) { playlists = legacy; await idbSet(KEY, playlists); }
    else if (backup?.playlists?.length) { playlists = backup.playlists; await idbSet(KEY, playlists); }
    else if (Array.isArray(saved)) playlists = saved;
    if (legacy) localStorage.removeItem(KEY);
    // Playlist nascoste: unione di quelle salvate in entrambi i posti.
    if (Array.isArray(savedIgnored)) savedIgnored.forEach((id) => ignored.add(id));
    saveIgnored();
    if (playlists.length && (!backup || Date.now() - (backup.at || 0) > BACKUP_EVERY)) {
      idbSet(BACKUP_KEY, { at: Date.now(), playlists }).catch(() => {});
    }
  } catch (e) {
    console.warn('Libreria non leggibile', e);
    const legacy = load(KEY, null);
    if (Array.isArray(legacy)) { useIdb = false; playlists = legacy; }
    else readOnly = true;
  }
})();

export const isReadOnly = () => readOnly;

function saveIgnored() {
  save(IGNORED_KEY, [...ignored]);
  idbSet(IGNORED_KEY, [...ignored]).catch(() => {});
}

// Le scritture vanno in fila, così l'ultima vince sempre.
let writing = Promise.resolve();
let lastBackup = Date.now();
function persist() {
  if (readOnly) return;
  const snapshot = playlists;
  writing = writing.then(async () => {
    if (useIdb) {
      try {
        await idbSet(KEY, snapshot);
        if (snapshot.length && Date.now() - lastBackup > BACKUP_EVERY) {
          lastBackup = Date.now();
          idbSet(BACKUP_KEY, { at: lastBackup, playlists: snapshot }).catch(() => {});
        }
        return;
      } catch (e) { console.warn('Salvataggio IndexedDB fallito', e); }
    }
    try { localStorage.setItem(KEY, JSON.stringify(snapshot)); } catch (e) {
      errorListeners.forEach((fn) => fn(e));
    }
  });
}

function commit() {
  persist();
  listeners.forEach((fn) => fn(playlists));
}

/** Avvisa se un salvataggio non va a buon fine (memoria piena). */
export const onSaveError = (fn) => { errorListeners.add(fn); return () => errorListeners.delete(fn); };
/** Attende che tutte le scritture siano finite. */
export const flushed = () => writing;

const withIds = (tracks) => tracks.map((t) => ({ ...t, id: uid() }));

export const store = {
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  all() { return playlists; },
  get(id) { return playlists.find((p) => p.id === id); },
  bySpotifyId(sid) { return playlists.find((p) => p.spotify?.id === sid); },

  create(name, tracks = [], extra = {}) {
    const p = {
      id: uid(),
      name: name?.trim() || 'Nuova playlist',
      tracks: withIds(tracks),
      createdAt: new Date().toISOString(),
      ...extra,
    };
    playlists = [p, ...playlists];
    commit();
    return p;
  },
  /** Fissa / sblocca una playlist in cima alla libreria. */
  setClone(id, clone) { mutate(id, (p) => { p.clone = clone; }); },
  togglePin(id) { mutate(id, (p) => { p.pinned = !p.pinned; }); },
  rename(id, name) { mutate(id, (p) => { p.name = name.trim() || p.name; p.renamed = true; }); },
  remove(id) {
    const p = store.get(id);
    if (p?.spotify) { ignored.add(p.spotify.id); saveIgnored(); }
    playlists = playlists.filter((x) => x.id !== id);
    commit();
  },
  /** Rimette in libreria una playlist eliminata (annulla). */
  restore(p, index = 0) {
    if (p.spotify) { ignored.delete(p.spotify.id); saveIgnored(); }
    playlists = [...playlists.slice(0, index), p, ...playlists.slice(index)];
    commit();
  },
  addTracks(id, tracks) { mutate(id, (p) => { p.tracks.push(...withIds(tracks)); }); },
  addTrack(id, track) { store.addTracks(id, [track]); },
  /** Sostituisce un brano mantenendo la posizione (es. versione YouTube → file sul telefono). */
  replaceTrack(id, index, track) {
    mutate(id, (p) => {
      const old = p.tracks[index];
      // Il codice d'origine (brano Spotify da cui viene una copia YouTube) resta anche quando il brano diventa file.
      // Copertina e artista: se il nuovo brano (es. un file) non li ha, restano quelli del vecchio.
      if (old) {
        p.tracks[index] = {
          ...track,
          artwork: track.artwork || old.artwork || null,
          artworkLg: track.artworkLg || old.artworkLg || null,
          artist: track.artist || old.artist || '',
          origin: track.origin ?? old.origin,
          // Un file che prende il posto di un brano YouTube si ricorda da quale video viene.
          ...(track.source === 'file' && old.source === 'youtube' ? { ytId: track.ytId || old.sourceId, yt: true } : {}),
          id: uid(),
        };
      }
    });
  },
  /** Sostituisce tutti i brani (usato per aggiornare le copie su YouTube). */
  setTracks(id, tracks) { mutate(id, (p) => { p.tracks = tracks.map((t) => (t.id ? t : { ...t, id: uid() })); }); },
  removeTrack(id, index) {
    mutate(id, (p) => {
      const [t] = p.tracks.splice(index, 1);
      // Un brano sincronizzato tolto a mano non deve tornare al prossimo sync.
      if (t?.synced && p.spotify) p.spotify = { ...p.spotify, removed: [...(p.spotify.removed || []), trackUri(t)] };
    });
  },
  /** Annulla una rimozione: rimette il brano e lo toglie dall'elenco dei "non risincronizzare". */
  unremoveTrack(id, index, track) {
    mutate(id, (p) => {
      p.tracks.splice(index, 0, track);
      if (p.spotify?.removed) p.spotify = { ...p.spotify, removed: p.spotify.removed.filter((u) => u !== trackUri(track)) };
    });
  },
  moveTrack(id, from, to) { mutate(id, (p) => { p.tracks = move(p.tracks, from, to); }); },

  // ---------- Sincronizzazione Spotify ----------

  isIgnored(spotifyId) { return ignored.has(spotifyId); },

  /** Crea o aggiorna la playlist collegata a una playlist Spotify. */
  applySync(remote, tracks) {
    const existing = store.bySpotifyId(remote.id);
    if (!existing) {
      store.create(remote.name, tracks.map((t) => ({ ...t, synced: true })), {
        spotify: { id: remote.id, snapshot: remote.snapshot, removed: [] },
        image: remote.image,
      });
      return;
    }
    mutate(existing.id, (p) => {
      const r = mergeSync(p.tracks, tracks, p.spotify.removed);
      const known = new Map(p.tracks.map((t) => [t.id, t]));
      p.tracks = r.tracks.map((t) => (known.has(t.id) ? t : { ...t, id: uid() }));
      p.spotify = { ...p.spotify, snapshot: remote.snapshot };
      p.image = remote.image;
      if (!p.renamed) p.name = remote.name;
    });
  },

  /**
   * Prima di una risincronizzazione completa: tornano visibili tutte le playlist Spotify e le
   * copie della stessa playlist Spotify si fondono in una (i brani aggiunti a mano restano).
   */
  prepareFullSync() {
    ignored = new Set(); saveIgnored();
    const seen = new Map();
    const out = [];
    for (const p of playlists) {
      const sid = p.spotify?.id;
      const first = sid && seen.get(sid);
      if (!first) { if (sid) seen.set(sid, p); out.push(p); continue; }
      const have = new Set(first.tracks.map((t) => `${t.source}:${t.sourceId}`));
      const extra = p.tracks.filter((t) => !t.synced && !have.has(`${t.source}:${t.sourceId}`));
      if (extra.length) {
        const merged = { ...first, tracks: [...first.tracks, ...extra] };
        out[out.indexOf(first)] = merged; seen.set(sid, merged);
      }
    }
    playlists = out;
    commit();
  },

  exportJSON() {
    return JSON.stringify({ app: 'hybrid-player', version: 2, playlists }, null, 2);
  },
  /**
   * Ripristino da backup: una playlist già presente (stesso id, o stessa playlist Spotify)
   * viene sostituita dalla versione del backup; le altre si aggiungono. Mai doppioni.
   */
  importJSON(text) {
    const data = JSON.parse(text);
    const incoming = Array.isArray(data) ? data : data.playlists;
    if (!Array.isArray(incoming)) throw new Error('File non valido');
    const valid = incoming.filter((p) => p && p.id && Array.isArray(p.tracks));
    const sameAs = (a, b) => a.id === b.id || (a.spotify?.id && a.spotify.id === b.spotify?.id);
    let next = playlists.map((p) => valid.find((q) => sameAs(p, q)) || p);
    const added = valid.filter((q) => !playlists.some((p) => sameAs(p, q)));
    next = [...next, ...added];
    playlists = dedupe(next);
    commit();
    return valid.length;
  },

  /** Toglie le copie "Nome (2)" identiche all'originale (create da vecchi ripristini). */
  removeDuplicates() {
    const before = playlists.length;
    playlists = dedupe(playlists);
    if (playlists.length !== before) commit();
    return before - playlists.length;
  },
};

/** Copie "Nome (2)" con gli stessi brani di "Nome": via. */
function dedupe(list) {
  const key = (p) => p.tracks.map((t) => `${t.source}:${t.sourceId}`).join('|');
  return list.filter((p) => {
    const m = /^(.*) \(2\)$/.exec(p.name || '');
    if (!m) return true;
    return !list.some((o) => o !== p && o.name === m[1] && key(o) === key(p));
  });
}

function mutate(id, fn) {
  const i = playlists.findIndex((p) => p.id === id);
  if (i < 0) return;
  const copy = { ...playlists[i], tracks: [...playlists[i].tracks] };
  fn(copy);
  playlists = playlists.map((p, j) => (j === i ? copy : p));
  commit();
}
