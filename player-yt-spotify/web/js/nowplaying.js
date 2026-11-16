// Mini player, player a schermo intero e coda.
import * as spotify from './spotify.js';
import { settings, updateSettings } from './settings.js';
import { formatTime, trackUri } from './util.js';
import { $, $$, esc, icon, trackRow, toast, actionSheet, panel, close, dragToDismiss, tintOf, art, eq, trackSwipe, marquee, fileOrigin } from './ui.js';

let player;
let hooks;
let fullOpen = false;
let seeking = false;
let lastQid = null;
let lastError = null;

const el = {};

export function initNowPlaying(p, h) {
  player = p;
  hooks = h; // { addToPlaylist(track), onTrackChange() }
  Object.assign(el, {
    mini: $('#mini'), miniArt: $('#mini-art'), miniTitle: $('#mini-title'), miniArtist: $('#mini-artist'),
    miniDot: $('#mini-dot'), miniPlay: $('#mini-play'),
    full: $('#full'), art: $('#fp-art'), title: $('#fp-title'), artist: $('#fp-artist'), dot: $('#fp-dot'),
    ctx: $('#fp-context'), bar: $('#fp-bar'), pos: $('#fp-pos'), dur: $('#fp-dur'),
    toggle: $('[data-fp="toggle"]'), shuffle: $('[data-fp="shuffle"]'), repeat: $('[data-fp="repeat"]'),
    next: $('[data-fp="next"]'), host: $('#yt-host'),
  });

  // Scorri il mini player o la copertina: a sinistra il brano prima, a destra quello dopo.
  const swipeOpts = { onNext: () => player.next(), onPrev: () => player.previousTrack(), canNext: () => player.hasNext };
  const miniSlid = trackSwipe($('#mini-open'), () => $('#mini-open .slide'), swipeOpts);
  trackSwipe($('#fp-artbox'), () => el.art, swipeOpts);
  $('#mini-open').addEventListener('click', () => { if (!miniSlid()) openFull(); });
  el.miniPlay.addEventListener('click', () => player.toggle());
  $('#mini-next').addEventListener('click', () => player.next());
  initMediaSession();

  el.full.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fp]');
    if (!b) return;
    const t = player.current;
    switch (b.dataset.fp) {
      case 'close': closeFull(); break;
      case 'toggle': player.toggle(); break;
      case 'next': player.next(); break;
      case 'prev': player.previous(); break;
      case 'shuffle': player.setShuffle(!player.shuffled); break;
      case 'repeat': player.setRepeat({ off: 'all', all: 'one', one: 'off' }[player.repeat]); break;
      case 'add': if (t) hooks.addToPlaylist(t); break;
      case 'queue': showQueue(); break;
      case 'device': chooseDevice(); break;
      case 'more': moreMenu(); break;
      default: break;
    }
  });

  initScrubber();

  dragToDismiss(el.full, $('.full-in', el.full), closeFull, {
    canStart: (e) => !e.target.closest('.scrub, .full-ctrl, .full-foot, .full-meta'),
  });
  el.full.addEventListener('transitionend', placeYt);
  window.addEventListener('resize', placeYt);

  player.subscribe(update);
}

export function openFull() {
  if (!player.current) return;
  fullOpen = true;
  el.full.inert = false;
  el.full.classList.add('open');
  document.body.classList.add('full-open');
  history.pushState({ full: true }, '');
  placeYt();
}

export function closeFull(fromHistory = false) {
  if (!fullOpen) return;
  fullOpen = false;
  el.full.classList.remove('open');
  document.body.classList.remove('full-open');
  el.full.inert = true;
  el.full.style.transform = '';
  if (!fromHistory && history.state?.full) history.back();
  placeYt();
}
export const isFullOpen = () => fullOpen;

// Il tasto "indietro" (gesto di sistema o history.back) chiude il player.
window.addEventListener('popstate', () => { if (fullOpen) closeFull(true); });

