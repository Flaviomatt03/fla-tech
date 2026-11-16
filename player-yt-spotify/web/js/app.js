import { store, ready as storeReady, onSaveError, isReadOnly } from './store.js';
import { settings, updateSettings, redirectUri } from './settings.js';
import * as spotify from './spotify.js';
import * as yt from './youtube.js';
import { YouTubeAudio, prefetch as prefetchAudio, clearDownloads, saveFile, probeFile, hasLocal, loadFileIndex, fileExists, gcFiles } from './ytaudio.js';
import { Player } from './player.js';
import { syncSpotify, onSyncChange, isSyncing } from './sync.js';
import { parseLink, parseCollection, trackUri, uid, parseFileName, titleKey, audioId, fileIdsIn, findSameFile } from './util.js';
import { load, save, idbGet } from './storage.js';
import { VERSION } from './version.js';
import {
  $, $$, esc, icon, dot, cover, trackRow, totalTime, eq, toast, actionSheet, askText, tintOf,
  enableSwipe, justSwiped, srcName, panel, close, art as artHTML,
} from './ui.js';
import { initNowPlaying, markCurrent, chooseDevice, isFullOpen, closeFull } from './nowplaying.js';

// ---------- Player ----------

const ytEngine = new YouTubeAudio($('#yt-audio'), new yt.YouTubePlayer('yt-player'));
const player = new Player({
  spotify: {
    play: spotify.play, pause: spotify.pause, resume: spotify.resume,
    seek: spotify.seek, playbackState: spotify.playbackState, log: spotify.logEvent,
  },
  youtube: ytEngine,
});
player.context = null;

/** Contesto di riproduzione di una playlist: per quelle sincronizzate anche la playlist Spotify. */
const ctxOf = (p) => ({ id: p.id, name: p.name, spotifyUri: p.spotify ? `spotify:playlist:${p.spotify.id}` : null });

function playFrom(tracks, i, context = null) {
  if (!tracks.length) return;
  player.context = context;
  player.playList(tracks, i);
}

// ---------- Router ----------

const view = $('#view');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
let route = null;
const scrollMemo = new Map();
let skipTransition = false;

function parseRoute() {
  const path = (location.hash.slice(1) || '/').split('?')[0];
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'playlist' && parts[1] && parts[2] === 'add') return { name: 'add', id: parts[1], depth: 2, tab: 'library' };
  if (parts[0] === 'playlist' && parts[1]) return { name: 'playlist', id: parts[1], depth: 1, tab: 'library' };
  if (parts[0] === 'search') return { name: 'search', depth: 0, tab: 'search' };
  if (parts[0] === 'settings') return { name: 'settings', depth: 1, tab: 'library' };
  return { name: 'library', depth: 0, tab: 'library' };
}
const routeKey = (r) => (r ? `${r.name}:${r.id || ''}` : '');
const parentHash = (r) => (r.name === 'add' ? `#/playlist/${r.id}` : r.tab === 'search' ? '#/search' : '#/');

function navigate() {
  if (isFullOpen() && !history.state?.full) closeFull(true);
  const next = parseRoute();
  if (route && routeKey(next) === routeKey(route)) return;
  const prev = route;
  if (prev) scrollMemo.set(routeKey(prev), view.scrollTop);
  const dir = !prev || skipTransition ? null
    : next.depth > prev.depth ? 'push'
      : next.depth < prev.depth ? 'pop'
        : next.tab !== prev.tab ? 'fade' : null;
  skipTransition = false;
  const apply = () => {
    route = next;
    render({ fresh: !prev || next.depth >= prev.depth });
    view.scrollTop = prev && next.depth < prev.depth ? (scrollMemo.get(routeKey(next)) || 0) : 0;
    onScroll();
    // VoiceOver e tastiera ripartono dal titolo della nuova pagina.
    if (prev) $('h1', view)?.focus({ preventScroll: true });
  };
  if (dir && document.startViewTransition && !reduceMotion.matches) {
    document.documentElement.dataset.nav = dir;
    const vt = document.startViewTransition(apply);
    vt.finished.finally(() => { delete document.documentElement.dataset.nav; });
  } else {
    apply();
  }
}

