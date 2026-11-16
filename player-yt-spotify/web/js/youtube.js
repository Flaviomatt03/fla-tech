// YouTube: ricerca con la Data API v3 e riproduzione con il player IFrame ufficiale.
// Solo audio: il player è nascosto sotto l'interfaccia (scelta dell'utente, uso personale).
// iOS ferma comunque l'audio di un iframe quando l'app va in background.
import { settings } from './settings.js';
import { htmlUnescape, isoDurationMs, cleanTitle } from './util.js';

const API = 'https://www.googleapis.com/youtube/v3';

// Si possono mettere più chiavi (separate da virgola o spazio): a quota finita si passa alla
// successiva. Ogni chiave ha 10.000 unità al giorno, azzerate alle 9:00 italiane (mezzanotte
// del Pacifico).
const SPENT_KEY = 'hp.yt.spent';
const quotaDay = () => new Date(Date.now() - 8 * 3600_000).toISOString().slice(0, 10);
export const apiKeys = () => String(settings.youtubeApiKey || '').split(/[\s,;]+/).filter(Boolean);
export function spent() {
  try { const s = JSON.parse(localStorage.getItem(SPENT_KEY) || '{}'); return s.day === quotaDay() ? s : { day: quotaDay(), keys: [] }; } catch { return { day: quotaDay(), keys: [] }; }
}
function markSpent(key) {
  const s = spent();
  if (!s.keys.includes(key)) s.keys.push(key);
  try { localStorage.setItem(SPENT_KEY, JSON.stringify(s)); } catch { /* niente */ }
}

// Stato delle chiavi (motivo dell'ultimo errore), per mostrarlo in Impostazioni.
const STATUS_KEY = 'hp.yt.keystatus';
export function keyStatus() { try { return JSON.parse(localStorage.getItem(STATUS_KEY) || '{}'); } catch { return {}; } }
function setStatus(key, msg) {
  const s = keyStatus();
  if (msg) s[key] = msg; else delete s[key];
  try { localStorage.setItem(STATUS_KEY, JSON.stringify(s)); } catch { /* niente */ }
}

/** Motivo leggibile di un errore della Data API. */
function why(data, status) {
  const e = data?.error || {};
  const reasons = [...(e.errors || []).map((x) => x.reason), ...(e.details || []).map((x) => x.reason), e.status].filter(Boolean).join(' ');
  if (/quotaExceeded|dailyLimitExceeded|RATE_LIMIT_EXCEEDED/i.test(reasons)) return { quota: true, msg: 'esaurita oggi' };
  if (/accessNotConfigured|SERVICE_DISABLED/i.test(reasons) || /has not been used|is disabled/i.test(e.message || '')) return { msg: 'API YouTube non abilitata nel progetto' };
  if (/keyInvalid|API_KEY_INVALID/i.test(reasons) || /API key not valid/i.test(e.message || '')) return { msg: 'chiave non valida (copiata male?)' };
  if (/REFERRER|ipRefererBlocked|API_KEY_SERVICE_BLOCKED|API_KEY_.*BLOCKED|forbidden/i.test(reasons)) return { msg: 'chiave con restrizioni: toglile o aggiungi il sito di Duetto' };
  return { msg: `errore ${status}${e.message ? `: ${e.message}` : ''}` };
}

async function get(path, params) {
  const keys = apiKeys();
  if (!keys.length) throw new Error('Inserisci la chiave API YouTube nelle Impostazioni.');
  const done = spent().keys;
  const order = [...keys.filter((k) => !done.includes(k)), ...keys.filter((k) => done.includes(k))];
  const fails = [];
  for (const key of order) {
    const url = new URL(`${API}/${path}`);
    Object.entries({ ...params, key }).forEach(([k, v]) => url.searchParams.set(k, v));
    let res, data;
    try { res = await fetch(url); data = await res.json().catch(() => ({})); } catch { throw new Error('YouTube: connessione assente.'); }
    if (res.ok) { setStatus(key, null); return data; }
    const w = why(data, res.status);
    if (w.quota) markSpent(key);
    setStatus(key, w.msg);
    fails.push({ key, ...w });
  }
  if (fails.every((f) => f.quota)) {
    throw new Error(keys.length > 1 ? `Quota giornaliera YouTube esaurita su tutte le ${keys.length} chiavi (si azzera alle 9:00 italiane).` : 'Quota giornaliera YouTube esaurita (si azzera alle 9:00 italiane).');
  }
  // Almeno una chiave ha un problema diverso dalla quota: si dice quale.
  const f = fails.find((x) => !x.quota);
  const n = keys.indexOf(f.key) + 1;
  throw new Error(`YouTube, chiave ${n}: ${f.msg}`);
}

