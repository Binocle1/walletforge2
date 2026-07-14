// Service worker minimal : cache le shell pour un démarrage instantané en boutique
const CACHE = 'wf-scanner-v7'; // Bump version
const SHELL = ['/scanner/', '/scanner/index.html', '/scanner/manifest.json'];
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks =>
    Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || e.request.url.includes('/api/') || e.request.url.startsWith('blob:')) return;
  // Network first for HTML, cache fallback. Cache first for everything else.
  const accept = e.request.headers.get('accept') || '';
  if (accept.includes('text/html')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const resClone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, resClone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
  }
});