function render({ fresh = false } = {}) {
  $$('.tabbar a').forEach((a) => {
    const on = a.dataset.tab === route.tab;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  hideImportBar();
  view.classList.toggle('grouped', route.name === 'settings');
  ({ library: renderLibrary, playlist: renderPlaylist, add: renderAdd, search: renderSearch, settings: renderSettings })[route.name]({ fresh });
  markCurrent(view);
}

/** Ridisegna la vista attuale tenendo la posizione di scorrimento (solo quando cambiano i dati). */
function refresh() {
  if (!route || dragging) return;
  const y = view.scrollTop;
  render();
  view.scrollTop = y;
  onScroll();
}

window.addEventListener('hashchange', navigate);
store.subscribe(() => { if (route && !isSyncing() && route.name !== 'add' && route.name !== 'search') refresh(); });

function goBack() {
  const parent = parentHash(route);
  if (backTarget === parent) history.back();
  else location.replace(parent);
}
let backTarget = null;
let lastHash = (location.hash && location.hash !== '#') ? location.hash : '#/';
window.addEventListener('hashchange', () => { backTarget = lastHash; lastHash = location.hash || '#/'; });

// Barra di navigazione: diventa vetro e mostra il titolo quando il titolo grande scorre via.
function onScroll() {
  const nav = $('.nav', view);
  if (!nav) return;
  const limit = Number(nav.dataset.limit) || 36;
  nav.classList.toggle('scrolled', view.scrollTop > limit);
}
view.addEventListener('scroll', onScroll, { passive: true });

/** Barra di navigazione iOS: sinistra, titolo (piccolo), destra. */
function navBar({ title, left = '', right = '', limit = 36, always = false }) {
  return `<header class="nav${always ? ' show-t' : ''}" data-limit="${limit}">
    <div class="nav-l">${left}</div>
    <div class="nav-t" aria-hidden="true">${esc(title)}</div>
    <div class="nav-r">${right}</div>
  </header>`;
}
const backBtn = () => `<button class="ibtn gbtn glass" data-a="back" aria-label="Indietro">${icon('back')}</button>`;

// Scorrimento dal bordo sinistro per tornare indietro (gesto di sistema iOS).
let edge = null;
view.addEventListener('touchstart', (e) => {
  const x = e.touches[0].clientX;
  if (!route || route.depth === 0 || x > 24 || isFullOpen()) return;
  edge = { x0: x, y0: e.touches[0].clientY, dx: 0, t0: performance.now(), on: false };
}, { passive: true });
view.addEventListener('touchmove', (e) => {
  if (!edge) return;
  const dx = e.touches[0].clientX - edge.x0;
  const dy = e.touches[0].clientY - edge.y0;
  if (!edge.on) {
    if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { edge = null; return; }
    if (dx < 10) return;
    edge.on = true;
    view.classList.add('edge');
  }
  edge.dx = Math.max(0, dx);
  view.style.transform = `translateX(${edge.dx}px)`;
}, { passive: true });
view.addEventListener('touchend', () => {
  if (!edge) return;
  const { dx, on, t0 } = edge;
  edge = null;
  if (!on) return;
  const v = dx / Math.max(1, performance.now() - t0);
  view.classList.add('edge-anim');
  if (dx > innerWidth / 3 || v > 0.5) {
    view.style.transform = 'translateX(100%)';
    setTimeout(() => {
      view.classList.remove('edge', 'edge-anim');
      skipTransition = true;
      goBack();
      requestAnimationFrame(() => { view.style.transform = ''; });
    }, 260);
  } else {
    view.style.transform = '';
    setTimeout(() => view.classList.remove('edge', 'edge-anim'), 300);
  }
});

// ---------- Libreria ----------

function renderLibrary({ fresh }) {
  const all = store.all();
  const lists = [...all.filter((p) => p.pinned), ...all.filter((p) => !p.pinned)];
  const playingId = player.current ? player.context?.id : null;
  const right = `
    <span class="ibtn" id="sync-ind" ${isSyncing() ? '' : 'hidden'} role="status" aria-label="Sincronizzazione in corso"><span class="spin" style="margin:0;width:18px;height:18px"></span></span>
    <button class="ibtn gbtn glass" data-a="new" aria-label="Nuova playlist">${icon('plus')}</button>
    <a class="ibtn gbtn glass" href="#/settings" aria-label="Impostazioni">${icon('gear')}</a>`;
  const head = `${navBar({ title: 'Libreria', right })}<h1 class="large" tabindex="-1">Libreria</h1>`;

  if (!lists.length) {
    const needsSetup = !spotify.isLoggedIn();
    view.innerHTML = `${head}
      <div class="empty">
        ${isSyncing() ? '<div class="spin" role="status" aria-label="Caricamento"></div>' : `
        <span class="art" aria-hidden="true">${icon('note')}</span>
        <div class="stack">
          ${needsSetup ? `<a class="btn accent" href="#/settings">Collega Spotify</a>` : ''}
          <button class="btn" data-a="new">Nuova playlist</button>
        </div>`}
      </div>`;
    return;
  }

  view.innerHTML = `${head}
    <div class="list lib" role="list">
      ${lists.map((p, i) => {
        const yt = p.tracks.some((t) => t.source === 'youtube');
        const hasFile = p.tracks.some((t) => t.source === 'file');
        const label = `${p.name}${p.pinned ? ', fissata' : ''}, ${p.tracks.length} brani${p.spotify ? ', da Spotify' : ''}${yt ? ', con YouTube' : ''}`;
        return `
        <a class="row" href="#/playlist/${esc(p.id)}" data-pl="${esc(p.id)}" style="--i:${i}" role="listitem" aria-label="${esc(label)}">
          ${cover(p, 'lg')}
          <div class="grow" aria-hidden="true">
            <div class="t">${esc(p.name)}</div>
            <div class="s">${p.pinned ? `<span class="pin">${icon('pin')}</span>` : ''}${p.spotify ? dot('spotify') : ''}${yt ? dot('youtube') : ''}${hasFile ? dot('file') : ''}<span>${p.tracks.length} brani</span></div>
          </div>
          <span class="pl-eq">${p.id === playingId ? eq(player.playing) : ''}</span>
        </a>`;
      }).join('')}
    </div>`;
}

// Tira giù la libreria per sincronizzare Spotify.
let pull = null;
view.addEventListener('touchstart', (e) => {
  if (route?.name !== 'library' || view.scrollTop > 0 || !spotify.isLoggedIn()) return;
  pull = { y: e.touches[0].clientY, d: 0 };
}, { passive: true });
view.addEventListener('touchmove', (e) => {
  if (!pull) return;
  pull.d = e.touches[0].clientY - pull.y;
  const ind = $('#sync-ind');
  if (ind && pull.d > 20 && !isSyncing()) {
    ind.hidden = false;
    ind.style.opacity = Math.min(1, pull.d / 90);
    ind.style.transform = `rotate(${pull.d * 3}deg)`;
  }
}, { passive: true });
view.addEventListener('touchend', () => {
  if (!pull) return;
  const go = pull.d > 90;
  pull = null;
  const ind = $('#sync-ind');
  if (ind) { ind.style.opacity = ''; ind.style.transform = ''; ind.hidden = !isSyncing() && !go; }
  if (go) runSync(true);
});

async function runSync(force, full = false) {
  try {
    const n = await syncSpotify({ force, full });
    if (full) { toast(`Playlist Spotify ripristinate (${n})`, { ms: 2500 }); return; }
    if (force && n === 0) toast('Già aggiornato', { ms: 1400 });
  } catch (e) {
    if (force) toast(e.message, { error: true });
  }
}
onSyncChange((on) => {
  const ind = $('#sync-ind');
  if (ind) ind.hidden = !on;
  // Durante il sync non si ridisegna: lo si fa una volta sola alla fine, su qualsiasi pagina di dati.
  if (!on && route && route.name !== 'add' && route.name !== 'search') refresh();
});

async function newPlaylist() {
  const name = await askText('Nuova playlist', '', 'Crea');
  if (!name) return null;
  return store.create(name);
}

// ---------- Playlist ----------

let editing = false;
let dragging = false;

/** In cima alla playlist: scarica / importa tutti i brani YouTube non ancora file, aggiorna la copia. */
function bulkBar(p) {
  if (editing) return '';
  const todo = p.tracks.filter((t) => t.source === 'youtube' && !hasLocal(t.sourceId));
  const lost = p.tracks.filter((t) => t.source === 'file' && !fileExists(t.sourceId)).length;
  const upd = p.clone ? cloneDiff(p) : null;
  const n = upd ? upd.add.length + upd.remove.length : 0;
  if (!todo.length && !n && !lost) return '';
  return `<div class="bulk">
    ${n ? `<button class="btn small" data-a="clone-go">${icon('sync')} Aggiorna (${n})</button>` : ''}
    ${todo.length ? `<button class="btn small" data-a="dl-all">${icon('download')} Scarica tutti (${todo.length})</button>` : ''}
    ${todo.length || lost ? `<button class="btn small accent" data-a="import-files">Importa file${lost ? ` (${lost} mancanti)` : ''}</button>` : ''}
    <input type="file" id="bulk-pick" accept="audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg,.opus" multiple hidden>
  </div>`;
}

function renderPlaylist({ fresh }) {
  const p = store.get(route.id);
  if (!p) { location.replace('#/'); return; }
  if (fresh) editing = false;
  const isCtx = player.context?.id === p.id && player.current;
  const playing = isCtx && player.playing;
  const meta = [`${p.tracks.length} brani`, totalTime(p.tracks)].filter(Boolean).join(' · ');

  view.innerHTML = `
    ${navBar({
      title: p.name, limit: 300,
      left: backBtn(),
      right: editing
        ? '<button class="btn small accent" data-a="done">Fine</button>'
        : `<button class="ibtn gbtn glass" data-a="pl-more" aria-label="Altre azioni">${icon('more')}</button>`,
    })}
    <div class="hero" id="hero">
      <div class="hero-art">${cover(p)}</div>
      <h1 tabindex="-1">${esc(p.name)}</h1>
      <div class="meta">${p.spotify ? dot('spotify') : ''}<span>${meta}</span></div>
    </div>
    <div class="actions">
      <button class="ibtn" data-a="add" aria-label="Aggiungi brani">${icon('plus')}</button>
      <button class="play" data-a="play" id="pl-play" aria-label="${playing ? 'Pausa' : 'Riproduci'}" ${p.tracks.length ? '' : 'disabled'}>${icon(playing ? 'pause' : 'play')}</button>
      <button class="ibtn${player.shuffled ? ' on' : ''}" data-a="shuffle" aria-label="Casuale" aria-pressed="${player.shuffled}">${icon('shuffle')}</button>
    </div>
    ${bulkBar(p)}
    ${p.tracks.length ? `
      <div class="list${editing ? ' editing' : ''}" id="tracks">
        ${p.tracks.map((t, i) => trackRow(t, {
          i,
          swipe: !editing,
          ...(t.source === 'youtube' && !hasLocal(t.sourceId) ? { cls: 'todo', sub: t.blocked ? `Video ${t.blocked}: cambialo dal menu`
            : t.refMs && t.durationMs && Math.abs(t.refMs - t.durationMs) > 10000 ? `Da scaricare · ⚠︎ durata diversa da Spotify (${diffLabel(t.durationMs, t.refMs)})` : 'Da scaricare' } : {}),
          ...(t.source === 'file' && !fileExists(t.sourceId) ? { cls: 'todo', sub: 'File mancante: reimportalo' } : {}),
          attrs: `data-i="${i}"${editing ? '' : ' data-a="play-at"'}`,
          lead: editing ? `<button class="ibtn minus" data-a="rm" data-i="${i}" aria-label="Togli ${esc(t.title)}">${icon('minus')}</button>` : '',
          trailing: editing
            ? `<span class="ibtn grip" data-grip="${i}" aria-hidden="true">${icon('grip')}</span>`
            : `${t.source === 'youtube' && !hasLocal(t.sourceId) ? `<button class="ibtn tint" data-a="dl" data-i="${i}" aria-label="Scarica ${esc(t.title)}">${icon('download')}</button>` : ''}<button class="ibtn" data-a="t-more" data-i="${i}" aria-label="Azioni per ${esc(t.title)}">${icon('more')}</button>`,
        })).join('')}
      </div>` : ''}`;

  // Sfumatura della copertina dietro l'intestazione.
  const src = p.image || p.tracks.find((t) => t.artwork)?.artwork;
  tintOf(src).then((c) => { $('#hero')?.style.setProperty('--tint', c || 'var(--bg)'); });
}

// ---------- Copia di una playlist su YouTube ----------
// Ogni brano Spotify si cerca su YouTube (101 unità di quota: ~95 brani al giorno con la quota
// gratuita). La copia è una playlist nuova; a quota finita si ferma e si riprende dal menu.

async function cloneToYouTube(p) {
  const n = p.tracks.filter((t) => t.source === 'spotify').length;
  const c = await actionSheet([{ label: `Copia su YouTube (${n} ricerche)`, icon: 'plus', value: 'go' }], {
    title: 'Copia su YouTube',
    sub: n > 90 ? `YouTube permette circa 95 ricerche al giorno: la copia finirà in ${Math.ceil(n / 95)} giorni` : 'I brani Spotify diventano brani YouTube da scaricare',
  });
  if (c !== 'go') return;
  const copy = store.create(`${p.name} (YouTube)`, [], { clone: { from: p.id, missing: [], missingKeys: [] }, image: p.image });
  location.hash = `#/playlist/${copy.id}`;
  runClone(copy.id);
}

const cloneKey = (t) => `${t.source}:${t.sourceId}`;
const songKey = (x) => titleKey(String(x || '').replace(/\s+[-–(\[].*$/, '')) || titleKey(x);
const closeDur = (a, b) => !a.durationMs || !b.durationMs || Math.abs(a.durationMs - b.durationMs) < 15000;

/**
 * Differenza tra la copia "(YouTube)" e la playlist originale, legata dal codice d'origine
 * (`origin` = brano Spotify da cui viene, anche dopo essere diventato file):
 * - add: brani dell'originale che nella copia mancano (esclusi quelli non trovati su YouTube);
 * - remove: brani della copia il cui originale non c'è più (quelli aggiunti a mano restano).
 */
function cloneDiff(copy) {
  const src = store.get(copy.clone?.from);
  if (!src) return { add: [], remove: [] };
  const srcKeys = new Set(src.tracks.map(cloneKey));
  const have = new Set(copy.tracks.map((t) => t.origin).filter(Boolean));
  const skip = new Set(copy.clone.missingKeys || []);
  return {
    add: src.tracks.filter((t) => !have.has(cloneKey(t)) && !skip.has(cloneKey(t))),
    remove: copy.tracks.filter((t) => t.origin && !srcKeys.has(t.origin)),
  };
}

/** Vecchie copie senza codice d'origine: si collegano all'originale per titolo e durata. */
function adoptOrigins(copy, src) {
  const words = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const used = new Set(copy.tracks.map((t) => t.origin).filter(Boolean));
  const pos = new Map(src.tracks.map((x, j) => [cloneKey(x), j]));
  let last = -1;           // posizione nell'originale dell'ultimo brano collegato (la copia segue lo stesso ordine)
  let changed = false;
  const tracks = copy.tracks.map((t) => {
    if (t.origin) { if (pos.has(t.origin)) last = pos.get(t.origin); return t; }
    const text = new Set(words(`${t.title} ${t.artist} ${t.ytTitle || ''}`));
    let best = null;
    src.tracks.forEach((x, j) => {
      const k = cloneKey(x);
      if (used.has(k)) return;
      if (k === cloneKey(t)) { best = { x, j, sc: 1e9 }; return; }
      const tw = words(x.title.replace(/\s*[(\[].*$/, ''));
      const hit = tw.filter((w) => text.has(w)).length;
      const aHit = words(x.artist).filter((w) => text.has(w)).length;
      const d = x.durationMs && t.durationMs ? Math.abs(x.durationMs - t.durationMs) : 99999;
      const near = Math.abs(j - (last + 1));
      const titleOk = tw.length && hit / tw.length >= 0.5 && d < 20000;
      const orderOk = d < 3000 && near <= 2;
      if (!titleOk && !orderOk) return;
      const sc = hit * 4 + aHit * 2 - d / 3000 - near * 0.5;
      if (!best || sc > best.sc) best = { x, j, sc };
    });
    if (!best) return t;
    used.add(cloneKey(best.x)); last = best.j; changed = true;
    return { ...t, origin: cloneKey(best.x) };
  });
  return changed ? tracks : null;
}

/** La stessa canzone già presente da qualche parte: prima per codice d'origine, poi per titolo; file prima di YouTube. */
function sameInLibrary(t) {
  const key = cloneKey(t);
  const k = songKey(t.title);
  let yt = null;
  for (const p of store.all()) {
    for (const x of p.tracks) {
      if (x.source !== 'file' && x.source !== 'youtube') continue;
      const hit = x.origin === key || (k && songKey(x.title) === k && closeDur(t, x));
      if (!hit) continue;
      if (x.source === 'file' && fileExists(x.sourceId)) return x;
      if (x.source === 'youtube') yt ||= x;
    }
  }
  return yt;
}

/** Ordina la copia come l'originale; i brani senza origine (aggiunti a mano) restano in fondo. */
function orderLike(tracks, src) {
  const pos = new Map(src.tracks.map((t, i) => [cloneKey(t), i]));
  const withO = tracks.filter((t) => t.origin && pos.has(t.origin)).sort((x, y) => pos.get(x.origin) - pos.get(y.origin));
  return [...withO, ...tracks.filter((t) => !t.origin || !pos.has(t.origin))];
}

/** Titolo, artista e copertina del brano Spotify d'origine (più belli di quelli di YouTube). */
function withMeta(x, t) {
  if (t.source !== 'spotify') return x;
  return { ...x, ytTitle: x.ytTitle || (x.source === 'youtube' && x.title !== t.title ? x.title : undefined), title: t.title || x.title, artist: t.artist || x.artist, artwork: t.artwork || x.artwork || null, artworkLg: t.artworkLg || x.artworkLg || null, albumId: t.albumId || x.albumId, refMs: t.durationMs || x.refMs || null };
}

/**
 * File senza copertina o artista (importati prima di questa versione): si prendono dal brano
 * d'origine (codice `origin`), o da un brano Spotify/YouTube della libreria con lo stesso titolo.
 */
function enrichFiles() {
  if (isReadOnly()) return 0;
  // Copie create prima del codice d'origine: si ricollegano all'originale (titolo, artista, durata, ordine).
  for (const c of store.all()) {
    const src = c.clone && store.get(c.clone.from);
    if (!src || !c.tracks.some((t) => !t.origin)) continue;
    const adopted = adoptOrigins(c, src);
    if (adopted) store.setTracks(c.id, adopted);
  }
  const byKey = new Map();
  const byTitle = new Map();
  for (const p of store.all()) for (const t of p.tracks) {
    if (t.source !== 'spotify' && t.source !== 'youtube') continue;
    if (!t.artwork) continue;
    const k = cloneKey(t);
    if (!byKey.has(k) || t.source === 'spotify') byKey.set(k, t);
    const tk = songKey(t.title);
    if (tk && (!byTitle.has(tk) || t.source === 'spotify')) byTitle.set(tk, t);
  }
  let fixed = 0;
  for (const p of store.all()) {
    let changed = false;
    const tracks = p.tracks.map((t) => {
      if (t.source !== 'file' && t.source !== 'youtube') return t;
      // Brano di una copia: sempre copertina e nomi del brano Spotify d'origine.
      const src = t.origin && byKey.get(t.origin);
      if (src?.source === 'spotify') {
        if (t.artwork === src.artwork && t.artist === src.artist && t.title === src.title && t.refMs === (src.durationMs || null)) return t;
        changed = true; fixed++;
        return withMeta(t, src);
      }
      if (t.source !== 'file' || (t.artwork && t.artist)) return t;
      const o = src || byTitle.get(songKey(t.title));
      if (!o || (o.durationMs && t.durationMs && Math.abs(o.durationMs - t.durationMs) > 15000)) return t;
      changed = true; fixed++;
      return { ...t, artwork: t.artwork || o.artwork, artworkLg: t.artworkLg || o.artworkLg || null, artist: t.artist || o.artist };
    });
    if (changed) store.setTracks(p.id, tracks);
  }
  // File già importati senza segno della provenienza: i file arrivano solo da YouTube, quindi è
  // da YouTube ogni file che non viene da Spotify (fuori dalle copie, o senza origine Spotify).
  for (const p of store.all()) {
    if (p.clone) continue;
    let changed = false;
    const tracks = p.tracks.map((t) => {
      if (t.source !== 'file' || t.yt || String(t.origin || '').startsWith('spotify:')) return t;
      changed = true; fixed++;
      return { ...t, yt: true };
    });
    if (changed) store.setTracks(p.id, tracks);
  }
  // File di brani nati da YouTube (non da Spotify): la copertina si ricava dal codice del video
  // nel nome del file; l'artista (nome del canale) si chiede a YouTube, 1 unità ogni 50 brani.
  const ytIdOf = (t) => t.ytId || /\[([A-Za-z0-9_-]{11})\]\s*\.[a-z0-9]{2,4}$/i.exec(t.fileName || '')?.[1] || null;
  const needArtist = new Set();
  for (const p of store.all()) {
    let changed = false;
    const tracks = p.tracks.map((t) => {
      if (t.source !== 'file') return t;
      const vid = ytIdOf(t);
      if (!vid) return t;
      if (!t.artist) needArtist.add(vid);
      if (t.artwork && t.ytId) return t;
      changed = true; fixed++;
      return { ...t, ytId: vid, artwork: t.artwork || `https://i.ytimg.com/vi/${vid}/mqdefault.jpg` };
    });
    if (changed) store.setTracks(p.id, tracks);
  }
  if (needArtist.size && settings.youtubeApiKey) fillArtists([...needArtist]).catch(() => {});
  return fixed;
}

async function fillArtists(ids) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    for (const v of await yt.videos(ids.slice(i, i + 50))) found.set(v.sourceId, v);
  }
  if (!found.size) return;
  for (const p of store.all()) {
    let changed = false;
    const tracks = p.tracks.map((t) => {
      const v = t.source === 'file' && !t.artist && found.get(t.ytId);
      if (!v) return t;
      changed = true;
      return { ...t, artist: v.artist, artwork: t.artwork?.includes('i.ytimg.com') && v.artwork ? v.artwork : t.artwork };
    });
    if (changed) store.setTracks(p.id, tracks);
  }
  refresh();
}

let cloning = null;
async function runClone(id) {
  if (cloning) { toast('Aggiornamento già in corso', { ms: 1400 }); return; }
  cloning = id;
  let added = 0;
  let removed = 0;
  try {
    let copy = store.get(id);
    const src = copy && store.get(copy.clone?.from);
    if (!src) { toast('La playlist originale non c\'è più', { error: true }); return; }
    // Prima i passaggi senza quota: origini, brani tolti, brani già in libreria, ordine.
    const adopted = adoptOrigins(copy, src);
    let tracks = adopted || copy.tracks;
    const { remove } = cloneDiff({ ...copy, tracks });
    const gone = new Set(remove);
    removed = remove.length;
    tracks = tracks.filter((t) => !gone.has(t));
    for (const t of cloneDiff({ ...copy, tracks }).add) {
      const have = t.source === 'spotify' ? sameInLibrary(t) : t;
      if (have) { tracks.push({ ...withMeta(have, t), origin: cloneKey(t), id: uid() }); added++; }
    }
    store.setTracks(id, orderLike(tracks, src));
    // Poi le ricerche su YouTube, una alla volta (100 unità di quota ciascuna).
    for (;;) {
      copy = store.get(id);
      if (!copy) return;
      const todo = cloneDiff(copy).add;
      if (!todo.length) break;
      const t = todo[0];
      toast(`Cerco su YouTube… mancano ${todo.length}`, { ms: 60000 });
      let v = null;
      try { v = await yt.findMatch(t); } catch (e) {
        toast(/quota/i.test(e.message) ? `Quota YouTube finita, mancano ${todo.length} brani: domani tocca di nuovo «Aggiorna»` : e.message, { error: true, ms: 6000 });
        return;
      }
      copy = store.get(id);
      if (!copy) return;
      if (v) {
        store.setTracks(id, orderLike([...copy.tracks, { ...withMeta(v, t), origin: cloneKey(t), id: uid() }], src));
        added++;
      } else {
        store.setClone(id, { ...copy.clone, missingKeys: [...(copy.clone.missingKeys || []), cloneKey(t)], missing: [...(copy.clone.missing || []), `${t.artist} – ${t.title}`] });
      }
    }
    const miss = store.get(id)?.clone?.missing?.length || 0;
    const parts = [added && `${added} aggiunti`, removed && `${removed} tolti`, miss && `${miss} non trovati su YouTube`].filter(Boolean);
    toast(parts.length ? `Copia aggiornata: ${parts.join(' · ')}` : 'Copia già aggiornata', { ms: 3500 });
  } finally {
    cloning = null;
    enrichFiles();
    refresh();
  }
}

/**
 * Importazione in blocco dei file scaricati: ogni file si collega al brano YouTube con lo
 * stesso codice video (nel nome del file) o lo stesso titolo, in TUTTE le playlist. I file
 * già importati si riconoscono e non si duplicano; quelli che non corrispondono a niente si
 * ignorano.
 */
async function importDownloaded(files) {
  let linked = 0, already = 0, unknown = 0, failed = 0, repaired = 0;
  const unknownNames = [];
  const where = new Set();
  toast(`Importo ${files.length} file…`, { ms: 60000 });
  for (const file of files) {
    const ytId = /\[([A-Za-z0-9_-]{11})\]\s*\.[a-z0-9]{2,4}$/i.exec(file.name)?.[1] || null;
    const base = file.name.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/\s*\[[A-Za-z0-9_-]{11}\]\s*$/, '');
    const key = titleKey(base);
    const picked = { file, key, ytId };
    const matches = [];
    for (const pl of store.all()) pl.tracks.forEach((x, k) => {
      if (x.source === 'youtube' && ((ytId && x.sourceId === ytId) || (!ytId && key && (titleKey(x.title) === key || titleKey(x.ytTitle) === key)))) matches.push([pl.id, k, x]);
    });
    const same = findSameFile(store.all(), file.name, file.size);
    let missing = !matches.length && (same && !fileExists(same.sourceId) ? same : findMissingFile(picked));
    if (!matches.length && !missing && same) { already++; continue; }
    let meta = null;
    if (!matches.length && !missing) {
      // Nome irriconoscibile: si confronta la durata del file (identica a quella salvata
      // quando era stato importato) con i file mancanti, insieme alle parole del titolo.
      meta = await probeFile(file);
      missing = meta && missingByDuration(base, meta.durationMs);
      if (!missing) { unknown++; unknownNames.push(file.name); continue; }
    }
    let fileId;
    if (same && fileExists(same.sourceId)) fileId = same.sourceId;
    else {
      meta ||= await probeFile(file);
      if (!meta) { failed++; continue; }
      fileId = missing ? missing.sourceId : uid();
      if (!(await saveFile(file, fileId).catch(() => null))) { failed++; continue; }
      if (missing) { repairFileMeta(fileId, file); repaired++; continue; }
      picked.durationMs = meta.durationMs;
    }
    for (const [pid, k, x] of matches) {
      store.replaceTrack(pid, k, {
        source: 'file', sourceId: fileId, title: x.title, artist: x.artist, artwork: x.artwork, artworkLg: x.artworkLg,
        durationMs: picked.durationMs || x.durationMs, fileName: file.name, size: file.size, origin: x.origin, ytId: ytId || x.sourceId,
      });
      where.add(pid);
    }
    linked++;
  }
  const parts = [
    linked && `${linked} collegati in ${where.size} ${where.size === 1 ? 'playlist' : 'playlist'}`,
    repaired && `${repaired} ripristinati`,
    already && `${already} già importati`,
    unknown && `${unknown} non riconosciuti`,
    failed && `${failed} non salvati`,
  ].filter(Boolean);
  enrichFiles();
  refresh();
  if (!unknownNames.length) {
    toast(parts.join(' · ') || 'Niente da importare', { ms: 4000, error: !linked && !repaired && !!failed });
    return;
  }
  const left = store.all().reduce((n, p) => n + p.tracks.filter((t) => t.source === 'file' && !fileExists(t.sourceId)).length, 0);
  panel(`
    <div class="sheet-title">Importazione</div>
    <p class="gfoot" style="margin-top:0">${esc(parts.join(' · '))}${left ? ` · ancora ${left} brani con il file mancante` : ''}</p>
    <div class="ghead">Non riconosciuti</div>
    <div class="cv-list"><ol class="guide">${unknownNames.slice(0, 80).map((n) => `<li>${esc(n)}</li>`).join('')}</ol></div>
    <p class="gfoot">Questi file non corrispondono a nessun brano mancante o da scaricare: forse sono canzoni che non sono più in nessuna playlist. Per collegarne uno a mano: menu ··· della canzone → «Scegli di nuovo il file».</p>
    <div class="form"><button class="btn" data-close>Fine</button></div>`, null, 'Importazione');
}

/** Il file mancante con la stessa durata (entro 1,5 s) e qualche parola del titolo in comune. */
function missingByDuration(base, ms) {
  if (!ms) return null;
  const words = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const got = new Set(words(base));
  let best = null;
  for (const pl of store.all()) for (const x of pl.tracks) {
    if (x.source !== 'file' || fileExists(x.sourceId) || !x.durationMs) continue;
    const d = Math.abs(x.durationMs - ms);
    if (d > 1500) continue;
    const tw = words(`${x.title} ${x.ytTitle || ''} ${x.artist}`);
    const hit = tw.filter((w) => got.has(w)).length;
    if (!hit && d > 400) continue;
    const sc = hit * 3 - d / 300;
    if (!best || sc > best.sc) best = { x, sc };
  }
  return best?.x || null;
}

async function playlistMenu(p) {
  const c = await actionSheet([
    { label: p.pinned ? 'Non fissare' : 'Fissa in alto', icon: 'pin', value: 'pin' },
    { label: 'Aggiungi brani', icon: 'plus', value: 'add' },
    ...(p.tracks.some((t) => t.source === 'youtube') ? [{ label: 'Scarica i brani YouTube', icon: 'download', value: 'download' }] : []),
    ...(p.clone ? [{ label: 'Aggiorna dalla playlist Spotify', icon: 'sync', value: 'clone-go' }]
      : p.tracks.some((t) => t.source === 'spotify') ? [{ label: 'Copia su YouTube', icon: 'plus', value: 'clone' }] : []),
    { label: 'Modifica', icon: 'grip', value: 'edit' },
    { label: 'Rinomina', icon: 'pencil', value: 'rename' },
    // Solo da Duetto: su Spotify la playlist resta com'è e non torna col sync.
    { label: 'Rimuovi da Duetto', icon: 'trash', value: 'delete', danger: true },
  ], { title: p.name, sub: `${p.tracks.length} brani`, artHtml: cover(p) });
  if (c === 'clone') cloneToYouTube(p);
  if (c === 'clone-go') runClone(p.id);
  if (c === 'download') downloadSheet(p.tracks.filter((t) => t.source === 'youtube'), p.id);
  if (c === 'pin') { store.togglePin(p.id); toast(p.pinned ? 'Non più fissata' : 'Fissata in alto', { ms: 1400 }); }
  if (c === 'add') location.hash = `#/playlist/${p.id}/add`;
  if (c === 'edit') { editing = true; refresh(); }
  if (c === 'rename') {
    const name = await askText('Rinomina', p.name);
    if (name) store.rename(p.id, name);
  }
  if (c === 'delete') {
    const index = store.all().indexOf(p);
    store.remove(p.id);
    location.hash = '#/';
    toast(`"${p.name}" rimossa da Duetto`, { action: { label: 'Annulla', fn: () => store.restore(p, index) } });
  }
}

async function trackMenu(p, i) {
  const t = p.tracks[i];
  const c = await actionSheet([
    { label: 'Riproduci dopo', icon: 'next-up', value: 'next' },
    { label: 'Aggiungi alla coda', icon: 'queue', value: 'queue' },
    { label: 'Aggiungi a una playlist', icon: 'plus', value: 'copy' },
    ...(t.source === 'youtube' ? [
      { label: 'Scarica sul telefono', icon: 'download', value: 'download' },
      { label: 'Collega un file', icon: 'link', value: 'link-file' },
      { label: 'Cambia video YouTube', icon: 'sync', value: 'change-video' },
    ] : []),
    ...(t.source === 'file' && !fileExists(t.sourceId) ? [{ label: 'Scegli di nuovo il file', icon: 'link', value: 'link-file' }] : []),
    ...(t.source === 'file' && (t.ytId || t.yt || t.origin) ? [{ label: 'Cambia video YouTube', icon: 'sync', value: 'change-video' }] : []),
    ...(t.source !== 'file' ? [{ label: `Apri in ${srcName(t.source)}`, icon: 'link', value: 'open' }] : []),
    { label: 'Togli da questa playlist', icon: 'trash', value: 'remove', danger: true },
  ], { track: t });
  if (c === 'clone') cloneToYouTube(p);
  if (c === 'clone-go') runClone(p.id);
  if (c === 'download') downloadSheet([t]);
  if (c === 'link-file') linkFileSheet(t);
  if (c === 'change-video') changeVideo(t);
  if (c === 'next') playNext(t);
  if (c === 'queue') { player.enqueue(t); toast('In coda', { ms: 1400 }); }
  if (c === 'copy') addToPlaylist([t]);
  if (c === 'open') window.open(t.source === 'spotify' ? `https://open.spotify.com/track/${t.sourceId}` : `https://www.youtube.com/watch?v=${t.sourceId}`, '_blank');
  if (c === 'remove') removeWithUndo(p, i);
}

/** Brano di riferimento per cercare un video: il brano Spotify d'origine se c'è, altrimenti il brano stesso. */
function refTrack(t) {
  if (t.origin) for (const p of store.all()) for (const x of p.tracks) if (cloneKey(x) === t.origin) return x;
  return t;
}
const fmtDur = (ms) => (ms ? `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}` : '');
const diffLabel = (ms, ref) => {
  if (!ms || !ref) return '';
  const d = Math.round((ms - ref) / 1000);
  return Math.abs(d) <= 2 ? 'durata uguale' : `${d > 0 ? '+' : '−'}${Math.abs(d)} s`;
};

/**
 * "Cambia video": quando la ricerca automatica ha scelto il video sbagliato. Si cerca con un
 * testo modificabile, si confrontano durata e canale con il brano Spotify, si guarda il video
 * su YouTube prima di sceglierlo, o si incolla un link. Vale in tutte le playlist dove c'è quel
 * video (o quel file); titolo, artista, copertina e origine restano quelli di Spotify. Un file
 * già scaricato torna "da scaricare" con il video nuovo.
 */
function changeVideo(t) {
  const ref = refTrack(t);
  const refMs = t.refMs || (ref !== t ? ref.durationMs : null) || (t.source === 'youtube' ? null : t.durationMs);
  const curId = t.source === 'youtube' ? t.sourceId : t.ytId || null;
  const q0 = `${String(ref.artist || '').split(',')[0]} ${ref.title}`.trim();
  let list = [];
  const d = panel(`
    <div class="sheet-head">${artHTML(t)}<div class="grow"><div class="t">${esc(ref.title)}</div><div class="s">${esc(ref.artist || '')}${refMs ? ` · ${fmtDur(refMs)}${ref.source === 'spotify' ? ' su Spotify' : ''}` : ''}</div></div></div>
    <form class="cv-bar" id="cv-form" role="search">
      <input id="cv-q" type="search" enterkeyhint="search" autocomplete="off" spellcheck="false" value="${esc(q0)}" aria-label="Cerca su YouTube">
      <button class="btn small accent" type="submit">Cerca</button>
    </form>
    <div class="cv-list" id="cv-list" aria-live="polite"></div>
    <form class="cv-bar" id="cv-link">
      <input id="cv-url" type="url" inputmode="url" autocomplete="off" placeholder="…oppure incolla un link YouTube" aria-label="Link YouTube">
      <button class="btn small" type="submit">Usa</button>
    </form>
    <p class="gfoot">Ogni ricerca usa una delle ~95 ricerche giornaliere. «Guarda» apre il video su YouTube.</p>`, (e) => {
    const w = e.target.closest('[data-cv-watch]');
    if (w) { window.open(`https://www.youtube.com/watch?v=${w.dataset.cvWatch}`, '_blank'); return; }
    const r = e.target.closest('[data-cv]');
    if (r) pick(list[Number(r.dataset.cv)]);
  }, 'Cambia video');

  const paint = (msg) => {
    const box = $('#cv-list', d);
    if (msg) { box.innerHTML = `<p class="gfoot cv-msg">${esc(msg)}</p>`; return; }
    box.innerHTML = list.map((v, i) => {
      const cur = v.sourceId === curId;
      const diff = diffLabel(v.durationMs, refMs);
      const far = refMs && v.durationMs && Math.abs(v.durationMs - refMs) > 10000;
      return `<div class="row cv-row${cur ? ' cur' : ''}" ${cur ? '' : `data-cv="${i}" role="button" tabindex="0"`} aria-label="${esc(`${v.title}, ${v.artist}, ${fmtDur(v.durationMs)}`)}">
        ${artHTML(v)}
        <div class="grow">
          <div class="t">${esc(v.title)}</div>
          <div class="s"><span>${cur ? '<b>Attuale</b> · ' : ''}${esc(v.artist)} · ${fmtDur(v.durationMs)}${diff ? ` · <span class="${far ? 'warn' : ''}">${diff}</span>` : ''}${v.blocked ? ` · <span class="warn">⚠︎ ${esc(v.blocked)}</span>` : ''}</span></div>
        </div>
        <button class="btn small" type="button" data-cv-watch="${esc(v.sourceId)}">Guarda</button>
      </div>`;
    }).join('') || '<p class="gfoot cv-msg">Nessun risultato: cambia il testo e riprova.</p>';
  };

  const search = async (q) => {
    paint('Cerco su YouTube…');
    try {
      const found = await yt.searchFor(q, { ...ref, refMs });
      const cur = curId && !found.some((v) => v.sourceId === curId) ? await yt.videos([curId]).catch(() => []) : [];
      list = [...cur, ...found];
      paint();
    } catch (e) { paint(e.message); }
  };

  const pick = async (v) => {
    if (!v) return;
    if (t.source === 'file') {
      const c = await actionSheet([{ label: 'Usa questo video', icon: 'sync', value: 'ok', danger: true }], { title: 'Il file attuale verrà sostituito', sub: 'La canzone torna «da scaricare» con il video nuovo' });
      if (c !== 'ok') return;
    }
    let n = 0;
    for (const pl of store.all()) pl.tracks.forEach((x, k) => {
      const same = (x.source === 'youtube' && t.source === 'youtube' && x.sourceId === t.sourceId) || (x.source === 'file' && t.source === 'file' && x.sourceId === t.sourceId);
      if (!same) return;
      store.replaceTrack(pl.id, k, {
        source: 'youtube', sourceId: v.sourceId, title: x.title, artist: x.artist, artwork: x.artwork || v.artwork, artworkLg: x.artworkLg || null,
        durationMs: v.durationMs, refMs: x.refMs || refMs || null, ytTitle: v.title, origin: x.origin, blocked: v.blocked || undefined, albumId: x.albumId,
      });
      n++;
    });
    close();
    toast(v.blocked ? `Video cambiato, ma è ${v.blocked}: potrebbe non scaricarsi` : `Video cambiato${n > 1 ? ` in ${n} playlist` : ''}: ora tocca ↓ per scaricarlo`, { ms: 3500, error: !!v.blocked });
    refresh();
  };

  $('#cv-form', d).addEventListener('submit', (e) => { e.preventDefault(); const q = $('#cv-q', d).value.trim(); if (q) search(q); });
  $('#cv-link', d).addEventListener('submit', async (e) => {
    e.preventDefault();
    const link = parseLink($('#cv-url', d).value);
    if (link?.source !== 'youtube') { toast('Non è un link YouTube', { error: true }); return; }
    try {
      const [v] = await yt.videos([link.sourceId]);
      if (!v) { toast('Video non trovato', { error: true }); return; }
      pick(v);
    } catch (err) { toast(err.message, { error: true }); }
  });
  search(q0);
}

// ---------- Scaricare i brani YouTube sul telefono ----------
// Un'app web non può prendere l'audio da YouTube (il browser lo vieta e i server pubblici
// sono bloccati). Lo fa un comando rapido di iPhone che lavora dal telefono: Duetto gli passa
// i link, il comando salva i file nell'app File, e da Aggiungi → File si importano (i brani
// YouTube con lo stesso titolo vengono sostituiti dai file).
const SHORTCUT = 'Scarica per Duetto';

// Al ritorno dal comando rapido: una canzone → foglio "Collega il file" per quella canzone;
// più canzoni (playlist) → scheda Aggiungi → File della playlist.
let pendingDownload = null; // { playlistId, track?, at }

// Comando di a-Shell. "python3 -m yt_dlp" funziona anche senza il comando corto "yt-dlp";
// il codice del video nel nome del file permette a Duetto di riconoscerlo con certezza.
// Comando unico (in a-Shell il ";" non separa i comandi): -P sceglie la cartella e la crea.
const DL_CMD = 'python3 -m yt_dlp -P "~/Documents/Duetto" -f "ba[ext=m4a]/ba" -o "%(title)s [%(id)s].%(ext)s" ';

// Tutti i file in un'unica cartella (File → a-Shell → Duetto): un file può stare in più playlist.
const dlArgs = (tracks) => tracks.map((t) => `"https://www.youtube.com/watch?v=${t.sourceId}"`).join(' ');

/** Foglio "Scarica": 1) Copia il comando (con i link)  2) Scarica → apre a-Shell, incolli. */
function downloadSheet(tracks, playlistId = route?.id || player.context?.id || null) {
  if (!tracks.length) return;
  const full = DL_CMD + dlArgs(tracks);
  const head = tracks.length === 1
    ? `<div class="sheet-head">${artHTML(tracks[0])}<div class="grow"><div class="t">${esc(tracks[0].title)}</div><div class="s">${esc(tracks[0].artist)}</div></div></div>`
    : `<div class="sheet-title">${tracks.length} brani</div>`;
  panel(`${head}
    <p class="gfoot">I file vanno in File → a-Shell → Duetto. Poi tocca «Importa file» nella playlist e scegli tutti i file della cartella.</p>
    <div class="form">
      <button class="btn" data-dl-copy>1 · Copia</button>
      <button class="btn accent" data-dl-go>2 · Scarica</button>
    </div>`, async (e) => {
    if (e.target.closest('[data-dl-copy]')) {
      try { await navigator.clipboard.writeText(full); toast('Copiato', { ms: 1200 }); } catch { toast('Copia non riuscita', { error: true }); }
    }
    if (e.target.closest('[data-dl-go]')) { close(); downloadViaShortcut(tracks, playlistId); }
  }, 'Scarica');
}

function downloadViaShortcut(tracks, playlistId = route?.id || player.context?.id || null) {
  if (!tracks.length) return;
  pendingDownload = { playlistId, track: tracks.length === 1 ? tracks[0] : null, at: Date.now() };
  const urls = tracks.map((t) => `https://www.youtube.com/watch?v=${t.sourceId}`).join(' ');
  // Rete di sicurezza: il comando completo (con i link) va negli appunti. Se a-Shell si apre
  // senza partire, basta incollarlo e premere Invio. La copia parte dentro il tocco.
  navigator.clipboard?.writeText(DL_CMD + dlArgs(tracks)).catch(() => {});
  location.href = `shortcuts://run-shortcut?name=${encodeURIComponent(SHORTCUT)}&input=text&text=${encodeURIComponent(urls)}`;
}

/** Brano file la cui copia audio manca, che corrisponde al file scelto (nome o titolo). */
function findMissingFile(picked) {
  const ytId = picked.ytId || /\[([A-Za-z0-9_-]{11})\]\s*\.[a-z0-9]{2,4}$/i.exec(picked.file.name)?.[1] || null;
  let byTitle = null;
  for (const pl of store.all()) for (const x of pl.tracks) {
    if (x.source !== 'file' || fileExists(x.sourceId)) continue;
    // Prima il nome del file o il codice del video (sicuri), poi il titolo (anche quello YouTube).
    if (x.fileName === picked.file.name || (ytId && (x.ytId === ytId || x.fileName?.includes(`[${ytId}]`)))) return x;
    if (!byTitle && picked.key && (titleKey(x.title) === picked.key || titleKey(x.ytTitle) === picked.key)) byTitle = x;
  }
  return byTitle;
}

/** Aggiorna nome e dimensione del file in tutti i brani che usano quella copia. */
function repairFileMeta(sourceId, file) {
  for (const pl of store.all()) pl.tracks.forEach((x, k) => {
    if (x.source === 'file' && x.sourceId === sourceId && (x.fileName !== file.name || x.size !== file.size)) {
      store.replaceTrack(pl.id, k, { ...x, fileName: file.name, size: file.size });
    }
  });
}

/** Il file prende il posto del brano YouTube (stesso video) in tutte le playlist. */
function linkFileToTrack(ytTrack, fileTrack) {
  let n = 0;
  for (const pl of store.all()) {
    pl.tracks.forEach((x, k) => {
      if (x.source === 'youtube' && x.sourceId === ytTrack.sourceId) { store.replaceTrack(pl.id, k, fileTrack); n++; }
    });
  }
  return n;
}

/**
 * Foglio per collegare un file audio a una canzone YouTube precisa: un tocco su "Scegli il
 * file", si sceglie il file appena scaricato e viene associato subito a quella canzone.
 */
function linkFileSheet(t) {
  const d = panel(`
    <div class="sheet-head">${artHTML(t)}<div class="grow"><div class="t">${esc(t.title)}</div><div class="s">${t.source === 'file' ? 'Scegli di nuovo il file' : 'Collega il file scaricato'}</div></div></div>
    <div class="form">
      <button class="btn accent" data-link-pick>Scegli il file</button>
      <input type="file" id="link-pick" accept="audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg,.opus" hidden>
    </div>`, (e) => {
    if (e.target.closest('[data-link-pick]')) $('#link-pick', d).click();
  }, 'Collega il file scaricato');
  $('#link-pick', d).addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const btn = $('[data-link-pick]', d);
    btn.disabled = true; btn.textContent = 'Salvo…';
    // Se il nome contiene il codice di un altro video, meglio chiedere conferma.
    const fileYt = /\[([A-Za-z0-9_-]{11})\]\s*\.[a-z0-9]{2,4}$/i.exec(file.name)?.[1];
    if (t.source === 'youtube' && fileYt && fileYt !== t.sourceId) {
      close();
      const ok = await actionSheet([{ label: 'Collega lo stesso', icon: 'link', value: 'ok' }],
        { title: 'Questo file sembra di un\'altra canzone', sub: file.name });
      if (ok !== 'ok') return;
    }
    if (t.source === 'file') {
      // Brano "File mancante": si ricrea la copia con lo stesso id (tutte le playlist tornano a posto).
      const ok = await saveFile(file, t.sourceId).catch(() => null);
      close();
      if (!ok) { toast('Questo file non si riesce a salvare', { error: true }); return; }
      repairFileMeta(t.sourceId, file);
      toast(`"${t.title}" ripristinato`, { ms: 2000 });
      refresh();
      return;
    }
    const same = findSameFile(store.all(), file.name, file.size);
    let id = same && fileExists(same.sourceId) ? same.sourceId : null;
    let meta = null;
    if (!id) {
      meta = await saveFile(file).catch(() => null);
      if (!meta) { close(); toast('Questo file non si riesce a salvare', { error: true }); return; }
      id = meta.id;
    }
    const fileTrack = {
      source: 'file', sourceId: id, title: t.title, artist: t.artist, artwork: t.artwork || null,
      durationMs: meta?.durationMs || same?.durationMs || t.durationMs || null, fileName: file.name, size: file.size,
    };
    const n = linkFileToTrack(t, fileTrack);
    close();
    toast(n ? `"${t.title}" ora suona dal telefono` : 'Collegato', { ms: 2200 });
    refresh();
  });
}

function showDownloadGuide() {
  const cmd = DL_CMD;
  panel(`
    <div class="sheet-title">Scaricare i brani YouTube</div>
    <ol class="guide">
      <li>Installa <b>a-Shell</b> dall'App Store (gratis), aprila e scrivi <code>pip install yt-dlp</code>, poi Invio.</li>
      <li>Apri <b>Comandi</b> → <b>+</b> → chiamalo <b>${SHORTCUT}</b>.</li>
      <li>Aggiungi l'azione di a-Shell <b>Execute Command</b>, incolla il comando qui sotto e aggiungi alla fine (dopo uno spazio) la variabile <b>Input comando rapido</b>.</li>
      <li>Tocca la freccia <b>›</b> dell'azione e imposta l'esecuzione su <b>App</b> (non "Estensione"): yt-dlp funziona solo dentro l'app.</li>
    </ol>
    <pre class="diag">${esc(cmd)}</pre>
    <div class="form"><button class="btn" data-copy-cmd>Copia il comando</button></div>
    <ol class="guide" start="5">
      <li>In Duetto tocca <b>↓</b> su una canzone: a-Shell la scarica. Se a-Shell si apre ma non parte, tieni premuto, <b>Incolla</b> e premi Invio (il comando con il link è già negli appunti).</li>
      <li>Torna in Duetto → <b>Scegli il file</b>: la canzone viene collegata da sola.</li>
      <li>Per tante canzoni: <b>Scarica tutti</b> in cima alla playlist, poi <b>Importa file</b> e scegli tutti i file della cartella <b>File → a-Shell → Duetto</b>: ognuno si collega da solo, in tutte le playlist.</li>
      <li>Dopo l'importazione Duetto ha una sua copia: i file nella cartella puoi spostarli o cancellarli senza perdere niente.</li>
    </ol>`, async (e) => {
    if (!e.target.closest('[data-copy-cmd]')) return;
    try { await navigator.clipboard.writeText(cmd); toast('Copiato', { ms: 1200 }); } catch { toast('Copia non riuscita', { error: true }); }
  }, 'Scaricare i brani YouTube');
}

function playNext(t) {
  player.playNext(t);
  toast('Dopo questo brano', { ms: 1400 });
}

function removeWithUndo(p, i) {
  const t = p.tracks[i];
  store.removeTrack(p.id, i);
  toast('Brano tolto', { action: { label: 'Annulla', fn: () => store.unremoveTrack(p.id, i, t) } });
}

/** Aggiunge brani a una playlist scelta da un foglio. */
async function addToPlaylist(tracks) {
  const c = await actionSheet([
    { label: 'Nuova playlist', icon: 'plus', value: '__new' },
    ...store.all().map((p) => ({ label: p.name, sub: `${p.tracks.length} brani`, artHtml: cover(p), value: p.id })),
  ], tracks.length === 1 ? { track: tracks[0] } : { title: `${tracks.length} brani` });
  if (!c) return false;
  let id = c;
  if (c === '__new') {
    const p = await newPlaylist();
    if (!p) return false;
    id = p.id;
  }
  store.addTracks(id, tracks);
  toast(`Aggiunto a "${store.get(id).name}"`, { ms: 1600 });
  return true;
}

enableSwipe(view, {
  // Come Spotify: scorrere sulla riga mette il brano in fondo alla coda (il primo aggiunto suona per primo).
  onLead: (i) => { const p = store.get(route?.id); if (p?.tracks[i]) { player.enqueue(p.tracks[i]); toast('In coda', { ms: 1400 }); } },
  onTrail: (i) => { const p = store.get(route?.id); if (p?.tracks[i]) removeWithUndo(p, i); },
});

// Riordino con trascinamento (modalità Modifica).
view.addEventListener('pointerdown', (e) => {
  const grip = e.target.closest('[data-grip]');
  if (!grip || route?.name !== 'playlist') return;
  e.preventDefault();
  const row = grip.closest('.row');
  const rows = $$('#tracks .row');
  const from = rows.indexOf(row);
  const h = row.offsetHeight;
  const y0 = e.clientY;
  let to = from;
  dragging = true;
  row.classList.add('dragging');
  grip.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const dy = ev.clientY - y0;
    row.style.transform = `translateY(${dy}px)`;
    to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / h)));
    rows.forEach((r, k) => {
      if (r === row) return;
      const shift = from < to && k > from && k <= to ? -h : from > to && k < from && k >= to ? h : 0;
      r.style.transition = 'transform 200ms var(--ease-out)';
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', up);
    dragging = false;
    rows.forEach((r) => { r.style.transform = ''; r.style.transition = ''; });
    row.classList.remove('dragging');
    if (to !== from) store.moveTrack(route.id, from, to);
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
});

