// Coordinatore della coda ibrida.
//
// - I brani Spotify si avviano "da un contesto" (la playlist Spotify sincronizzata, oppure
//   l'album del brano) partendo dal brano scelto: è l'unico comando che l'app Spotify su
//   iPhone esegue davvero. Con la playlist, Spotify prosegue da solo nei brani consecutivi
//   (`makeRun`), anche con la web app in background o lo schermo bloccato.
// - Quando il blocco finisce (Spotify si ferma o passa a un brano che non è nostro)
//   si passa al video YouTube successivo, e viceversa.
// - Lo stato Spotify si legge con polling della Web API (non esistono eventi push).
import { spotifyRun, indexInRun, trackUri, audioId, shuffle, uid } from './util.js';

const NEAR_END_MS = 5000;
const CONFIRM_MS = 3500;
const EARLY_SWITCH_MS = 1200;  // anticipo con cui si lascia l'ultimo brano Spotify del blocco   // entro quanto Spotify deve mostrare il brano richiesto

const norm = (x) => String(x || '').toLowerCase().replace(/\s*[-(\[].*$/, '').replace(/[^\p{L}\p{N}]+/gu, '');
/** Stesso brano anche se Spotify usa un altro codice: stesso titolo, durata entro 5 s. */
function sameSong(item, t) {
  if (!item?.name || !t?.title || norm(item.name) !== norm(t.title)) return false;
  return !item.duration_ms || !t.durationMs || Math.abs(item.duration_ms - t.durationMs) < 5000;
}

export class Player {
  /**
   * @param {object} deps
   * @param {object} deps.spotify  { play(uris), pause(), resume(), seek(ms), playbackState() }
   * @param {object} deps.youtube  { load(id), play(), pause(), stop(), seek(ms), currentMs(), durationMs(), on(evt, fn) }
   * @param {boolean} [deps.autoPoll=true]
   */
  constructor({ spotify, youtube, autoPoll = true }) {
    this.spotify = spotify;
    this.youtube = youtube;
    this.autoPoll = autoPoll;
    this.context = null;        // { id, name, spotifyUri? } della playlist in riproduzione
    this.spotifyMode = null;    // come è stato avviato l'ultimo blocco: 'playlist' | 'album'

    this.queue = [];
    this.index = -1;
    this.playing = false;
    this.positionMs = 0;
    this.durationMs = 0;
    this.repeat = 'off'; // 'off' | 'all' | 'one'
    this.shuffled = false;
    this.original = null;       // ordine della coda prima del casuale
    this.error = null;
    this.needsDevice = false;   // Spotify chiuso sul telefono: si riprova al ritorno nell'app
    this.ytBlocked = false;
    this.ytLoadedQid = null;    // brano YouTube effettivamente caricato nel lettore
    this.restoring = false;     // primo controllo dopo un ripristino: non far avanzare la coda
    this.sentAt = 0;            // quando è stato mandato a Spotify l'ultimo "suona"
    this.resent = false;        // il comando è già stato rimandato una volta

    this.run = null;            // blocco Spotify in corso
    this.runStarted = false;    // Spotify ha confermato di suonare un brano del blocco
    this.lastNearEnd = false;
    this.pollTimer = null;
    this.tickTimer = null;
    this.listeners = new Set();
    this.generation = 0;        // invalida risposte asincrone di brani precedenti

    youtube.on('state', (s) => this.onYouTubeState(s));
    youtube.on('error', (msg) => {
      if (!this.current || this.current.source === 'spotify') return;
      const skipped = this.current.title;
      // Un "ripeti brano" su un video non riproducibile girerebbe a vuoto.
      if (this.repeat === 'one') this.repeat = 'off';
      this.advanceFrom(this.index, true);
      this.setError(`"${skipped}": ${msg} Passo al successivo.`);
    });
    youtube.on('blocked', (b) => { this.ytBlocked = b; this.emit(); });

    if (autoPoll) {
      this.tickTimer = setInterval(() => this.tick(), 500);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.current?.source === 'spotify') this.poll();
      });
    }
  }

  get current() { return this.queue[this.index] || null; }
  get hasNext() { return this.index + 1 < this.queue.length || (this.repeat === 'all' && this.queue.length > 0); }

  subscribe(fn) { this.listeners.add(fn); fn(this); return () => this.listeners.delete(fn); }
  emit() { this.listeners.forEach((fn) => fn(this)); }
  setError(msg) { this.error = msg; this.emit(); }
  clearError() { this.error = null; this.needsDevice = false; this.emit(); }

  /** Riprova il brano attuale (es. dopo aver riaperto Spotify). */
  retry(opts) { if (this.current) this.start(this.index, opts); }

  /** Stato da salvare: iOS può chiudere l'app in background e al ritorno si riparte da qui. */
  snapshot() {
    if (!this.current) return null;
    return {
      queue: this.queue, index: this.index, positionMs: this.positionMs,
      shuffled: this.shuffled, original: this.original, repeat: this.repeat,
    };
  }

  /**
   * Ripristina la coda salvata, in pausa. Se il brano era di Spotify e Spotify lo sta ancora
   * suonando (anche più avanti nel blocco), il player si riaggancia e prosegue come prima.
   */
  restore(s) {
    if (!s?.queue?.length || !s.queue[s.index]) return;
    this.queue = s.queue;
    this.index = s.index;
    this.original = s.original || null;
    this.shuffled = !!s.shuffled;
    this.repeat = s.repeat || 'off';
    this.positionMs = s.positionMs || 0;
    this.durationMs = this.current.durationMs || 0;
    this.playing = false;
    if (this.current.source === 'spotify') {
      const t = this.current;
      this.run = this.makeRun(this.index);
      this.runStarted = true;
      this.restoring = true;
      this.schedulePoll(300);
    }
    this.emit();
  }

  // ---------- Comandi ----------

  playList(tracks, start = 0) {
    if (!tracks.length) return;
    this.queue = tracks.map((t) => ({ ...t, qid: uid() }));
    this.original = null;
    if (this.shuffled) {
      this.original = this.queue.slice();
      const first = this.queue[start];
      this.queue = [first, ...shuffle(this.queue.filter((_, i) => i !== start))];
      start = 0;
    }
    this.start(start);
  }

  playShuffled(tracks) {
    this.shuffled = true;
    this.playList(tracks, Math.floor(Math.random() * tracks.length));
  }

  /** Casuale on/off sulla coda in corso: il brano attuale resta, cambia solo quello che segue. */
  setShuffle(on) {
    if (on === this.shuffled) return;
    this.shuffled = on;
    const cur = this.current;
    if (cur) {
      if (on) {
        this.original = this.queue.slice();
        const rest = shuffle(this.queue.filter((_, i) => i !== this.index));
        this.queue = [cur, ...rest];
        this.index = 0;
      } else if (this.original) {
        const kept = new Set(this.queue.map((t) => t.qid));
        this.queue = this.original.filter((t) => kept.has(t.qid));
        this.index = Math.max(0, this.queue.findIndex((t) => t.qid === cur.qid));
        this.original = null;
      }
      this.truncateRun();
    }
    this.emit();
  }

  /** Dopo una modifica alla coda il blocco Spotify in corso vale solo fino al brano attuale. */
  truncateRun() {
    if (this.run) this.run = { start: Math.min(this.run.start, this.index), end: this.index, uris: this.run.uris };
  }

  moveInQueue(from, to) {
    if (from === this.index || to <= this.index || !this.queue[from] || !this.queue[to]) return;
    const [t] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, t);
    this.truncateRun();
    this.emit();
  }

  /**
   * "Aggiungi alla coda", come su Spotify: il brano suona dopo quello attuale e dopo gli altri
   * già messi in coda (in ordine di aggiunta), prima del resto della playlist.
   */
  enqueue(track) {
    if (this.index < 0) { this.queue.push({ ...track, qid: uid() }); return this.start(this.queue.length - 1); }
    let at = this.index + 1;
    while (at < this.queue.length && this.queue[at].queued) at++;
    this.insertAt(at, track);
  }

  /** "Riproduci dopo": subito dopo il brano attuale, davanti a tutto. */
  playNext(track) {
    if (this.index < 0) { this.queue.push({ ...track, qid: uid() }); return this.start(this.queue.length - 1); }
    // Dopo l'attuale e dopo gli altri "Riproduci dopo" (nell'ordine in cui li hai scelti),
    // davanti a quelli "Aggiungi alla coda".
    let at = this.index + 1;
    while (at < this.queue.length && this.queue[at].queued && this.queue[at].playNext) at++;
    this.insertAt(at, track, { playNext: true });
  }

  insertAt(at, track, extra = {}) {
    const item = { ...track, qid: uid(), queued: true, ...extra };
    this.queue.splice(at, 0, item);
    // Con il casuale attivo il brano va anche nell'ordine originale, subito dopo l'attuale.
    if (this.original) {
      const k = this.original.findIndex((t) => t.qid === this.current?.qid);
      this.original.splice(k + 1, 0, item);
    }
    // Il blocco Spotify in corso finiva più avanti: ora finisce con il brano attuale, così
    // dopo di esso parte il brano messo in coda e non il successivo della playlist Spotify.
    if (this.run && this.run.end >= at) this.truncateRun();
    this.emit();
  }

  removeAt(i) {
    if (i === this.index) return;
    this.queue.splice(i, 1);
    if (i < this.index) this.index--;
    // Il blocco Spotify in corso resta valido solo fino al brano attuale.
    this.truncateRun();
    this.emit();
  }

  jump(i) { if (this.queue[i]) this.start(i); }
  next() { this.advanceFrom(this.index, false); }

  previous() {
    if (this.positionMs > 3000 || this.index <= 0) this.seek(0);
    else this.start(this.index - 1);
  }

  async toggle() {
    const t = this.current;
    if (!t) return;
    this.clearError();
    try {
      if (t.source !== 'spotify') {
        if (t.qid !== this.ytLoadedQid) return this.start(this.index);
        this.playing ? this.youtube.pause() : this.youtube.play();
      } else if (this.playing) {
        this.playing = false; this.emit();
        await this.spotify.pause();
      } else {
        // "Riprendi" solo se Spotify ha davvero in mano il nostro brano: altrimenti riprenderebbe
        // la canzone aperta nell'app Spotify. In tutti gli altri casi si manda il brano giusto.
        const state = await this.spotify.playbackState().catch(() => null);
        if (t !== this.current) return;
        const sUri = state?.item?.linked_from?.uri || state?.item?.uri;
        if (sUri === trackUri(t) && state.is_playing) {
          // Suonava già: era solo il pulsante a dire "pausa".
          if (!this.run) this.run = this.makeRun(this.index);
          this.runStarted = true;
          this.playing = true; this.emit();
          this.schedulePoll(1500);
          return;
        }
        if (sUri === trackUri(t)) {
          if (!this.run) this.run = this.makeRun(this.index);
          this.runStarted = true;
          this.restoring = false;
          this.playing = true; this.emit();
          await this.spotify.resume();
          this.schedulePoll(1500);
        } else {
          this.spotify.log?.(`play: Spotify ha ${state?.item?.uri || 'niente'}, mando ${trackUri(t)}`);
          this.start(this.index);
        }
      }
    } catch (e) {
      this.setError(e.message);
    }
  }

  async seek(ms) {
    const t = this.current;
    if (!t) return;
    this.positionMs = ms;
    this.emit();
    try {
      if (t.source !== 'spotify') this.youtube.seek(ms);
      else { await this.spotify.seek(ms); this.schedulePoll(1000); }
    } catch (e) { this.setError(e.message); }
  }

  setRepeat(mode) { this.repeat = mode; this.emit(); }

  stop() {
    this.generation++;
    this.stopPolling();
    if (this.current?.source === 'spotify' || this.run) this.spotify.pause().catch(() => {});
    this.youtube.stop();
    this.ytLoadedQid = null;
    this.run = null;
    this.runStarted = false;
    this.playing = false;
    this.index = -1;
    this.queue = [];
    this.positionMs = this.durationMs = 0;
    this.emit();
  }

  // ---------- Logica ----------

  async start(i, { waitMs = 0 } = {}) {
    const t = this.queue[i];
    if (!t) return;
    const gen = ++this.generation;
    const wasSpotify = !!this.run;
    this.index = i;
    this.error = null;
    this.needsDevice = false;
    this.restoring = false;
    this.positionMs = 0;
    this.durationMs = t.durationMs || 0;
    this.playing = true;
    this.lastNearEnd = false;
    this.stopPolling();

    if (t.source === 'spotify') {
      this.youtube.stop();
      this.run = this.makeRun(i, this.playlistContextFor(t) ? 'playlist' : 'album');
      this.runStarted = false;
      this.resent = false;
      this.emit();
      await this.sendSpotify(i, { waitMs });
    } else {
      this.run = null;
      this.runStarted = false;
      this.emit();
      if (wasSpotify) this.spotify.pause().catch(() => {});
      this.ytLoadedQid = t.qid;
      this.youtube.load(audioId(t));
    }
  }

  /** Passa al brano dopo `from`. `auto` = fine naturale del brano (rispetta "ripeti brano"). */
  advanceFrom(from, auto) {
    if (auto && this.repeat === 'one' && this.queue[from]) return this.start(from);
    if (from + 1 < this.queue.length) return this.start(from + 1);
    if (this.repeat === 'all' && this.queue.length) return this.start(0);
    // Fine coda.
    this.generation++;
    this.stopPolling();
    if (this.run) this.spotify.pause().catch(() => {});
    this.run = null;
    this.runStarted = false;
    this.playing = false;
    this.positionMs = 0;
    this.emit();
  }

  onYouTubeState(s) {
    if (!this.current || this.current.source === 'spotify') return;
    if (s === 1) this.playing = true;
    else if (s === 2) this.playing = false;
    else if (s === 0) return this.advanceFrom(this.index, true);
    this.emit();
  }

  /** Interpreta lo stato restituito da GET /me/player. Esposto per i test. */
  handleSpotifyState(state) {
    const run = this.run;
    if (!run || this.current?.source !== 'spotify') return;
    const item = state?.item;
    // Spotify a volte suona una versione "equivalente" del brano (altro mercato): conta l'originale.
    let uri = item?.linked_from?.uri && this.queue.some((t) => trackUri(t) === item.linked_from.uri) ? item.linked_from.uri : item?.uri;
    // Stessa canzone con un altro codice (ristampa, altro paese): stesso titolo e durata simile.
    const cur = this.current;
    if (uri && cur && uri !== trackUri(cur) && sameSong(item, cur)) {
      if (this.sentAt) this.spotify.log?.(`Spotify suona "${item.name}" con un altro codice (${uri}): è lo stesso brano`);
      uri = trackUri(cur);
    }
    const k = uri ? indexInRun(this.queue, run, uri, this.index) : -1;

    if (k < 0 && uri && (this.restoring || this.runStarted)) {
      // Spotify suona un altro brano della nostra coda (es. "indietro"/"avanti" dal widget
      // di Spotify, o la playlist è andata avanti da sola): Duetto si allinea a quello.
      // Solo un brano precedente o proprio il successivo: se Spotify è andato oltre, saltando
      // brani di Duetto (file, coda), si suona il successivo di Duetto.
      const j = this.findInQueue(uri);
      if (j >= 0 && (j < this.index || j === this.nextIndexAfter(run.end))) {
        this.restoring = false;
        this.spotify.log?.(`allineato: Spotify suona il brano ${j + 1} della coda`);
        this.index = j;
        this.run = this.makeRun(j, this.spotifyMode || 'album');
        this.runStarted = true;
        this.sentAt = 0;
        this.lastNearEnd = false;
        this.playing = !!state.is_playing;
        this.positionMs = state.progress_ms || 0;
        this.durationMs = item.duration_ms || this.queue[j].durationMs || 0;
        this.emit();
        return;
      }
    }

    if (this.restoring) {
      this.restoring = false;
      if (k < 0) {
        if (state?.is_playing && item) {
          // Mentre Duetto era chiuso è stato premuto "avanti" sul widget di Spotify (o Spotify
          // è andato avanti da solo): si passa al brano successivo di Duetto.
          this.spotify.log?.(`Spotify è passato a ${uri} fuori da Duetto: vado al brano successivo della coda`);
          return this.endRun();
        }
        // Spotify fermo: resta in pausa.
        this.run = null;
        this.runStarted = false;
        this.playing = false;
        this.emit();
        return;
      }
    }

    if (k >= 0) {
      const justSent = !!this.sentAt;
      if (justSent) this.spotify.log?.(`confermato: Spotify suona il brano scelto (${this.spotifyMode || '?'})`);
      // Subito dopo il comando Spotify può dire "in pausa" mentre carica: resta "suona".
      const nowPlaying = !!state.is_playing || (justSent && (state.progress_ms || 0) < 3000);
      if (this.runStarted && this.playing && !nowPlaying && !justSent) {
        this.spotify.log?.(`Spotify si è messo in pausa da solo (${state?.device?.name || '?'})`);
      }
      this.runStarted = true;
      this.sentAt = 0;
      this.index = k;
      this.playing = nowPlaying;
      this.positionMs = state.progress_ms || 0;
      this.durationMs = item.duration_ms || this.queue[k].durationMs || 0;

      const atStart = !state.is_playing && this.positionMs < 1500;
      if (k === run.end && atStart && this.lastNearEnd) {
        // Spotify si è fermato alla fine dell'ultimo brano del blocco.
        return this.endRun();
      }
      // Ultimo brano del blocco quasi finito e dopo c'è altro: si passa un attimo prima della
      // fine, altrimenti Spotify farebbe sentire per un secondo il SUO brano successivo
      // (della playlist o dell'album) prima che Duetto cambi.
      const remaining = this.durationMs - this.positionMs;
      if (k === run.end && state.is_playing && this.durationMs > 0 && remaining < EARLY_SWITCH_MS
        && this.repeat !== 'one' && this.nextIndexAfter(k) >= 0) {
        return this.endRun();
      }
      this.lastNearEnd = k === run.end && remaining < NEAR_END_MS;
      this.emit();
      return;
    }

    if (state?.device?.name) this.deviceName = state.device.name;
    if (!this.runStarted) {
      // Spotify non suona ancora il brano scelto. Se passa troppo tempo il comando è andato
      // perso (app Spotify sospesa da iOS): lo rimando una volta, poi chiedo di aprire Spotify.
      if (this.sentAt && Date.now() - this.sentAt > CONFIRM_MS) {
        this.spotify.log?.(`conferma mancata: Spotify suona ${item?.name ? `"${item.name}" ` : ''}${uri || 'niente'} su ${state?.device?.name || '?'}, atteso ${run.uris[0]}`);
        this.commandLost();
      }
      return;
    }

    if (!state || !item) {
      // Niente in riproduzione: se eravamo alla fine il blocco è finito, altrimenti è in pausa.
      if (this.lastNearEnd) return this.endRun();
      this.playing = false;
      this.emit();
      return;
    }

    // Spotify suona un brano che non è nel blocco (avanti dal widget di Spotify, autoplay):
    // si passa al brano successivo di Duetto.
    this.spotify.log?.(`Spotify è passato a ${uri} fuori da Duetto: vado al brano successivo della coda`);
    this.endRun();
  }

  /**
   * Blocco di brani che Spotify suonerà da solo dopo il comando:
   * - 'playlist': i brani consecutivi della playlist Spotify sincronizzata (stesso ordine);
   * - 'album' o "ripeti brano": solo il brano scelto (poi è Duetto a passare al successivo).
   */
  makeRun(i, mode = 'playlist') {
    const t = this.queue[i];
    if (this.repeat === 'one' || mode === 'album') return { start: i, end: i, uris: [trackUri(t)] };
    let end = i;
    while (end + 1 < this.queue.length && this.queue[end + 1].source === 'spotify' && this.queue[end + 1].synced) end++;
    return { start: i, end, uris: this.queue.slice(i, end + 1).map(trackUri) };
  }

  /** Playlist Spotify da usare come contesto, se il brano ne fa parte e l'ordine è quello. */
  playlistContextFor(t) {
    return t.synced && !this.shuffled && this.context?.spotifyUri ? this.context.spotifyUri : null;
  }

  /**
   * Spotify ha accettato il comando ma non l'ha eseguito: se era "dalla playlist" riprovo
   * "dall'album", altrimenti rimando una volta; poi lo dico chiaramente.
   */
  commandLost() {
    if (this.resent) {
      this.failSpotify(true, 'Spotify non risponde');
      return;
    }
    this.resent = true;
    const force = this.spotifyMode === 'playlist' ? 'album' : null;
    this.spotify.log?.(force ? 'riprovo partendo dall\'album del brano' : 'riprovo');
    this.sendSpotify(this.index, { force });
  }

  /** Manda a Spotify il brano `i` (con contesto) e prepara il blocco da seguire. */
  async sendSpotify(i, { waitMs = 0, force = null } = {}) {
    const t = this.queue[i];
    const gen = this.generation;
    const contextUri = force === 'album' ? null : this.playlistContextFor(t);
    try {
      const mode = await this.spotify.play([trackUri(t)], { waitMs, contextUri, albumId: t.albumId, force });
      if (gen !== this.generation) return;
      this.spotifyMode = mode || 'album';
      this.run = this.makeRun(i, this.spotifyMode);
      this.runStarted = false;
      // Spotify risponde "ok" anche quando il telefono non esegue: si verifica col polling.
      this.sentAt = Date.now();
      this.schedulePoll(900);
    } catch (e) {
      if (gen !== this.generation) return;
      this.failSpotify(e.reason === 'NO_ACTIVE_DEVICE', e.message);
    }
  }

  failSpotify(needsDevice, msg) {
    this.generation++;
    this.stopPolling();
    this.run = null;
    this.runStarted = false;
    this.sentAt = 0;
    this.playing = false;
    this.needsDevice = needsDevice;
    this.setError(msg);
  }

  /** Brano precedente vero (per lo scorrimento): non riavvolge il brano attuale. */
  previousTrack() {
    if (this.index > 0) this.start(this.index - 1);
    else if (this.repeat === 'all' && this.queue.length) this.start(this.queue.length - 1);
    else this.seek(0);
  }

  endRun() {
    const end = this.run?.end ?? this.index;
    const nextIsSpotify = this.nextIndexAfter(end) >= 0 && this.queue[this.nextIndexAfter(end)].source === 'spotify';
    if (!nextIsSpotify) this.spotify.pause().catch(() => {});
    this.run = null;
    this.runStarted = false;
    this.advanceFrom(end, true);
  }

  /** Posizione nella coda di un brano Spotify, cercando prima vicino al brano attuale. */
  findInQueue(uri) {
    const n = this.queue.length;
    for (let d = 1; d < n; d++) {
      for (const j of [this.index + d, this.index - d]) {
        if (j >= 0 && j < n && this.queue[j].source === 'spotify' && trackUri(this.queue[j]) === uri) return j;
      }
    }
    return -1;
  }

  nextIndexAfter(i) {
    if (this.repeat === 'one') return i;
    if (i + 1 < this.queue.length) return i + 1;
    return this.repeat === 'all' && this.queue.length ? 0 : -1;
  }

  // ---------- Polling / timer ----------

  schedulePoll(ms) {
    if (!this.autoPoll) return;
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.poll(), ms);
  }

  stopPolling() { clearTimeout(this.pollTimer); this.pollTimer = null; }

  async poll() {
    if (!this.run) return;
    const gen = this.generation;
    let delay = 3000;
    try {
      const state = await this.spotify.playbackState();
      if (gen !== this.generation) return;
      this.handleSpotifyState(state);
      if (!this.run) return;
      const remaining = this.durationMs - this.positionMs;
      // Più frequente verso la fine del brano per un passaggio rapido.
      delay = this.playing && remaining < 4000 ? 400 : this.playing && remaining < 8000 ? 1000 : this.playing ? 3000 : 5000;
      // In attesa che Spotify confermi il brano richiesto: controlli ravvicinati.
      if (!this.runStarted && this.sentAt) delay = 1000;
    } catch (e) {
      if (e.status === 429) delay = 10000;
      else if (e.status === 401) { this.setError(e.message); return; }
    }
    if (document.hidden) delay = Math.max(delay, 5000);
    this.schedulePoll(delay);
  }

  tick() {
    const t = this.current;
    if (!t || !this.playing) return;
    if (t.source !== 'spotify') {
      this.positionMs = this.youtube.currentMs();
      const d = this.youtube.durationMs();
      if (d > 0) this.durationMs = d;
    } else if (this.runStarted) {
      // Interpolazione tra un polling e l'altro.
      this.positionMs = Math.min(this.positionMs + 500, this.durationMs || Infinity);
    }
    this.emit();
  }
}
