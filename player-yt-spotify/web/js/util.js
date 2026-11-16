// Funzioni pure (senza DOM): testabili con `node --test`.

/** Riconosce "spotify:track:ID", "youtube:ID" e link condivisi di Spotify/YouTube. */
export function parseLink(input) {
  const s = String(input || '').trim();
  if (s.startsWith('spotify:track:')) return { source: 'spotify', sourceId: s.slice(14) };
  if (s.startsWith('youtube:')) return { source: 'youtube', sourceId: s.slice(8) };
  let url;
  try { url = new URL(s); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'open.spotify.com') {
    const i = parts.indexOf('track');
    if (i >= 0 && parts[i + 1]) return { source: 'spotify', sourceId: parts[i + 1] };
  }
  if (host === 'youtu.be' && parts[0]) return { source: 'youtube', sourceId: parts[0] };
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    const v = url.searchParams.get('v');
    if (v) return { source: 'youtube', sourceId: v };
    if (parts.length >= 2 && ['shorts', 'embed', 'live'].includes(parts[0])) {
      return { source: 'youtube', sourceId: parts[1] };
    }
  }
  return null;
}

/**
 * Riconosce i link a raccolte: playlist YouTube, playlist e album Spotify.
 * Restituisce { source, kind: 'playlist' | 'album', id, videoId? } oppure null.
 * Un link "watch?v=…&list=…" restituisce la playlist con anche il video di partenza.
 * I mix automatici di YouTube (list=RD…) non sono leggibili con l'API: ignorati.
 */
export function parseCollection(input) {
  const s = String(input || '').trim();
  const sp = /^spotify:(playlist|album):([A-Za-z0-9]+)$/.exec(s);
  if (sp) return { source: 'spotify', kind: sp[1], id: sp[2] };
  let url;
  try { url = new URL(s); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'open.spotify.com') {
    for (const kind of ['playlist', 'album']) {
      const i = parts.indexOf(kind);
      if (i >= 0 && parts[i + 1]) return { source: 'spotify', kind, id: parts[i + 1] };
    }
  }
  const isYt = host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
  const list = url.searchParams.get('list');
  if (isYt && list && !/^(RD|UL|LL$|WL$)/.test(list)) {
    const video = parseLink(s);
    return { source: 'youtube', kind: 'playlist', id: list, ...(video ? { videoId: video.sourceId } : {}) };
  }
  return null;
}

/**
 * Unisce una playlist locale con la sua versione su Spotify (sincronizzazione a senso unico).
 * - i brani arrivati da Spotify (`synced`) e tolti su Spotify spariscono;
 * - i brani aggiunti a mano (anche YouTube) restano dove sono;
 * - i brani nuovi su Spotify si aggiungono in fondo, tranne quelli tolti a mano (`removed`).
 */
export function mergeSync(local, remote, removed = []) {
  const remoteSet = new Set(remote.map(trackUri));
  const kept = local.filter((t) => !t.synced || remoteSet.has(trackUri(t)));
  const present = new Set(kept.map(trackUri));
  const skip = new Set(removed);
  const added = [];
  for (const t of remote) {
    const u = trackUri(t);
    if (present.has(u) || skip.has(u)) continue;
    present.add(u);
    added.push({ ...t, synced: true });
  }
  return { tracks: [...kept, ...added], added: added.length, dropped: local.length - kept.length };
}

/** Sposta un elemento in un nuovo array. */
export function move(arr, from, to) {
  const a = arr.slice();
  if (from === to || from < 0 || to < 0 || from >= a.length || to >= a.length) return a;
  const [x] = a.splice(from, 1);
  a.splice(to, 0, x);
  return a;
}

/** Durata ISO 8601 di YouTube ("PT1H2M3S") in millisecondi, oppure null. */
export function isoDurationMs(str) {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(str || '');
  if (!m || str === 'P' || str.endsWith('T')) return null;
  const [, w, d, h, min, s] = m.map((x) => (x === undefined ? 0 : Number(x)));
  return Math.round(((((w * 7 + d) * 24 + h) * 60 + min) * 60 + s) * 1000);
}

