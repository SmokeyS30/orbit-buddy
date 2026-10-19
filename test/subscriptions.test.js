import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Environment, SignedDataVerifier, Status } from '@apple/app-store-server-library';
import {
  APPLE_ROOT_CA_DER_BASE64, BUNDLE_ID_DEFAULT, createSubscriptionService, FREE_DAILY_LIMIT,
  mapAppleStatus, nextResetUtc, nyDayKey, PRODUCTS,
} from '../src/subscriptions.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PRODUCT = 'com.smokeys30.orbitbuddy.standard.monthly';
const TOKEN = '123e4567-e89b-42d3-a456-426614174000';
const future = () => Date.now() + 30 * 86400_000;

function mockDb() {
  const subs = new Map();
  const usage = new Map();
  const notifications = new Map();
  return {
    getSubscription: (userId) => subs.get(userId) || null,
    saveSubscription(userId, value) {
      for (const [owner, sub] of subs) {
        if (owner !== userId && value.appAccountToken && sub.app_account_token === value.appAccountToken) throw new Error('duplicate app token');
        if (owner !== userId && value.originalTransactionId && sub.original_transaction_id === value.originalTransactionId) throw new Error('duplicate original transaction');
      }
      const old = subs.get(userId);
      subs.set(userId, {
        user_id: userId, product_id: value.productId, status: value.status,
        expires_at: value.expiresAt || null, app_account_token: value.appAccountToken || null,
        environment: value.environment || 'production', original_transaction_id: value.originalTransactionId || null,
        last_event_signed_at: value.lastEventSignedAt || old?.last_event_signed_at || null,
      });
    },
    getDailyUsageCount: (userId, day) => usage.get(`${userId}:${day}`) || 0,
    incrementDailyUsage(userId, day) { usage.set(`${userId}:${day}`, (usage.get(`${userId}:${day}`) || 0) + 1); },
    consumeDailyUsage(userId, day, limit) {
      const key = `${userId}:${day}`; const count = usage.get(key) || 0;
      if (count >= limit) return { allowed: false, count };
      usage.set(key, count + 1); return { allowed: true, count: count + 1 };
    },
    pruneDailyUsage(before) { for (const key of usage.keys()) if (key.split(':')[1] < before) usage.delete(key); },
    claimNotification(id) { if (notifications.has(id)) return false; notifications.set(id, 'processing'); return true; },
    completeNotification(id) { if (notifications.get(id) !== 'processing') return false; notifications.set(id, 'processed'); return true; },
    releaseNotification(id) { return notifications.delete(id); },
    notificationState: (id) => notifications.get(id),
    pruneNotifications() {}, prunePurchaseIntents() {}, addEvent() {},
    findUserByAppAccountToken(token) { for (const [userId, sub] of subs) if (sub.app_account_token === token) return userId; return null; },
  };
}

function appleRuntime(options = {}) {
  const state = {
    status: options.status || Status.ACTIVE,
    statusFailures: options.statusFailures || 0,
  };
  const base = {
    transactionId: 'txn-1', originalTransactionId: 'orig-1', productId: PRODUCT,
    bundleId: 'com.smokeys30.orbitbuddy', appAccountToken: TOKEN,
    expiresDate: future(), environment: Environment.PRODUCTION, signedDate: Date.now(),
    ...options.transaction,
  };
  const signed = new Map([
    ['device', base], ['server', { ...base }], ['status', { ...base }], ['notification-txn', { ...base }],
    ['notification', {
      notificationUUID: options.notificationUUID || 'notification-1',
      notificationType: options.notificationType || 'DID_RENEW',
      signedDate: options.notificationSignedDate || Date.now(),
      data: { signedTransactionInfo: 'notification-txn' },
    }],
  ]);
  const verifier = {
    async verifyAndDecodeTransaction(value) { if (!signed.has(value)) throw new Error('invalid transaction'); return signed.get(value); },
    async verifyAndDecodeNotification(value) { if (value !== 'notification') throw new Error('invalid notification'); return signed.get(value); },
    async verifyAndDecodeRenewalInfo() { return {}; },
  };
  const client = {
    async getTransactionInfo() { return { signedTransactionInfo: 'server' }; },
    async getAllSubscriptionStatuses() {
      if (state.statusFailures > 0) { state.statusFailures--; throw new Error('temporary Apple outage'); }
      return { data: [{ lastTransactions: [{ status: state.status, signedTransactionInfo: 'status' }] }] };
    },
  };
  return { runtime: { production: { environment: Environment.PRODUCTION, verifier, client } }, state, signed };
}

const enabledService = (db, options = {}) => {
  const apple = appleRuntime(options);
  return { service: createSubscriptionService({ SUBSCRIPTIONS_ENABLED: 'true' }, db, { appleRuntime: apple.runtime }), ...apple };
};