/** Prova ogni chiave con una richiesta da 1 unità e aggiorna il suo stato. */
export async function testKeys() {
  const out = [];
  for (const key of apiKeys()) {
    const url = new URL(`${API}/videos`);
    Object.entries({ part: 'id', id: 'dQw4w9WgXcQ', key }).forEach(([k, v]) => url.searchParams.set(k, v));
    try {
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        // La prova da 1 unità passa anche a quota di ricerca quasi finita: lo stato "esaurita" resta quello visto.
        setStatus(key, spent().keys.includes(key) ? 'esaurita oggi' : null);
        out.push(true);
      } else {
        const w = why(data, res.status);
        if (w.quota) markSpent(key);
        setStatus(key, w.msg);
        out.push(false);
      }
    } catch { out.push(false); }
  }
  return out;
}

/** Ogni ricerca costa 100 unità di quota (10.000 al giorno => ~100 ricerche). */
export async function searchVideos(q, { musicOnly = true, pageToken } = {}) {
  const params = { part: 'id', type: 'video', videoEmbeddable: 'true', maxResults: 15, q };
  if (musicOnly) params.videoCategoryId = '10';
  if (pageToken) params.pageToken = pageToken;
  const data = await get('search', params);
  const ids = (data.items || []).map((i) => i.id?.videoId).filter(Boolean);
  return { tracks: await videos(ids), nextPageToken: data.nextPageToken || null };
}

/**
 * Il video YouTube più simile a un brano Spotify (101 unità di quota): stessa durata entro
 * 15 s, preferendo i canali ufficiali ("- Topic", VEVO) e scartando live/cover/karaoke.
 */
export async function findMatch(track) {
  const q = `${track.artist} ${track.title}`.trim();
  const data = await get('search', { part: 'id', type: 'video', maxResults: 6, videoCategoryId: '10', q });
  const ids = (data.items || []).map((i) => i.id?.videoId).filter(Boolean);
  const list = await videos(ids);
  return bestMatch(list, track);
}

/** Quanto un video somiglia al brano: durata, parole del titolo, artista; niente live/cover. */
export function scoreMatch(v, track) {
  const words = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const want = new Set(words(track.title));
  const bad = /\b(live|cover|karaoke|instrumental|8d|slowed|sped up|reverb|nightcore|lyrics? video)\b/i;
  let sc = 0;
  const ref = track.refMs || track.durationMs;
  const d = ref && v.durationMs ? Math.abs(ref - v.durationMs) : 0;
  if (ref && v.durationMs) sc -= d > 15000 ? 50 + d / 1000 : d / 1000;
  const got = words(v.title);
  sc += [...want].filter((w) => got.includes(w)).length * 3;
  if (bad.test(v.title) && !bad.test(track.title)) sc -= 30;
  const a = String(track.artist || '').toLowerCase().split(',')[0].trim();
  if (a && `${v.artist} ${v.title}`.toLowerCase().includes(a)) sc += 5;
  return sc;
}

export function bestMatch(list, track) {
  const best = list.filter((v) => !v.blocked).map((v) => [scoreMatch(v, track), v]).sort((x, y) => y[0] - x[0])[0];
  return best && best[0] > -40 ? best[1] : null;
}

/** Ricerca libera per "Cambia video" (101 unità): i più simili al brano prima, i non scaricabili in fondo. */
export async function searchFor(q, track, max = 10) {
  const data = await get('search', { part: 'id', type: 'video', maxResults: max, q });
  const list = await videos((data.items || []).map((i) => i.id?.videoId).filter(Boolean));
  return list.map((v) => ({ ...v, score: scoreMatch(v, track) }))
    .sort((a, b) => (!!a.blocked - !!b.blocked) || b.score - a.score);
}

function blockedReason(v) {
  const cd = v.contentDetails || {};
  if (cd.contentRating?.ytRating === 'ytAgeRestricted') return 'limitato per età';
  const rr = cd.regionRestriction;
  if (rr && ((rr.blocked || []).includes('IT') || (rr.allowed && !rr.allowed.includes('IT')))) return 'bloccato in Italia';
  return null;
}

/** Candidati per una canzone (101 unità), il migliore per primo; quelli non scaricabili in fondo. */
export async function candidates(track, max = 8) {
  const q = `${track.artist} ${track.title}`.trim();
  const data = await get('search', { part: 'id', type: 'video', maxResults: max, videoCategoryId: '10', q });
  const list = await videos((data.items || []).map((i) => i.id?.videoId).filter(Boolean));
  const best = bestMatch(list, track);
  return [...list].sort((a, b) => (a === best ? -1 : b === best ? 1 : 0) || (!!a.blocked - !!b.blocked));
}

