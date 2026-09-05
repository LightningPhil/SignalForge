// 6.0.0-72f8ec07a1ee is replaced at build time with the package version and a hash of the built
// entry document, so every deployment gets its own runtime cache and stale hashed chunks are evicted.
const CACHE_NAME = 'signalforge-runtime-6.0.0-72f8ec07a1ee';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('signalforge-runtime-') && key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request, fallbackToScopeRoot) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallbackToScopeRoot) {
      const root = await cache.match(new URL('./', self.registration.scope).href);
      if (root) return root;
    }
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || request.headers.has('range')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, true).catch(() => Response.error()));
    return;
  }

  // Only content-hashed build assets are immutable. Everything else (notices, icons, the worker
  // script itself) is served network-first so a redeploy is picked up without clearing site data.
  const scopePath = new URL(self.registration.scope).pathname;
  const isHashedAsset = url.pathname.startsWith(`${scopePath}assets/`);
  event.respondWith(isHashedAsset ? cacheFirst(request) : networkFirst(request, false));
});
