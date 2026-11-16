import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLink, isoDurationMs, formatTime, spotifyRun, indexInRun, htmlUnescape } from '../web/js/util.js';

test('parseLink: Spotify e YouTube', () => {
  const cases = [
    ['spotify:track:4uLU6hMCjMI75M1A2tKUQC', 'spotify', '4uLU6hMCjMI75M1A2tKUQC'],
    ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc', 'spotify', '4uLU6hMCjMI75M1A2tKUQC'],
    ['https://open.spotify.com/intl-it/track/4uLU6hMCjMI75M1A2tKUQC', 'spotify', '4uLU6hMCjMI75M1A2tKUQC'],
    ['youtube:dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', 'youtube', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=x', 'youtube', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
  ];
  for (const [input, source, sourceId] of cases) {
    assert.deepEqual(parseLink(input), { source, sourceId }, input);
  }
  assert.equal(parseLink('ciao'), null);
  assert.equal(parseLink('https://open.spotify.com/album/123'), null);
  assert.equal(parseLink('https://notyoutube.com/watch?v=abc'), null);
});

test('isoDurationMs', () => {
  assert.equal(isoDurationMs('PT3M33S'), 213000);
  assert.equal(isoDurationMs('PT1H2M3S'), 3723000);
  assert.equal(isoDurationMs('PT45S'), 45000);
  assert.equal(isoDurationMs('P1DT1S'), 86401000);
  assert.equal(isoDurationMs('PT'), null);
  assert.equal(isoDurationMs('P'), null);
  assert.equal(isoDurationMs('3M'), null);
  assert.equal(isoDurationMs(undefined), null);
});

test('formatTime', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(213000), '3:33');
  assert.equal(formatTime(3723000), '1:02:03');
  assert.equal(formatTime(null), '--:--');
});

test('htmlUnescape', () => {
  assert.equal(htmlUnescape('Rock &amp; Roll &#39;69&#39;'), "Rock & Roll '69'");
  assert.equal(htmlUnescape('&amp;quot;'), '&quot;');
});

test('spotifyRun raggruppa i brani Spotify consecutivi', () => {
  const s = (id) => ({ source: 'spotify', sourceId: id });
  const y = (id) => ({ source: 'youtube', sourceId: id });
  const q = [s('a'), s('b'), y('x'), s('c'), s('d'), s('e')];
  assert.deepEqual(spotifyRun(q, 0), { start: 0, end: 1, uris: ['spotify:track:a', 'spotify:track:b'] });
  assert.deepEqual(spotifyRun(q, 3).uris.length, 3);
  assert.equal(spotifyRun(q, 3, 2).end, 4);
  assert.equal(indexInRun(q, spotifyRun(q, 3), 'spotify:track:e', 3), 5);
  assert.equal(indexInRun(q, spotifyRun(q, 3), 'spotify:track:a', 3), -1);
});

import { parseCollection, mergeSync, move } from '../web/js/util.js';

