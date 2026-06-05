// frontend/game-client/sw.js
// Service Worker for PWA offline support and caching
'use strict';

const CACHE_VERSION = 'pmg-v1';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const API_CACHE = `${CACHE_VERSION}-api`;
const IMAGE_CACHE = `${CACHE_VERSION}-images`;

// Precache static resources
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/src/main.js',
  '/src/api/client.js',
  '/src/game/GameStore.js',
  '/src/game/LocationManager.js',
  '/src/game/CatchEngine.js',
  '/src/game/RaidManager.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// API caching rules: path prefix -> { maxAge, strategy }
const API_CACHE_RULES = [
  { prefix: '/v1/map/nearby', maxAge: 30000, strategy: 'staleWhileRevalidate' },
  { prefix: '/v1/users/me', maxAge: 60000, strategy: 'staleWhileRevalidate' },
  { prefix: '/v1/users/me/inventory', maxAge: 30000, strategy: 'staleWhileRevalidate' },
  { prefix: '/v1/pokemon/pokedex', maxAge: 86400000, strategy: 'cacheFirst' },
  { prefix: '/v1/pokemon/my', maxAge: 60000, strategy: 'staleWhileRevalidate' },
  { prefix: '/v1/rewards/daily', maxAge: 60000, strategy: 'staleWhileRevalidate' },
];

// Operations that should NOT be cached (write operations)
const NO_CACHE_PATHS = [
  '/v1/catch/',
  '/v1/payment/',
  '/v1/auth/',
  '/v1/location',
  '/v1/friends/',
  '/v1/gyms/',
  '/v1/raids/',
];

// ── Install Event ─────────────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log('[SW] Installing Service Worker...');
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        console.log('[SW] Precaching static resources');
        return cache.addAll(PRECACHE_URLS);
      })
      .then(() => self.skipWaiting())
      .catch((err) => console.error('[SW] Precache failed:', err))
  );
});

// ── Activate Event ────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating Service Worker...');
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => !name.startsWith(CACHE_VERSION))
            .map((name) => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => {
        console.log('[SW] Service Worker activated');
        return self.clients.claim();
      })
  );
});

// ── Fetch Event ───────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests for caching
  if (request.method !== 'GET') {
    // Queue write operations for background sync if offline
    if (!navigator.onLine && shouldQueueForSync(url.pathname)) {
      event.respondWith(queueOperation(request));
      return;
    }
    event.respondWith(fetch(request));
    return;
  }

  // Skip cross-origin requests
  if (url.origin !== location.origin) {
    return;
  }

  // Determine caching strategy
  const strategy = getStrategyForPath(url.pathname);

  switch (strategy) {
    case 'cacheFirst':
      event.respondWith(cacheFirst(request));
      break;
    case 'staleWhileRevalidate':
      event.respondWith(staleWhileRevalidate(request));
      break;
    case 'networkFirst':
      event.respondWith(networkFirst(request));
      break;
    default:
      // Static resources: cacheFirst
      if (isStaticResource(url.pathname)) {
        event.respondWith(cacheFirst(request));
      } else {
        event.respondWith(networkFirst(request));
      }
  }
});

// ── Caching Strategies ────────────────────────────────────────

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return offlineResponse(request);
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(request);

  // Start background fetch regardless of cache
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        const cachedResponse = response.clone();
        cache.put(request, cachedResponse);
        // Store timestamp for maxAge check
        cache.put(
          request.url + ':timestamp',
          new Response(JSON.stringify({ timestamp: Date.now() }))
        );
      }
      return response;
    })
    .catch(() => null);

  // Return cached immediately if valid
  if (cached && await isCacheValid(request, cache)) {
    return cached;
  }

  // Wait for network if no valid cache
  const networkResponse = await fetchPromise;
  if (networkResponse) return networkResponse;
  if (cached) return cached;
  return offlineResponse(request);
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(API_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return offlineResponse(request);
  }
}

// ── Cache Validation ──────────────────────────────────────────

async function isCacheValid(request, cache) {
  const timestampEntry = await cache.match(request.url + ':timestamp');
  if (!timestampEntry) return true; // No timestamp, assume valid

  try {
    const { timestamp } = await timestampEntry.json();
    const rule = API_CACHE_RULES.find(r => request.url.includes(r.prefix));
    if (rule && rule.maxAge) {
      return Date.now() - timestamp < rule.maxAge;
    }
  } catch {}
  return true;
}

