// Componenti dell'interfaccia: righe, copertine, fogli dal basso, avvisi, gesti.
import { formatTime, trackUri } from './util.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
export const dot = (source) => `<i class="src ${esc(source)}" aria-hidden="true"></i>`;
/** File di un brano nato su YouTube (non da una copia di Spotify): accanto al puntino del file c'è quello rosso. */
export const fromYouTube = (t) => t?.source === 'file' && !String(t.origin || '').startsWith('spotify:')
  && !!(t.yt || t.ytId || /\[[A-Za-z0-9_-]{11}\]\s*\.[a-z0-9]{2,4}$/i.test(t.fileName || ''));
/** File scaricato per un brano Spotify (copia su YouTube): accanto al puntino del file c'è quello verde. */
export const fromSpotify = (t) => t?.source === 'file' && String(t.origin || '').startsWith('spotify:');
/** Secondo puntino della provenienza di un file: 'spotify', 'youtube' o null. */
export const fileOrigin = (t) => (fromSpotify(t) ? 'spotify' : fromYouTube(t) ? 'youtube' : null);
export const dots = (t) => dot(t.source) + (fileOrigin(t) ? dot(fileOrigin(t)) : '');
export const srcName = (source) => ({ spotify: 'Spotify', youtube: 'YouTube', file: 'File sul telefono' }[source] || source);

export function art(track, cls = '') {
  return track?.artwork
    ? `<img class="art ${cls}" src="${esc(track.artwork)}" alt="" loading="lazy" decoding="async" width="48" height="48">`
    : `<span class="art ${cls}" aria-hidden="true">${icon('note')}</span>`;
}

/** Copertina di una playlist: immagine Spotify, oppure mosaico delle prime quattro copertine. */
export function cover(p, cls = '') {
  if (p.image) return `<img class="art ${cls}" src="${esc(p.image)}" alt="" loading="lazy" decoding="async">`;
  const arts = [...new Set(p.tracks.map((t) => t.artwork).filter(Boolean))];
  if (arts.length >= 4) {
    return `<span class="art cover ${cls}" aria-hidden="true">${arts.slice(0, 4).map((a) => `<img src="${esc(a)}" alt="" loading="lazy" decoding="async">`).join('')}</span>`;
  }
  if (arts.length) return `<img class="art ${cls}" src="${esc(arts[0])}" alt="" loading="lazy" decoding="async">`;
  return `<span class="art ${cls}" aria-hidden="true">${icon('note')}</span>`;
}

export const eq = (playing) => `<span class="eq${playing ? '' : ' paused'}" aria-hidden="true"><i></i><i></i><i></i></span>`;

/**
 * Riga brano. Se ha un'azione (`data-a`) è un pulsante per VoiceOver e tastiera.
 * `swipe`: avvolge la riga per le azioni a scorrimento (riproduci dopo / togli).
 */
export function trackRow(t, { attrs = '', lead = '', trailing = '', cls = '', i = 0, swipe = false, role = 'button', sub = null } = {}) {
  const interactive = /data-a=/.test(attrs);
  const label = `${t.title}, ${sub ?? t.artist}, ${srcName(t.source)}`;
  const row = `
    <div class="row ${cls}" data-uri="${esc(trackUri(t))}" style="--i:${i}" ${attrs}
      ${interactive ? `role="${role}" tabindex="0" aria-label="${esc(label)}"` : ''}>
      ${lead}${art(t)}
      <div class="grow" aria-hidden="${interactive}">
        <div class="t">${esc(t.title)}</div>
        <div class="s">${dots(t)}<span>${esc(sub ?? t.artist)}</span></div>
      </div>
      ${trailing}
    </div>`;
  if (!swipe) return row;
  return `<div class="swipe" data-i="${i}">
    <div class="swipe-bg" aria-hidden="true"><span class="lead">${icon('queue')}</span><span class="trail">${icon('trash')}</span></div>
    ${row}</div>`;
}

export function totalTime(tracks) {
  const ms = tracks.reduce((a, t) => a + (t.durationMs || 0), 0);
  if (!ms) return '';
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}
export { formatTime };

// Invio e spazio attivano le righe-pulsante come un tocco.
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[role="button"][tabindex], [role="checkbox"][tabindex]')) {
    e.preventDefault();
    e.target.click();
  }
});

// ---------- Avviso ----------

