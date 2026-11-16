import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../web/js/player.js';

const s = (id, ms = 200000) => ({ source: 'spotify', sourceId: id, title: id, artist: '', durationMs: ms, synced: true });
const y = (id) => ({ source: 'youtube', sourceId: id, title: id, artist: '', durationMs: 180000 });

function setup(opts = {}) {
  const calls = [];
  const ytHandlers = {};
  const spotify = {
    play: async (uris, opts = {}) => { calls.push(['sp.play', uris, opts]); if (spotify.fail) throw spotify.fail; return opts.contextUri && opts.force !== 'album' ? 'playlist' : 'album'; },
    pause: async () => { calls.push(['sp.pause']); },
    resume: async () => { calls.push(['sp.resume']); },
    seek: async () => {},
    playbackState: async () => null,
  };
  const youtube = {
    on: (evt, fn) => { ytHandlers[evt] = fn; },
    load: (id) => calls.push(['yt.load', id]),
    play: () => calls.push(['yt.play']),
    pause: () => calls.push(['yt.pause']),
    stop: () => calls.push(['yt.stop']),
    seek: () => {},
    currentMs: () => 0,
    durationMs: () => 0,
  };
  const player = new Player({ spotify, youtube, autoPoll: false, ...opts });
  return { player, calls, yt: ytHandlers };
}

const st = (id, { playing = true, pos = 1000, dur = 200000 } = {}) => ({
  is_playing: playing, progress_ms: pos, item: { uri: `spotify:track:${id}`, duration_ms: dur },
});
const tick = () => new Promise((r) => setTimeout(r, 0));
const plays = (calls) => calls.filter((c) => c[0] === 'sp.play');
const CTX = { id: 'p', name: 'P', spotifyUri: 'spotify:playlist:PL' };

test('playlist sincronizzata: parte dalla playlist Spotify al brano scelto, il blocco copre i brani consecutivi', async () => {
  const { player, calls } = setup();
  player.context = CTX;
  player.playList([s('a'), s('b'), y('x'), s('c')]);
  await tick();
  const [, uris, opts] = plays(calls)[0];
  assert.deepEqual(uris, ['spotify:track:a']);
  assert.equal(opts.contextUri, 'spotify:playlist:PL');
  assert.deepEqual(player.run.uris, ['spotify:track:a', 'spotify:track:b']);
});

test('brano non sincronizzato o casuale: parte dall\'album, blocco di un solo brano', async () => {
  const { player, calls } = setup();
  player.context = CTX;
  player.playList([{ ...s('a'), synced: false, albumId: 'AL' }, s('b')]);
  await tick();
  const [, , opts] = plays(calls)[0];
  assert.equal(opts.contextUri, null);
  assert.equal(opts.albumId, 'AL');
  assert.deepEqual(player.run.uris, ['spotify:track:a']);
});

test('segue il brano corrente dentro il blocco e passa a YouTube a fine blocco (Spotify si ferma)', async () => {
  const { player, calls } = setup();
  player.playList([s('a'), s('b'), y('x')]);
  await tick();
  player.handleSpotifyState(st('a'));
  assert.equal(player.index, 0);
  player.handleSpotifyState(st('b', { pos: 5000 }));
  assert.equal(player.index, 1);
  player.handleSpotifyState(st('b', { pos: 198000 }));      // quasi alla fine
  player.handleSpotifyState(st('b', { playing: false, pos: 0 })); // Spotify si è fermato
  assert.equal(player.index, 2);
  assert.deepEqual(calls.at(-1), ['yt.load', 'x']);
  assert.ok(calls.some((c) => c[0] === 'sp.pause'));
});

test('fine blocco quando Spotify passa a un brano non nostro (autoplay)', async () => {
  const { player, calls } = setup();
  player.playList([s('a'), y('x')]);
  await tick();
  player.handleSpotifyState(st('a'));
  player.handleSpotifyState(st('zzz'));
  assert.equal(player.index, 1);
  assert.deepEqual(calls.at(-1), ['yt.load', 'x']);
});

