// YouTube senza pubblicità: l'audio arriva da un server Piped (proxy open source di YouTube)
// e suona in un normale elemento <audio>. Vantaggi: niente spot, comandi sulla schermata di
// blocco, si può continuare in background. Se nessun server risponde si passa al player
// ufficiale (nascosto), che però può mostrare pubblicità.
// Stessa interfaccia di YouTubePlayer, così il coordinatore della coda non cambia.
import { settings } from './settings.js';
import { load, save, audioGet, audioPut, audioDelete, audioKeys } from './storage.js';
import { logEvent } from './spotify.js';
import { pickStream, uid } from './util.js';

export const DEFAULT_SERVERS = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.reallyaweso.me',
];
const GOOD_KEY = 'hp.audio.good';
/** Un secondo di silenzio (WAV): in loop tiene viva la sessione audio a schermo bloccato. */
function silentWav() {
  const sr = 8000; const n = sr;
  const b = new ArrayBuffer(44 + n); const v = new DataView(b);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, 'data'); v.setUint32(40, n, true); new Uint8Array(b, 44).fill(128);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
let SILENT = null;
const silentUrl = () => (SILENT ??= silentWav());
const cache = new Map(); // id -> { url, at }

const bad = new Map(); // server -> fino a quando evitarlo
function servers() {
  const custom = (settings.audioServer || '').trim().replace(/\/+$/, '');
  const all = [...new Set([custom, load(GOOD_KEY, ''), ...DEFAULT_SERVERS].filter(Boolean))];
  const ok = all.filter((b) => !(bad.get(b) > Date.now()));
  return ok.length ? ok : all;
}
const cachedUrl = (id) => { const h = cache.get(id); return h && Date.now() - h.at < 30 * 60_000 ? h.url : null; };

const pending = new Map(); // id -> Promise in corso (stesso video chiesto due volte)

/**
 * URL dell'audio per un video, o null se nessun server lo fornisce.
 * I server si interrogano quasi in parallelo (l'ultimo che ha funzionato parte subito, gli
 * altri a scaglioni) e vince il primo che risponde: un server lento non blocca più tutto.
 */
export function resolveStream(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 30 * 60_000) return Promise.resolve(hit.url);
  if (pending.has(id)) return pending.get(id);
  const p = race(id).finally(() => pending.delete(id));
  pending.set(id, p);
  return p;
}