let toastTimer;
export function toast(message, { error = false, ms = 2600, action = null } = {}) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  el.className = `toast glass out${error ? ' error' : ''}`;
  el.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('out')));
  clearTimeout(toastTimer);
  const hide = () => { el.classList.add('out'); setTimeout(() => { if (el.classList.contains('out')) el.hidden = true; }, 220); };
  toastTimer = setTimeout(hide, action ? Math.max(ms, 5000) : ms);
  el.onclick = (e) => {
    if (action && e.target.closest('button')) action.fn();
    clearTimeout(toastTimer); hide();
  };
}

// ---------- Fogli dal basso ----------

const dlg = () => $('#sheet');
let closeResolvers = [];

/**
 * Testo troppo lungo per la riga: scorre avanti e indietro (con una pausa a ogni capo) invece di
 * restare tagliato con "…". Si ricalcola quando cambia la larghezza.
 */
const marqObs = typeof ResizeObserver !== 'undefined' ? new ResizeObserver((es) => es.forEach((e) => fitMarquee(e.target))) : null;
export function marquee(el, text) {
  if (!el) return;
  if (text !== undefined || !el.querySelector(':scope > .marq-in')) {
    const span = document.createElement('span');
    span.className = 'marq-in';
    span.textContent = text !== undefined ? text : el.textContent;
    el.replaceChildren(span);
  }
  el.classList.add('marq');
  marqObs?.observe(el);
  requestAnimationFrame(() => fitMarquee(el));
}
function fitMarquee(el) {
  const inner = el.querySelector(':scope > .marq-in');
  if (!inner) return;
  const over = inner.scrollWidth - el.clientWidth;
  const on = over > 4 && el.clientWidth > 0;
  el.classList.toggle('scroll', on);
  if (on) {
    el.style.setProperty('--marq-dist', `${-over}px`);
    el.style.setProperty('--marq-dur', `${Math.max(4, over / 30 + 3).toFixed(1)}s`);
  }
}

function open(html, { onClick, label = '' } = {}) {
  const d = dlg();
  d.innerHTML = html;
  d.querySelectorAll('.sheet-head .t, .sheet-head .s').forEach((x) => marquee(x));
  d.setAttribute('aria-label', label);
  d.onclick = (e) => {
    if (e.target === d || e.target.closest('[data-close]')) return close();
    onClick?.(e);
  };
  d.oncancel = (e) => { e.preventDefault(); close(); };
  if (!d.open) d.showModal();
  // Il foglio prende il focus su sé stesso, non sulla prima voce (che altrimenti appare
  // evidenziata come se fosse selezionata). VoiceOver legge comunque il titolo del foglio.
  d.tabIndex = -1;
  d.focus({ preventScroll: true });
  const grab = $('.grab', d);
  if (grab) dragToDismiss(d, $('.sheet-card', d), close, { handle: grab });
  return d;
}

export function close() {
  const d = dlg();
  if (!d.open) return;
  d.style.transform = '';
  d.close();
  const rs = closeResolvers; closeResolvers = [];
  rs.forEach((r) => r(null));
}

const cancelCard = '<div class="sheet-card"><button class="opt cancel" data-close>Annulla</button></div>';

/**
 * Menu di azioni (foglio di azioni iOS). `options`: [{ label, icon?, value, danger?, sub?, artHtml? }].
 * `head`: { track } oppure { title, sub, artHtml }. Restituisce il value scelto o null.
 */
export function actionSheet(options, head = null) {
  const h = head?.track
    ? `<div class="sheet-head">${art(head.track)}<div class="grow"><div class="t">${esc(head.track.title)}</div><div class="s">${esc(head.track.artist)}</div></div></div>`
    : head?.title ? `<div class="sheet-head">${head.artHtml || ''}<div class="grow"><div class="t">${esc(head.title)}</div>${head.sub ? `<div class="s">${esc(head.sub)}</div>` : ''}</div></div>` : '';
  return new Promise((resolve) => {
    closeResolvers.push(resolve);
    open(`<div class="sheet-card"><div class="grab"></div>${h}<div class="sheet-body" role="menu">${options.map((o, i) => `
      <button class="opt${o.danger ? ' danger' : ''}" data-i="${i}" role="menuitem">
        ${o.artHtml || (o.icon ? icon(o.icon) : '')}
        <span class="grow">${esc(o.label)}${o.sub ? `<span class="sub">${esc(o.sub)}</span>` : ''}</span>
      </button>`).join('')}</div></div>${cancelCard}`, {
      label: head?.track?.title || head?.title || 'Azioni',
      onClick: (e) => {
        const b = e.target.closest('[data-i]');
        if (!b) return;
        closeResolvers = closeResolvers.filter((r) => r !== resolve);
        close();
        resolve(options[Number(b.dataset.i)].value);
      },
    });
  });
}

