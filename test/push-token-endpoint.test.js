// B1: POST /api/push/token — native iOS device token registration.
// 401 unauthenticated; 400 on malformed tokens; 201 stores the token
// (upserted, lowercased); 429 past the per-user rate limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';

async function fixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-push-token-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', ...extraEnv } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function register(base, email = 'owner@example.com') {
  const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, displayName: 'Owner', password: 'correct horse battery staple' }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrf, userId: body.user.id };
}

const authHeaders = ({ cookie, csrf }) => ({ Cookie: cookie, 'X-Orbit-CSRF': csrf, 'Content-Type': 'application/json' });
const postToken = (base, headers, token) => fetch(`${base}/api/push/token`, { method: 'POST', headers, body: JSON.stringify({ token }) });

test('push token: 401 unauthenticated, 400 malformed, 201 stores', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const headers = authHeaders(auth);

  const anon = await postToken(base, { 'Content-Type': 'application/json' }, 'a'.repeat(64));
  assert.equal(anon.status, 401);

  for (const bad of ['', 'xyz', 'a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64), 'a'.repeat(64).replace('a', ' ')]) {
    const res = await postToken(base, headers, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }

  const token = 'ab'.repeat(32);
  const ok = await postToken(base, headers, token);
  assert.equal(ok.status, 201);
  assert.deepEqual(await ok.json(), { ok: true });
  const rows = app.db.listApnsTokens(auth.userId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].device_token, token);
  assert.equal(rows[0].platform, 'ios');
  assert.equal(rows[0].apns_environment, 'production');
});

test('push token: upserted (no duplicates) and lowercased', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const headers = authHeaders(auth);

  const upper = 'AB'.repeat(32);
  assert.equal((await postToken(base, headers, upper)).status, 201);
  assert.equal((await postToken(base, headers, upper.toLowerCase())).status, 201);
  const rows = app.db.listApnsTokens(auth.userId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].device_token, upper.toLowerCase());
});

test('push token: per-user rate limit (30 per 5 min)', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const headers = authHeaders(auth);

  let lastStatus = 0;
  for (let i = 0; i < 35; i++) {
    const token = i.toString(16).padStart(64, '0');
    const res = await postToken(base, headers, token);
    lastStatus = res.status;
    await res.text().catch(() => {});
  }
  assert.equal(lastStatus, 429);
});
