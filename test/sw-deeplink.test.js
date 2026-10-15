import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Load public/sw.js in a sandbox with stubbed `self`/`clients`, mirroring
// test/sw-manifest.test.js, so the notificationclick data → navigation mapping
// can be exercised without a browser or a real push subscription.
function loadSw() {
  const src = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  const listeners = {};
  const sandbox = {
    URL: URL,
    self: {
      location: { origin: 'https://orbitbuddy.app' },
      addEventListener: (name, fn) => {
        listeners[name] = fn;
      },
    },
    clients: null, // installed per test
    fetch: async () => ({ ok: false }),
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { sandbox, listeners };
}

// Fires notificationclick with stubbed clients; windows=[] simulates the app
// not being open (clients.openWindow path).
async function fireClick({ sandbox, listeners }, { data = {}, action = '', windows = null }) {
  let closed = false;
  const navigated = [];
  const opened = [];
  sandbox._windows = windows === null
    ? [{ focus: async () => {}, navigate: (url) => { navigated.push(url); return Promise.resolve(); } }]
    : windows;
  sandbox.clients = {
    matchAll: async () => sandbox._windows,
    openWindow: async (url) => { opened.push(url); return {}; },
  };
  const pending = [];
  listeners.notificationclick({
    action,
    notification: { data, close() { closed = true; } },
    waitUntil(promise) { pending.push(Promise.resolve(promise)); },
  });
  await Promise.all(pending);
  return { closed, navigated, opened };
}

test('notificationclick closes the notification', async () => {
  const sw = loadSw();
  const { closed } = await fireClick(sw, { data: { view: 'today' } });
  assert.equal(closed, true);
});

test('tap with conversationId navigates the open window to the deep link', async () => {
  const sw = loadSw();
  const { navigated, opened } = await fireClick(sw, {
    data: { view: 'today', conversationId: 'abc-123' },
  });
  assert.deepEqual(navigated, ['/?conversation=abc-123#today']);
  assert.deepEqual(opened, []);
});

test('tap preserves the payload view in the deep-link hash', async () => {
  const sw = loadSw();
  const { navigated } = await fireClick(sw, {
    data: { view: 'tasks', conversationId: 'abc-123' },
  });
  assert.deepEqual(navigated, ['/?conversation=abc-123#tasks']);
});

test('tap with conversationId opens a new window when the app is closed', async () => {
  const sw = loadSw();
  const { navigated, opened } = await fireClick(sw, {
    data: { view: 'today', conversationId: 'abc-123' },
    windows: [],
  });
  assert.deepEqual(navigated, []);
  assert.deepEqual(opened, ['/?conversation=abc-123#today']);
});

test('tap without conversationId keeps the legacy hash-only navigation', async () => {
  const sw = loadSw();
  const { navigated } = await fireClick(sw, { data: { view: 'safety' } });
  assert.deepEqual(navigated, ['/#safety']);
});

test('tap with no data falls back to the today view', async () => {
  const sw = loadSw();
  const { navigated } = await fireClick(sw, { data: {} });
  assert.deepEqual(navigated, ['/#today']);
});

test('non-string conversationId values are ignored (no crash, hash-only)', async () => {
  const sw = loadSw();
  for (const conversationId of [123, null, {}, []]) {
    const { navigated } = await fireClick(sw, { data: { view: 'today', conversationId } });
    assert.deepEqual(navigated, ['/#today'], `for ${JSON.stringify(conversationId)}`);
  }
});

test('conversationId is URL-encoded in the deep link', async () => {
  const sw = loadSw();
  const { navigated } = await fireClick(sw, {
    data: { view: 'today', conversationId: 'a b/c' },
  });
  assert.deepEqual(navigated, ['/?conversation=a%20b%2Fc#today']);
});

test('door action still takes the fetch path (not the deep link)', async () => {
  const sw = loadSw();
  const { navigated, opened } = await fireClick(sw, {
    data: { view: 'safety', doorToken: 'tok-1' },
    action: 'open-door',
  });
  // fetch stub returns { ok: false } → catch → openWindow('/#safety')
  assert.deepEqual(navigated, []);
  assert.deepEqual(opened, ['/#safety']);
});

test('precache manifest covers the new deep-link module', () => {
  const { sandbox } = loadSw();
  const manifest = sandbox.buildPrecacheManifest();
  assert.ok(manifest.includes('/deep-link.js'), `missing /deep-link.js in ${manifest.join(', ')}`);
});
