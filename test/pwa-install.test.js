import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// pwa-install.js is a classic browser script; load it in a sandbox with a
// `module` stub so the test exports are captured without a DOM.
function loadPwa() {
  const src = readFileSync(new URL('../public/pwa-install.js', import.meta.url), 'utf8');
  const sandbox = {
    module: { exports: {} },
    window: undefined,
    document: undefined,
    navigator: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.module.exports;
}

const pwa = loadPwa();

function memStorage(initial) {
  const store = { ...(initial || {}) };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
  };
}

test('recordVisit counts distinct days, not loads', () => {
  const s = memStorage();
  const d1 = new Date('2026-10-13T12:00:00Z');
  assert.equal(pwa.recordVisit(s, d1), 1);
  assert.equal(pwa.recordVisit(s, new Date('2026-10-13T23:59:00Z')), 1); // same day
  assert.equal(pwa.recordVisit(s, new Date('2026-10-14T00:01:00Z')), 2);
  assert.equal(pwa.recordVisit(s, new Date('2026-10-15T09:00:00Z')), 3);
});

test('nudge never shows before MIN_VISITS', () => {
  const now = Date.now();
  for (const count of [0, 1, 2]) {
    assert.equal(
      pwa.shouldShowNudge({ installed: false, visitCount: count, dismissedAt: null, now }),
      false
    );
  }
  assert.equal(
    pwa.shouldShowNudge({ installed: false, visitCount: pwa.MIN_VISITS, dismissedAt: null, now }),
    true
  );
});

test('nudge suppressed when installed (standalone / iOS / Capacitor)', () => {
  assert.equal(pwa.isInstalled({ capacitorNative: true }), true);
  assert.equal(pwa.isInstalled({ standalone: true }), true);
  assert.equal(pwa.isInstalled({ displayStandalone: true }), true);
  assert.equal(pwa.isInstalled({}), false);
  const now = Date.now();
  assert.equal(
    pwa.shouldShowNudge({ installed: true, visitCount: 10, dismissedAt: null, now }),
    false
  );
});

test('dismissal suppresses the nudge until 30 days pass', () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  assert.equal(
    pwa.shouldShowNudge({ installed: false, visitCount: 5, dismissedAt: now - 29 * day, now }),
    false
  );
  assert.equal(
    pwa.shouldShowNudge({ installed: false, visitCount: 5, dismissedAt: now - 30 * day, now }),
    true
  );
  assert.equal(
    pwa.shouldShowNudge({ installed: false, visitCount: 5, dismissedAt: now - 60 * day, now }),
    true
  );
});

test('iOS copy has no programmatic action; Android copy does', () => {
  const ios = pwa.installCopy(true);
  assert.equal(ios.action, null);
  assert.match(ios.body, /Share/);
  assert.match(ios.body, /Add to Home Screen/);
  const android = pwa.installCopy(false);
  assert.equal(android.action, 'install');
});

test('iOS and iPadOS detection', () => {
  assert.equal(pwa.isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)'), true);
  assert.equal(pwa.isIos('Mozilla/5.0 (iPod touch; CPU iPhone OS 27_0 like Mac OS X)'), true);
  assert.equal(pwa.isIos('Mozilla/5.0 (Linux; Android 16; Pixel 10)'), false);
  // iPadOS 13+ desktop UA, detected via touch points
  assert.equal(
    pwa.isIpadOs({ maxTouchPoints: 5 }, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)'),
    true
  );
  assert.equal(
    pwa.isIpadOs({ maxTouchPoints: 0 }, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)'),
    false
  );
  assert.equal(
    pwa.isIpadOs({}, 'Mozilla/5.0 (iPad; CPU OS 27_0 like Mac OS X)'),
    true
  );
});
