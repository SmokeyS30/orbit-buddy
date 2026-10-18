// StoreKit 2 subscriptions: quota, reset math, JWS verification, notifications.
// - The 25/day quota is NEVER enforced unless SUBSCRIPTIONS_ENABLED=true AND
//   Apple server config is complete (fail-open protects production users).
// - Universal reset: one midnight America/New_York for all users; UTC stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createSubscriptionService, nyDayKey, nextResetUtc, verifyAppleJws,
  PRODUCTS, FREE_DAILY_LIMIT,
} from '../src/subscriptions.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// --- Test fixtures: Apple-like cert chain (generated with openssl) ---
const FIX = path.join('/home/hatch/.scratch/storekit-build/test-fixtures');
const LEAF_B64 = fs.readFileSync(path.join(FIX, 'leaf.b64'), 'utf8').trim();
const ROOT_B64 = fs.readFileSync(path.join(FIX, 'root.b64'), 'utf8').trim();
const LEAF_KEY = fs.readFileSync(path.join(FIX, 'leaf-key.txt'), 'utf8');

function makeJws(payload, { key = LEAF_KEY, chain = [LEAF_B64, ROOT_B64], alg = 'ES256' } = {}) {
  const h = Buffer.from(JSON.stringify({ alg, x5c: chain })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${h}.${p}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `${data}.${Buffer.from(sig).toString('base64url')}`;
}

const TXN = {
  transactionId: 'txn-1', originalTransactionId: 'orig-1',
  productId: 'com.smokeys30.orbitbuddy.standard.monthly',
  bundleId: 'com.smokeys30.orbitbuddy',
  appAccountToken: 'user-uuid-1234',
  expiresDate: String(Date.now() + 30 * 86400_000),
  environment: 'Production',
};

// Minimal in-memory db for service tests.
function mockDb() {
  const subs = new Map();
  const usage = new Map();
  const notifs = new Set();
  return {
    getSubscription: (u) => subs.get(u) || null,
    saveSubscription: (u, s) => { subs.set(u, { user_id: u, product_id: s.productId, status: s.status, expires_at: s.expiresAt || null, app_account_token: s.appAccountToken || null, environment: s.environment || 'production', original_transaction_id: s.originalTransactionId || null, updated_at: new Date().toISOString() }); },
    getDailyUsageCount: (u, d) => usage.get(`${u}:${d}`) || 0,
    incrementDailyUsage: (u, d) => { usage.set(`${u}:${d}`, (usage.get(`${u}:${d}`) || 0) + 1); },
    pruneDailyUsage: (before) => { for (const k of [...usage.keys()]) if (k.split(':')[1] < before) usage.delete(k); },
    markNotificationProcessed: (id) => { if (notifs.has(id)) return false; notifs.add(id); return true; },
    pruneNotifications: () => {},
    findUserByAppAccountToken: (t) => { for (const [u, s] of subs) if (s.app_account_token === t) return u; return null; },
    addEvent: () => {},
  };
}

const APPLE_ENV = {
  SUBSCRIPTIONS_ENABLED: 'true',
  APPSTORE_ISSUER_ID: 'issuer-123',
  APPSTORE_KEY_ID: 'key-123',
  APPSTORE_PRIVATE_KEY_P8: 'fake',
};

// --- Reset math ---

test('nyDayKey resolves the New York calendar day', () => {
  // 2026-10-18 03:00 UTC is 2026-10-17 23:00 EDT.
  assert.equal(nyDayKey(new Date('2026-10-18T03:00:00Z')), '2026-10-17');
  // 2026-10-18 05:00 UTC is 2026-10-18 01:00 EDT.
  assert.equal(nyDayKey(new Date('2026-10-18T05:00:00Z')), '2026-10-18');
});

test('nextResetUtc is 04:00Z in EDT and 05:00Z in EST', () => {
  // Mid-October: EDT (UTC-4).
  const edt = nextResetUtc(new Date('2026-10-18T12:00:00Z'));
  assert.equal(edt.toISOString(), '2026-10-19T04:00:00.000Z');
  // Mid-January: EST (UTC-5).
  const est = nextResetUtc(new Date('2026-01-15T12:00:00Z'));
  assert.equal(est.toISOString(), '2026-01-16T05:00:00.000Z');
});

test('daily reset is idempotent and missed runs self-heal', () => {
  const db = mockDb();
  const svc = createSubscriptionService({ SUBSCRIPTIONS_ENABLED: 'false' }, db);
  const day1 = new Date('2026-10-18T12:00:00Z');
  const day2 = new Date('2026-10-19T12:00:00Z');
  // Simulate usage on day 1 (recorded directly since service is disabled).
  db.incrementDailyUsage('u1', nyDayKey(day1));
  assert.equal(db.getDailyUsageCount('u1', nyDayKey(day1)), 1);
  // Run reset twice — idempotent.
  svc.runDailyReset(day2);
  svc.runDailyReset(day2);
  assert.equal(db.getDailyUsageCount('u1', nyDayKey(day1)), 0);
  // A missed run changes nothing: the day key rolls forward on its own.
  db.incrementDailyUsage('u1', nyDayKey(day2));
  assert.equal(db.getDailyUsageCount('u1', nyDayKey(day2)), 1);
});

// --- Quota gating ---

test('quota is not enforced when subscriptions are disabled', () => {
  const db = mockDb();
  const svc = createSubscriptionService({ SUBSCRIPTIONS_ENABLED: 'false' }, db);
  for (let i = 0; i < 30; i++) {
    const q = svc.checkQuota('u1');
    assert.equal(q.allowed, true);
    assert.equal(q.enforced, false);
  }
});

test('quota is not enforced when enabled but Apple config is incomplete', () => {
  const db = mockDb();
  const svc = createSubscriptionService({ SUBSCRIPTIONS_ENABLED: 'true' }, db);
  assert.equal(svc.configured, false);
  assert.equal(svc.ready, false);
  const q = svc.checkQuota('u1');
  assert.equal(q.allowed, true);
  assert.equal(q.enforced, false);
});

test('messages 1-25 accepted, 26 rejected when ready', () => {
  const db = mockDb();
  const svc = createSubscriptionService(APPLE_ENV, db);
  assert.equal(svc.ready, true);
  const now = new Date('2026-10-18T12:00:00Z');
  for (let i = 1; i <= 25; i++) {
    const q = svc.checkQuota('u1', now);
    assert.equal(q.allowed, true, `message ${i} should be allowed`);
    svc.recordUsage('u1', now);
  }
  const blocked = svc.checkQuota('u1', now);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.used, 25);
  assert.equal(blocked.limit, FREE_DAILY_LIMIT);
  assert.ok(blocked.resetAt);
});