test('parseCollection: playlist YouTube, playlist e album Spotify', () => {
  assert.deepEqual(parseCollection('https://www.youtube.com/playlist?list=PLabc123'),
    { source: 'youtube', kind: 'playlist', id: 'PLabc123' });
  assert.deepEqual(parseCollection('https://music.youtube.com/playlist?list=OLAK5uy_x'),
    { source: 'youtube', kind: 'playlist', id: 'OLAK5uy_x' });
  assert.deepEqual(parseCollection('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc'),
    { source: 'youtube', kind: 'playlist', id: 'PLabc', videoId: 'dQw4w9WgXcQ' });
  assert.equal(parseCollection('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ'), null);
  assert.equal(parseCollection('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.deepEqual(parseCollection('https://open.spotify.com/playlist/37i9dQZF1?si=x'),
    { source: 'spotify', kind: 'playlist', id: '37i9dQZF1' });
  assert.deepEqual(parseCollection('https://open.spotify.com/intl-it/album/4aawyAB9'),
    { source: 'spotify', kind: 'album', id: '4aawyAB9' });
  assert.deepEqual(parseCollection('spotify:album:abc'), { source: 'spotify', kind: 'album', id: 'abc' });
  assert.equal(parseCollection('ciao'), null);
});

test('mergeSync: tiene i brani aggiunti a mano, segue Spotify, rispetta le rimozioni', () => {
  const s = (id, synced = true) => ({ source: 'spotify', sourceId: id, synced });
  const y = (id) => ({ source: 'youtube', sourceId: id });
  const local = [s('a'), y('x'), s('b'), s('m', false)];
  const remote = [s('a'), s('c'), s('d'), s('m')];
  const r = mergeSync(local, remote, ['spotify:track:d']);
  assert.deepEqual(r.tracks.map((t) => t.sourceId), ['a', 'x', 'm', 'c']);
  assert.equal(r.added, 1);
  assert.equal(r.dropped, 1);
  assert.equal(r.tracks.at(-1).synced, true);
  // Prima sincronizzazione: playlist vuota.
  assert.deepEqual(mergeSync([], remote).tracks.map((t) => t.sourceId), ['a', 'c', 'd', 'm']);
});

test('move', () => {
  assert.deepEqual(move([1, 2, 3, 4], 0, 2), [2, 3, 1, 4]);
  assert.deepEqual(move([1, 2, 3], 2, 0), [3, 1, 2]);
  assert.deepEqual(move([1, 2], 0, 5), [1, 2]);
});

import { cleanTitle } from '../web/js/util.js';

test('cleanTitle toglie le diciture da video', () => {
  assert.equal(cleanTitle('Artista - Brano (Official Video)'), 'Artista - Brano');
  assert.equal(cleanTitle('Brano [Official Music Video] (Lyrics)'), 'Brano');
  assert.equal(cleanTitle('Brano (feat. Altro) [HD]'), 'Brano (feat. Altro)');
  assert.equal(cleanTitle('Brano | Official Audio'), 'Brano');
  assert.equal(cleanTitle('Video Killed the Radio Star'), 'Video Killed the Radio Star');
  assert.equal(cleanTitle('(Official Video)'), '(Official Video)');
});

import { pickStream } from '../web/js/util.js';

test('pickStream: preferisce m4a, poi mp4 con audio, mai HLS o webm', () => {
  assert.equal(pickStream({
    audioStreams: [
      { url: 'opus', mimeType: 'audio/webm', bitrate: 160000 },
      { url: 'm4a-low', mimeType: 'audio/mp4', bitrate: 48000 },
      { url: 'm4a-high', mimeType: 'audio/mp4', bitrate: 128000 },
    ],
  }), 'm4a-high');
  assert.equal(pickStream({
    audioStreams: [],
    videoStreams: [
      { url: 'lbry', mimeType: 'video/mp4', quality: 'LBRY', videoOnly: false, itag: -1 },
      { url: 'hls', mimeType: 'application/x-mpegurl', quality: 'LBRY HLS', videoOnly: false },
      { url: 'only', mimeType: 'video/mp4', videoOnly: true, itag: 137 },
      { url: 'muxed', mimeType: 'video/mp4', quality: '360p', videoOnly: false, itag: 18 },
    ],
  }), 'muxed');
  assert.equal(pickStream({ audioStreams: [], videoStreams: [{ url: 'h', mimeType: 'application/x-mpegurl' }] }), null);
  assert.equal(pickStream(null), null);
});

import { parseFileName, titleKey, trackUri, audioId } from '../web/js/util.js';

test('parseFileName: artista e titolo dal nome del file scaricato', () => {
  assert.deepEqual(parseFileName('Måneskin - Zitti e buoni (Official Video).m4a'), { artist: 'Måneskin', title: 'Zitti e buoni' });
  assert.deepEqual(parseFileName('Live al Forum [dQw4w9WgXcQ].mp3'), { artist: '', title: 'Live al Forum' });
  assert.deepEqual(parseFileName('nome_file_strano.wav'), { artist: '', title: 'nome file strano' });
});

test('titleKey riconosce lo stesso brano tra YouTube e file', () => {
  assert.equal(titleKey('Måneskin - ZITTI E BUONI (Official Video)'), titleKey('Maneskin - Zitti e buoni'));
  assert.notEqual(titleKey('Brano A'), titleKey('Brano B'));
});

test('file sul telefono: uri e id del lettore', () => {
  const f = { source: 'file', sourceId: 'abc' };
  assert.equal(trackUri(f), 'file:abc');
  assert.equal(audioId(f), 'file:abc');
  assert.equal(audioId({ source: 'youtube', sourceId: 'v' }), 'v');
});

import { fileIdsIn, findSameFile } from '../web/js/util.js';

test('fileIdsIn: raccoglie i file usati da playlist, copia di sicurezza e coda', () => {
  const a = [{ tracks: [{ source: 'file', sourceId: 'f1' }, { source: 'spotify', sourceId: 's' }] }];
  const b = [{ tracks: [{ source: 'file', sourceId: 'f2' }] }];
  assert.deepEqual([...fileIdsIn(a, b, null, [{ tracks: [{ source: 'file', sourceId: 'f3' }] }])].sort(), ['f1', 'f2', 'f3']);
});

test('findSameFile: stesso nome e dimensione = stesso file', () => {
  const lists = [{ tracks: [{ source: 'file', sourceId: 'f1', fileName: 'a.m4a', size: 10 }] }];
  assert.equal(findSameFile(lists, 'a.m4a', 10).sourceId, 'f1');
  assert.equal(findSameFile(lists, 'a.m4a', 11), null);
});

test('mergeSync non tocca mai i file importati (restano nella loro posizione)', () => {
  const s = (id) => ({ source: 'spotify', sourceId: id, synced: true });
  const f = { source: 'file', sourceId: 'mio-file' };
  const r = mergeSync([s('a'), f, s('b')], [s('b'), s('c')]);
  assert.deepEqual(r.tracks.map((t) => t.sourceId), ['mio-file', 'b', 'c']);
  assert.deepEqual(mergeSync([f], []).tracks.map((t) => t.sourceId), ['mio-file']);
});
