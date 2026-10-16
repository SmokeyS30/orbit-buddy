// Orbit Buddy service worker.
//
// Cache strategies:
// - App shell + static assets: precached at install; stale-while-revalidate at
//   runtime, so versioned URLs (e.g. /styles.css?v=...) self-heal even if the
//   precache entry ever lags behind a query-string bump.
// - Navigations (HTML): network-first, so the maintenance page and the
//   ?maint_bypass= override always reach the server live.
// - API traffic: never touched (bypassed entirely).
//
// Bump CACHE + STATIC_VERSION together whenever shipped static assets change,
// so existing clients drop the old cache cleanly on next visit.

const CACHE = 'orbit-buddy-v53';
const STATIC_VERSION = '20261015a'; // keep in sync with the ?v= in public/index.html

// Every static asset the app shell needs on first paint / offline.
// The list is generated from these entries (see buildPrecacheManifest) so it
// can't go stale the way the old hardcoded list did — v50 missed the
// versioned ?v= CSS, voice-mode.js, canvas.js and desktop.css.
// W7: voice-mode.js and canvas.js are NOT precached anymore — they are
// code-split chunks fetched on first use. The fetch handler below serves them
// via stale-while-revalidate on demand (network, then cached), so removing
// them from the precache list is safe.
const STATIC_ASSETS = [
  { url: '/', versioned: false },
  { url: '/styles.css', versioned: true },
  { url: '/mobile.css', versioned: false },
  { url: '/desktop.css', versioned: false },
  { url: '/smooth.css', versioned: false },
  { url: '/app.js', versioned: false },
  { url: '/briefing-layout.js', versioned: false },
  { url: '/chat-scroll.js', versioned: false },
  { url: '/chat-markdown.js', versioned: false },
  { url: '/deep-link.js', versioned: false },
  { url: '/smooth.js', versioned: false },
  { url: '/pwa-install.js', versioned: false },
  { url: '/vendor/marked.min.js', versioned: false },
  { url: '/vendor/purify.min.js', versioned: false },
  { url: '/manifest.webmanifest', versioned: false },
  { url: '/icon.svg', versioned: false },
  { url: '/apple-touch-icon.png', versioned: false },
  { url: '/icon-192.png', versioned: false },
  { url: '/icon-512.png', versioned: false },
];

function buildPrecacheManifest() {
  return STATIC_ASSETS.map((entry) =>
    entry.versioned ? `${entry.url}?v=${STATIC_VERSION}` : entry.url
  );
}

const STATIC_RE = /\.(css|js|mjs|svg|png|jpg|jpeg|webp|ico|woff2?)($|\?)/i;

function isStaticAsset(url) {
  return (
    url.origin === self.location.origin &&
    (url.pathname.startsWith('/vendor/') || STATIC_RE.test(url.pathname))
  );
}

function cacheable(response) {
  return response && response.ok && (response.type === 'basic' || response.type === 'default');
}

function putInCache(request, response) {
  const copy = response.clone();
  return caches.open(CACHE).then((cache) => cache.put(request, copy));
}

// Navigations + anything dynamic: network first, cache as fallback.
function networkFirst(request) {
  return fetch(request)
    .then((response) => {
      if (cacheable(response)) putInCache(request, response).catch(() => {});
      return response;
    })
    .catch(() =>
      caches
        .match(request)
        .then((cached) => cached || (request.mode === 'navigate' ? caches.match('/') : undefined))
    );
}

// Versioned/unversioned static assets: serve from cache, revalidate in the
// background so the next visit gets the fresh bytes.
function staleWhileRevalidate(request) {
  return caches.match(request).then((cached) => {
    const network = fetch(request)
      .then((response) => {
        if (cacheable(response)) putInCache(request, response).catch(() => {});
        return response;
      })
      .catch(() => cached);
    return cached || network;
  });
}

self.addEventListener('install', (event) =>
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(buildPrecacheManifest()))
      .then(() => self.skipWaiting())
  )
);

self.addEventListener('activate', (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((windows) =>
        Promise.all(
          windows.map((client) => {
            try {
              client.postMessage({ type: 'SW_UPDATED' });
            } catch (_) {}
            try {
              const p = client.navigate(client.url);
              if (p && p.catch) p.catch(() => {});
            } catch (_) {}
          })
        )
      )
  )
);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return; // API traffic: never intercepted
  if (request.mode === 'navigate' || !isStaticAsset(url)) {
    // HTML (incl. the maintenance page / bypass) and anything dynamic:
    // network-first so the server is always authoritative.
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});

self.addEventListener('push', (event) => {
  const payload = event.data?.json() || { title: 'Orbit Buddy', body: 'Orbit has an update.' };
  const data = payload.data || {};
  const actions = data.doorAction && data.doorToken ? [{ action: 'open-door', title: 'Open the door' }] : [];
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: '/icon.svg', badge: '/icon.svg', data, tag: data.taskId || 'orbit-update', actions
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  if (event.action === 'open-door' && data.doorToken) {
    event.waitUntil(fetch('/api/registration/door-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: data.doorToken }) }).then((response) => {
      if (!response.ok) throw new Error('expired');
      return self.registration.showNotification('Door is open', { body: 'Registration is open. Close it from Safety when done.', icon: '/icon.svg', badge: '/icon.svg', data: { view: 'safety' } });
    }).catch(() => clients.openWindow('/#safety')));
    return;
  }
  const view = data.view || 'today';
  // W4: notification tap deep-linking — when the push relates to a conversation,
  // carry its id in the URL so the app opens that thread on boot (the client
  // seeds its active conversation from ?conversation=; see public/app.js).
  // Notifications without a conversation keep the hash-only behavior.
  const conversationId = typeof data.conversationId === 'string' && data.conversationId ? data.conversationId : null;
  const targetUrl = conversationId ? `/?conversation=${encodeURIComponent(conversationId)}#${view}` : `/#${view}`;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const target = windows[0];
    return target ? target.focus().then(() => target.navigate(targetUrl)) : clients.openWindow(targetUrl);
  }));
});