async function race(id) {
  let done = false;
  const attempt = (base, delay) => new Promise((resolve, reject) => {
    setTimeout(async () => {
      if (done) { reject(new Error('già trovato')); return; } // un altro server ha già risposto
      try {
        const res = await fetch(`${base}/streams/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(String(res.status));
        const url = pickStream(await res.json());
        if (!url) throw new Error('nessun audio');
        resolve({ url, base });
      } catch (e) { reject(e); }
    }, delay);
  });
  try {
    const { url, base } = await Promise.any(servers().map((b, i) => attempt(b, i === 0 ? 0 : 600 + (i - 1) * 300)));
    done = true;
    save(GOOD_KEY, base);
    cache.set(id, { url, at: Date.now(), base });
    return url;
  } catch {
    done = true;
    return null;
  }
}

// ---------- Brani scaricati sul telefono ----------
// L'audio dei brani YouTube viene salvato in IndexedDB: al cambio brano parte dalla memoria
// del telefono, all'istante e senza rete (fondamentale a schermo spento, quando iOS non
// aspetta), e funziona anche se in quel momento il server non risponde.

const INDEX_KEY = 'hp.audio.index'; // [{ id, size, at }] dal meno al più recente
const MAX_BYTES = 700 * 1024 * 1024;
const localUrls = new Map();        // id -> URL locale pronto da suonare
const downloading = new Map();
let playingId = null;

function remember(id, blob) {
  if (localUrls.has(id)) return localUrls.get(id);
  const url = URL.createObjectURL(blob);
  localUrls.set(id, url);
  for (const [old, u] of localUrls) {
    if (localUrls.size <= 6) break;
    if (old === playingId || old === id) continue;
    URL.revokeObjectURL(u);
    localUrls.delete(old);
  }
  return url;
}

function touch(id, size) {
  const idx = load(INDEX_KEY, []).filter((e) => e.id !== id);
  const prev = load(INDEX_KEY, []).find((e) => e.id === id);
  idx.push({ id, size: size ?? prev?.size ?? 0, at: Date.now() });
  // Oltre il limite si tolgono i brani ascoltati meno di recente.
  let total = idx.reduce((a, e) => a + e.size, 0);
  while (total > MAX_BYTES && idx.length > 2) {
    const victim = idx.findIndex((e) => e.id !== id && e.id !== playingId);
    if (victim < 0) break;
    const [gone] = idx.splice(victim, 1);
    total -= gone.size;
    audioDelete(gone.id).catch(() => {});
    if (localUrls.has(gone.id)) { URL.revokeObjectURL(localUrls.get(gone.id)); localUrls.delete(gone.id); }
  }
  save(INDEX_KEY, idx);
}

const isDownloaded = (id) => load(INDEX_KEY, []).some((e) => e.id === id);


/** URL locale del brano se è già sul telefono (legge IndexedDB), altrimenti null. */
async function localUrl(id) {
  if (localUrls.has(id)) return localUrls.get(id);
  if (isFile(id)) {
    try { const rec = await audioGet(id); return rec?.blob ? remember(id, rec.blob) : null; } catch { return null; }
  }
  if (!isDownloaded(id)) return null;
  try {
    const rec = await audioGet(id);
    if (rec?.blob) { touch(id, rec.size); return remember(id, rec.blob); }
  } catch { /* memoria non leggibile: si usa la rete */ }
  return null;
}

/** Scarica l'audio di un brano sul telefono (se non c'è già) e lo tiene pronto. */
const isFile = (id) => String(id).startsWith('file:');
const label = (id) => (isFile(id) ? `File ${String(id).slice(5, 13)}` : `YouTube ${id}`);
const failedAt = new Map(); // id -> ultimo download fallito (niente tentativi a raffica)

export function download(id) {
  // Solo locale: si tiene pronto ciò che è già sul telefono (file importati e vecchi download).
  return localUrl(id).then(Boolean);
}

/** Vecchio scaricamento dai server Piped: non più usato (YouTube li blocca come "bot"). */
export function downloadFromServer(id) {
  if (downloading.has(id)) return downloading.get(id);
  if (Date.now() - (failedAt.get(id) || 0) < 120_000) return Promise.resolve(false);
  const p = (async () => {
    if (await localUrl(id)) return true;
    const url = await resolveStream(id);
    if (!url) return false;
    try {
      const t0 = Date.now();
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (blob.size < 32_000) throw new Error('file incompleto'); // nessun brano vero è così piccolo
      await audioPut(id, { blob, size: blob.size, at: Date.now() });
      touch(id, blob.size);
      remember(id, blob);
      logEvent(`YouTube ${id}: scaricato sul telefono (${(blob.size / 1048576).toFixed(1)} MB, ${Math.round((Date.now() - t0) / 1000)} s)`);
      return true;
    } catch (e) {
      logEvent(`YouTube ${id}: download non riuscito (${e.message})`);
      failedAt.set(id, Date.now());
      return false;
    }
  })().finally(() => downloading.delete(id));
  downloading.set(id, p);
  return p;
}

// ---------- File audio importati dall'utente ----------

/** Durata di un file audio (ms), leggendo solo i metadati. */
function durationOf(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    const done = (ms) => { URL.revokeObjectURL(url); resolve(ms); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : null);
    a.onerror = () => done(null);
    setTimeout(() => done(null), 6000);
    a.src = url;
  });
}

/**
 * Salva un file audio scelto dall'utente (app File, iCloud…) nella memoria di Duetto.
 * Restituisce { id, durationMs } o null se il file non è un audio leggibile.
 */
/** Controlla che un file sia un audio leggibile e ne legge la durata. */
export async function probeFile(file) {
  const durationMs = await durationOf(file);
  return durationMs == null ? null : { durationMs };
}

export async function saveFile(file, id = uid()) {
  const durationMs = await durationOf(file);
  if (durationMs == null) return null;
  // Copia vera dei byte: su iPhone un File scelto dall'app File, salvato così com'è, può
  // restare un riferimento al file temporaneo che iOS cancella dopo ("WebKitBlobResource
  // error"). Con la copia il brano resta in Duetto per sempre.
  const blob = new Blob([await file.arrayBuffer()], { type: file.type || 'audio/mp4' });
  await audioPut(`file:${id}`, { blob, size: blob.size, name: file.name, at: Date.now() });
  // Verifica: si rilegge e si controlla che sia tutto lì.
  const back = await audioGet(`file:${id}`);
  if (!back?.blob || back.blob.size !== blob.size) {
    await audioDelete(`file:${id}`).catch(() => {});
    logEvent(`${label('file:' + id)}: salvataggio non verificato`);
    return null;
  }
  fileSet?.add(id);
  logEvent(`${label('file:' + id)}: importato (${(blob.size / 1048576).toFixed(1)} MB)`);
  return { id, durationMs, size: blob.size };
}

/** Elimina dal telefono un file importato. */
export const deleteFile = (id) => { fileSet?.delete(id); return audioDelete(`file:${id}`).catch(() => {}); };

// Elenco dei file presenti (letto all'avvio): serve a segnalare un file mancante invece di
// fallire in silenzio. Finché non è letto si considera tutto presente.
let fileSet = null;
export async function loadFileIndex() {
  try {
    const keys = await audioKeys();
    fileSet = new Set(keys.filter((k) => String(k).startsWith('file:')).map((k) => String(k).slice(5)));
  } catch { fileSet = null; }
  return fileSet;
}
export const fileExists = (id) => !fileSet || fileSet.has(id);

/**
 * Elimina i file che nessuna playlist usa più. Prudente: solo file importati da più di un
 * giorno (così "Annulla" e i ripensamenti non perdono nulla) e solo con l'elenco dei brani
 * in uso calcolato da una libreria letta correttamente.
 */
export async function gcFiles(referenced) {
  if (!fileSet || !referenced) return 0;
  let n = 0;
  for (const id of [...fileSet]) {
    if (referenced.has(id)) continue;
    const rec = await audioGet(`file:${id}`).catch(() => null);
    if (rec && Date.now() - (rec.at || 0) < 24 * 3600_000) continue;
    await deleteFile(id);
    n++;
  }
  if (n) logEvent(`file non più usati eliminati: ${n}`);
  return n;
}

/** Elimina tutti i brani scaricati (tranne quello che sta suonando). */
export async function clearDownloads() {
  const keep = load(INDEX_KEY, []).filter((e) => e.id === playingId);
  for (const e of load(INDEX_KEY, [])) {
    if (e.id === playingId) continue;
    await audioDelete(e.id).catch(() => {});
    if (localUrls.has(e.id)) { URL.revokeObjectURL(localUrls.get(e.id)); localUrls.delete(e.id); }
  }
  save(INDEX_KEY, keep);
}

/** È già sul telefono? (file importato o vecchio scaricamento) */
export const hasLocal = (id) => isFile(id) || isDownloaded(id);

/** Prepara in anticipo un brano (es. il prossimo della coda): lo tiene pronto dalla memoria. */
export const prefetch = (id) => { download(id).catch(() => {}); };

export class YouTubeAudio {
  constructor(audio, fallback) {
    this.a = audio;
    this.fb = fallback;
    this.mode = 'audio';
    this.id = null;
    this.seq = 0;
    this.silent = false;      // sta suonando il silenzio che tiene viva la sessione
    this.retried = null;      // video già riprovato con un altro server
    this.nearEnd = false;
    this.handlers = { state: [], error: [], blocked: [], nearend: [], missing: [] };

    const a = audio;
    a.addEventListener('playing', () => this.audioState(1));
    a.addEventListener('pause', () => {
      if (document.hidden && !this.silent && this.id && !a.ended) logEvent(`${label(this.id)}: iOS ha messo in pausa l'audio a schermo spento`);
      if (!a.ended) this.audioState(2);
    });
    a.addEventListener('stalled', () => { if (this.id && !this.silent) logEvent(`${label(this.id)}: rete lenta (stalled)`); });
    a.addEventListener('waiting', () => this.audioState(3));
    // Fine brano: si passa al successivo subito, nello stesso evento (a schermo bloccato non c'è
    // tempo per aspettare: iOS sospende l'app appena l'audio si ferma).
    a.addEventListener('ended', () => {
      if (this.id && !this.silent) logEvent(`${label(this.id)}: finito${document.hidden ? ' (schermo spento)' : ''}`);
      this.audioState(0);
    });
    a.addEventListener('timeupdate', () => {
      if (this.silent || this.nearEnd || !Number.isFinite(a.duration)) return;
      if (a.duration - a.currentTime < 30) { this.nearEnd = true; this.emit('nearend'); }
    });
    a.addEventListener('error', () => {
      if (this.mode !== 'audio' || !this.id || this.silent) return;
      const id = this.id;
      logEvent(`${label(id)}: errore audio ${a.error?.code || '?'}`);
      if (isFile(id)) { this.emit('error', 'Questo file audio non si riesce a suonare.'); return; }
      // Un file locale rovinato si butta e si torna alla rete.
      if (a.src.startsWith('blob:') && localUrls.get(id) === a.src) {
        localUrls.delete(id);
        save(INDEX_KEY, load(INDEX_KEY, []).filter((e) => e.id !== id));
        audioDelete(id).catch(() => {});
        this.load(id);
        return;
      }
      const hit = cache.get(id);
      cache.delete(id);
      // Un server che dà un audio non valido viene evitato per 10 minuti e si riprova con un
      // altro: il lettore ufficiale di riserva non suona a schermo bloccato.
      if (hit?.base) bad.set(hit.base, Date.now() + 10 * 60_000);
      if (this.retried !== id) { this.retried = id; this.load(id); return; }
      this.toIframe(id);
    });

    fallback.on('state', (st) => { if (this.mode === 'iframe') this.emit('state', st); });
    fallback.on('error', (m) => { if (this.mode === 'iframe') this.emit('error', m); });
    fallback.on('blocked', (b) => { if (this.mode === 'iframe') this.emit('blocked', b); });

    // iOS lascia avviare l'audio da codice solo dopo un primo tocco: lo "sblocchiamo" subito.
    const unlock = () => {
      if (!a.getAttribute('src')) {
        // Muto: un audio vero, anche silenzioso, interromperebbe Spotify che sta suonando.
        this.silent = true;
        a.muted = true;
        a.src = silentUrl();
        a.play().then(() => { if (this.silent) a.pause(); }).catch(() => {}).finally(() => { a.muted = false; });
      }
      document.removeEventListener('touchend', unlock, true);
      document.removeEventListener('click', unlock, true);
    };
    document.addEventListener('touchend', unlock, true);
    document.addEventListener('click', unlock, true);
  }

  on(event, fn) { this.handlers[event].push(fn); }
  emit(event, arg) { this.handlers[event].forEach((fn) => fn(arg)); }
  audioState(st) {
    if (this.mode !== 'audio' || !this.id || this.silent) return;
    if (st === 1) this.emit('blocked', false);
    this.emit('state', st);
  }
  get usesIframe() { return this.mode === 'iframe'; }

  init() { return this.fb.init(); }

  /** Silenzio in loop: tiene l'app viva a schermo bloccato mentre si aspetta la rete o Spotify. */
  holdSession(maxMs = 20000) {
    logEvent('audio: silenzio per tenere viva l\'app a schermo spento');
    this.silent = true;
    this.a.loop = true;
    this.a.src = silentUrl();
    this.a.play().catch(() => {});
    const seq = this.seq;
    clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => { if (this.silent && this.seq === seq) this.releaseSession(); }, maxMs);
  }

  releaseSession() {
    clearTimeout(this.holdTimer);
    if (!this.silent) return;
    this.silent = false;
    this.a.loop = false;
    this.a.pause();
  }

  load(id) {
    const seq = ++this.seq;
    if (this.id !== id) this.retried = null;
    this.id = id;
    this.mode = 'audio';
    this.nearEnd = false;
    this.fb.stop();
    playingId = id;
    // 1) Già sul telefono: parte all'istante, nello stesso evento (anche a schermo spento).
    const local = localUrls.get(id);
    if (local) { this.playUrl(local, seq, 'telefono'); return; }
    // 2) Riproduzione SOLO da locale (scelta dell'utente: niente server né lettore ufficiale,
    //    quindi niente blocchi). Si legge dalla memoria del telefono; se il brano YouTube non
    //    è ancora stato scaricato si avvisa ('missing') e si passa al successivo.
    if (document.hidden) this.holdSession(); else this.a.pause();
    localUrl(id).then((u) => {
      if (seq !== this.seq) return;
      if (u) { this.playUrl(u, seq, 'telefono'); return; }
      this.releaseSession();
      logEvent(`${label(id)}: ${isFile(id) ? 'file non trovato sul telefono' : 'non ancora scaricato, salto al prossimo'}`);
      if (!isFile(id)) this.emit('missing', id);
      this.emit('error', isFile(id) ? 'File non trovato sul telefono.' : 'non è ancora scaricato.');
    });
  }

  playUrl(url, seq, from = 'rete') {
    logEvent(`${label(this.id)}: suona ${from === 'telefono' ? 'dal telefono' : 'dalla rete'}${document.hidden ? ' (schermo spento)' : ''}`);
    clearTimeout(this.holdTimer);
    this.silent = false;
    this.a.loop = false;
    this.a.src = url;
    this.a.play().catch((e) => {
      if (seq !== this.seq) return;
      if (e.name === 'NotAllowedError') {
        // Serve un tocco: il play pulsa e il tocco successivo avvia l'audio.
        this.emit('state', 2);
        this.emit('blocked', true);
      }
    });
  }

  toIframe(id) {
    logEvent(`YouTube ${id}: nessun server audio, uso il lettore ufficiale (a schermo spento non suona)`);
    this.mode = 'iframe';
    this.a.pause();
    this.a.removeAttribute('src');
    this.fb.load(id);
  }

  play() {
    if (this.mode === 'iframe') return this.fb.play();
    this.a.play().catch(() => {});
  }
  pause() { if (this.mode === 'iframe') this.fb.pause(); else this.a.pause(); }

  /**
   * Fine dei brani YouTube (es. si passa a Spotify). A schermo bloccato si tiene viva l'app
   * ancora qualche secondo col silenzio, il tempo di mandare il comando a Spotify: quando
   * Spotify parte, iOS gli passa l'audio e il silenzio si ferma da solo.
   */
  stop() {
    this.seq++;
    this.id = null;
    this.fb.stop();
    this.emit('blocked', false);
    if (document.hidden && this.mode === 'audio') this.holdSession(15000);
    else { this.releaseSession(); this.a.pause(); }
  }
  seek(ms) {
    if (this.mode === 'iframe') this.fb.seek(ms);
    else if (Number.isFinite(this.a.duration)) this.a.currentTime = ms / 1000;
  }
  currentMs() { return this.mode === 'iframe' ? this.fb.currentMs() : Math.round((this.a.currentTime || 0) * 1000); }
  durationMs() {
    if (this.mode === 'iframe' || this.silent) return this.mode === 'iframe' ? this.fb.durationMs() : 0;
    return Number.isFinite(this.a.duration) ? Math.round(this.a.duration * 1000) : 0;
  }
}