// ---------- Ricerca e importazione (condivise da Cerca e Aggiungi) ----------

function newSearch() {
  return { source: 'spotify', query: '', items: [], group: null, loading: false, error: null, offset: 0, pageToken: null, hasMore: false, seq: 0 };
}
const searches = { search: newSearch(), add: newSearch() };
let selected = new Map(); // uri -> brano, per "Aggiungi"
let selectedFor = null;

const SOURCES = { spotify: 'Spotify', youtube: 'YouTube', file: 'File' };
const sourcesFor = () => (route.name === 'add' ? ['spotify', 'youtube', 'file'] : ['spotify', 'youtube']);

function segHTML(s) {
  const list = sourcesFor();
  const on = Math.max(0, list.indexOf(s.source));
  return `<div class="seg" style="--n:${list.length};--on:${on}" role="radiogroup" aria-label="Fonte">
      <span class="thumb" aria-hidden="true"></span>
      ${list.map((k) => `<button data-a="src" data-src="${k}" role="radio" aria-checked="${s.source === k}" class="${s.source === k ? 'on' : ''}">${SOURCES[k]}</button>`).join('')}
    </div>`;
}

function searchHTML(s) {
  return `
    <div class="searchbar" ${s.source === 'file' ? 'hidden' : ''}>
      <form class="sfield" id="sform" role="search">
        ${icon('search')}
        <input id="q" type="search" enterkeyhint="search" autocomplete="off" autocorrect="off" spellcheck="false"
          placeholder="Cerca o incolla un link" value="${esc(s.query)}" aria-label="Cerca brani o incolla un link">
        <button type="button" class="ibtn clear" data-a="clear" aria-label="Cancella" ${s.query ? '' : 'hidden'}>${icon('x-fill')}</button>
      </form>
    </div>
    ${segHTML(s)}
    <input type="file" id="file-pick" accept="audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg,.opus" multiple hidden>
    <div id="results" aria-live="polite">${resultsHTML(s)}</div>`;
}

