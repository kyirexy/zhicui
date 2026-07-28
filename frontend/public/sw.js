// VideoCapsule Service Worker
const CACHE_NAME = 'videocapsule-v3';
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

function offlineResponse(request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    return new Response(
      JSON.stringify({
        success: false,
        data: null,
        error: '网络暂不可用，请恢复连接后重试',
      }),
      {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      },
    );
  }

  const acceptsHtml = (
    request.mode === 'navigate'
    || (request.headers.get('accept') || '').includes('text/html')
  );
  if (acceptsHtml) {
    return new Response(
      '<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>知萃暂时离线</title><body style="font-family:system-ui;padding:2rem">'
        + '<h1>网络暂不可用</h1><p>恢复网络后刷新页面即可继续使用知萃。</p></body></html>',
      {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      },
    );
  }

  return new Response('', {
    status: 503,
    statusText: 'Service Unavailable',
  });
}

function rememberResponse(request, response) {
  if (!response.ok) return;
  const clone = response.clone();
  void caches
    .open(CACHE_NAME)
    .then((cache) => cache.put(request, clone))
    .catch(() => undefined);
}

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
        await Promise.allSettled(clients.map((client) => client.navigate(client.url)));
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

    // Authenticated API responses are never cached. Cache Storage keys do not
    // provide a safe user/session boundary for bearer-authenticated payloads.
    if (isApi) {
      event.respondWith(
        fetch(request).catch(() => offlineResponse(request)),
      );
      return;
    }

    if (isNextInternal || isHtml) {
      event.respondWith(
        fetch(request)
          .then((response) => {
            rememberResponse(request, response);
            return response;
          })
          .catch(async () => (
            (await caches.match(request)) || offlineResponse(request)
          )),
      );
      return;
    }

    // Static assets: cache-first
    event.respondWith(
      caches
        .match(request)
        .then((cached) => {
          if (cached) return cached;
          return fetch(request).then((response) => {
            rememberResponse(request, response);
            return response;
          });
        })
        .catch(() => offlineResponse(request)),
    );
  });
}
