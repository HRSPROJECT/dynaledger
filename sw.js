/* CashBook service worker — fully offline-first (no CDN dependencies at all) */
const VER = 'cashbook-v1';
const CORE = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VER).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VER).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    if (res && res.ok) { const copy = res.clone(); caches.open(VER).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match('./index.html'))));
});