function resultsHTML(s) {
  const mode = route.name;
  const target = mode === 'add' ? store.get(route.id) : null;
  const inList = new Set(target ? target.tracks.map(trackUri) : []);
  let html = '';
  if (s.source === 'file' && !s.items.length) {
    return `<div class="empty" style="padding-top:8vh">
      <span class="art" aria-hidden="true">${icon('note')}</span>
      <div class="stack"><button class="btn accent" data-a="pick-files">Scegli file audio</button></div>
    </div>`;
  }
  if (s.source === 'file') {
    s.group = `${dot('file')}<span>${s.items.length} ${s.items.length === 1 ? 'file' : 'file'}</span>`;
  }
  if (s.error) html += `<div class="note">${s.error.message ? `<span>${esc(s.error.message)}</span>` : ''}${s.error.fix || ''}</div>`;
  if (s.group) {
    const selectable = s.items.filter((t) => !inList.has(trackUri(t)));
    const all = selectable.length && selectable.every((t) => selected.has(trackUri(t)));
    html += `<div class="group-head"><div class="grow">${s.group}</div>
      ${s.source === 'file' ? `<button class="btn small" data-a="pick-files">Altri</button>` : ''}
      ${mode === 'add'
        ? `<button class="btn small${all ? ' accent' : ''}" data-a="all" aria-pressed="${!!all}">${all ? 'Nessuno' : 'Tutti'}</button>`
        : `<button class="btn small" data-a="add-all">Aggiungi tutti</button>`}
    </div>`;
  }
  html += `<div class="list">${s.items.map((t, i) => {
    const uri = trackUri(t);
    if (mode === 'add') {
      const already = inList.has(uri);
      const on = selected.has(uri);
      return trackRow(t, {
        i, cls: on ? 'sel' : '', role: 'checkbox',
        attrs: already ? 'aria-disabled="true" style="opacity:.45"' : `data-a="pick" data-i="${i}" aria-checked="${on}"`,
        trailing: `<span class="ibtn pick" aria-hidden="true">${icon(already ? 'check' : on ? 'check-fill' : 'circle')}</span>`,
      });
    }
    return trackRow(t, {
      i, attrs: `data-a="res-play" data-i="${i}"`,
      trailing: `<button class="ibtn" data-a="res-add" data-i="${i}" aria-label="Aggiungi ${esc(t.title)} a una playlist">${icon('plus-circle')}</button>`,
    });
  }).join('')}</div>`;
  if (s.loading) html += '<div class="spin" role="status" aria-label="Caricamento"></div>';
  else if (s.hasMore) html += '<div id="more-sentinel" style="height:1px"></div>';
  else if (s.query && !s.items.length && !s.error) html += '<div class="note">Nessun risultato</div>';
  return html;
}

