// Service worker minimal : cache le shell pour un démarrage instantané en boutique
const CACHE = 'wf-scanner-v4';
const SHELL = ['/scanner/', '/scanner/index.html', '/scanner/manifest.json'];
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || e.request.url.includes('/api/')) return;
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