function setArt(t) {
  const fallback = t.artwork || '';
  el.art.onload = null; el.art.onerror = null;
  if (t.source === 'youtube') {
    // Miniatura grande senza bande nere, se esiste; altrimenti quella media.
    el.art.onload = () => { if (el.art.naturalWidth <= 120 && el.art.src !== fallback) el.art.src = fallback; };
    el.art.onerror = () => { if (el.art.src !== fallback) el.art.src = fallback; };
    el.art.src = t.artworkLg || `https://i.ytimg.com/vi/${t.sourceId}/maxresdefault.jpg`;
  } else if (t.artworkLg || fallback) {
    el.art.src = t.artworkLg || fallback;
  } else {
    el.art.removeAttribute('src');
  }
  if (fallback) el.miniArt.src = fallback; else el.miniArt.removeAttribute('src');
  tintOf(t.artwork).then((c) => {
    if (player.current?.qid !== t.qid) return;
    const v = c || '';
    el.full.style.setProperty('--tint', v || 'var(--surface-3)');
    document.documentElement.style.setProperty('--ptint', v || '#3a3a3c');
    el.mini.style.setProperty('--tint', v || 'var(--surface-3)');
  });
}

function update(p) {
  const t = p.current;
  el.mini.hidden = !t;
  document.body.classList.toggle('has-mini', !!t);
  if (!t) { if (fullOpen) closeFull(); placeYt(); return; }

  if (t.qid !== lastQid) {
    lastQid = t.qid;
    marquee(el.miniTitle, t.title); marquee(el.title, t.title);
    marquee(el.artist, t.artist);
    el.miniArtist.textContent = t.artist;
    el.miniDot.className = el.dot.className = `src ${t.source}`;
    const o = fileOrigin(t);
    for (const d of [$('#mini-dot2'), $('#fp-dot2')]) { d.hidden = !o; d.className = `src ${o || ''}`; }
    el.ctx.textContent = p.context?.name || '';
    setArt(t);
    hooks.onTrackChange?.();
  }

  const icn = p.playing ? '#i-pause' : '#i-play';
  el.miniPlay.querySelector('use').setAttribute('href', icn);
  el.toggle.querySelector('use').setAttribute('href', icn);
  el.miniPlay.setAttribute('aria-label', p.playing ? 'Pausa' : 'Riproduci');
  el.toggle.setAttribute('aria-label', p.playing ? 'Pausa' : 'Riproduci');
  el.full.classList.toggle('playing', p.playing);

  const frac = p.durationMs ? Math.min(1, p.positionMs / p.durationMs) : 0;
  if (!seeking) {
    setBar(frac);
    el.pos.textContent = formatTime(p.positionMs);
  }
  el.dur.textContent = p.durationMs ? formatTime(p.durationMs) : '--:--';

  el.shuffle.classList.toggle('on', p.shuffled);
  el.shuffle.setAttribute('aria-pressed', p.shuffled);
  el.repeat.classList.toggle('on', p.repeat !== 'off');
  el.repeat.classList.toggle('rep1', p.repeat === 'one');
  el.repeat.setAttribute('aria-pressed', p.repeat !== 'off');
  el.repeat.setAttribute('aria-label', p.repeat === 'one' ? 'Ripeti brano' : 'Ripeti');
  $('#mini-next').disabled = !p.hasNext;
  // Su quale dispositivo sta suonando Spotify: così si vede subito se comandiamo quello giusto.
  const devName = t.source === 'spotify' ? (p.deviceName || settings.spotifyDeviceName || '') : '';
  const devEl = $('#fp-device');
  if (devEl.textContent !== devName) devEl.textContent = devName;
  updateMediaSession(p);
  el.next.disabled = !p.hasNext;

  if (p.error && p.error !== lastError) {
    if (p.needsDevice) {
      // iOS ha addormentato l'app Spotify (succede dopo che ha suonato un file): nessuna app
      // la può risvegliare da lontano. Foglio fisso: un tocco la apre, al ritorno si riparte.
      wakeSpotifySheet(p);
    } else {
      toast(p.error, { error: true, ms: 5000 });
    }
  }
  lastError = p.error;
  placeYt();
}

/**
 * iOS può bloccare l'avvio dell'audio YouTube senza un tocco "dentro" il player. In quel caso
 * il player (invisibile) si mette esattamente sopra il pulsante play visibile, che pulsa:
 * il tocco dell'utente arriva al player e lo sblocca.
 */