test('pausa manuale nello Spotify non fa avanzare', async () => {
  const { player } = setup();
  player.playList([s('a'), y('x')]);
  await tick();
  player.handleSpotifyState(st('a', { pos: 50000 }));
  player.handleSpotifyState(st('a', { playing: false, pos: 50000 }));
  assert.equal(player.index, 0);
  assert.equal(player.playing, false);
});

test('stato iniziale vecchio (brano precedente) viene ignorato finché il nostro non parte', async () => {
  const { player } = setup();
  player.playList([s('a'), y('x')]);
  await tick();
  player.handleSpotifyState(st('old'));
  assert.equal(player.index, 0);
});

test('fine video YouTube passa al blocco Spotify successivo', async () => {
  const { player, calls, yt } = setup();
  player.context = CTX;
  player.playList([y('x'), s('a'), s('b')]);
  assert.deepEqual(calls.at(-1), ['yt.load', 'x']);
  yt.state(1);
  assert.equal(player.playing, true);
  yt.state(0);
  await tick();
  assert.equal(player.index, 1);
  assert.deepEqual(plays(calls)[0][1], ['spotify:track:a']);
  assert.deepEqual(player.run.uris, ['spotify:track:a', 'spotify:track:b']);
});

test('errore YouTube salta al successivo', async () => {
  const { player, yt } = setup();
  player.playList([y('x'), y('y')]);
  yt.error('non incorporabile');
  assert.equal(player.index, 1);
  assert.match(player.error, /non incorporabile/);
});

test('fine coda: si ferma; con ripeti tutto ricomincia', async () => {
  const { player, yt } = setup();
  player.playList([y('x')]);
  yt.state(0);
  assert.equal(player.playing, false);

  player.setRepeat('all');
  player.jump(0);
  yt.state(0);
  assert.equal(player.index, 0);
  assert.equal(player.playing, true);
});

test('ripeti brano su Spotify usa un blocco di un solo brano', async () => {
  const { player, calls } = setup();
  player.setRepeat('one');
  player.playList([s('a'), s('b')]);
  await tick();
  assert.deepEqual(plays(calls)[0][1], ['spotify:track:a']);
  assert.deepEqual(player.run.uris, ['spotify:track:a']);
  player.handleSpotifyState(st('a', { pos: 199000 }));
  player.handleSpotifyState(st('a', { playing: false, pos: 0 }));
  await tick();
  assert.equal(player.index, 0);
  assert.equal(calls.filter((c) => c[0] === 'sp.play').length, 2);
});

test('rimuovere brani prima del corrente aggiorna l\'indice', () => {
  const { player } = setup();
  player.playList([y('a'), y('b'), y('c')], 2);
  player.removeAt(0);
  assert.equal(player.index, 1);
  assert.equal(player.current.sourceId, 'c');
});

test('casuale: il brano attuale resta, il blocco Spotify si accorcia, spegnendo torna l\'ordine', async () => {
  const { player } = setup();
  player.playList([s('a'), s('b'), s('c'), y('x'), y('z')], 0);
  await tick();
  player.handleSpotifyState(st('a'));
  player.setShuffle(true);
  assert.equal(player.current.sourceId, 'a');
  assert.equal(player.index, 0);
  assert.equal(player.queue.length, 5);
  assert.equal(player.run.end, 0);
  player.setShuffle(false);
  assert.deepEqual(player.queue.map((t) => t.sourceId), ['a', 'b', 'c', 'x', 'z']);
  assert.equal(player.index, 0);
});

test('playList con casuale attivo parte dal brano scelto', () => {
  const { player } = setup();
  player.setShuffle(true);
  player.playList([y('a'), y('b'), y('c')], 2);
  assert.equal(player.current.sourceId, 'c');
  assert.equal(player.index, 0);
  player.setShuffle(false);
  assert.deepEqual(player.queue.map((t) => t.sourceId), ['a', 'b', 'c']);
  assert.equal(player.index, 2);
});

test('ripristino: si riaggancia a Spotify se suona ancora un brano del blocco', async () => {
  const { player, calls } = setup();
  player.restore({ queue: [s('a'), s('b'), y('x')].map((t, k) => ({ ...t, qid: 'q' + k })), index: 0 });
  assert.equal(player.playing, false);
  player.handleSpotifyState(st('b', { pos: 3000 }));
  assert.equal(player.index, 1);
  assert.equal(player.playing, true);
  assert.equal(calls.filter((c) => c[0] === 'sp.play').length, 0); // nessun riavvio
});