export function formatTime(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '--:--';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Toglie dai titoli YouTube le diciture da video: "(Official Video)", "[Lyrics]", "| HD"… */
export function cleanTitle(s) {
  const junk = String.raw`official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|m\/?v|testo|videoclip|clip ufficiale|ufficiale`;
  const out = String(s)
    .replace(new RegExp(String.raw`\s*[(\[][^)\]]*\b(${junk})\b[^)\]]*[)\]]`, 'gi'), '')
    .replace(new RegExp(String.raw`\s*[|｜]\s*(${junk})\b.*$`, 'i'), '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return out || String(s).trim();
}

export function htmlUnescape(s) {
  return String(s)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function trackUri(t) {
  if (t.source === 'spotify') return `spotify:track:${t.sourceId}`;
  if (t.source === 'file') return `file:${t.sourceId}`;
  return `youtube:${t.sourceId}`;
}

/** Id da passare al lettore audio: i file sul telefono hanno il prefisso "file:". */
export const audioId = (t) => (t.source === 'file' ? `file:${t.sourceId}` : t.sourceId);

/**
 * Titolo e artista da un nome di file: "Artista - Titolo.m4a" → { artist, title }.
 * Toglie estensione, id tra parentesi quadre (es. "[dQw4w9WgXcQ]") e diciture da video.
 */
export function parseFileName(name) {
  let base = String(name || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/\s*\[[A-Za-z0-9_-]{11}\]\s*$/, '').replace(/_/g, ' ').trim();
  base = cleanTitle(base);
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(base);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base || 'Brano' };
}

/** Chiave di confronto tra titoli (per riconoscere il file scaricato di un brano YouTube). */
export function titleKey(s) {
  return cleanTitle(String(s || ''))
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function uid() {
  return (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).toString();
}

/**
 * Blocco di brani Spotify consecutivi a partire da `index`.
 * Vengono passati tutti insieme a Spotify, che li suona in sequenza anche se la web app
 * è in background o lo schermo è bloccato.
 */
export function spotifyRun(queue, index, max = 50) {
  let end = index;
  while (end + 1 < queue.length && queue[end + 1].source === 'spotify' && end - index + 1 < max) end++;
  return { start: index, end, uris: queue.slice(index, end + 1).map(trackUri) };
}

/** Posizione nella coda del brano che Spotify sta suonando, cercando dentro il blocco corrente. */
export function indexInRun(queue, run, uri, fromIndex) {
  for (let i = Math.max(fromIndex, run.start); i <= run.end; i++) {
    if (trackUri(queue[i]) === uri) return i;
  }
  return -1;
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Sceglie dalla risposta di un server Piped (`/streams/{id}`) l'URL da dare a un elemento
 * <audio>: prima l'audio AAC (m4a, il formato che iPhone suona sempre), poi il file mp4 con
 * audio e video insieme (l'elemento audio ne suona solo l'audio). Niente HLS, niente WebM/Opus.
 */
export function pickStream(data) {
  const audio = (data?.audioStreams || [])
    .filter((a) => a.url && /^audio\/mp4/.test(a.mimeType || ''))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  if (audio[0]) return audio[0].url;
  const muxed = (data?.videoStreams || [])
    .filter((v) => v.url && !v.videoOnly && /^video\/mp4/.test(v.mimeType || ''));
  const yt = muxed.filter((v) => !/LBRY/i.test(v.quality || ''));
  return (yt.find((v) => v.itag === 18) || yt[0] || muxed[0])?.url || null;
}

/** Id dei file sul telefono usati da un insieme di playlist (per non cancellarli mai). */
export function fileIdsIn(...lists) {
  const out = new Set();
  for (const list of lists) for (const p of list || []) for (const t of p?.tracks || []) if (t?.source === 'file') out.add(t.sourceId);
  return out;
}

/** File già importato con stesso nome e dimensione (per non salvarne due copie). */
export function findSameFile(lists, name, size) {
  for (const p of lists || []) for (const t of p.tracks || []) {
    if (t.source === 'file' && t.fileName === name && t.size === size) return t;
  }
  return null;
}
