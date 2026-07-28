// VideoCapsule Service Worker
const CACHE_NAME = 'videocapsule-v2';
const STATIC_ASSETS = [
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Self-destruct on dev hosts. If a prod SW was ever installed on localhost
// (which happens once anyone runs `next start` against the same origin) it
// will keep serving stale Turbopack chunks across reloads and put dev into
// an infinite refresh loop. Detect and remove ourselves before doing
// anything else.
const isDevHost = (() => {
  const h = self.location.hostname;
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '0.0.0.0' ||
    h.endsWith('.local')
  );
})();

if (isDevHost) {
  self.addEventListener('install', () => {
    self.skipWaiting();
  });
  self.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
        await self.registration.unregister();
        const clients = await self.clients.matchAll({ type: 'window' });
        clients.forEach((c) => c.navigate(c.url));
      })(),
    );
  });
  // No fetch handler in dev — let the network handle everything.
} else {
  // Install: cache static assets
  self.addEventListener('install', (event) => {
    event.waitUntil(
      caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)),
    );
    self.skipWaiting();
  });

  // Activate: clean old caches
  self.addEventListener('activate', (event) => {
    event.waitUntil(
      caches.keys().then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
        ),
      ),
    );
    self.clients.claim();
  });

  // Fetch: network-first for API and Next.js HTML/chunks (so dev/HMR
  // and live API responses stay fresh), cache-first for static media.
  self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    if (request.method !== 'GET') return;

    const isApi = url.pathname.startsWith('/api/');
    const isNextInternal = url.pathname.startsWith('/_next/');
    const isHtml =
      request.mode === 'navigate' ||
      (request.headers.get('accept') || '').includes('text/html');

    if (isApi || isNextInternal || isHtml) {
      event.respondWith(
        fetch(request)
          .then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return response;
          })
          .catch(() => caches.match(request)),
      );
      return;
    }

    // Static assets: cache-first
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      }),
    );
  });
}