function placeYt() {
  const t = player?.current;
  // Serve solo col player ufficiale di riserva: l'audio diretto si sblocca col tocco sul play.
  const need = t && t.source !== 'spotify' && player.ytBlocked;
  const viaIframe = hooks.ytUsesIframe?.();
  const target = need ? (fullOpen ? el.toggle : el.miniPlay) : null;
  [el.toggle, el.miniPlay].forEach((b) => b?.classList.toggle('needs-tap', !!target && b === target));
  const h = el.host;
  if (!target || !viaIframe || !target.offsetParent) {
    h.classList.remove('tap');
    h.style.left = ''; h.style.top = ''; h.style.bottom = ''; h.style.clipPath = '';
    return;
  }
  const r = target.getBoundingClientRect();
  h.style.left = `${r.left + r.width / 2 - 100}px`;
  h.style.top = `${r.top + r.height / 2 - 100}px`;
  h.style.bottom = 'auto';
  h.style.clipPath = `circle(${r.width / 2 + 6}px at 50% 50%)`;
  h.classList.add('tap');
}

// ---------- Barra del minutaggio (trascinabile) ----------

function setBar(frac) {
  el.bar.style.setProperty('--p', String(frac));
  el.bar.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
  el.bar.setAttribute('aria-valuetext', `${formatTime(frac * player.durationMs)} di ${formatTime(player.durationMs)}`);
}

function initScrubber() {
  const bar = el.bar;
  let id = null;
  const fracAt = (x) => {
    const r = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (x - r.left) / r.width));
  };
  const show = (f) => { setBar(f); el.pos.textContent = formatTime(f * player.durationMs); };
  bar.addEventListener('pointerdown', (e) => {
    if (!player.durationMs) return;
    id = e.pointerId;
    seeking = true;
    bar.setPointerCapture(id);
    bar.classList.add('active');
    show(fracAt(e.clientX));
  });
  bar.addEventListener('pointermove', (e) => { if (e.pointerId === id) show(fracAt(e.clientX)); });
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    bar.classList.remove('active');
    const f = fracAt(e.clientX);
    seeking = false;
    player.seek(f * player.durationMs);
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', (e) => { if (e.pointerId === id) { id = null; seeking = false; bar.classList.remove('active'); } });
  // Tastiera / VoiceOver: frecce = ±5 secondi.
  bar.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 5000, ArrowUp: 5000, ArrowLeft: -5000, ArrowDown: -5000 }[e.key];
    if (!step || !player.durationMs) return;
    e.preventDefault();
    player.seek(Math.min(player.durationMs, Math.max(0, player.positionMs + step)));
  });
}

// ---------- Spotify addormentato ----------

function wakeSpotifySheet(p) {
  const t = p.current;
  panel(`
    <div class="sheet-head">${t ? art(t) : ''}<div class="grow"><div class="t">Spotify è in pausa sul telefono</div><div class="s">Aprilo e torna qui: ${esc(t?.title || 'il brano')} riparte da solo</div></div></div>
    <div class="form"><button class="btn accent" data-wake>Apri Spotify</button></div>`, (e) => {
    if (e.target.closest('[data-wake]')) { close(); location.href = 'spotify:'; }
  }, 'Spotify in pausa');
}

// ---------- Coda ----------

function showQueue() {
  const render = () => {
    const q = player.queue;
    const cur = player.current;
    const next = q.map((t, i) => ({ t, i })).filter(({ i }) => i > player.index);
    // Prima i brani messi in coda (subito dopo l'attuale), poi il resto della playlist.
    let k = 0;
    while (k < next.length && next[k].t.queued) k++;
    const row = ({ t, i }) => trackRow(t, {
      attrs: `data-q="${i}"`,
      trailing: `<button class="ibtn" data-qrm="${i}" aria-label="Togli dalla coda">${icon('x')}</button>`,
    });
    return `
      <div class="sheet-body queue">
        ${cur ? trackRow(cur, { cls: 'current', trailing: eq(player.playing) }) : ''}
        ${k ? `<div class="q-label">In coda</div>${next.slice(0, k).map(row).join('')}` : ''}
        ${next.length > k ? `<div class="q-label">Successivi</div>${next.slice(k).map(row).join('')}` : ''}
      </div>`;
  };
  const d = panel(render(), (e) => {
    const rm = e.target.closest('[data-qrm]');
    if (rm) { player.removeAt(Number(rm.dataset.qrm)); $('.sheet-body', d).outerHTML = render(); return; }
    const row = e.target.closest('[data-q]');
    if (row) { player.jump(Number(row.dataset.q)); close(); }
  });
}

