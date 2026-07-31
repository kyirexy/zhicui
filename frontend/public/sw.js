// One-time cleanup Service Worker.
//
// Previous releases cached HTML and Next.js chunks. A returning client could
// therefore keep requesting assets from an older deployment and end on a
// blank page. This worker intentionally owns no fetch handler and stores
// nothing. Its only job is to replace an older worker, clear application
// caches, unregister itself, and move open clients back to the network.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      let cacheKeys = [];
      try {
        cacheKeys = await caches.keys();
      } catch {}
      await Promise.allSettled(
        cacheKeys.map((cacheKey) => caches.delete(cacheKey)),
      );

      try {
        await self.registration.unregister();
      } catch {}

      let clients = [];
      try {
        clients = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
      } catch {}
      await Promise.allSettled(
        clients.map((client) => client.navigate(client.url)),
      );
    })(),
  );
});
