import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';

async function fixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-server-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-5.4-mini', ...extraEnv } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function register(base, { email = 'owner@example.com', displayName = 'Owner' } = {}) {
  const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, displayName, password: 'correct horse battery staple' }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrf, body };
}

const authHeaders = ({ cookie, csrf }) => ({ Cookie: cookie, 'X-Orbit-CSRF': csrf, 'Content-Type': 'application/json' });

test('health and setup are public while private data requires a session', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/api/auth/setup-status`)).status, 200);
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  const auth = await register(base);
  const response = await fetch(`${base}/api/auth/me`, { headers: { Cookie: auth.cookie } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.email, 'owner@example.com');
});

test('CSRF is enforced and background work produces a saved artifact', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  assert.equal((await fetch(`${base}/api/tasks`, { method: 'POST', headers: { Cookie: auth.cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const created = await fetch(`${base}/api/tasks`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ title: 'Plan', prompt: 'Make a plan' }) });
  assert.equal(created.status, 201);
  await app.runDueTasks();
  const snapshot = await fetch(`${base}/api/snapshot`, { headers: { Cookie: auth.cookie } });
  const body = await snapshot.json();
  assert.equal(body.tasks[0].status, 'completed');
  assert.equal(body.artifacts.length, 1);
  assert.match(body.artifacts[0].name, /plan/i);
});

test('owner emergency pause blocks work until explicit resume', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const paused = await fetch(`${base}/api/admin/pause`, { method: 'POST', headers: authHeaders(auth), body: '{}' });
  assert.equal(paused.status, 200);
  assert.equal((await fetch(`${base}/api/tasks`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ title: 'Blocked', prompt: 'Do work' }) })).status, 423);
  const resumed = await fetch(`${base}/api/admin/resume`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ confirm: 'RESUME' }) });
  assert.equal(resumed.status, 200);
});

test('scoped automation tokens create internal-only tasks', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const tokenResponse = await fetch(`${base}/api/automation-tokens`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ label: 'iPhone Shortcut' }) });
  const token = (await tokenResponse.json()).token;
  const taskResponse = await fetch(`${base}/api/automation/tasks`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'From phone', prompt: 'Prepare a checklist', risk: 'external' }) });
  assert.equal(taskResponse.status, 201);
  assert.equal((await taskResponse.json()).risk, 'internal');
});

test('only the owner can restore a backup and restoration leaves work paused', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const owner = await register(base);
  const opened = await fetch(`${base}/api/admin/registration`, { method: 'POST', headers: authHeaders(owner), body: JSON.stringify({ open: true }) });
  assert.equal(opened.status, 200);
  const member = await register(base, { email: 'member@example.com', displayName: 'Member' });
  const exported = await fetch(`${base}/api/backups/export`, { method: 'POST', headers: authHeaders(owner), body: JSON.stringify({ passphrase: 'a separate backup passphrase' }) });
  assert.equal(exported.status, 200);
  const payload = await exported.text();
  const blocked = await fetch(`${base}/api/backups/restore`, { method: 'POST', headers: authHeaders(member), body: JSON.stringify({ payload, passphrase: 'a separate backup passphrase', confirm: 'RESTORE' }) });
  assert.equal(blocked.status, 403);
  const restored = await fetch(`${base}/api/backups/restore`, { method: 'POST', headers: authHeaders(owner), body: JSON.stringify({ payload, passphrase: 'a separate backup passphrase', confirm: 'RESTORE' }) });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).paused, true);
});

test('registration door is closed by default; owner can open and close it', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const owner = await register(base);
  const setup = await (await fetch(`${base}/api/auth/setup-status`)).json();
  assert.equal(setup.registrationOpen, false);
  const attempt = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'member@example.com', displayName: 'Member', password: 'correct horse battery staple' }) };
  assert.equal((await fetch(`${base}/api/auth/register`, attempt)).status, 403);
  const opened = await fetch(`${base}/api/admin/registration`, { method: 'POST', headers: authHeaders(owner), body: JSON.stringify({ open: true }) });
  assert.equal(opened.status, 200);
  assert.equal((await opened.json()).open, true);
  const member = await register(base, { email: 'member@example.com', displayName: 'Member' });
  assert.equal(member.body.user.email, 'member@example.com');
  const denied = await fetch(`${base}/api/admin/registration`, { method: 'POST', headers: authHeaders(member), body: JSON.stringify({ open: false }) });
  assert.equal(denied.status, 403);
  const closed = await fetch(`${base}/api/admin/registration`, { method: 'POST', headers: authHeaders(owner), body: JSON.stringify({ open: false }) });
  assert.equal((await closed.json()).open, false);
  assert.equal((await fetch(`${base}/api/auth/register`, { ...attempt, body: JSON.stringify({ email: 'third@example.com', displayName: 'Third', password: 'correct horse battery staple' }) })).status, 403);
});