// ── Helper Functions ──────────────────────────────────────────

function getStrategyForPath(pathname) {
  for (const rule of API_CACHE_RULES) {
    if (pathname.startsWith(rule.prefix)) {
      return rule.strategy;
    }
  }
  return null;
}

function isStaticResource(pathname) {
  return pathname.match(/\.(html|css|js|png|jpg|jpeg|gif|svg|woff|woff2)$/i) ||
         pathname === '/' ||
         pathname === '/index.html';
}

function shouldQueueForSync(pathname) {
  return NO_CACHE_PATHS.some(p => pathname.startsWith(p));
}

function offlineResponse(request) {
  const url = new URL(request.url);

  // Return cached data for API requests
  if (url.pathname.startsWith('/v1/')) {
    return new Response(
      JSON.stringify({
        code: 9999,
        message: '当前离线，请检查网络连接',
        data: null,
        offline: true
      }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  // Return offline page for navigation requests
  if (request.mode === 'navigate') {
    return caches.match('/index.html');
  }

  return new Response('Offline', { status: 503 });
}

// ── Background Sync ───────────────────────────────────────────

const SYNC_QUEUE = 'pmg-sync-queue';

async function queueOperation(request) {
  try {
    const queue = await getSyncQueue();
    const operation = {
      id: Date.now() + Math.random(),
      url: request.url,
      method: request.method,
      body: await request.text(),
      headers: Object.fromEntries(request.headers.entries()),
      timestamp: Date.now()
    };
    queue.push(operation);
    await saveSyncQueue(queue);

    // Register background sync
    await self.registration.sync.register('sync-pending-operations');

    return new Response(
      JSON.stringify({
        code: 0,
        message: '操作已保存，将在恢复网络后同步',
        data: { queued: true, operationId: operation.id }
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[SW] Failed to queue operation:', err);
    return new Response(
      JSON.stringify({ code: 9999, message: '离线操作保存失败' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function getSyncQueue() {
  try {
    const cache = await caches.open(SYNC_QUEUE);
    const response = await cache.match('queue');
    if (response) return await response.json();
  } catch {}
  return [];
}

async function saveSyncQueue(queue) {
  const cache = await caches.open(SYNC_QUEUE);
  await cache.put('queue', new Response(JSON.stringify(queue)));
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-pending-operations') {
    event.waitUntil(syncPendingOperations());
  }
});

async function syncPendingOperations() {
  console.log('[SW] Starting background sync...');
  const queue = await getSyncQueue();
  const failed = [];

  for (const op of queue) {
    try {
      const response = await fetch(op.url, {
        method: op.method,
        body: op.body,
        headers: op.headers
      });

      if (!response.ok) {
        failed.push(op);
        console.warn('[SW] Sync failed for:', op.url);
      } else {
        console.log('[SW] Synced:', op.url);

        // Notify client of successful sync
        const clients = await self.clients.matchAll();
        clients.forEach(client => {
          client.postMessage({
            type: 'SYNC_COMPLETE',
            operation: op
          });
        });
      }
    } catch (err) {
      failed.push(op);
      console.error('[SW] Sync error:', err);
    }
  }

  await saveSyncQueue(failed);
  console.log(`[SW] Sync complete: ${queue.length - failed.length}/${queue.length}`);
}

// ── Push Notifications (placeholder for future) ───────────────

self.addEventListener('push', (event) => {
  if (!event.data) return;

  const data = event.data.json();
  const options = {
    body: data.body || '你有新的通知',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    vibrate: [100, 50, 100],
    tag: data.tag || 'default',
    data: data.data || {}
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Pocket Monster Go', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      // Focus existing window or open new
      for (const client of clientList) {
        if (client.url.includes('/index.html') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow('/index.html');
    })
  );
});

// ── Message Handler ───────────────────────────────────────────

self.addEventListener('message', (event) => {
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data.type === 'GET_SYNC_QUEUE') {
    getSyncQueue().then(queue => {
      event.ports[0].postMessage({ queue });
    });
  }

  if (event.data.type === 'CLEAR_CACHE') {
    caches.keys().then(names => {
      Promise.all(names.map(name => caches.delete(name)))
        .then(() => event.ports[0].postMessage({ cleared: true }));
    });
  }
});

console.log('[SW] Service Worker loaded');
