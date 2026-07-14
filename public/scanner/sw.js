/**
 * Service worker "kill switch".
 *
 * L'ancienne version se désinscrivait PUIS forçait client.navigate(url), ce qui
 * relançait la page, qui réenregistrait le SW, qui se désinscrivait... => boucle
 * de rechargement infinie, la page ne chargeait plus du tout.
 *
 * Ici : on purge les caches, on se désinscrit, et on NE TOUCHE PAS à la navigation.
 * Le fichier reste en place pour nettoyer les téléphones où l'ancien SW est encore installé.
 */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (_) { /* pas de cache : rien à faire */ }
    await self.registration.unregister();
    // PAS de client.navigate() ici. C'est ça qui bouclait.
  })());
});