test('New York usage day and reset honor EDT and EST', () => {
  assert.equal(nyDayKey(new Date('2026-10-18T03:00:00Z')), '2026-10-17');
  assert.equal(nextResetUtc(new Date('2026-10-18T12:00:00Z')).toISOString(), '2026-10-19T04:00:00.000Z');
  assert.equal(nextResetUtc(new Date('2026-01-15T12:00:00Z')).toISOString(), '2026-01-16T05:00:00.000Z');
});

test('invalid or incomplete Apple configuration fails open', () => {
  const db = mockDb();
  const service = createSubscriptionService({ SUBSCRIPTIONS_ENABLED: 'true', APPSTORE_PRIVATE_KEY_P8: 'not-a-key' }, db);
  assert.equal(service.ready, false);
  for (let i = 0; i < 30; i++) assert.equal(service.consumeQuota('u1').allowed, true);
  assert.equal(db.getDailyUsageCount('u1', nyDayKey()), 0);
});

test('atomic quota accepts messages 1-25 and blocks 26', () => {
  const db = mockDb(); const { service } = enabledService(db);
  const now = new Date('2026-10-18T12:00:00Z');
  for (let i = 1; i <= 25; i++) assert.deepEqual(service.consumeQuota('u1', null, now).used, i);
  const blocked = service.consumeQuota('u1', null, now);
  assert.equal(blocked.allowed, false); assert.equal(blocked.used, 25); assert.equal(blocked.limit, FREE_DAILY_LIMIT);
});

test('active and grace are unlimited; retry, expired, and revoked are not', () => {
  const db = mockDb(); const { service } = enabledService(db);
  for (const status of ['active', 'grace', 'billing-retry', 'expired', 'revoked']) {
    db.saveSubscription(status, { productId: PRODUCT, status, expiresAt: new Date(future()).toISOString() });
    assert.equal(service.isPaid(status), ['active', 'grace'].includes(status));
  }
});

test('official status mapping preserves active access after auto-renew cancellation and recognizes grace', () => {
  assert.equal(mapAppleStatus(Status.ACTIVE), 'active');
  assert.equal(mapAppleStatus(Status.BILLING_GRACE_PERIOD), 'grace');
  assert.equal(mapAppleStatus(Status.BILLING_RETRY), 'billing-retry');
  assert.equal(mapAppleStatus(Status.EXPIRED), 'expired');
  assert.equal(mapAppleStatus(Status.REVOKED), 'revoked');
});

test('verification requires exact appAccountToken and purchase product', async () => {
  const db = mockDb(); const { service } = enabledService(db);
  await assert.rejects(service.verifyTransaction('device', {}), /not bound/);
  await assert.rejects(service.verifyTransaction('device', { expectedAppAccountToken: 'different' }), /not bound/);
  await assert.rejects(service.verifyTransaction('device', { expectedAppAccountToken: TOKEN, expectedProductId: 'com.smokeys30.orbitbuddy.pro.monthly' }), /product/);
  const result = await service.verifyTransaction('device', { expectedAppAccountToken: TOKEN, expectedProductId: PRODUCT });
  assert.equal(result.transactionId, 'txn-1'); assert.equal(result.status, 'active'); assert.equal(result.appAccountToken, TOKEN);
});

test('Apple-confirmed transaction token mismatch is rejected', async () => {
  const db = mockDb(); const apple = appleRuntime();
  apple.signed.set('server', { ...apple.signed.get('server'), appAccountToken: 'different' });
  const service = createSubscriptionService({ SUBSCRIPTIONS_ENABLED: 'true' }, db, { appleRuntime: apple.runtime });
  await assert.rejects(service.verifyTransaction('device', { expectedAppAccountToken: TOKEN }), /Apple server transaction/);
});

test('notification claim is idempotent and released when processing fails', async () => {
  const db = mockDb(); db.saveSubscription('u1', { productId: PRODUCT, status: 'active', appAccountToken: TOKEN, originalTransactionId: 'orig-1' });
  const { service } = enabledService(db, { statusFailures: 1 });
  await assert.rejects(service.handleNotification('notification'), /temporary Apple outage/);
  assert.equal(db.notificationState('notification-1'), undefined, 'failed delivery must be retryable');
  assert.equal((await service.handleNotification('notification')).ok, true);
  assert.equal((await service.handleNotification('notification')).deduped, true);
});

test('out-of-order notification cannot overwrite a newer entitlement event', async () => {
  const db = mockDb();
  db.saveSubscription('u1', { productId: PRODUCT, status: 'active', appAccountToken: TOKEN, originalTransactionId: 'orig-1', lastEventSignedAt: '2026-10-19T12:00:00.000Z' });
  const { service } = enabledService(db, { notificationSignedDate: Date.parse('2026-10-19T11:00:00Z') });
  const result = await service.handleNotification('notification');
  assert.equal(result.reason, 'stale notification'); assert.equal(db.getSubscription('u1').status, 'active');
});