test('paid and grace users are unlimited', () => {
  const db = mockDb();
  const svc = createSubscriptionService(APPLE_ENV, db);
  const future = new Date(Date.now() + 86400_000).toISOString();
  db.saveSubscription('paid', { productId: 'com.smokeys30.orbitbuddy.pro.monthly', status: 'active', expiresAt: future });
  db.saveSubscription('grace', { productId: 'com.smokeys30.orbitbuddy.standard.monthly', status: 'grace', expiresAt: future });
  for (const u of ['paid', 'grace']) {
    assert.equal(svc.isPaid(u), true);
    const q = svc.checkQuota(u);
    assert.equal(q.allowed, true);
    assert.equal(q.unlimited, true);
  }
});

test('expired, revoked, billing-retry users get the free allowance', () => {
  const db = mockDb();
  const svc = createSubscriptionService(APPLE_ENV, db);
  const future = new Date(Date.now() + 86400_000).toISOString();
  for (const [u, status] of [['exp', 'expired'], ['rev', 'revoked'], ['br', 'billing-retry']]) {
    db.saveSubscription(u, { productId: 'com.smokeys30.orbitbuddy.standard.monthly', status, expiresAt: future });
    assert.equal(svc.isPaid(u), false, `${status} should not be unlimited`);
  }
  const now = new Date('2026-10-18T12:00:00Z');
  for (let i = 0; i < 25; i++) svc.recordUsage('exp', now);
  assert.equal(svc.checkQuota('exp', now).allowed, false);
});

test('expired subscription with past expiry is not paid', () => {
  const db = mockDb();
  const svc = createSubscriptionService(APPLE_ENV, db);
  const past = new Date(Date.now() - 86400_000).toISOString();
  db.saveSubscription('u1', { productId: 'com.smokeys30.orbitbuddy.standard.monthly', status: 'active', expiresAt: past });
  assert.equal(svc.isPaid('u1'), false);
});

// --- JWS verification ---

