import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';

async function fixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-server-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', ...extraEnv } });
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

test('user preferences and typed memory are exposed in the snapshot', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const saved = await fetch(`${base}/api/preferences`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ timeZone: 'Europe/London', quietStart: '23:00', quietEnd: '07:00', proactiveEnabled: false }) });
  assert.equal(saved.status, 200);
  const memory = await fetch(`${base}/api/memories`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ content: 'Working toward a marathon.', kind: 'goal' }) });
  assert.equal(memory.status, 201);
  const snapshot = await (await fetch(`${base}/api/snapshot`, { headers: { Cookie: auth.cookie } })).json();
  assert.equal(snapshot.preferences.time_zone, 'Europe/London');
  assert.equal(snapshot.preferences.proactive_enabled, 0);
  assert.equal(snapshot.memories[0].kind, 'goal');
});

test('goal and routine endpoints update the proactive snapshot', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const createdGoal = await fetch(`${base}/api/goals`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ title: 'Finish certification', priority: 3, targetDate: '2026-12-01', nextStep: 'Study chapter four' }) });
  assert.equal(createdGoal.status, 201);
  const goal = await createdGoal.json();
  const progressed = await fetch(`${base}/api/goals/${goal.id}`, { method: 'PATCH', headers: authHeaders(auth), body: JSON.stringify({ progress: 45, note: 'Practice exam completed' }) });
  assert.equal(progressed.status, 200);
  assert.equal((await progressed.json()).progress, 45);
  const createdRoutine = await fetch(`${base}/api/routines`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ title: 'Morning brief', prompt: 'Prepare my priorities', kind: 'briefing', cadence: 'weekdays', timeLocal: '08:00' }) });
  assert.equal(createdRoutine.status, 201);
  const routine = await createdRoutine.json();
  const paused = await fetch(`${base}/api/routines/${routine.id}`, { method: 'PATCH', headers: authHeaders(auth), body: JSON.stringify({ enabled: false }) });
  assert.equal(paused.status, 200);
  const snapshot = await (await fetch(`${base}/api/snapshot`, { headers: { Cookie: auth.cookie } })).json();
  assert.equal(snapshot.goals[0].progress, 45);
  assert.equal(snapshot.routines[0].enabled, 0);
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

test('automation endpoints are gone', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  assert.equal((await fetch(`${base}/api/automation-tokens`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ label: 'x' }) })).status, 404);
  assert.equal((await fetch(`${base}/api/automation/tasks`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({}) })).status, 404);
  assert.equal((await fetch(`${base}/api/automation/ask`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({}) })).status, 404);
  assert.equal((await fetch(`${base}/api/automation/memories`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({}) })).status, 404);
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

test('access requests: public can ask, owner is notified and can dismiss', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const owner = await register(base);
  const ask = (name, email) => fetch(`${base}/api/registration-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email }) });
  assert.equal((await ask('', 'a@example.com')).status, 400);
  assert.equal((await ask('Amy', 'not-an-email')).status, 400);
  assert.equal((await ask('Amy', 'amy@example.com')).status, 201);
  const listed = await fetch(`${base}/api/admin/access-requests`, { headers: authHeaders(owner) });
  assert.equal(listed.status, 200);
  const requests = (await listed.json()).requests;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].name, 'Amy');
  assert.equal(requests[0].email, 'amy@example.com');
  assert.equal(requests[0].handled_at, null);
  const events = await fetch(`${base}/api/snapshot`, { headers: { Cookie: owner.cookie } });
  const eventTypes = (await events.json()).events.map((e) => e.type);
  assert.ok(eventTypes.includes('access_request'));
});

test('access requests are rate-limited and owner-only to manage', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const owner = await register(base);
  const opened = await fetch(`${base}/api/admin/registration`, { method: 'POST', headers: authHeaders(owner), body: JSON.stringify({ open: true }) });
  assert.equal(opened.status, 200);
  const member = await register(base, { email: 'member@example.com', displayName: 'Member' });
  const ask = (n) => fetch(`${base}/api/registration-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `Person ${n}`, email: `person${n}@example.com` }) });
  assert.equal((await ask(1)).status, 201);
  assert.equal((await ask(2)).status, 201);
  assert.equal((await ask(3)).status, 201);
  assert.equal((await ask(4)).status, 429);
  const id = (await (await fetch(`${base}/api/admin/access-requests`, { headers: authHeaders(owner) })).json()).requests[0].id;
  assert.equal((await fetch(`${base}/api/admin/access-requests`, { headers: authHeaders(member) })).status, 403);
  assert.equal((await fetch(`${base}/api/admin/access-requests/${id}`, { method: 'POST', headers: authHeaders(member) })).status, 403);
  assert.equal((await fetch(`${base}/api/admin/access-requests/${id}`, { method: 'POST', headers: authHeaders(owner) })).status, 200);
  const remaining = (await (await fetch(`${base}/api/admin/access-requests`, { headers: authHeaders(owner) })).json()).requests.filter((r) => !r.handled_at);
  assert.equal(remaining.length, 2);
});

test('door-left-open nudge fires once after an hour', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const owner = await register(base);
  await fetch(`${base}/api/admin/registration`, { method: 'POST', headers: authHeaders(owner), body: JSON.stringify({ open: true }) });
  await app.checkDoorLeftOpen();
  const fresh = await (await fetch(`${base}/api/snapshot`, { headers: { Cookie: owner.cookie } })).json();
  assert.ok(!fresh.events.some((e) => e.type === 'registration_nudge'));
  app.db.setSetting('registration_opened_at', new Date(Date.now() - 2 * 60 * 60_000).toISOString());
  await app.checkDoorLeftOpen();
  await app.checkDoorLeftOpen();
  const after = await (await fetch(`${base}/api/snapshot`, { headers: { Cookie: owner.cookie } })).json();
  assert.equal(after.events.filter((e) => e.type === 'registration_nudge').length, 1);
});

test('door token opens registration once, then expires', async (t) => {
  const { hashToken } = await import('../src/security.js');
  const { app, base } = await fixture(); t.after(() => app.close());
  await register(base);
  const raw = 'door_test_token_abc';
  app.db.addDoorToken(hashToken(raw), new Date(Date.now() + 60_000).toISOString());
  const post = (token) => fetch(`${base}/api/registration/door-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal((await post('')).status, 403);
  assert.equal((await post('garbage')).status, 403);
  const ok = await post(raw);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).open, true);
  assert.equal((await (await fetch(`${base}/api/auth/setup-status`)).json()).registrationOpen, true);
  assert.equal((await post(raw)).status, 403);
  app.db.addDoorToken(hashToken('expired'), new Date(Date.now() - 60_000).toISOString());
  assert.equal((await post('expired')).status, 403);
});