function paintResults() {
  const box = $('#results');
  if (!box) return;
  const s = searches[route.name];
  box.innerHTML = resultsHTML(s);
  markCurrent(box);
  const sentinel = $('#more-sentinel');
  if (sentinel) {
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) { io.disconnect(); runSearch(true); }
    }, { root: view, rootMargin: '400px' });
    io.observe(sentinel);
  }
  if (route.name === 'add') updateImportBar();
}

function bindSearch() {
  const s = searches[route.name];
  const input = $('#q');
  let timer;
  $('#sform').addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(timer);
    s.query = input.value.trim();
    input.blur();
    runSearch(false);
  });
  input.addEventListener('input', () => {
    const v = input.value.trim();
    $('[data-a="clear"]').hidden = !v;
    clearTimeout(timer);
    // Link incollato: parte subito. Spotify: ricerca dal vivo. YouTube: con Invio (quota).
    if (parseLink(v) || parseCollection(v)) { s.query = v; input.blur(); runSearch(false); return; }
    if (s.source === 'spotify' && v.length > 1) timer = setTimeout(() => { s.query = v; runSearch(false); }, 380);
  });
}

function needSpotify() {
  return !spotify.isLoggedIn() ? { message: '', fix: '<a class="btn accent" href="#/settings">Collega Spotify</a>' } : null;
}
function needYouTube() {
  return !settings.youtubeApiKey ? { message: '', fix: '<a class="btn" href="#/settings">Aggiungi la chiave YouTube</a>' } : null;
}

