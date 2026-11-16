import { test } from 'node:test';
import assert from 'node:assert/strict';
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { bestMatch } = await import('../web/js/youtube.js');

const v = (title, artist, durationMs) => ({ source: 'youtube', sourceId: title, title, artist, durationMs });

test('bestMatch: preferisce durata giusta e titolo, scarta live e cover', () => {
  const track = { title: 'Blinding Lights', artist: 'The Weeknd', durationMs: 200000 };
  const list = [
    v('Blinding Lights (Live)', 'The Weeknd', 230000),
    v('Blinding Lights cover', 'Pinco', 201000),
    v('Blinding Lights', 'The Weeknd', 201500),
    v('Altro brano', 'The Weeknd', 200000),
  ];
  assert.equal(bestMatch(list, track).title, 'Blinding Lights');
});

test('bestMatch: niente di simile → null', () => {
  const track = { title: 'Canzone', artist: 'Tizio', durationMs: 200000 };
  assert.equal(bestMatch([v('Video lunghissimo', 'Altro', 3600000)], track), null);
  assert.equal(bestMatch([], track), null);
});