test('ripristino: Spotify fermo su un altro brano → resta in pausa senza avanzare', () => {
  const { player, calls } = setup();
  player.restore({ queue: [s('a'), y('x')].map((t, k) => ({ ...t, qid: 'q' + k })), index: 0 });
  player.handleSpotifyState(st('zzz', { playing: false }));
  assert.equal(player.index, 0);
  assert.equal(player.playing, false);
  assert.equal(calls.filter((c) => c[0] === 'yt.load').length, 0);
});

test('ripristino dopo "avanti" dal widget Spotify: passa al file successivo e mette in pausa Spotify', () => {
  const { player, calls } = setup();
  player.restore({ queue: [s('a'), { ...y('x'), source: 'file' }].map((t, k) => ({ ...t, qid: 'q' + k })), index: 0 });
  player.handleSpotifyState(st('zzz'));
  assert.equal(player.index, 1);
  assert.ok(calls.some((c) => c[0] === 'sp.pause'));
  assert.ok(calls.some((c) => c[0] === 'yt.load'));
});

test('widget Spotify "avanti" durante la riproduzione: Duetto va al suo successivo (file)', async () => {
  const { player, calls } = setup();
  player.playList([{ ...s('a'), synced: false }, { ...y('x'), source: 'file' }, s('c')]);
  await tick();
  player.handleSpotifyState(st('a'));
  player.handleSpotifyState(st('album-next'));
  assert.equal(player.index, 1);
  assert.ok(calls.some((c) => c[0] === 'yt.load'));
});

test('Spotify torna a un brano precedente della coda: Duetto si allinea senza rimandare comandi', async () => {
  const { player, calls } = setup();
  player.playList([{ ...s('a'), synced: false }, y('x'), { ...s('c'), synced: false }], 2);
  await tick();
  player.handleSpotifyState(st('c'));
  const n = plays(calls).length;
  player.handleSpotifyState(st('a', { pos: 5000 })); // "indietro" dal widget di Spotify
  assert.equal(player.index, 0);
  assert.equal(player.playing, true);
  assert.equal(plays(calls).length, n);
});

test('ripristino YouTube: il play ricarica il brano invece di restare muto', () => {
  const { player, calls } = setup();
  player.restore({ queue: [{ ...y('x'), qid: 'q0' }], index: 0 });
  player.toggle();
  assert.deepEqual(calls.at(-1), ['yt.load', 'x']);
});

test('Spotify chiuso: segna needsDevice e retry riparte', async () => {
  const { player, calls } = setup();
  const err = Object.assign(new Error('Spotify è chiuso sul telefono'), { reason: 'NO_ACTIVE_DEVICE' });
  player.spotify.fail = err;
  player.playList([s('a')]);
  await tick();
  assert.equal(player.needsDevice, true);
  assert.equal(player.playing, false);
  player.spotify.fail = null;
  player.retry();
  await tick();
  assert.equal(player.needsDevice, false);
  assert.equal(calls.filter((c) => c[0] === 'sp.play').length, 2);
});

test('comando accettato ma non eseguito dalla playlist: riprova dall\'album, poi avviso onesto', async () => {
  const { player, calls } = setup();
  player.context = CTX;
  player.playList([s('a'), s('b')]);
  await tick();
  player.handleSpotifyState(st('vecchio')); // subito: si aspetta ancora
  assert.equal(plays(calls).length, 1);
  player.sentAt = Date.now() - 5000;
  player.handleSpotifyState(st('vecchio'));
  await tick();
  assert.equal(plays(calls).length, 2);
  assert.equal(plays(calls)[1][2].force, 'album');
  assert.deepEqual(player.run.uris, ['spotify:track:a']);
  assert.equal(player.error, null);
  player.handleSpotifyState(st('a')); // dall'album il telefono obbedisce
  assert.equal(player.playing, true);
});