async function moreMenu() {
  const t = player.current;
  if (!t) return;
  const c = await actionSheet([
    { label: 'Aggiungi a playlist', icon: 'plus-circle', value: 'add' },
    { label: 'Coda', icon: 'queue', value: 'queue' },
    ...(t.source !== 'file' ? [{ label: t.source === 'spotify' ? 'Apri in Spotify' : 'Apri in YouTube', icon: 'link', value: 'open' }] : []),
    { label: 'Interrompi', icon: 'x', value: 'stop', danger: true },
  ], { track: t });
  if (c === 'add') hooks.addToPlaylist(t);
  if (c === 'queue') showQueue();
  if (c === 'open') window.open(t.source === 'spotify' ? `https://open.spotify.com/track/${t.sourceId}` : `https://www.youtube.com/watch?v=${t.sourceId}`, '_blank');
  if (c === 'stop') { closeFull(); player.stop(); }
}

export async function chooseDevice() {
  if (!spotify.isLoggedIn()) { location.hash = '#/settings'; closeFull(); return; }
  let list;
  try { list = await spotify.devices(); } catch (e) { toast(e.message, { error: true }); return; }
  if (!list.length) {
    toast('Apri l\'app Spotify e riprova', { action: { label: 'Apri', fn: () => { location.href = 'spotify:'; } } });
    return;
  }
  const c = await actionSheet([
    ...list.map((d) => ({
      label: d.name,
      icon: d.id === settings.spotifyDeviceId || (!settings.spotifyDeviceId && d.is_active) ? 'check' : 'device',
      value: d,
    })),
  ], { title: 'Spotify' });
  if (c) { updateSettings({ spotifyDeviceId: c.id, spotifyDeviceName: c.name }); toast(c.name); }
}

// ---------- Schermata di blocco e Centro di Controllo ----------

function initMediaSession() {
  const ms = navigator.mediaSession;
  if (!ms) return;
  const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* non supportata */ } };
  set('play', () => { if (!player.playing) player.toggle(); });
  set('pause', () => { if (player.playing) player.toggle(); });
  set('nexttrack', () => player.next());
  set('previoustrack', () => player.previousTrack());
  set('seekto', (d) => player.seek(d.seekTime * 1000));
  // Senza questi null iOS mostra "±10 secondi" al posto di brano precedente/successivo.
  set('seekbackward', null);
  set('seekforward', null);
}

let msQid = null;
function updateMediaSession(p) {
  const ms = navigator.mediaSession;
  const t = p.current;
  if (!ms || typeof MediaMetadata === 'undefined') return;
  // Quando suona Spotify l'audio è dell'app Spotify: schermata di blocco e Centro di Controllo
  // devono mostrare Spotify, non Duetto. Duetto li riprende quando suona un file.
  if (!t || t.source === 'spotify') {
    if (msQid !== null) { msQid = null; ms.metadata = null; ms.playbackState = 'none'; }
    return;
  }
  if (t.qid !== msQid) {
    msQid = t.qid;
    initMediaSession(); // iOS può azzerare i comandi quando cambia il file audio: si rimettono
    const src = t.artworkLg || t.artwork;
    ms.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: p.context?.name || '',
      artwork: src ? [{ src, sizes: '512x512' }] : [],
    });
  }
  ms.playbackState = p.playing ? 'playing' : 'paused';
  if (p.durationMs > 0 && ms.setPositionState) {
    try { ms.setPositionState({ duration: p.durationMs / 1000, position: Math.min(p.positionMs, p.durationMs) / 1000, playbackRate: 1 }); } catch { /* valori non validi */ }
  }
}

/** Evidenzia nelle liste il brano in riproduzione. */
export function markCurrent(root = document) {
  const uri = player.current ? trackUri(player.current) : null;
  $$('.row[data-uri]', root).forEach((r) => {
    if (r.closest('.queue')) return;
    const on = r.dataset.uri === uri;
    r.classList.toggle('current', on);
  });
}

export { art, esc };
