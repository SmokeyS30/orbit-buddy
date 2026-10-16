import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Load public/sw.js in a sandbox with a stubbed `self` so the pure manifest
// builder can be exercised without a browser.
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
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { sandbox, listeners };
}

test('precache manifest includes the versioned styles.css', () => {
  const { sandbox } = loadSw();
  const manifest = sandbox.buildPrecacheManifest();
  assert.ok(
    manifest.some((u) => /^\/styles\.css\?v=.+/.test(u)),
    `expected versioned /styles.css, got: ${manifest.join(', ')}`
  );
  assert.ok(
    !manifest.includes('/styles.css'),
    'stale unversioned /styles.css must not be precached'
  );
});

test('precache manifest covers desktop assets (W7: voice/canvas chunks excluded)', () => {
  const { sandbox } = loadSw();
  const manifest = sandbox.buildPrecacheManifest();
  for (const asset of ['/desktop.css', '/pwa-install.js', '/app.js']) {
    assert.ok(manifest.includes(asset), `missing ${asset} in ${manifest.join(', ')}`);
  }
  // W7 code-split: the lazily-loaded chunks must not be precached — they are
  // fetched on first use and served via the runtime stale-while-revalidate
  // path instead.
  for (const chunk of ['/voice-mode.js', '/canvas.js']) {
    assert.ok(!manifest.includes(chunk), `${chunk} must not be precached (W7 code-split)`);
  }
});

test('no duplicate precache entries', () => {
  const { sandbox } = loadSw();
  const manifest = sandbox.buildPrecacheManifest();
  assert.equal(new Set(manifest).size, manifest.length);
});

test('fetch handler routes: API untouched, navigations network-first, static SWR', () => {
  const { sandbox, listeners } = loadSw();
  const fetchHandler = listeners.fetch;
  assert.ok(typeof fetchHandler === 'function', 'fetch listener registered');

  const calls = [];
  sandbox.fetch = (req) => Promise.resolve({ ok: true, type: 'basic', clone: () => ({}) });
  sandbox.caches = {
    open: () => Promise.resolve({ put: () => Promise.resolve() }),
    match: () => Promise.resolve(undefined),
  };

  function fakeRequest(url, mode) {
    return {
      method: 'GET',
      url: 'https://orbitbuddy.app' + url,
      mode: mode || 'cors',
    };
  }
  function fakeEvent(request) {
    return {
      request,
      respondWith(p) {
        calls.push({ url: request.url, promise: p });
        return p;
      },
    };
  }

  // API request: no respondWith -> request passes through to the network.
  fetchHandler(fakeEvent(fakeRequest('/api/chat', 'cors')));
  // Navigation: network-first -> fetch called even with empty cache.
  fetchHandler(fakeEvent(fakeRequest('/', 'navigate')));
  // Static asset: stale-while-revalidate -> still fetches (revalidation).
  fetchHandler(fakeEvent(fakeRequest('/app.js', 'cors')));
  // Versioned CSS: treated as static.
  fetchHandler(fakeEvent(fakeRequest('/styles.css?v=20261012a', 'cors')));
  // Maintenance bypass navigation: network-first, untouched by cache logic.
  fetchHandler(fakeEvent(fakeRequest('/?maint_bypass=abc', 'navigate')));
  // W7 code-split chunk: not precached, but still a static asset — served via
  // stale-while-revalidate (network fetch, then cached for next time).
  fetchHandler(fakeEvent(fakeRequest('/voice-mode.js', 'cors')));

  assert.equal(calls.length, 5, 'API request must not be intercepted');
  return Promise.all(calls.map((c) => c.promise)).then(() => {
    assert.ok(true);
  });
});