test('comando mai eseguito nemmeno con un brano: avviso onesto', async () => {
  const { player } = setup();
  player.playList([s('a'), s('b')]);
  await tick();
  for (let k = 0; k < 4 && !player.error; k++) {
    player.sentAt = Date.now() - 5000;
    player.handleSpotifyState(st('vecchio'));
    await tick();
  }
  assert.equal(player.playing, false);
  assert.equal(player.needsDevice, true);
  assert.match(player.error, /non risponde/);
});

test('comando confermato: nessun nuovo invio', async () => {
  const { player, calls } = setup();
  player.playList([s('a')]);
  await tick();
  player.handleSpotifyState(st('a'));
  player.sentAt = Date.now() - 5000; // anche se il tempo passa, il brano è confermato
  player.handleSpotifyState(st('a', { pos: 9000 }));
  assert.equal(calls.filter((c) => c[0] === 'sp.play').length, 1);
  assert.equal(player.playing, true);
});

test('previousTrack va al brano prima senza riavvolgere', () => {
  const { player } = setup();
  player.playList([y('a'), y('b')], 1);
  player.positionMs = 60000;
  player.previousTrack();
  assert.equal(player.current.sourceId, 'a');
});

test('play dopo un ripristino: se Spotify ha un altro brano manda il nostro, non "riprendi"', async () => {
  const { player, calls } = setup();
  player.spotify.playbackState = async () => st('canzone-aperta-su-spotify', { playing: false });
  player.restore({ queue: [s('a'), s('b')].map((t, k) => ({ ...t, qid: 'q' + k })), index: 0 });
  await player.toggle();
  await tick();
  assert.equal(calls.some((c) => c[0] === 'sp.resume'), false);
  assert.deepEqual(plays(calls)[0][1], ['spotify:track:a']);
});

test('play quando Spotify ha già il nostro brano in pausa: riprende senza ricominciare', async () => {
  const { player, calls } = setup();
  player.spotify.playbackState = async () => st('a', { playing: false, pos: 60000 });
  player.restore({ queue: [s('a'), s('b')].map((t, k) => ({ ...t, qid: 'q' + k })), index: 0 });
  await player.toggle();
  assert.equal(calls.filter((c) => c[0] === 'sp.play').length, 0);
  assert.ok(calls.some((c) => c[0] === 'sp.resume'));
});

test('file sul telefono: suona dal lettore audio con id "file:", fine brano passa al successivo', () => {
  const { player, calls, yt } = setup();
  const f = (id) => ({ source: 'file', sourceId: id, title: id, artist: '', durationMs: 1000 });
  player.playList([f('uno'), f('due')]);
  assert.deepEqual(calls.at(-1), ['yt.load', 'file:uno']);
  yt.state(1);
  yt.state(0);
  assert.deepEqual(calls.at(-1), ['yt.load', 'file:due']);
});

test('aggiungi alla coda: dopo l\'attuale e dopo gli altri in coda, prima del resto', () => {
  const { player } = setup();
  player.playList([y('a'), y('b'), y('c')], 0);
  player.enqueue(y('q1'));
  player.enqueue(y('q2'));
  player.playNext(y('subito'));
  assert.deepEqual(player.queue.map((t) => t.sourceId), ['a', 'subito', 'q1', 'q2', 'b', 'c']);
  player.next();
  assert.equal(player.current.sourceId, 'subito');
  player.enqueue(y('q3')); // va dopo q1, q2
  assert.deepEqual(player.queue.map((t) => t.sourceId), ['a', 'subito', 'q1', 'q2', 'q3', 'b', 'c']);
});

test('aggiungi alla coda durante un blocco Spotify: il blocco si accorcia, poi parte il brano in coda', async () => {
  const { player, calls } = setup();
  player.context = CTX;
  player.playList([s('a'), s('b'), s('c')]);
  await tick();
  player.handleSpotifyState(st('a'));
  assert.deepEqual(player.run.uris, ['spotify:track:a', 'spotify:track:b', 'spotify:track:c']);
  player.enqueue(y('q'));
  assert.equal(player.run.end, 0);
  // Spotify passa da solo a "b" (playlist): non è nel blocco → Duetto suona il brano in coda.
  player.handleSpotifyState(st('b'));
  assert.equal(player.current.sourceId, 'q');
  assert.deepEqual(calls.at(-1), ['yt.load', 'q']);
});