/** Dettagli dei video (1 unità di quota), nello stesso ordine degli id. */
export async function videos(ids) {
  if (!ids.length) return [];
  const data = await get('videos', { part: 'snippet,contentDetails', id: ids.join(','), maxResults: 50 });
  const byId = new Map((data.items || []).map((v) => [v.id, v]));
  return ids.filter((id) => byId.has(id)).map((id) => {
    const v = byId.get(id);
    const th = v.snippet.thumbnails || {};
    return {
      source: 'youtube',
      sourceId: id,
      title: cleanTitle(htmlUnescape(v.snippet.title)),
      artist: htmlUnescape(v.snippet.channelTitle).replace(/ - Topic$/, ''),
      artwork: (th.medium || th.high || th.default)?.url || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      artworkLg: th.maxres?.url || null, // le altre miniature hanno le bande nere
      durationMs: isoDurationMs(v.contentDetails?.duration),
      // yt-dlp senza accesso a YouTube non scarica i video limitati per età o bloccati in Italia.
      ...(blockedReason(v) ? { blocked: blockedReason(v) } : {}),
    };
  });
}

/** Video di una playlist (1 unità di quota ogni 50), con durate. Fino a `max` video. */
export async function playlistVideos(listId, max = 500) {
  const ids = [];
  let pageToken;
  let title = null;
  do {
    const data = await get('playlistItems', {
      part: 'contentDetails', playlistId: listId, maxResults: 50, ...(pageToken ? { pageToken } : {}),
    });
    ids.push(...(data.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean));
    pageToken = data.nextPageToken;
  } while (pageToken && ids.length < max);
  try {
    const info = await get('playlists', { part: 'snippet', id: listId });
    title = info.items?.[0] ? htmlUnescape(info.items[0].snippet.title) : null;
  } catch { /* il titolo è facoltativo */ }
  const tracks = [];
  for (let i = 0; i < ids.length; i += 50) tracks.push(...await videos(ids.slice(i, i + 50)));
  return { title, tracks };
}

// ---------- Player IFrame ----------

const ERRORS = {
  2: 'ID video non valido.',
  5: 'Errore del player HTML5.',
  100: 'Video non trovato o rimosso.',
  101: 'Il proprietario non consente la riproduzione incorporata di questo video.',
  150: 'Il proprietario non consente la riproduzione incorporata di questo video.',
};

export const State = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

export class YouTubePlayer {
  constructor(elementId) {
    this.elementId = elementId;
    this.player = null;
    this.ready = false;
    this.pendingId = null;
    this.state = State.UNSTARTED;
    this.handlers = { state: [], error: [], blocked: [] };
    this.blockTimer = null;
    this.readyPromise = new Promise((resolve) => { this.resolveReady = resolve; });
  }

  on(event, fn) { this.handlers[event].push(fn); }
  emit(event, arg) { this.handlers[event].forEach((fn) => fn(arg)); }

  /** Carica l'API IFrame solo quando serve. */
  init() {
    if (this.initStarted) return this.readyPromise;
    this.initStarted = true;
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      this.player = new window.YT.Player(this.elementId, {
        width: '100%',
        height: '100%',
        playerVars: {
          playsinline: 1, rel: 0, fs: 0, controls: 0, disablekb: 1, iv_load_policy: 3, modestbranding: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: () => {
            this.ready = true;
            this.resolveReady();
            if (this.pendingId) { const id = this.pendingId; this.pendingId = null; this.load(id); }
          },
          onStateChange: (e) => this.onState(e.data),
          onError: (e) => {
            clearTimeout(this.blockTimer);
            this.emit('error', ERRORS[e.data] || `Errore YouTube ${e.data}.`);
          },
        },
      });
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.async = true;
    document.head.appendChild(tag);
    return this.readyPromise;
  }

  onState(s) {
    this.state = s;
    if (s === State.PLAYING || s === State.BUFFERING) {
      clearTimeout(this.blockTimer);
      this.emit('blocked', false);
    }
    this.emit('state', s);
  }

  load(videoId) {
    this.init();
    if (!this.ready) { this.pendingId = videoId; return; }
    this.player.loadVideoById(videoId);
    // iOS può bloccare l'avvio automatico con audio se non c'è stato un tocco dell'utente:
    // in quel caso chiediamo di toccare il video.
    clearTimeout(this.blockTimer);
    this.blockTimer = setTimeout(() => {
      if (this.state !== State.PLAYING && this.state !== State.BUFFERING) this.emit('blocked', true);
    }, 2500);
  }

  play() { this.player?.playVideo?.(); }
  pause() { this.player?.pauseVideo?.(); }
  stop() {
    this.pendingId = null;
    clearTimeout(this.blockTimer);
    this.emit('blocked', false);
    if (this.ready) this.player.stopVideo();
  }
  seek(ms) { this.player?.seekTo?.(ms / 1000, true); }
  currentMs() { return this.ready ? Math.round((this.player.getCurrentTime?.() || 0) * 1000) : 0; }
  durationMs() { return this.ready ? Math.round((this.player.getDuration?.() || 0) * 1000) : 0; }
}