function setSegment(src) {
  const seg = $('.seg');
  if (!seg) return;
  seg.style.setProperty('--on', String(Math.max(0, sourcesFor().indexOf(src))));
  const bar = $('.searchbar');
  if (bar) bar.hidden = src === 'file';
  $$('.seg button').forEach((b) => { b.classList.toggle('on', b.dataset.src === src); b.setAttribute('aria-checked', b.dataset.src === src); });
}

async function runSearch(more) {
  const mode = route.name;
  const s = searches[mode];
  const q = s.query;
  if (!q) { s.items = []; s.group = null; s.error = null; paintResults(); return; }
  const seq = ++s.seq;
  if (!more) { s.items = []; s.group = null; s.offset = 0; s.pageToken = null; }
  s.loading = true; s.error = null; s.hasMore = false;
  paintResults();
  try {
    const coll = !more && parseCollection(q);
    const link = !more && !coll && parseLink(q);
    const src = coll?.source || link?.source || s.source;
    if (src !== s.source) { s.source = src; setSegment(src); }
    const missing = src === 'spotify' ? needSpotify() : needYouTube();
    if (missing) { s.error = missing; return; }
    const inList = new Set((store.get(route.id)?.tracks || []).map(trackUri));

    if (coll) {
      let res;
      if (coll.source === 'youtube') {
        res = await yt.playlistVideos(coll.id);
        // Link "video dentro una playlist": il video va in cima ed è l'unico selezionato.
        if (coll.videoId) {
          const k = res.tracks.findIndex((t) => t.sourceId === coll.videoId);
          if (k > 0) res.tracks.unshift(...res.tracks.splice(k, 1));
        }
      } else if (coll.kind === 'album') {
        const r = await spotify.albumTracks(coll.id);
        res = { title: r.name, tracks: r.tracks };
      } else {
        const [info, tracks] = await Promise.all([spotify.playlistInfo(coll.id).catch(() => null), spotify.playlistTracks(coll.id)]);
        res = { title: info?.name, tracks };
      }
      if (seq !== s.seq) return;
      s.items = res.tracks;
      s.group = `${dot(coll.source)}<span>${esc(res.title || srcName(coll.source))}</span>`;
      if (mode === 'add') {
        const pick = coll.videoId ? res.tracks.filter((t) => t.sourceId === coll.videoId) : res.tracks;
        pick.forEach((t) => { if (!inList.has(trackUri(t))) selected.set(trackUri(t), t); });
      }
    } else if (link) {
      const t = link.source === 'spotify' ? await spotify.getTrack(link.sourceId) : (await yt.videos([link.sourceId]))[0];
      if (seq !== s.seq) return;
      s.items = t ? [t] : [];
      if (t && mode === 'add' && !inList.has(trackUri(t))) selected.set(trackUri(t), t);
    } else if (s.source === 'spotify') {
      const r = await spotify.searchTracks(q, s.offset);
      if (seq !== s.seq) return;
      s.items = [...s.items, ...r.tracks];
      s.offset += 10;
      s.hasMore = r.hasMore && s.offset < 100;
    } else {
      const r = await yt.searchVideos(q, { musicOnly: settings.youtubeMusicOnly, pageToken: s.pageToken });
      if (seq !== s.seq) return;
      s.items = [...s.items, ...r.tracks];
      s.pageToken = r.nextPageToken;
      s.hasMore = !!r.nextPageToken && s.items.length < 60;
    }
  } catch (e) {
    if (seq !== s.seq) return;
    s.error = { message: e.status === 403 || e.status === 404 ? 'Non è possibile aprire questo link' : e.message };
  } finally {
    if (seq === s.seq) {
      s.loading = false;
      if (route?.name === mode) paintResults();
    }
  }
}

function switchSource(src) {
  const s = searches[route.name];
  if (s.source === src) return;
  s.source = src;
  setSegment(src);
  s.items = src === 'file' ? [...pickedFiles.values()].map((x) => x.track) : [];
  s.group = null; s.error = null; s.hasMore = false;
  const q = s.query;
  if (src !== 'file' && q && (src === 'spotify' || parseLink(q) || parseCollection(q))) runSearch(false);
  else paintResults();
}

// ---------- File audio dal telefono ----------
// I file scelti restano in memoria finché non si preme Importa: solo allora vengono salvati.
let pickedFiles = new Map(); // id provvisorio -> { file, track, key }

async function onFilesPicked(e) {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  const s = searches.add;
  s.loading = true; paintResults();
  let bad = 0;
  for (const file of files) {
    const meta = await probeFile(file);
    if (!meta) { bad++; continue; }
    const id = uid();
    const { title, artist } = parseFileName(file.name);
    const track = { source: 'file', sourceId: id, title, artist, artwork: null, durationMs: meta.durationMs };
    const ytId = /\[([A-Za-z0-9_-]{11})\]\s*\.[a-z0-9]{2,4}$/i.exec(file.name)?.[1] || null;
    const base = file.name.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/\s*\[[A-Za-z0-9_-]{11}\]\s*$/, '');
    pickedFiles.set(id, { file, track, key: titleKey(base), ytId });
    selected.set(trackUri(track), track);
  }
  s.loading = false;
  s.items = [...pickedFiles.values()].map((x) => x.track);
  paintResults();
  if (bad) toast(bad === 1 ? 'Un file non è un audio leggibile' : `${bad} file non sono audio leggibili`, { error: true });
}

// ---------- Cerca ----------

function renderSearch() {
  view.innerHTML = `${navBar({ title: 'Cerca' })}<h1 class="large" tabindex="-1">Cerca</h1>${searchHTML(searches.search)}`;
  bindSearch();
  if (searches.search.hasMore) paintResults();
}

// ---------- Aggiungi a playlist ----------

function renderAdd({ fresh }) {
  const p = store.get(route.id);
  if (!p) { location.replace('#/'); return; }
  if (fresh || selectedFor !== p.id) {
    selected = new Map();
    selectedFor = p.id;
    searches.add = { ...newSearch(), source: searches.add.source };
    pickedFiles = new Map();
  }
  view.innerHTML = `
    ${navBar({ title: 'Aggiungi', always: true, left: backBtn() })}
    <h1 class="sr" tabindex="-1">Aggiungi a ${esc(p.name)}</h1>
    <div style="height:8px"></div>
    ${searchHTML(searches.add)}`;
  bindSearch();
  $('#file-pick').addEventListener('change', onFilesPicked);
  if (searches.add.source === 'file') { searches.add.items = [...pickedFiles.values()].map((x) => x.track); paintResults(); }
  updateImportBar();
  if (fresh && searches.add.source !== 'file') setTimeout(() => $('#q')?.focus({ preventScroll: true }), 400);
}

const importBar = $('#importbar');
function updateImportBar() {
  const n = selected.size;
  const show = route?.name === 'add' && n > 0;
  importBar.classList.toggle('show', show);
  importBar.inert = !show;
  if (n) $('#import-btn').textContent = `Importa ${n}`;
}
function hideImportBar() { importBar.classList.remove('show'); importBar.inert = true; }

$('#import-btn').addEventListener('click', async () => {
  const p = store.get(route?.id);
  if (!p || !selected.size) return;
  const btn = $('#import-btn');
  btn.disabled = true;
  const tracks = [];
  let replaced = 0;
  let failed = 0;
  let already = 0;
  let repaired = 0;
  for (let t of selected.values()) {
    if (t.source !== 'file') { tracks.push(t); continue; }
    const picked = pickedFiles.get(t.sourceId);
    if (!picked) { failed++; continue; }
    // Stesso file già importato (stesso nome e dimensione): si riusa la copia esistente.
    const same = findSameFile(store.all(), picked.file.name, picked.file.size);
    if (same && fileExists(same.sourceId)) {
      t = { ...t, sourceId: same.sourceId, fileName: same.fileName, size: same.size };
    } else {
      // Brano "File mancante" (es. dopo un ripristino del backup su un'altra installazione):
      // stesso file o stesso titolo → si ricrea la copia con lo STESSO id, così tutte le
      // playlist che lo usano tornano a funzionare, senza aggiungere doppioni.
      const missing = same || findMissingFile(picked);
      const saved = await saveFile(picked.file, missing ? missing.sourceId : t.sourceId).catch(() => null);
      if (!saved) { failed++; continue; }
      if (missing) { repairFileMeta(missing.sourceId, picked.file); repaired++; continue; }
      t = { ...t, fileName: picked.file.name, size: picked.file.size };
    }
    // Il file prende il posto del brano YouTube con lo stesso titolo, in TUTTE le playlist:
    // così le playlist restano allineate.
    let replacedHere = false;
    for (const pl of store.all()) {
      pl.tracks.forEach((x, k) => {
        // Prima per codice del video (nel nome del file), poi per titolo.
        if (x.source === 'youtube' && ((picked.ytId && x.sourceId === picked.ytId) || (picked.key && titleKey(x.title) === picked.key))) {
          store.replaceTrack(pl.id, k, t);
          if (pl.id === p.id) replacedHere = true;
        }
      });
    }
    if (replacedHere) { replaced++; continue; }
    // Già in questa playlist (stesso file): niente doppione.
    if (store.get(p.id).tracks.some((x) => x.source === 'file' && x.sourceId === t.sourceId) || tracks.some((x) => x.sourceId === t.sourceId)) { already++; continue; }
    tracks.push(t);
  }
  if (tracks.length) store.addTracks(p.id, tracks);
  btn.disabled = false;
  selected = new Map();
  pickedFiles = new Map();
  hideImportBar();
  const added = tracks.length;
  const msg = [
    added ? `${added} ${added === 1 ? 'brano aggiunto' : 'brani aggiunti'}` : '',
    replaced ? `${replaced} ${replaced === 1 ? 'brano YouTube sostituito' : 'brani YouTube sostituiti'} dal file` : '',
    failed ? `${failed} non salvati` : '',
    already ? `${already} già in playlist` : '',
    repaired ? `${repaired} ${repaired === 1 ? 'file ripristinato' : 'file ripristinati'}` : '',
  ].filter(Boolean).join(' · ');
  toast(msg || 'Niente da aggiungere', { ms: 2600, error: !!failed && !added && !replaced && !repaired });
  refresh();
  goBack();
});

