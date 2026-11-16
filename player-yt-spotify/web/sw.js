// Service worker: rende l'app installabile e utilizzabile anche con rete instabile.
// Strategia "network first" per i file dell'app: gli aggiornamenti arrivano subito,
// la cache serve solo quando sei offline. Le API esterne non vengono mai messe in cache.
const CACHE = 'duetto-v54'; // stesso numero di VERSION in js/version.js
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/player.js', 'js/spotify.js', 'js/youtube.js',
  'js/store.js', 'js/settings.js', 'js/storage.js', 'js/util.js', 'js/ui.js',
  'js/sync.js', 'js/nowplaying.js', 'js/ytaudio.js', 'js/version.js',
  'icons/icon-192.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.searchParams.has('code')) return; // ritorno dal login Spotify
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
