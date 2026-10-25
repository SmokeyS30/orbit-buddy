import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';
import { signupInbox } from './helpers/signup-inbox.js';

async function fixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-l3-'));
  const inbox=signupInbox();
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', SIGNUP_AUDIT_KEY: 'synthetic-multiuser-key', ...extraEnv }, sendEmail:inbox.sendEmail });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  return { app, base, register:(options)=>register(base,options,inbox) };
}

async function register(base, { email = 'mom@example.com', displayName = 'Sarah Miller' } = {},inbox) {
  const response = await inbox.register(base,{ email, displayName, password: 'correct horse battery staple' });
  assert.equal(response.status, 201);
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrf, body };
}

const authHeaders = ({ cookie, csrf }) => ({ Cookie: cookie, 'X-Orbit-CSRF': csrf, 'Content-Type': 'application/json' });

async function snapshot(base, auth) {
  const response = await fetch(`${base}/api/snapshot`, { headers: authHeaders(auth) });
  assert.equal(response.status, 200);
  return response.json();
}

test('L3 onboarding: registration seeds a warm welcome message and a name memory', async (t) => {
  const { app, base, register } = await fixture(); t.after(() => app.close());
  const auth = await register();
  const snap = await snapshot(base, auth);
  // Welcome message from Orbit in the default conversation
  const welcome = (snap.messages || []).find((m) => m.role === 'assistant' && /Welcome, Sarah/.test(m.content || ''));
  assert.ok(welcome, 'expected a warm welcome message mentioning the new user by first name');
  assert.match(welcome.content, /what should I call you|call you something else/i);
  // Name captured from registration as an approved memory (no separate modal hop needed)
  const nameMemory = (snap.memories || []).find((m) => /my name is sarah miller/i.test(m.content || ''));
  assert.ok(nameMemory, 'expected a name memory seeded from the registration display name');
  assert.equal(nameMemory.status, 'approved');
});

test('L3 intro card: shown for fresh users, dismissal persists server-side per user', async (t) => {
  const { app, base, register } = await fixture(); t.after(() => app.close());
  const auth = await register();
  let snap = await snapshot(base, auth);
  assert.ok(!snap.preferences.intro_dismissed, 'fresh user should not have dismissed the intro card');
  // Dismiss without CSRF must be rejected (auth security unchanged)
  const noCsrf = await fetch(`${base}/api/onboarding/intro-dismiss`, { method: 'POST', headers: { Cookie: auth.cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noCsrf.status, 403);
  // Dismiss without a session must be rejected
  const anon = await fetch(`${base}/api/onboarding/intro-dismiss`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(anon.status, 401);
  // Real dismissal persists
  const dismissed = await fetch(`${base}/api/onboarding/intro-dismiss`, { method: 'POST', headers: authHeaders(auth), body: '{}' });
  assert.equal(dismissed.status, 200);
  assert.deepEqual(await dismissed.json(), { ok: true });
  snap = await snapshot(base, auth);
  assert.equal(Number(snap.preferences.intro_dismissed), 1, 'dismissal must persist server-side');
  // Idempotent: dismissing again is fine
  const again = await fetch(`${base}/api/onboarding/intro-dismiss`, { method: 'POST', headers: authHeaders(auth), body: '{}' });
  assert.equal(again.status, 200);
});

test('L3 intro dismissal is per-user, not global', async (t) => {
  const { app, base, register } = await fixture(); t.after(() => app.close());
  const first = await register({ email: 'first@example.com', displayName: 'First' });
  // Owner opens registration so a second user can join
  const openReg = await fetch(`${base}/api/admin/registration`, { method: 'POST', headers: authHeaders(first), body: JSON.stringify({ open: true }) });
  assert.equal(openReg.status, 200);
  const second = await register({ email: 'second@example.com', displayName: 'Second' });
  await fetch(`${base}/api/onboarding/intro-dismiss`, { method: 'POST', headers: authHeaders(first), body: '{}' });
  const snapFirst = await snapshot(base, first);
  const snapSecond = await snapshot(base, second);
  assert.equal(Number(snapFirst.preferences.intro_dismissed), 1);
  assert.ok(!snapSecond.preferences.intro_dismissed, 'second user must still see the intro card');
});

test('L3 onboarding: registration still enforces auth security properties', async (t) => {
  const { app, base, register } = await fixture(); t.after(() => app.close());
  // Missing display name is still rejected
  const bad = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x@example.com', displayName: ' ', password: 'correct horse battery staple' }) });
  assert.equal(bad.status, 400);
  // Duplicate email is still rejected
  await register({ email: 'dupe@example.com', displayName: 'Dupe' });
  const dupe = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dupe@example.com', displayName: 'Dupe 2', password: 'correct horse battery staple' }) });
  assert.equal(dupe.status, 409);
});
