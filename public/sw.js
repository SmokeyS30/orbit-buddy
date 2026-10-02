const CACHE = 'orbit-buddy-v11';
const ASSETS = ['/', '/styles.css', '/mobile.css', '/app.js', '/manifest.webmanifest', '/icon.svg', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS))));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request).then((response) => { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(event.request, copy)); return response; }).catch(() => caches.match(event.request)));
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
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const target = windows[0];
    return target ? target.focus().then(() => target.navigate(`/#${view}`)) : clients.openWindow(`/#${view}`);
  }));
});
