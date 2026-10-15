import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';

const NATIVE = 'capacitor://localhost';
const IONIC = 'ionic://localhost';

async function fixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-ios-native-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', ...extraEnv } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function register(base, { email, origin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers,
    body: JSON.stringify({ email: email || `user${Date.now()}@example.com`, displayName: 'Test', password: 'correct horse battery staple' }),
  });
  assert.equal(response.status, 201);
  return { response, body: await response.json() };
}

test('native origins get CORS headers on API responses; web origins get none', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  for (const origin of [NATIVE, IONIC]) {
    const res = await fetch(`${base}/api/auth/setup-status`, { headers: { Origin: origin } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    assert.match(res.headers.get('vary') || '', /Origin/);
  }
  // A normal web origin gets no CORS headers — web behavior unchanged.
  const web = await fetch(`${base}/api/auth/setup-status`, { headers: { Origin: 'https://orbitbuddy.app' } });
  assert.equal(web.status, 200);
  assert.equal(web.headers.get('access-control-allow-origin'), null);
  const plain = await fetch(`${base}/api/auth/setup-status`);
  assert.equal(plain.headers.get('access-control-allow-origin'), null);
});

test('OPTIONS preflight from a native origin is answered; others are not', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const pre = await fetch(`${base}/api/chat`, {
    method: 'OPTIONS',
    headers: { Origin: NATIVE, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'X-Orbit-CSRF' },
  });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-methods') || '', /POST/);
  assert.match(pre.headers.get('access-control-allow-headers') || '', /X-Orbit-CSRF/);
  assert.equal(pre.headers.get('access-control-allow-origin'), NATIVE);
  assert.equal(pre.headers.get('access-control-allow-credentials'), 'true');
  // No CORS preflight answer for ordinary browser requests.
  const web = await fetch(`${base}/api/chat`, { method: 'OPTIONS' });
  assert.notEqual(web.status, 204);
});

test('session cookie is SameSite=None;Secure for the native origin, Strict for web', async (t) => {
  const n = await fixture(); t.after(() => n.app.close());
  const native = await register(n.base, { email: 'native@example.com', origin: NATIVE });
  const nativeCookie = native.response.headers.get('set-cookie');
  assert.match(nativeCookie, /SameSite=None/);
  assert.match(nativeCookie, /Secure/);
  // Web register in a fresh fixture (registration closes after the first user).
  const w = await fixture(); t.after(() => w.app.close());
  const web = await register(w.base, { email: 'web@example.com' });
  const webCookie = web.response.headers.get('set-cookie');
  assert.match(webCookie, /SameSite=Strict/);
});

test('logout clears the session cookie with the matching SameSite value', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const { response, body } = await register(base, { email: 'logout@example.com', origin: NATIVE });
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const out = await fetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: { Origin: NATIVE, Cookie: cookie, 'X-Orbit-CSRF': body.csrf },
  });
  assert.equal(out.status, 200);
  const cleared = out.headers.get('set-cookie');
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /SameSite=None/);
  assert.match(cleared, /Secure/);
});
