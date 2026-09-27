/* DynaLedger service worker — offline-first app shell + CDN runtime cache */
const VER = 'dynaledger-v2';
const CORE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VER).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VER).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Cache-first for app shell + CDNs/fonts (opaque ok). Network falls back to cache when offline.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isCDN = /cdn\.tailwindcss\.com|cdn\.jsdelivr\.net|unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|peerjs|0\.peerjs\.com/.test(url.hostname + url.href);
  const isSame = url.origin === self.location.origin;
  if (!isCDN && !isSame) return;
  // Never cache peerjs websocket/signalling traffic (only GET statics reach here anyway)
  e.respondWith(
    caches.match(req, { ignoreSearch: false }).then((hit) => {
      if (hit) {
        // refresh CDN entries quietly in background
        if (isCDN) fetch(req).then((res) => {
          if (res && (res.ok || res.type === 'opaque')) caches.open(VER).then((c) => c.put(req, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(VER).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