// ---------- Impostazioni ----------

let spotifyUser = null;

function renderSettings() {
  const logged = spotify.isLoggedIn();
  view.innerHTML = `
    ${navBar({ title: 'Impostazioni', left: backBtn() })}
    <h1 class="large" tabindex="-1">Impostazioni</h1>

    <div class="ghead">Spotify</div>
    <div class="group">
      ${logged ? `
        <div class="cell ico"><span class="badge">${icon('spotify')}</span><span class="grow">${esc(spotifyUser || 'Connesso')}</span>
          <button class="btn small" data-a="logout">Esci</button></div>
        <button class="cell ico" data-a="device"><span class="badge plain">${icon('device')}</span><span class="grow">Dispositivo</span><span class="val">${esc(settings.spotifyDeviceName || 'Automatico')}</span>${icon('chev')}</button>
        <button class="cell ico" data-a="sync"><span class="badge plain">${icon('sync')}</span><span class="grow">Sincronizza ora</span></button>
        <button class="cell ico" data-a="fullsync"><span class="badge plain">${icon('sync')}</span><span class="grow">Ripristina playlist Spotify</span></button>` : `
        <label class="cell"><span class="grow">Client ID</span>
          <input id="sp-client" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(settings.spotifyClientId)}" placeholder="Incolla"></label>
        <button class="cell" data-a="copy"><span class="grow">Redirect URI</span><span class="mono">${esc(redirectUri())}</span></button>
        <button class="cell tint" data-a="login" ${settings.spotifyClientId ? '' : 'disabled'}>Accedi a Spotify</button>`}
    </div>
    ${logged ? '' : '<p class="gfoot">Client ID e Redirect URI dalla Spotify Developer Dashboard. Tocca la Redirect URI per copiarla.</p>'}

    <div class="ghead">YouTube</div>
    <div class="group">
      ${yt.apiKeys().map((k, i) => `<div class="cell"><span class="grow">Chiave ${i + 1} <span class="mono">••••${esc(k.slice(-4))}</span></span>
        <span class="val">${esc(yt.spent().keys.includes(k) ? 'esaurita oggi' : yt.keyStatus()[k] || 'attiva')}</span>
        <button class="ibtn" data-a="yt-key-rm" data-i="${i}" aria-label="Elimina la chiave ${i + 1}">${icon('trash')}</button></div>`).join('')}
      ${yt.apiKeys().length ? '<button class="cell tint" data-a="yt-key-test">Prova le chiavi</button>' : ''}
      <button class="cell tint" data-a="yt-key-add">${yt.apiKeys().length ? 'Aggiungi un\'altra chiave' : 'Aggiungi la chiave API'}</button>
      <button class="cell" data-a="downloads"><span class="grow">Brani sul telefono</span><span class="val">${downloadsLabel()}</span></button>
      <button class="cell" data-a="dl-guide"><span class="grow">Scaricare i brani</span>${icon('chev')}</button>
    </div>
    <p class="gfoot">I brani YouTube suonano solo scaricati sul telefono: niente pubblicità, niente blocchi, anche a schermo spento. Ogni chiave permette circa 95 ricerche al giorno (si azzerano alle 9:00): con più chiavi, quando una finisce si passa da soli alla successiva. Ogni chiave va creata in un progetto Google Cloud diverso.</p>

    <div class="ghead">Assistenza</div>
    <div class="group">
      <button class="cell ico" data-a="diag"><span class="badge plain">${icon('queue')}</span><span class="grow">Diagnostica</span>${icon('chev')}</button>
    </div>

    <div class="ghead">Playlist</div>
    <div class="group">
      <button class="cell ico" data-a="export"><span class="badge plain">${icon('upload')}</span><span class="grow">Esporta backup</span></button>
      <button class="cell ico" data-a="import"><span class="badge plain">${icon('download')}</span><span class="grow">Ripristina backup</span></button>
    </div>
    <div class="group" style="margin-top:22px">
      <button class="cell" data-a="update"><span class="grow">Aggiorna ora</span><span class="val">versione ${VERSION}</span></button>
    </div>
    <input type="file" id="import-file" accept="application/json,.json" hidden>`;

  $('#sp-client')?.addEventListener('input', (e) => {
    updateSettings({ spotifyClientId: e.target.value.trim() });
    $('[data-a="login"]').disabled = !settings.spotifyClientId;
  });
  $('#import-file').addEventListener('change', importFile);
  if (logged && !spotifyUser) {
    spotify.me().then((u) => { spotifyUser = u?.display_name || u?.id || 'Connesso'; if (route?.name === 'settings') refresh(); }).catch(() => { spotifyUser = 'Connesso'; });
  }
}

function downloadsLabel() {
  const idx = load('hp.audio.index', []);
  const mb = idx.reduce((a, e) => a + (e.size || 0), 0) / 1048576;
  return idx.length ? `${idx.length} · ${mb < 1000 ? Math.round(mb) + ' MB' : (mb / 1024).toFixed(1) + ' GB'}` : 'Nessuno';
}

async function manageDownloads() {
  if (!load('hp.audio.index', []).length) return;
  const c = await actionSheet([{ label: 'Elimina i brani scaricati', icon: 'trash', value: 'clear', danger: true }],
    { title: 'Brani sul telefono', sub: downloadsLabel() });
  if (c !== 'clear') return;
  await clearDownloads();
  toast('Memoria liberata', { ms: 1400 });
  refresh();
}

// ---------- Aggiornamenti ----------
// Controllo diretto: si legge js/version.js dal sito senza cache e si confronta col numero in uso.
async function latestVersion() {
  try {
    const txt = await (await fetch(`js/version.js?t=${Date.now()}`, { cache: 'no-store' })).text();
    return Number(/VERSION\s*=\s*(\d+)/.exec(txt)?.[1]) || null;
  } catch { return null; }
}

/** Svuota la cache dell'app e ricarica (la coda viene salvata e ripresa). */
async function forceUpdate() {
  savePlayer();
  try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* niente cache */ }
  try { (await navigator.serviceWorker?.getRegistration())?.update(); } catch { /* niente service worker */ }
  location.replace(`${location.pathname}?v=${Date.now()}${location.hash}`);
}

let updateOffered = false;
async function checkForUpdate() {
  const v = await latestVersion();
  if (!v || v <= VERSION) return;
  spotify.logEvent(`versione nuova disponibile: ${v} (in uso ${VERSION})`);
  // Un solo tentativo automatico per versione (mai ricariche a ripetizione).
  let tried = null;
  try { tried = sessionStorage.getItem('hp.updateTried'); } catch { /* niente */ }
  if (!player.playing && tried !== String(v)) {
    try { sessionStorage.setItem('hp.updateTried', String(v)); } catch { /* niente */ }
    forceUpdate();
    return;
  }
  if (updateOffered) return;
  updateOffered = true;
  toast(`Versione ${v} disponibile`, { ms: 10000, action: { label: 'Aggiorna', fn: forceUpdate } });
}

function showDiagnostics() {
  const lines = spotify.getLog();
  const text = [`Duetto v${VERSION} ${new Date().toISOString()}`, `collegato: ${spotify.isLoggedIn()}`, `dispositivo salvato: ${settings.spotifyDeviceName || '—'}`, ...lines].join('\n');
  const d = panel(`
    <div class="sheet-title">Diagnostica</div>
    <pre class="diag">${esc(lines.length ? lines.join('\n') : 'Ancora niente: prova a riprodurre un brano, poi torna qui.')}</pre>
    <div class="form"><button class="btn accent" data-copy>Copia</button></div>`, async (e) => {
    if (!e.target.closest('[data-copy]')) return;
    try { await navigator.clipboard.writeText(text); toast('Copiata', { ms: 1200 }); } catch { toast('Copia non riuscita', { error: true }); }
  }, 'Diagnostica');
  return d;
}

function exportPlaylists() {
  const blob = new Blob([store.exportJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `duetto-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const n = store.importJSON(await file.text());
    toast(`${n} playlist ripristinate, senza doppioni`);
  } catch (err) {
    toast(err.message, { error: true });
  }
  e.target.value = '';
}

// ---------- Azioni ----------

view.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-a]');
  if (!el) return;
  if (justSwiped() && el.closest('.swipe')) return;
  const a = el.dataset.a;
  const i = Number(el.dataset.i);
  const p = route.id ? store.get(route.id) : null;

  switch (a) {
    case 'back': goBack(); break;
    case 'new': { const np = await newPlaylist(); if (np) location.hash = `#/playlist/${np.id}`; break; }
    case 'pl-more': playlistMenu(p); break;
    case 'dl-all': downloadSheet(p.tracks.filter((t) => t.source === 'youtube' && !hasLocal(t.sourceId)), p.id); break;
    case 'import-files': {
      const inp = $('#bulk-pick');
      inp.onchange = async () => { const files = [...inp.files]; inp.value = ''; if (files.length) await importDownloaded(files); };
      inp.click();
      break;
    }
    case 'clone-go': runClone(p.id); break;
    case 'add': location.hash = `#/playlist/${p.id}/add`; break;
    case 'done': editing = false; refresh(); break;
    case 'play':
      if (player.context?.id === p.id && player.current) player.toggle();
      else playFrom(p.tracks, player.shuffled ? Math.floor(Math.random() * p.tracks.length) : 0, ctxOf(p));
      break;
    case 'shuffle':
      player.setShuffle(!player.shuffled);
      el.classList.toggle('on', player.shuffled);
      el.setAttribute('aria-pressed', player.shuffled);
      break;
    case 'play-at':
      if (e.target.closest('button')) break;
      // Canzone YouTube non ancora scaricata: il tocco la scarica invece di provare a suonarla.
      if (p.tracks[i]?.source === 'youtube' && !hasLocal(p.tracks[i].sourceId)) { downloadSheet([p.tracks[i]], p.id); break; }
      if (p.tracks[i]?.source === 'file' && !fileExists(p.tracks[i].sourceId)) { linkFileSheet(p.tracks[i]); break; }
      playFrom(p.tracks, i, ctxOf(p));
      break;
    case 'dl': e.stopPropagation(); downloadSheet([p.tracks[i]], p.id); break;
    case 't-more': e.stopPropagation(); trackMenu(p, i); break;
    case 'rm': e.stopPropagation(); removeWithUndo(p, i); break;
    case 'src': switchSource(el.dataset.src); break;
    case 'pick-files': $('#file-pick')?.click(); break;
    case 'clear': {
      const s = searches[route.name];
      s.query = ''; s.items = []; s.group = null; s.error = null; s.hasMore = false; s.seq++;
      $('#q').value = ''; el.hidden = true; $('#q').focus();
      paintResults();
      break;
    }
    case 'pick': {
      const t = searches.add.items[i];
      const uri = trackUri(t);
      if (selected.has(uri)) selected.delete(uri); else selected.set(uri, t);
      const on = selected.has(uri);
      el.classList.toggle('sel', on);
      el.setAttribute('aria-checked', on);
      $('.pick use', el).setAttribute('href', on ? '#i-check-fill' : '#i-circle');
      updateImportBar();
      if (searches.add.group) {
        const btn = $('[data-a="all"]');
        const inList = new Set(p.tracks.map(trackUri));
        const all = searches.add.items.filter((x) => !inList.has(trackUri(x))).every((x) => selected.has(trackUri(x)));
        if (btn) { btn.classList.toggle('accent', all); btn.textContent = all ? 'Nessuno' : 'Tutti'; btn.setAttribute('aria-pressed', all); }
      }
      break;
    }
    case 'all': {
      const inList = new Set(p.tracks.map(trackUri));
      const items = searches.add.items.filter((x) => !inList.has(trackUri(x)));
      const all = items.every((x) => selected.has(trackUri(x)));
      items.forEach((x) => (all ? selected.delete(trackUri(x)) : selected.set(trackUri(x), x)));
      paintResults();
      break;
    }
    case 'res-play': if (!e.target.closest('button')) playFrom(searches.search.items, i); break;
    case 'res-add': e.stopPropagation(); addToPlaylist([searches.search.items[i]]); break;
    case 'add-all': addToPlaylist(searches.search.items); break;
    case 'login': try { await spotify.login(); } catch (err) { toast(err.message, { error: true }); } break;
    case 'logout': spotify.logout(); spotifyUser = null; refresh(); break;
    case 'device': await chooseDevice(); refresh(); break;
    case 'sync': runSync(true); toast('Sincronizzo…', { ms: 1200 }); break;
    case 'fullsync': runSync(true, true); toast('Riscarico le playlist da Spotify…', { ms: 1500 }); break;
    case 'copy':
      try { await navigator.clipboard.writeText(redirectUri()); toast('Copiata', { ms: 1200 }); } catch { toast(redirectUri(), { ms: 8000 }); }
      break;
    case 'diag': showDiagnostics(); break;
    case 'update': forceUpdate(); break;
    case 'downloads': manageDownloads(); break;
    case 'yt-key-add': {
      const k = (await askText('Chiave API YouTube', '', 'Aggiungi'))?.trim();
      if (!k) break;
      const keys = yt.apiKeys();
      if (keys.includes(k)) { toast('Chiave già presente', { ms: 1400 }); break; }
      updateSettings({ youtubeApiKey: [...keys, k].join(',') });
      await yt.testKeys();
      const st = yt.keyStatus()[k];
      toast(st ? `Chiave ${keys.length + 1}: ${st}` : `Chiave ${keys.length + 1} aggiunta e funzionante`, { ms: st ? 6000 : 2000, error: !!st });
      refresh();
      break;
    }
    case 'yt-key-test': {
      toast('Provo le chiavi…', { ms: 4000 });
      const ok = await yt.testKeys();
      toast(ok.every(Boolean) ? 'Tutte le chiavi rispondono' : `${ok.filter((x) => !x).length} ${ok.filter((x) => !x).length === 1 ? 'chiave ha' : 'chiavi hanno'} un problema: vedi accanto`, { ms: 3000, error: !ok.every(Boolean) });
      refresh();
      break;
    }
    case 'yt-key-rm': {
      const keys = yt.apiKeys();
      const i = Number(el.dataset.i);
      const c = await actionSheet([{ label: `Elimina la chiave ${i + 1}`, icon: 'trash', value: 'rm', danger: true }], { title: `Chiave ${i + 1}`, sub: `••••${keys[i]?.slice(-4) || ''}` });
      if (c !== 'rm') break;
      updateSettings({ youtubeApiKey: keys.filter((_, j) => j !== i).join(',') });
      refresh();
      break;
    }
    case 'dl-guide': showDownloadGuide(); break;
    case 'export': exportPlaylists(); break;
    case 'import': $('#import-file').click(); break;
    default: break;
  }
});