test('arbitrary self-signed Apple-named test chain is rejected by pinned roots', async () => {
  const fakeLeaf = 'MIIBTTCB9QIUUeZrViFyIrogp4BXbGU/AnZmH88wCgYIKoZIzj0EAwIwLTEWMBQGA1UEAwwNQXBwbGUgUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjAeFw0yNjEwMTgyMTU2MzZaFw0yOTAxMjAyMTU2MzZaMCcxGDAWBgNVBAMMD0FwcGxlIEFwcCBTdG9yZTELMAkGA1UEBhMCVVMwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATyUQN2jYlX7TyAj5Y0ezJwlVFtrdntn+KIa5T3llY+ROv3GWFtEVyK2FPTAhsSZqJZs7D+F4y2o/wFzea2ihrYMAoGCCqGSM49BAMCA0cAMEQCIFM1KuaW/ird+bUqvdXJo8E47hZ0qenbJfOGsYwM8r+LAiBV/ji0/kOvhuSOKqiLRAaPlyVD8bSYkHzo7Et9/88b4g==';
  const fakeRoot = 'MIIBrzCCAVWgAwIBAgIUGEq4WmzOSW2sZcpBC6+YoYonj0UwCgYIKoZIzj0EAwIwLTEWMBQGA1UEAwwNQXBwbGUgUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjAeFw0yNjEwMTgyMTU2MzZaFw0zNjEwMTUyMTU2MzZaMC0xFjAUBgNVBAMMDUFwcGxlIFJvb3QgQ0ExEzARBgNVBAoMCkFwcGxlIEluYy4wWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQn6cbg/kef4r+J+5KzVvO53quaNJfN5KzmBeH65KpF3RIUmxIIQtTXr94D6gKjvk2AswYriGruMrkDtkX/160qo1MwUTAdBgNVHQ4EFgQUVU4CzkNR6pIXMBMzWXzoxBzuUAIwHwYDVR0jBBgwFoAUVU4CzkNR6pIXMBMzWXzoxBzuUAIwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiAqKZy/RmPvRAjhkk4TYr8hn0e4cQaH7ZqORHgXldFQ9wIhAIweqQNBP9eIkt1QGJUEl5YfmiVje+iMAg3tyUiBCGr6';
  const key = `-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgRAQnaMeBqPK9WWyg\nDsbRO1fWanQmWgVzMVil7DWRWZuhRANCAATyUQN2jYlX7TyAj5Y0ezJwlVFtrdnt\nn+KIa5T3llY+ROv3GWFtEVyK2FPTAhsSZqJZs7D+F4y2o/wFzea2ihrY\n-----END PRIVATE KEY-----`;
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', x5c: [fakeLeaf, fakeRoot] })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ transactionId: 'txn', productId: PRODUCT, bundleId: BUNDLE_ID_DEFAULT, environment: 'Sandbox', signedDate: Date.now() })).toString('base64url');
  const input = `${header}.${payload}`;
  const signature = crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const verifier = new SignedDataVerifier(APPLE_ROOT_CA_DER_BASE64.map((value) => Buffer.from(value, 'base64')), false, Environment.SANDBOX, 'com.smokeys30.orbitbuddy');
  await assert.rejects(verifier.verifyAndDecodeTransaction(`${input}.${signature}`));
});

test('bundled Apple roots match the pinned SHA-256 fingerprints', () => {
  assert.deepEqual(APPLE_ROOT_CA_DER_BASE64.map((value) => crypto.createHash('sha256').update(Buffer.from(value, 'base64')).digest('hex').toUpperCase()), [
    'B0B1730ECBC7FF4505142C49F1295E6EDA6BCAED7E2C68C5BE91B5A11001F024',
    'C2B9B042DD57830E7D117DAC55AC8AE19407D38E41D88F3215BC3A890444A050',
    '63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179',
  ]);
});

test('catalog and additive SQLite/Postgres migrations cover subscription state', () => {
  assert.deepEqual(Object.keys(PRODUCTS).sort(), [
    'com.smokeys30.orbitbuddy.pro.monthly', 'com.smokeys30.orbitbuddy.standard.monthly', 'com.smokeys30.orbitbuddy.standard.yearly',
  ]);
  for (const file of ['src/database.js', 'src/db/postgres-adapter.js', 'src/db/postgres-schema.sql']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const table of ['subscriptions', 'subscription_purchase_intents', 'daily_usage', 'processed_notifications']) assert.match(source, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
    assert.match(source, /last_event_signed_at/); assert.match(source, /idx_subscriptions_app_token_unique/);
  }
});

test('owner and configured comped users remain unlimited', () => {
  const db = mockDb(); const apple = appleRuntime();
  const service = createSubscriptionService({ SUBSCRIPTIONS_ENABLED: 'true', COMPED_USER_IDS: 'mom,dad,friend' }, db, { appleRuntime: apple.runtime });
  for (const [id, user] of [['owner', { role: 'owner' }], ['mom', null], ['dad', null], ['friend', null]]) {
    for (let i = 0; i < 30; i++) assert.equal(service.consumeQuota(id, user).allowed, true);
  }
});
