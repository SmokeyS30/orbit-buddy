// B1: native iOS push via APNs.
// - The provider-auth JWT is a valid ES256 token (header/payload/verifiable).
// - Pushes target the APNs production endpoint with the right headers.
// - A 410/Unregistered response deletes the dead token.
// - Without APNs env vars the service degrades gracefully (no crash).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApnsService, createApnsProviderToken, APNS_PRODUCTION_HOST, APNS_PRODUCTION_PORT } from '../src/apns.js';

function ecKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    p8: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKey,
  };
}

// Minimal fake for node:http2's connect(): captures the request and replays
// a canned APNs response.
function fakeHttp2({ status = 200, body = '' } = {}) {
  const captured = {};
  const req = {
    _handlers: {},
    on(event, cb) { this._handlers[event] = cb; return this; },
    end(payload) {
      captured.payload = payload;
      const h = this._handlers;
      if (h.response) h.response({ ':status': status });
      if (h.data && body) h.data(Buffer.from(body));
      if (h.end) h.end();
      return this;
    },
  };
  const session = {
    destroyed: false,
    on() { return this; },
    close() {},
    request(headers) { captured.headers = headers; return req; },
  };
  return { connect: (url) => { captured.url = url; return session; }, captured };
}

const TOKEN64 = 'a'.repeat(64);

function mockDb(rows = [{ device_token: TOKEN64 }]) {
  const deleted = [];
  return {
    db: {
      listApnsTokens: () => rows,
      deleteApnsToken: (token) => { deleted.push(token); },
    },
    deleted,
  };
}

test('provider token is a verifiable ES256 JWT with the right claims', () => {
  const { p8, publicKey } = ecKeyPair();
  const token = createApnsProviderToken({ keyP8: p8, keyId: 'KEY123ABCD', teamId: 'TEAM456EFG', issuedAt: 1780000000 });
  const [h, p, s] = token.split('.');
  assert.equal([h, p, s].length, 3);
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'ES256', kid: 'KEY123ABCD' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url').toString()), { iss: 'TEAM456EFG', iat: 1780000000 });
  const valid = crypto.verify(
    'sha256',
    Buffer.from(`${h}.${p}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(s, 'base64url')
  );
  assert.equal(valid, true);
});

test('provider token accepts \\n-escaped .p8 text (Azure env var style)', () => {
  const { p8, publicKey } = ecKeyPair();
  const escaped = p8.replace(/\n/g, '\\n');
  assert.ok(!escaped.includes('\n'));
  const token = createApnsProviderToken({ keyP8: escaped, keyId: 'K', teamId: 'T', issuedAt: 1780000000 });
  const [h, p, s] = token.split('.');
  const valid = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  assert.equal(valid, true);
});

test('push targets the APNs production endpoint with provider auth', async () => {
  const { p8 } = ecKeyPair();
  const { connect, captured } = fakeHttp2();
  const { db } = mockDb();
  const apns = createApnsService(
    { APNS_KEY_P8: p8, APNS_KEY_ID: 'KEY123', APNS_TEAM_ID: 'TEAM456' },
    db,
    { connect }
  );
  assert.equal(apns.configured, true);
  const result = await apns.notify('user-1', 'Hello', 'World', { view: 'safety' });
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.equal(captured.url, `https://${APNS_PRODUCTION_HOST}:${APNS_PRODUCTION_PORT}`);
  assert.equal(APNS_PRODUCTION_HOST, 'api.push.apple.com');
  const headers = captured.headers;
  assert.equal(headers[':method'], 'POST');
  assert.equal(headers[':path'], `/3/device/${TOKEN64}`);
  assert.equal(headers['apns-topic'], 'com.smokeys30.orbitbuddy');
  assert.equal(headers['apns-push-type'], 'alert');
  assert.match(headers['authorization'], /^bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const payload = JSON.parse(captured.payload);
  assert.equal(payload.aps.alert.title, 'Hello');
  assert.equal(payload.aps.alert.body, 'World');
  assert.equal(payload.view, 'safety');
});

test('provider token is cached across sends (not re-signed every push)', async () => {
  const { p8 } = ecKeyPair();
  const { connect, captured } = fakeHttp2();
  const authHeaders = [];
  const { db } = mockDb();
  const apns = createApnsService({ APNS_KEY_P8: p8, APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T' }, db, { connect });
  // Wrap request to record each authorization header actually used.
  await apns.notify('user-1', 'A', 'B');
  authHeaders.push(captured.headers['authorization']);
  await apns.notify('user-1', 'C', 'D');
  authHeaders.push(captured.headers['authorization']);
  assert.equal(authHeaders[0], authHeaders[1], 'JWT must be reused within its TTL');
});

test('410 Unregistered deletes the dead token', async () => {
  const { p8 } = ecKeyPair();
  const { connect } = fakeHttp2({ status: 410, body: JSON.stringify({ reason: 'Unregistered' }) });
  const { db, deleted } = mockDb();
  const apns = createApnsService({ APNS_KEY_P8: p8, APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T' }, db, { connect });
  const result = await apns.notify('user-1', 'A', 'B');
  assert.deepEqual(result, { sent: 0, failed: 1 });
  assert.deepEqual(deleted, [TOKEN64]);
});

test('unconfigured service degrades gracefully (no env vars, no crash)', async () => {
  const apns = createApnsService({}, { listApnsTokens: () => { throw new Error('must not be called'); } });
  assert.equal(apns.configured, false);
  const result = await apns.notify('user-1', 'A', 'B');
  assert.deepEqual(result, { sent: 0, failed: 0, skipped: true });
});
