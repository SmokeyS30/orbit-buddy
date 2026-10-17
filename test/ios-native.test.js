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

test('X-Orbit-Native header alone (no Origin) gets SameSite=None;Secure — the WKWebView case', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Orbit-Native': '1' },
    body: JSON.stringify({ email: `hdr${Date.now()}@example.com`, displayName: 'Test', password: 'correct horse battery staple' }),
  });
  assert.equal(res.status, 201);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /SameSite=None/);
  assert.match(cookie, /Secure/);
});

test('no header and no Origin stays SameSite=Strict — web behavior unchanged', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `web${Date.now()}@example.com`, displayName: 'Test', password: 'correct horse battery staple' }),
  });
  assert.equal(res.status, 201);
  assert.match(res.headers.get('set-cookie'), /SameSite=Strict/);
});

test('logout with only the native header clears the cookie as SameSite=None', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const reg = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Orbit-Native': '1' },
    body: JSON.stringify({ email: `lo${Date.now()}@example.com`, displayName: 'Test', password: 'correct horse battery staple' }),
  });
  assert.equal(reg.status, 201);
  const cookie = reg.headers.get('set-cookie').split(';')[0];
  const body = await reg.json();
  const out = await fetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-Orbit-Native': '1', 'X-Orbit-CSRF': body.csrf },
  });
  assert.equal(out.status, 200);
  const cleared = out.headers.get('set-cookie');
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /SameSite=None/);
});

test('preflight allow-headers includes X-Orbit-Native for the native origin', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const pre = await fetch(`${base}/api/chat`, {
    method: 'OPTIONS',
    headers: { Origin: NATIVE, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'X-Orbit-Native, X-Orbit-CSRF' },
  });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers') || '', /X-Orbit-Native/);
});

test('the native header alone never grants a CORS origin echo', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const res = await fetch(`${base}/api/auth/setup-status`, {
    headers: { Origin: 'https://evil.example', 'X-Orbit-Native': '1' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('native login response includes sessionToken in body; web login does not', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  // Native login (X-Orbit-Native header) → sessionToken present.
  const email = `bl${Date.now()}@example.com`;
  const password = 'correct horse battery staple';
  await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, displayName: 'Test', password }),
  });
  const nativeLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Orbit-Native': '1' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(nativeLogin.status, 200);
  const nativeBody = await nativeLogin.json();
  assert.ok(nativeBody.sessionToken, 'native login body must include sessionToken');
  assert.equal(typeof nativeBody.sessionToken, 'string');
  // Web login (no native header) → sessionToken absent.
  const webLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(webLogin.status, 200);
  const webBody = await webLogin.json();
  assert.equal(webBody.sessionToken, undefined, 'web login body must NOT include sessionToken');
});

test('Bearer token authenticates requests without a cookie', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const email = `bt${Date.now()}@example.com`;
  const password = 'correct horse battery staple';
  await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, displayName: 'Test', password }),
  });
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Orbit-Native': '1' },
    body: JSON.stringify({ email, password }),
  });
  const { sessionToken, csrf } = await login.json();
  // No cookie sent — only the Bearer header. Must authenticate.
  const me = await fetch(`${base}/api/auth/me`, {
    headers: { Authorization: `Bearer ${sessionToken}`, 'X-Orbit-Native': '1' },
  });
  assert.equal(me.status, 200);
  const meBody = await me.json();
  assert.equal(meBody.user.email, email);
  // And CSRF-protected writes work with Bearer + CSRF header.
  const snap = await fetch(`${base}/api/snapshot`, {
    headers: { Authorization: `Bearer ${sessionToken}`, 'X-Orbit-Native': '1', 'X-Orbit-CSRF': csrf },
  });
  assert.equal(snap.status, 200);
});

test('wrong or missing Bearer token → 401', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const bad = await fetch(`${base}/api/auth/me`, {
    headers: { Authorization: 'Bearer definitely-not-a-real-token', 'X-Orbit-Native': '1' },
  });
  assert.equal(bad.status, 401);
  const none = await fetch(`${base}/api/auth/me`, {
    headers: { 'X-Orbit-Native': '1' },
  });
  assert.equal(none.status, 401);
  const malformed = await fetch(`${base}/api/auth/me`, {
    headers: { Authorization: 'Token abc123', 'X-Orbit-Native': '1' },
  });
  assert.equal(malformed.status, 401);
});

test('cookie auth still works — Bearer is additive, not a replacement', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const reg = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `ck${Date.now()}@example.com`, displayName: 'Test', password: 'correct horse battery staple' }),
  });
  assert.equal(reg.status, 201);
  const cookie = reg.headers.get('set-cookie').split(';')[0];
  const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
});

test('logout via Bearer token deletes the session', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const email = `lbo${Date.now()}@example.com`;
  const password = 'correct horse battery staple';
  await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, displayName: 'Test', password }),
  });
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Orbit-Native': '1' },
    body: JSON.stringify({ email, password }),
  });
  const { sessionToken, csrf } = await login.json();
  const authHeaders = { Authorization: `Bearer ${sessionToken}`, 'X-Orbit-Native': '1', 'X-Orbit-CSRF': csrf };
  const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: authHeaders });
  assert.equal(out.status, 200);
  // Session is gone — Bearer no longer authenticates.
  const me = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${sessionToken}`, 'X-Orbit-Native': '1' } });
  assert.equal(me.status, 401);
});