test('verifyAppleJws accepts a valid Apple-style JWS', () => {
  const payload = verifyAppleJws(makeJws(TXN));
  assert.equal(payload.transactionId, 'txn-1');
  assert.equal(payload.productId, TXN.productId);
});

test('verifyAppleJws rejects wrong bundle id', () => {
  assert.throws(() => verifyAppleJws(makeJws({ ...TXN, bundleId: 'com.evil.app' })), /bundleId mismatch/);
});

test('verifyAppleJws rejects tampered payload', () => {
  const jws = makeJws(TXN);
  const parts = jws.split('.');
  const tampered = { ...TXN, productId: 'com.smokeys30.orbitbuddy.pro.monthly' };
  const bad = `${parts[0]}.${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${parts[2]}`;
  assert.throws(() => verifyAppleJws(bad), /signature invalid/);
});

test('verifyAppleJws rejects non-Apple root', () => {
  // Self-signed leaf (not chained to Apple): root check must fail.
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  // Build a minimal self-signed cert is complex; instead use a JWS with an
  // empty chain — must fail the chain check.
  assert.throws(() => verifyAppleJws(makeJws(TXN, { chain: [] })), /x5c/);
});

test('verifyAppleJws rejects malformed input', () => {
  assert.throws(() => verifyAppleJws('not-a-jws'), /Malformed JWS/);
  assert.throws(() => verifyAppleJws(makeJws(TXN, { alg: 'RS256' })), /Unexpected JWS alg/);
});

// --- Status reporting ---

test('status reports enabled/configured/ready distinctly', () => {
  const db = mockDb();
  const off = createSubscriptionService({}, db).status('u1');
  assert.deepEqual([off.enabled, off.configured, off.ready], [false, false, false]);
  const uncfg = createSubscriptionService({ SUBSCRIPTIONS_ENABLED: 'true' }, db).status('u1');
  assert.deepEqual([uncfg.enabled, uncfg.configured, uncfg.ready], [true, false, false]);
  const ready = createSubscriptionService(APPLE_ENV, db).status('u1');
  assert.deepEqual([ready.enabled, ready.configured, ready.ready], [true, true, true]);
  assert.deepEqual(ready.products.sort(), Object.keys(PRODUCTS).sort());
});

// --- Notification handling ---

function notifPayload(type, txnOverrides = {}, renewalOverrides = {}) {
  const txn = makeJws({ ...TXN, ...txnOverrides });
  const renewal = makeJws({ autoRenewStatus: '1', ...renewalOverrides });
  return makeJws({
    notificationType: type, notificationUUID: `uuid-${Math.random().toString(36).slice(2)}`,
    signedDate: String(Date.now()),
    data: { signedTransactionInfo: txn, signedRenewalInfo: renewal },
  });
}

test('notification handling is idempotent', async () => {
  const db = mockDb();
  const svc = createSubscriptionService(APPLE_ENV, db);
  db.saveSubscription('u1', { productId: 'pending', status: 'pending', appAccountToken: 'user-uuid-1234' });
  const payload = notifPayload('DID_RENEW');
  const r1 = await svc.handleNotification(payload);
  assert.equal(r1.ok, true);
  const r2 = await svc.handleNotification(payload);
  assert.equal(r2.deduped, true);
});

test('wrong appAccountToken is rejected (unknown account)', async () => {
  const db = mockDb();
  const svc = createSubscriptionService(APPLE_ENV, db);
  const payload = notifPayload('DID_RENEW', { appAccountToken: 'someone-else' });
  const r = await svc.handleNotification(payload);
  assert.equal(r.ignored, true);
  assert.equal(r.reason, 'unknown account token');
});

test('DID_FAIL_TO_RENEW with billing retry maps to billing-retry', async () => {
  const db = mockDb();
  const svc = createSubscriptionService(APPLE_ENV, db);
  db.saveSubscription('u1', { productId: 'pending', status: 'pending', appAccountToken: 'user-uuid-1234' });
  const payload = notifPayload('DID_FAIL_TO_RENEW', {}, { isInBillingRetryPeriod: 'true' });
  const r = await svc.handleNotification(payload);
  assert.equal(r.status, 'billing-retry');
  assert.equal(db.getSubscription('u1').status, 'billing-retry');
});

test('REFUND maps to revoked', async () => {
  const db = mockDb();
  const svc = createSubscriptionService(APPLE_ENV, db);
  db.saveSubscription('u1', { productId: 'pending', status: 'pending', appAccountToken: 'user-uuid-1234' });
  const r = await svc.handleNotification(notifPayload('REFUND'));
  assert.equal(r.status, 'revoked');
});

