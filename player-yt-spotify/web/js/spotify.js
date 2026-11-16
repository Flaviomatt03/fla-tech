// Spotify: login OAuth (Authorization Code + PKCE, senza client secret), Web API e controllo
// della riproduzione via Spotify Connect (l'audio lo suona l'app Spotify; serve Premium).
import { settings, updateSettings, redirectUri } from './settings.js';
import { load, save } from './storage.js';
import { uid } from './util.js';

const TOKEN_KEY = 'hp.spotify.token';
const PKCE_KEY = 'hp.spotify.pkce';
const API = 'https://api.spotify.com/v1';
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

export class SpotifyError extends Error {
  constructor(message, { status, reason } = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

let token = load(TOKEN_KEY, null);
let refreshing = null;
const listeners = new Set();

function setToken(t) {
  const was = !!token;
  token = t;
  save(TOKEN_KEY, t);
  if (was !== !!t) listeners.forEach((fn) => fn(isLoggedIn()));
}

export const isLoggedIn = () => !!token;
export const onAuthChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

// Il login può completarsi in un'altra vista (su iOS il flusso OAuth di una PWA a volte si apre
// in un browser interno): ricarichiamo il token quando cambia lo storage o si torna all'app.
function reloadToken() {
  const t = load(TOKEN_KEY, null);
  if (JSON.stringify(t) !== JSON.stringify(token)) setToken(t);
}
window.addEventListener('storage', (e) => { if (e.key === TOKEN_KEY) reloadToken(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) reloadToken(); });

// ---------- Login ----------

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function login() {
  if (!settings.spotifyClientId) throw new SpotifyError('Inserisci il Client ID Spotify nelle Impostazioni.');
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = uid();
  save(PKCE_KEY, { verifier, state, redirect: redirectUri() });

  const params = new URLSearchParams({
    client_id: settings.spotifyClientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: SCOPES,
  });
  window.location.assign(`https://accounts.spotify.com/authorize?${params}`);
}

/** Da chiamare all'avvio: completa il login se l'URL contiene ?code=… */
export async function handleRedirect() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const state = url.searchParams.get('state');
  if (!code && !error) return false;

  const pkce = load(PKCE_KEY, null);
  // Pulisce l'URL (niente codice nella cronologia o nei preferiti).
  url.search = '';
  history.replaceState(null, '', url.toString());
  save(PKCE_KEY, null);

  if (error) throw new SpotifyError(error === 'access_denied' ? 'Accesso annullato.' : `Accesso Spotify non riuscito: ${error}`);
  if (!pkce) throw new SpotifyError('Sessione di login scaduta: riprova.');
  if (pkce.state !== state) throw new SpotifyError('Risposta di Spotify non valida (state): riprova.');

  await requestToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: pkce.redirect,
    client_id: settings.spotifyClientId,
    code_verifier: pkce.verifier,
  });
  return true;
}

export function logout() {
  setToken(null);
}