/** Chiede un testo (es. nome playlist). Restituisce la stringa o null. */
export function askText(title, value = '', okLabel = 'Fine') {
  return new Promise((resolve) => {
    closeResolvers.push(resolve);
    const d = open(`
      <div class="sheet-card"><div class="grab"></div>
        <div class="sheet-title">${esc(title)}</div>
        <form class="form">
          <input name="v" value="${esc(value)}" autocomplete="off" enterkeyhint="done" aria-label="${esc(title)}">
          <button class="btn accent" type="submit">${esc(okLabel)}</button>
        </form>
      </div>${cancelCard}`, { label: title });
    const input = $('input', d);
    $('form', d).onsubmit = (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      closeResolvers = closeResolvers.filter((r) => r !== resolve);
      close();
      resolve(v);
    };
    setTimeout(() => { input.focus(); input.select(); }, 60);
  });
}

/** Foglio con contenuto libero. */
export function panel(html, onClick, label = '') {
  return open(`<div class="sheet-card"><div class="grab"></div>${html}</div>`, { onClick, label });
}

// ---------- Gesti ----------

/**
 * Trascina in giù per chiudere (fogli e player). Chiude oltre 1/4 dell'altezza o con un colpo
 * veloce; altrimenti torna al suo posto. `el` si muove, `handle` riceve il gesto.
 */
export function dragToDismiss(el, area, onClose, { handle = area, canStart = () => true } = {}) {
  if (handle.dataset.drag) return;
  handle.dataset.drag = '1';
  let x0 = 0; let y0 = 0; let t0 = 0; let dy = 0; let active = false; let id = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !canStart(e)) return;
    active = true; id = e.pointerId; x0 = e.clientX; y0 = e.clientY; t0 = performance.now(); dy = 0;
  });
  handle.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== id) return;
    const d = e.clientY - y0;
    if (!el.classList.contains('dragging')) {
      if (Math.abs(e.clientX - x0) > Math.abs(d)) { if (Math.abs(e.clientX - x0) > 8) active = false; return; }
      if (Math.abs(d) < 8) return;
      if (d < 0) { active = false; return; }
      el.classList.add('dragging');
      handle.setPointerCapture(id);
    }
    dy = d > 0 ? d : d / 4;
    el.style.transform = `translateY(${dy}px)`;
  });
  const end = (e) => {
    if (!active || e.pointerId !== id) return;
    active = false;
    if (!el.classList.contains('dragging')) return;
    el.classList.remove('dragging');
    const v = dy / Math.max(1, performance.now() - t0);
    el.style.transform = '';
    if (dy > el.offsetHeight / 4 || (v > 0.5 && dy > 40)) onClose();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/**
 * Scorrimento orizzontale sulle righe (come Mail/Musica): verso destra = azione principale,
 * verso sinistra = azione distruttiva. Oltre il 40% della larghezza l'azione parte.
 */
let swipedAt = 0;
export const justSwiped = () => Date.now() - swipedAt < 400;

export function enableSwipe(root, { onLead, onTrail }) {
  let st = null;
  root.addEventListener('pointerdown', (e) => {
    const wrap = e.target.closest('.swipe');
    if (!wrap || e.pointerType === 'mouse' || e.target.closest('button, [data-grip]')) return;
    st = { wrap, row: $('.row', wrap), bg: $('.swipe-bg', wrap), x0: e.clientX, y0: e.clientY, dx: 0, on: false, id: e.pointerId };
  });
  root.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.id) return;
    const dx = e.clientX - st.x0; const dy = e.clientY - st.y0;
    if (!st.on) {
      if (Math.abs(dy) > 10) { st = null; return; }
      if (Math.abs(dx) < 12) return;
      st.on = true;
      st.row.classList.remove('settle');
      st.wrap.setPointerCapture?.(e.pointerId);
    }
    st.dx = dx;
    st.row.style.transform = `translateX(${dx}px)`;
    st.bg.className = `swipe-bg ${dx > 0 ? 'l' : 'r'}`;
  });
  const end = (e) => {
    if (!st || e.pointerId !== st.id) return;
    const { wrap, row, bg, dx, on } = st;
    st = null;
    if (!on) return;
    swipedAt = Date.now(); // il rilascio non deve diventare un tocco sulla riga
    const w = wrap.offsetWidth;
    const i = Number(wrap.dataset.i);
    row.classList.add('settle');
    if (dx < -w * 0.4) {
      row.style.transform = 'translateX(-100%)';
      setTimeout(() => onTrail(i), 220);
    } else {
      row.style.transform = '';
      if (dx > w * 0.3) onLead(i);
      setTimeout(() => { bg.className = 'swipe-bg'; }, 300);
    }
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
}

