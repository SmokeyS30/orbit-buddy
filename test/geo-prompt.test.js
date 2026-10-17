import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GEO_ASKED_KEY,
  GEO_DENIED_KEY,
  wasGeoAsked,
  markGeoAsked,
  clearGeoAsked,
  queryGeoPermission,
  geoAttemptPlan,
} from '../public/geo-prompt.js';

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    _data: data,
  };
}

function throwingStorage() {
  const boom = () => { throw new Error('denied'); };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

function fakeNav(permState) {
  // permState: 'granted' | 'denied' | 'prompt' | null (no Permissions API)
  const nav = { geolocation: {} };
  if (permState !== null) {
    nav.permissions = { query: async () => ({ state: permState }) };
  }
  return nav;
}

test('wasGeoAsked: false on fresh storage', () => {
  assert.equal(wasGeoAsked(fakeStorage()), false);
});

test('wasGeoAsked: true after markGeoAsked', () => {
  const s = fakeStorage();
  markGeoAsked(s);
  assert.equal(s.getItem(GEO_ASKED_KEY), '1');
  assert.equal(wasGeoAsked(s), true);
});

test('wasGeoAsked: legacy denial key counts as asked (migration)', () => {
  const s = fakeStorage({ [GEO_DENIED_KEY]: '1' });
  assert.equal(wasGeoAsked(s), true);
});

test('clearGeoAsked removes both keys (sign-out)', () => {
  const s = fakeStorage({ [GEO_ASKED_KEY]: '1', [GEO_DENIED_KEY]: '1' });
  clearGeoAsked(s);
  assert.equal(wasGeoAsked(s), false);
});

test('storage failures fail open (old behavior)', () => {
  assert.equal(wasGeoAsked(throwingStorage()), false);
  assert.equal(wasGeoAsked(null), false);
  markGeoAsked(throwingStorage()); // must not throw
  clearGeoAsked(null); // must not throw
});

test('queryGeoPermission passes through browser state', async () => {
  for (const state of ['granted', 'denied', 'prompt']) {
    assert.equal(await queryGeoPermission(fakeNav(state)), state);
  }
});

test('queryGeoPermission: unknown without Permissions API', async () => {
  assert.equal(await queryGeoPermission(fakeNav(null)), 'unknown');
  assert.equal(await queryGeoPermission({}), 'unknown');
  assert.equal(await queryGeoPermission(null), 'unknown');
});

test('geoAttemptPlan: granted -> attempt, not an ask (no dialog)', async () => {
  const s = fakeStorage();
  const plan = await geoAttemptPlan(s, fakeNav('granted'));
  assert.deepEqual(plan, { attempt: true, countsAsAsk: false });
});

test('geoAttemptPlan: denied -> never attempt', async () => {
  const plan = await geoAttemptPlan(fakeStorage(), fakeNav('denied'));
  assert.deepEqual(plan, { attempt: false, countsAsAsk: false });
});

test('geoAttemptPlan: prompt + never asked -> attempt and mark as ask', async () => {
  const plan = await geoAttemptPlan(fakeStorage(), fakeNav('prompt'));
  assert.deepEqual(plan, { attempt: true, countsAsAsk: true });
});

test('geoAttemptPlan: prompt + already asked -> never re-prompt', async () => {
  const s = fakeStorage();
  markGeoAsked(s);
  const plan = await geoAttemptPlan(s, fakeNav('prompt'));
  assert.deepEqual(plan, { attempt: false, countsAsAsk: false });
});

test('geoAttemptPlan: no Permissions API + never asked -> attempt once', async () => {
  const plan = await geoAttemptPlan(fakeStorage(), fakeNav(null));
  assert.deepEqual(plan, { attempt: true, countsAsAsk: true });
});

test('geoAttemptPlan: no Permissions API + asked -> no re-prompt', async () => {
  const s = fakeStorage();
  markGeoAsked(s);
  const plan = await geoAttemptPlan(s, fakeNav(null));
  assert.deepEqual(plan, { attempt: false, countsAsAsk: false });
});

test('full device lifecycle: ask once, remember, clear on sign-out', async () => {
  const storage = fakeStorage();
  const nav = fakeNav('prompt'); // browser forgets grants (Edward's webview)
  let getCurrentPositionCalls = 0;

  // Fresh open #1: never asked -> the one prompt happens
  let plan = await geoAttemptPlan(storage, nav);
  assert.equal(plan.attempt, true);
  if (plan.countsAsAsk) markGeoAsked(storage);
  getCurrentPositionCalls += plan.attempt ? 1 : 0;

  // Fresh open #2 (new page load, same device): must NOT re-prompt
  plan = await geoAttemptPlan(storage, nav);
  assert.equal(plan.attempt, false);
  getCurrentPositionCalls += plan.attempt ? 1 : 0;

  // Sign-out clears; next user on this device gets asked once
  clearGeoAsked(storage);
  plan = await geoAttemptPlan(storage, nav);
  assert.deepEqual(plan, { attempt: true, countsAsAsk: true });

  assert.equal(getCurrentPositionCalls, 1);
});