test('ultimo brano Spotify del blocco quasi finito: si passa al file un attimo prima', async () => {
  const { player, calls } = setup();
  player.playList([s('a'), { source: 'file', sourceId: 'f', title: 'f', artist: '', durationMs: 1000 }]);
  await tick();
  player.handleSpotifyState(st('a', { pos: 100000 }));
  assert.equal(player.index, 0);
  player.handleSpotifyState(st('a', { pos: 199300 })); // mancano 0,7 s
  assert.equal(player.index, 1);
  assert.deepEqual(calls.at(-1), ['yt.load', 'file:f']);
  assert.ok(calls.some((c) => c[0] === 'sp.pause'));
});

test('coda alternata Spotify / file / Spotify / file con "avanti" ripetuto', async () => {
  const { player, calls } = setup();
  const f = (id) => ({ source: 'file', sourceId: id, title: id, artist: '', durationMs: 1000 });
  player.playList([s('s1'), f('f1'), s('s2'), f('f2')]);
  await tick();
  player.handleSpotifyState(st('s1'));
  const mark = () => calls.length;
  let m = mark();
  player.next(); await tick();                                   // → f1
  assert.equal(player.current.sourceId, 'f1');
  assert.deepEqual(calls.slice(m).map((c) => c[0]).sort(), ['sp.pause', 'yt.load'].sort());
  m = mark();
  player.next(); await tick();                                   // → s2
  assert.equal(player.current.sourceId, 's2');
  assert.ok(calls.slice(m).some((c) => c[0] === 'sp.play' && c[1][0] === 'spotify:track:s2'));
  assert.ok(calls.slice(m).some((c) => c[0] === 'yt.stop'));
  m = mark();
  player.next(); player.next(); await tick();                    // due "avanti" di fila: f2, poi fine coda
  assert.equal(player.current.sourceId, 'f2');
  assert.equal(player.playing, false);
  m = mark();
  player.previousTrack(); await tick();                          // indietro: di nuovo s2
  assert.equal(player.current.sourceId, 's2');
  assert.ok(calls.slice(m).some((c) => c[0] === 'sp.play' && c[1][0] === 'spotify:track:s2'));
});

test('conferma con Spotify ancora "in pausa" mentre carica: il pulsante resta su "suona"', async () => {
  const { player } = setup();
  player.playList([{ ...s('a'), synced: false }]);
  await tick();
  player.sentAt = Date.now();
  player.handleSpotifyState(st('a', { playing: false, pos: 0 }));
  assert.equal(player.playing, true);
});

test('play quando Spotify suona già il nostro brano: nessun comando, solo il pulsante', async () => {
  const { player, calls } = setup();
  player.playList([{ ...s('a'), synced: false }]);
  await tick();
  player.playing = false;
  player.spotify.playbackState = async () => st('a');
  const n = calls.length;
  await player.toggle();
  assert.equal(player.playing, true);
  assert.equal(calls.length, n);
});

test('Spotify suona la stessa canzone con un altro codice: confermato, niente nuovi invii', async () => {
  const { player, calls } = setup();
  player.playList([{ ...s('a'), title: 'Canzone (Remastered)', synced: false }, y('x')]);
  await tick();
  player.sentAt = Date.now() - 5000;
  const n = plays(calls).length;
  player.handleSpotifyState({ is_playing: true, progress_ms: 2000, item: { uri: 'spotify:track:ALTRO', name: 'Canzone - Remastered 2011', duration_ms: 201000 } });
  assert.equal(player.runStarted, true);
  assert.equal(player.index, 0);
  assert.equal(plays(calls).length, n);
});

test('coda come Spotify: il primo aggiunto suona per primo, anche con "Riproduci dopo"', () => {
  const { player } = setup();
  player.playList([y('cur'), y('rest')]);
  player.enqueue(y('q1'));
  player.enqueue(y('q2'));
  player.playNext(y('n1'));
  player.playNext(y('n2'));
  player.enqueue(y('q3'));
  assert.deepEqual(player.queue.map((t) => t.sourceId), ['cur', 'n1', 'n2', 'q1', 'q2', 'q3', 'rest']);
});