/** Colore dominante (scurito) di una copertina, per tingere il player. null se non leggibile. */
const tintCache = new Map();
export function tintOf(url) {
  if (!url) return Promise.resolve(null);
  if (tintCache.has(url)) return Promise.resolve(tintCache.get(url));
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 16;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 16, 16);
        const d = ctx.getImageData(0, 0, 16, 16).data;
        let r = 0; let g = 0; let b = 0; let w = 0;
        for (let i = 0; i < d.length; i += 4) {
          const max = Math.max(d[i], d[i + 1], d[i + 2]);
          const min = Math.min(d[i], d[i + 1], d[i + 2]);
          const k = 1 + (max - min) / 32; // privilegia i pixel saturi
          r += d[i] * k; g += d[i + 1] * k; b += d[i + 2] * k; w += k;
        }
        r /= w; g /= w; b /= w;
        const l = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
        const f = l > 120 ? 120 / l : 1;
        const col = `rgb(${Math.round(r * f)} ${Math.round(g * f)} ${Math.round(b * f)})`;
        tintCache.set(url, col);
        resolve(col);
      } catch { tintCache.set(url, null); resolve(null); }
    };
    img.onerror = () => { tintCache.set(url, null); resolve(null); };
    img.src = url;
  });
}

/**
 * Scorrimento orizzontale per cambiare brano (mini player, copertina): il precedente è a
 * sinistra, il successivo a destra. `area` riceve il gesto, `target()` è ciò che si sposta.
 * Restituisce `justSlid()` per ignorare il tocco che segue uno scorrimento.
 */
export function trackSwipe(area, target, { onNext, onPrev, canNext = () => true }) {
  let st = null;
  let slidAt = 0;
  area.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    st = { x0: e.clientX, y0: e.clientY, t0: performance.now(), dx: 0, on: false, id: e.pointerId };
  });
  area.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.id) return;
    const dx = e.clientX - st.x0; const dy = e.clientY - st.y0;
    if (!st.on) {
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { st = null; return; }
      if (Math.abs(dx) < 10) return;
      st.on = true;
      area.setPointerCapture(e.pointerId);
      target().classList.add('swiping');
    }
    // Oltre l'ultimo brano: resistenza.
    st.dx = dx < 0 && !canNext() ? dx / 4 : dx;
    target().style.transform = `translateX(${st.dx}px)`;
    target().style.opacity = String(1 - Math.min(0.6, Math.abs(st.dx) / area.offsetWidth));
  });
  const end = (e) => {
    if (!st || e.pointerId !== st.id) return;
    const { dx, on, t0 } = st;
    st = null;
    if (!on) return;
    slidAt = Date.now();
    const t = target();
    const w = area.offsetWidth;
    const fast = Math.abs(dx) / Math.max(1, performance.now() - t0) > 0.45 && Math.abs(dx) > 30;
    const go = Math.abs(dx) > w * 0.25 || fast;
    t.classList.remove('swiping');
    t.classList.add('slide-anim');
    const dir = dx < 0 ? -1 : 1;
    if (go && (dir > 0 || canNext())) {
      t.style.transform = `translateX(${dir * w}px)`;
      t.style.opacity = '0';
      setTimeout(() => {
        (dir < 0 ? onNext : onPrev)();
        // Il nuovo brano entra dal lato opposto.
        t.classList.remove('slide-anim');
        t.style.transform = `translateX(${-dir * w * 0.5}px)`;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          t.classList.add('slide-anim');
          t.style.transform = '';
          t.style.opacity = '';
        }));
      }, 200);
    } else {
      t.style.transform = '';
      t.style.opacity = '';
    }
    setTimeout(() => t.classList.remove('slide-anim'), 700);
  };
  area.addEventListener('pointerup', end);
  area.addEventListener('pointercancel', end);
  return () => Date.now() - slidAt < 400;
}