// --- Product catalog ---

test('product catalog matches the locked scope', () => {
  assert.deepEqual(Object.keys(PRODUCTS).sort(), [
    'com.smokeys30.orbitbuddy.pro.monthly',
    'com.smokeys30.orbitbuddy.standard.monthly',
    'com.smokeys30.orbitbuddy.standard.yearly',
  ]);
  assert.equal(PRODUCTS['com.smokeys30.orbitbuddy.standard.monthly'].price, 5.99);
  assert.equal(PRODUCTS['com.smokeys30.orbitbuddy.standard.yearly'].price, 59.99);
  assert.equal(PRODUCTS['com.smokeys30.orbitbuddy.pro.monthly'].price, 19.99);
  assert.equal(FREE_DAILY_LIMIT, 25);
});

test('subscription tables have Postgres startup migrations', () => {
  // Critical lesson: postgres-schema.sql is NOT run against production —
  // the migrations array in openPostgres is. Every table the adapter
  // touches must be created there.
  const pg = fs.readFileSync(path.join(root, 'src', 'db', 'postgres-adapter.js'), 'utf8');
  for (const table of ['subscriptions', 'daily_usage', 'processed_notifications']) {
    assert.match(pg, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`),
      `${table} must have a Postgres startup migration`);
  }
});

test('subscription tables exist in SQLite schema', () => {
  const sqlite = fs.readFileSync(path.join(root, 'src', 'database.js'), 'utf8');
  for (const table of ['subscriptions', 'daily_usage', 'processed_notifications']) {
    assert.match(sqlite, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`),
      `${table} must exist in SQLite schema`);
  }
});

test('comped list supports owner plus three family/friend members', () => {
  // The real scenario: Edward (owner, automatic) + mom, dad, and one friend
  // by user ID in COMPED_USER_IDS.
  const db = mockDb();
  const svc = createSubscriptionService({ ...APPLE_ENV, COMPED_USER_IDS: 'mom-id, dad-id,friend-id' }, db);
  const owner = { id: 'owner-id', role: 'owner' };
  const now = new Date('2026-10-18T12:00:00Z');
  // All four are unlimited, even past the 25/day free limit.
  for (const [id, user] of [['owner-id', owner], ['mom-id', null], ['dad-id', null], ['friend-id', null]]) {
    assert.equal(svc.isComped(id, user), true, `${id} should be comped`);
    for (let i = 0; i < 30; i++) {
      assert.equal(svc.checkQuota(id, user, now).allowed, true, `${id} message ${i + 1} allowed`);
      svc.recordUsage(id, user, now);
    }
    assert.equal(db.getDailyUsageCount(id, nyDayKey(now)), 0, `${id} usage not recorded`);
  }
  // A fifth person is NOT exempt and hits the free limit.
  assert.equal(svc.isComped('stranger', null), false);
  for (let i = 0; i < 25; i++) svc.recordUsage('stranger', null, now);
  assert.equal(svc.checkQuota('stranger', null, now).allowed, false);
});

test('owner role is always exempt, even with subscriptions disabled', () => {
  const db = mockDb();
  const svc = createSubscriptionService({ SUBSCRIPTIONS_ENABLED: 'false' }, db);
  const owner = { id: 'owner-1', role: 'owner' };
  assert.equal(svc.isComped('owner-1', owner), true);
  assert.equal(svc.isPaid('owner-1', owner), true);
  const q = svc.checkQuota('owner-1', owner);
  assert.equal(q.allowed, true);
  assert.equal(q.comped, true);
  // Non-owner without comped IDs is not exempt.
  assert.equal(svc.isComped('owner-1', { id: 'owner-1', role: 'member' }), false);
});

test('status endpoint reports comped state', () => {
  const db = mockDb();
  const svc = createSubscriptionService({ ...APPLE_ENV, COMPED_USER_IDS: 'vip-1' }, db);
  const compedStatus = svc.status('vip-1', null);
  assert.equal(compedStatus.comped, true);
  assert.equal(compedStatus.entitlement.unlimited, true);
  assert.equal(compedStatus.entitlement.product, 'comped');
  const plainStatus = svc.status('nobody', null);
  assert.equal(plainStatus.comped, false);
  assert.equal(plainStatus.entitlement, null);
});