// Stato del player nelle liste: aggiorna solo ciò che cambia (pulsante play, equalizzatore).
let lastPlaying = null;
let lastCtx = null;
player.subscribe((pl) => {
  const ctxId = pl.current ? pl.context?.id : null;
  if (pl.playing === lastPlaying && ctxId === lastCtx) return;
  lastPlaying = pl.playing; lastCtx = ctxId;
  const btn = $('#pl-play');
  if (btn && route?.name === 'playlist') {
    const on = ctxId === route.id && pl.playing;
    btn.innerHTML = icon(on ? 'pause' : 'play');
    btn.setAttribute('aria-label', on ? 'Pausa' : 'Riproduci');
  }
  $$('#view [data-pl]').forEach((row) => {
    const box = $('.pl-eq', row);
    if (box) box.innerHTML = row.dataset.pl === ctxId ? eq(pl.playing) : '';
  });
});

// iOS può chiudere Duetto quando passi a un'altra app: la coda si salva e al ritorno riprende.
const PLAYER_KEY = 'hp.player';
function savePlayer() {
  const snap = player.snapshot();
  if (!snap) { save(PLAYER_KEY, null); return; }
  // Solo una finestra attorno al brano attuale: localStorage è piccolo.
  const from = Math.max(0, snap.index - 20);
  const queue = snap.queue.slice(from, snap.index + 200);
  save(PLAYER_KEY, { ...snap, queue, index: snap.index - from, original: null, context: player.context });
}
{
  // Prima si rilegge, poi si comincia a salvare (altrimenti si sovrascriverebbe con "niente").
  const saved = load(PLAYER_KEY, null);
  if (saved) { player.context = saved.context || null; player.restore(saved); }
}
// Brano YouTube non ancora scaricato: il player passa al successivo, qui si offre "Scarica".
ytEngine.on('missing', (id) => {
  const t = player.queue.find((x) => x.source === 'youtube' && x.sourceId === id);
  setTimeout(() => toast(`"${t?.title || 'Brano'}" non è ancora scaricato`, {
    ms: 6000, action: t ? { label: 'Scarica', fn: () => downloadSheet([t], player.context?.id) } : null,
  }), 50);
});

// Verso la fine di un brano YouTube si riconferma l'audio del prossimo (se la preparazione
// all'inizio era fallita), così a schermo bloccato il passaggio è immediato.
ytEngine.on('nearend', () => {
  const next = player.queue.slice(player.index + 1, player.index + 4).find((t) => t.source !== 'spotify');
  if (next) prefetchAudio(audioId(next));
});

// Mentre suona un brano si prepara l'audio del prossimo brano YouTube: parte subito.
let prefetchedFor = null;
player.subscribe((pl) => {
  const qid = pl.current?.qid;
  if (!qid || qid === prefetchedFor) return;
  prefetchedFor = qid;
  const next = pl.queue.slice(pl.index + 1, pl.index + 4).find((t) => t.source !== 'spotify');
  if (next) prefetchAudio(audioId(next));
});

let lastSavedQid = player.current?.qid ?? null;
player.subscribe((pl) => {
  const qid = pl.current?.qid ?? null;
  if (qid !== lastSavedQid) { lastSavedQid = qid; savePlayer(); }
});
setInterval(() => { if (player.playing) savePlayer(); }, 10000);
window.addEventListener('pagehide', savePlayer);

initNowPlaying(player, {
  addToPlaylist: (t) => addToPlaylist([t]),
  onTrackChange: () => markCurrent(view),
  ytUsesIframe: () => ytEngine.usesIframe,
});

// ---------- Avvio ----------

/**
 * App installata su iPhone: a volte (dopo la tastiera) iOS lascia la finestra più corta dello
 * schermo, con una striscia nera sotto. Si misura e si registra nella diagnostica; chiusa la
 * tastiera si riporta la pagina a posto.
 */
let lastGap = -1;
function fixViewport() {
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (!standalone) return;
  if (document.activeElement?.matches?.('input, textarea')) return; // tastiera aperta: si aspetta
  const portrait = innerHeight >= innerWidth;
  const screenH = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
  const gap = Math.max(0, Math.min(80, Math.round(screenH - innerHeight)));
  if (gap === lastGap) return;
  lastGap = gap;
  // Difetto di iOS 26 (WebKit 301108): nelle app installate con barra di stato trasparente la
  // finestra è più corta dello schermo dell'altezza della barra di stato, e sotto iOS non
  // disegna niente. Non si può allungare; però il fondo della finestra è già sopra la barretta
  // Home, quindi quello spazio riservato si toglie (--vp-gap, con --safe-b mai sotto zero).
  document.documentElement.style.setProperty('--vp-gap', `${gap}px`);
  spotify.logEvent(`schermo: finestra ${innerWidth}×${innerHeight}, schermo ${screen.width}×${screen.height}, mancano ${gap}px`);
}
function settleViewport() {
  // Dopo la tastiera iOS può lasciare la pagina spostata: la si rimette a posto.
  setTimeout(() => { if (!document.activeElement?.matches?.('input, textarea')) { window.scrollTo(0, 0); fixViewport(); } }, 350);
}
window.addEventListener('resize', fixViewport);
window.visualViewport?.addEventListener('resize', settleViewport);
document.addEventListener('focusout', settleViewport, true);
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(fixViewport, 300); });

async function boot() {
  fixViewport();
  // Chiede a iOS di non cancellare mai i dati dell'app (playlist, chiavi, accesso Spotify).
  navigator.storage?.persist?.().catch(() => {});
  await storeReady;
  onSaveError(() => toast('Memoria del telefono piena: modifiche non salvate', { error: true, ms: 6000 }));
  if (!isReadOnly()) {
    const removed = store.removeDuplicates();
    if (removed) setTimeout(() => toast(`${removed} playlist doppie rimosse`, { ms: 2500 }), 800);
  }
  if (isReadOnly()) toast('Libreria non letta: chiudi e riapri Duetto', { error: true, ms: 8000 });
  // File sul telefono: si legge l'elenco per segnalare eventuali mancanti. Non si cancella mai
  // niente da solo (scelta dell'utente): un file tolto da una playlist resta disponibile.
  loadFileIndex().then(() => { if (route) refresh(); });
  enrichFiles();
  navigator.storage?.persisted?.().then((ok) => spotify.logEvent(`memoria persistente: ${ok ? 'sì' : 'no'}`)).catch(() => {});
  let justLogged = false;
  try {
    justLogged = await spotify.handleRedirect();
  } catch (e) {
    toast(e.message, { error: true, ms: 6000 });
  }
  if (justLogged) location.replace('#/');
  spotify.onAuthChange((logged) => {
    spotifyUser = null;
    if (route?.name === 'settings' || route?.name === 'library') refresh();
    if (logged) runSync(false);
  });
  navigate();
  // Una volta sola (v29): riscarica tutte le playlist Spotify dopo il ripristino del backup.
  if (!load('hp.fullsync29', false) && spotify.isLoggedIn() && !isReadOnly()) {
    save('hp.fullsync29', true);
    runSync(true, true);
  } else runSync(justLogged);
  document.addEventListener('visibilitychange', () => {
    spotify.logEvent(`schermo ${document.hidden ? 'spento / app in background' : 'acceso'} — sta suonando: ${player.current ? `${player.current.source} ${player.playing ? '▶︎' : '⏸'}` : 'niente'}`);
    if (document.hidden) { savePlayer(); return; }
    // Tornando dal comando rapido di scaricamento: si apre la scheda File della playlist.
    if (pendingDownload && Date.now() - pendingDownload.at < 30 * 60_000) {
      const { playlistId, track } = pendingDownload;
      pendingDownload = null;
      if (track) {
        setTimeout(() => linkFileSheet(track), 400);
      } else if (store.get(playlistId)) {
        searches.add.source = 'file';
        location.hash = `#/playlist/${playlistId}/add`;
        toast('Scegli i file appena scaricati', { ms: 3500 });
      }
    }
    // Tornando da Spotify appena aperto: il telefono compare tra i dispositivi in pochi secondi.
    if (player.needsDevice) { close(); player.retry({ waitMs: 8000 }); }
    runSync(false);
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // Aggiornamento automatico: ogni volta che si torna nell'app si controlla se c'è una
    // versione nuova; quando è pronta l'app si ricarica da sola appena non sta suonando
    // (la coda viene salvata e ripresa).
    let hadController = !!navigator.serviceWorker.controller;
    let pendingReload = false;
    const maybeReload = () => { if (pendingReload && !player.playing) { savePlayer(); location.reload(); } };
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; } // prima installazione
      pendingReload = true;
      maybeReload();
    });
    player.subscribe(() => { if (pendingReload) maybeReload(); });
    navigator.serviceWorker.register('sw.js').then((reg) => {
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch((e) => console.warn('SW', e));
  }
  // Controllo diretto della versione, indipendente dal service worker: all'avvio e a ogni ritorno.
  setTimeout(checkForUpdate, 3000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(checkForUpdate, 1500); });
  {
  }
}

boot();