async function requestToken(form) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new SpotifyError(`Token Spotify: ${data.error_description || data.error || res.status}`, { status: res.status });
  }
  setToken({
    access: data.access_token,
    refresh: data.refresh_token || token?.refresh,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  return token.access;
}

async function accessToken() {
  if (!token) throw new SpotifyError('Accedi a Spotify dalle Impostazioni.', { status: 401 });
  if (token.expiresAt - Date.now() > 60_000) return token.access;
  if (!token.refresh) { setToken(null); throw new SpotifyError('Sessione Spotify scaduta.', { status: 401 }); }
  refreshing ??= requestToken({
    grant_type: 'refresh_token',
    refresh_token: token.refresh,
    client_id: settings.spotifyClientId,
  }).catch((e) => { if (e.status === 400) setToken(null); throw e; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

// ---------- HTTP ----------

// ---------- Diagnostica ----------
// Ultime operazioni verso Spotify (mai token o dati personali), da copiare in caso di problemi.
const LOG_MAX = 60;
const diag = [];
export function logEvent(text) {
  const d = new Date();
  diag.push(`${d.toTimeString().slice(0, 8)} ${text}`);
  if (diag.length > LOG_MAX) diag.shift();
}
export const getLog = () => diag.slice();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_MS = [400, 1000, 2000];

/**
 * Chiamata alla Web API. Gli errori temporanei di Spotify (500/502/503/504, troppe richieste,
 * rete assente per un attimo) vengono ritentati da soli; un token scaduto viene rinnovato.
 */
async function api(path, { method = 'GET', query, body } = {}, attempt = 0) {
  const url = new URL(path.startsWith('http') ? path : API + path);
  if (query) Object.entries(query).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  const retry = async (ms) => { await sleep(ms); return api(path, { method, query, body }, attempt + 1); };
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e instanceof SpotifyError) throw e;
    if (attempt < 2) return retry(RETRY_MS[attempt]);
    throw new SpotifyError('Connessione assente.', { status: 0 });
  }
  if (res.status >= 500 && res.status !== 501 && attempt < RETRY_MS.length) return retry(RETRY_MS[attempt]);
  if (res.status === 429 && attempt < 2) {
    const after = Number(res.headers.get('Retry-After')) || 1;
    return retry(Math.min(after, 5) * 1000);
  }
  if (res.status === 401 && attempt === 0 && token?.refresh) {
    token = { ...token, expiresAt: 0 }; // forza il rinnovo e riprova una volta
    return retry(0);
  }
  if (url.pathname.startsWith('/v1/me/player') && !(method === 'GET' && url.pathname === '/v1/me/player')) {
    const extra = body?.context_uri ? ` contesto=${body.context_uri} da=${body.offset?.uri}` : body?.uris ? ` uris=${body.uris.length} primo=${body.uris[0]}` : body?.device_ids ? ` trasferisci→${body.device_ids[0]}` : '';
    logEvent(`${method} ${url.pathname.slice(3)}${url.searchParams.get('device_id') ? ` device=${url.searchParams.get('device_id').slice(0, 6)}` : ''}${extra} → ${res.status}`);
  }
  if (res.status === 204 || res.status === 202) return null;
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
  if (!res.ok) {
    const reason = data?.error?.reason;
    const msg = data?.error?.message || res.statusText;
    throw new SpotifyError(friendly(res.status, reason, msg), { status: res.status, reason });
  }
  return data;
}

function friendly(status, reason, msg) {
  if (reason === 'NO_ACTIVE_DEVICE' || (status === 404 && /device/i.test(msg))) return NO_DEVICE_MSG;
  if (reason === 'PREMIUM_REQUIRED') return 'Per comandare la riproduzione serve Spotify Premium.';
  if (status === 429) return 'Troppe richieste a Spotify: riprova tra qualche secondo.';
  if (status === 403) return `Spotify ha negato l'accesso (${msg}).`;
  return `Spotify: ${msg} (${status})`;
}

// ---------- Dati ----------

function toTrack(o, album) {
  if (!o || !o.id || o.is_local || (o.type && o.type !== 'track')) return null;
  const imgs = (o.album || album)?.images || [];
  return {
    source: 'spotify',
    sourceId: o.id,
    title: o.name,
    artist: (o.artists || []).map((a) => a.name).join(', '),
    artwork: (imgs[1] || imgs[0])?.url || null,
    artworkLg: imgs[0]?.url || null,
    durationMs: o.duration_ms ?? null,
    albumId: (o.album || album)?.id || null,
  };
}

/** Le app in Development Mode ricevono al massimo 10 risultati per pagina (regole feb. 2026). */
export async function searchTracks(q, offset = 0) {
  const data = await api('/search', { query: { q, type: 'track', limit: 10, offset } });
  return {
    tracks: (data?.tracks?.items || []).map(toTrack).filter(Boolean),
    hasMore: !!data?.tracks?.next,
  };
}

export async function getTrack(id) {
  return toTrack(await api(`/tracks/${encodeURIComponent(id)}`));
}

export async function me() {
  return api('/me');
}

export async function myPlaylists() {
  const out = [];
  let next = `${API}/me/playlists?limit=50`;
  while (next) {
    const page = await api(next);
    for (const p of page.items || []) {
      if (!p) continue;
      out.push({
        id: p.id,
        name: p.name,
        owner: p.owner?.display_name || p.owner?.id || '',
        ownerId: p.owner?.id || '',
        collaborative: !!p.collaborative,
        snapshot: p.snapshot_id || null,
        count: p.items?.total ?? p.tracks?.total ?? null,
        image: p.images?.[0]?.url || null,
      });
    }
    next = page.next;
  }
  return out;
}

/** Funziona solo per playlist di tua proprietà o collaborative (regole Development Mode). */
export async function playlistTracks(id) {
  const out = [];
  let next = `${API}/playlists/${encodeURIComponent(id)}/items?limit=50`;
  while (next) {
    const page = await api(next);
    for (const it of page.items || []) {
      const t = toTrack(it.item || it.track);
      if (t) out.push(t);
    }
    next = page.next;
  }
  return out;
}

export async function playlistInfo(id) {
  const p = await api(`/playlists/${encodeURIComponent(id)}`, { query: { fields: 'id,name,images' } });
  return { id: p.id, name: p.name, image: p.images?.[0]?.url || null };
}

export async function albumTracks(id) {
  const album = await api(`/albums/${encodeURIComponent(id)}`);
  const out = (album.tracks?.items || []).map((t) => toTrack(t, album)).filter(Boolean);
  let next = album.tracks?.next;
  while (next) {
    const page = await api(next);
    out.push(...(page.items || []).map((t) => toTrack(t, album)).filter(Boolean));
    next = page.next;
  }
  return { name: album.name, tracks: out };
}

// ---------- Riproduzione (Spotify Connect) ----------

export async function devices() {
  const data = await api('/me/player/devices');
  return data?.devices || [];
}

/** Stato del player: null se nessun dispositivo sta suonando. */
export async function playbackState() {
  return api('/me/player', { query: { additional_types: 'track', market: 'from_token' } });
}

export const NO_DEVICE_MSG = 'Spotify non risponde';
export const isNoDevice = (e) => e?.reason === 'NO_ACTIVE_DEVICE';
const noDevice = () => new SpotifyError(NO_DEVICE_MSG, { status: 404, reason: 'NO_ACTIVE_DEVICE' });

/**
 * Dispositivo su cui suonare: quello attivo, poi quello scelto, poi il telefono.
 * Con `waitMs` aspetta che compaia (l'app Spotify appena riaperta impiega qualche secondo).
 */
async function findDevice(waitMs = 0, { allowSaved = true } = {}) {
  const until = Date.now() + waitMs;
  const savedId = settings.spotifyDeviceId;
  for (;;) {
    const list = (await devices()).filter((d) => d.id && !d.is_restricted);
    logEvent(`dispositivi: ${list.map((d) => `${d.name}${d.is_active ? '*' : ''}(${d.id.slice(0, 6)})`).join(', ') || 'nessuno'}`);
    // Il dispositivo dell'utente (salvato) ha sempre la precedenza: mai prendersi il telefono
    // di qualcun altro che usa lo stesso account solo perché in quel momento è "attivo".
    const saved = list.find((d) => d.id === savedId);
    if (saved) return saved;
    if (savedId) {
      // Spotify in background a volte sparisce per qualche secondo dall'elenco: si prova
      // comunque il telefono conosciuto, che di solito risponde lo stesso; poi lo si aspetta.
      if (allowSaved) {
        logEvent('il tuo dispositivo non è in elenco: provo comunque quello conosciuto');
        return { id: savedId, name: settings.spotifyDeviceName, is_active: false };
      }
      if (Date.now() > until) throw noDevice();
      await sleep(1500);
      continue;
    }
    // Nessun dispositivo ancora scelto: quello attivo, poi il telefono, poi il primo.
    const chosen = list.find((d) => d.is_active) || list.find((d) => d.type === 'Smartphone') || list[0];
    if (chosen) {
      updateSettings({ spotifyDeviceId: chosen.id, spotifyDeviceName: chosen.name });
      return chosen;
    }
    if (Date.now() > until) throw noDevice();
    await sleep(1500);
  }
}

// Album di ogni brano (per avviarlo "dall'album"), anche per i brani salvati prima che
// Duetto memorizzasse l'album.
const albumCache = new Map();
async function albumUriOf(trackUriStr, albumId) {
  if (albumId) return `spotify:album:${albumId}`;
  const id = trackUriStr.split(':').pop();
  if (!albumCache.has(id)) {
    const t = await api(`/tracks/${encodeURIComponent(id)}`, { query: { market: 'from_token' } });
    albumCache.set(id, t?.album?.id || null);
  }
  const a = albumCache.get(id);
  return a ? `spotify:album:${a}` : null;
}

/** Manda un comando "suona" al dispositivo giusto, ritentando se il telefono si sta svegliando. */
async function sendPlay(body, waitMs) {
  let device = await findDevice(waitMs);
  try {
    await api('/me/player/play', { method: 'PUT', query: { device_id: device.id }, body });
  } catch (e) {
    // Si riprova solo se il dispositivo non c'è o Spotify ha un problema temporaneo; un errore
    // sul brano o sul contesto (es. brano non presente nella playlist) passa al chiamante.
    const deviceProblem = isNoDevice(e) || e.message === NO_DEVICE_MSG || e.status >= 500;
    if (!deviceProblem) throw e;
    await sleep(1000);
    device = await findDevice(4000, { allowSaved: false });
    try {
      await api('/me/player/play', { method: 'PUT', query: { device_id: device.id }, body });
    } catch (e2) {
      if (isNoDevice(e2) || e2.message === NO_DEVICE_MSG) throw noDevice();
      throw e2;
    }
  }
  return device;
}

/**
 * Avvia un brano Spotify. Su iPhone l'app Spotify ignora il comando con una semplice lista di
 * brani (`uris`: risponde 204 ma riprende la canzone che aveva), mentre esegue sempre
 * "suona questo contesto partendo da questo brano" (`context_uri` + `offset`), come quando si
 * tocca un brano nell'app. Quindi:
 * - `contextUri` (playlist Spotify sincronizzata) → suona la playlist da quel brano: Spotify
 *   prosegue da solo nell'ordine della playlist, anche a schermo bloccato;
 * - altrimenti → suona l'album del brano da quel brano (Duetto passa poi al successivo).
 * Restituisce la modalità usata: 'playlist' | 'album'.
 */
export async function play(uris, { waitMs = 0, contextUri = null, albumId = null, force = null } = {}) {
  const first = uris[0];
  let mode = null;
  let device = null;
  if (contextUri && force !== 'album') {
    try {
      device = await sendPlay({ context_uri: contextUri, offset: { uri: first }, position_ms: 0 }, waitMs);
      mode = 'playlist';
    } catch (e) {
      if (isNoDevice(e) || e.status === 401) throw e;
      logEvent(`playlist non utilizzabile (${e.status}), uso l'album`);
    }
  }
  if (!mode) {
    const album = await albumUriOf(first, albumId).catch(() => null);
    if (album) {
      device = await sendPlay({ context_uri: album, offset: { uri: first }, position_ms: 0 }, waitMs);
      mode = 'album';
    } else {
      // Ultima risorsa (brano senza album leggibile): lista semplice.
      device = await sendPlay({ uris: [first], position_ms: 0 }, waitMs);
      mode = 'album';
    }
  }
  // Niente casuale di Spotify (mescolerebbe l'ordine) né ripetizione del contesto.
  api('/me/player/shuffle', { method: 'PUT', query: { state: 'false', device_id: device.id } }).catch(() => {});
  api('/me/player/repeat', { method: 'PUT', query: { state: 'off', device_id: device.id } }).catch(() => {});
  return mode;
}

const dev = () => settings.spotifyDeviceId || undefined;
export const pause = () => api('/me/player/pause', { method: 'PUT', query: { device_id: dev() } }).catch(ignoreNoDevice);
export const resume = () => api('/me/player/play', { method: 'PUT', query: { device_id: dev() } });
export const seek = (ms) => api('/me/player/seek', { method: 'PUT', query: { position_ms: Math.max(0, Math.round(ms)), device_id: dev() } });

function ignoreNoDevice(e) {
  if (e.status === 404 || e.status === 403) return null;
  throw e;
}

