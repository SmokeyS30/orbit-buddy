import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createOrbitServer } from '../server.js';
import { openDatabase } from '../src/database.js';

function serverFixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-timeline-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', ...extraEnv } });
  return { app, base: null, directory };
}

async function startServer(fx) {
  await new Promise((resolve) => fx.app.server.listen(0, '127.0.0.1', resolve));
  fx.base = `http://127.0.0.1:${fx.app.server.address().port}`;
  return fx;
}

async function register(base, { email = 'owner@example.com', displayName = 'Owner' } = {}) {
  const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, displayName, password: 'correct horse battery staple' }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrf, user: body.user };
}

const authHeaders = ({ cookie, csrf }) => ({ Cookie: cookie, 'X-Orbit-CSRF': csrf, 'Content-Type': 'application/json' });

function backdate(directory, table, id, iso) {
  const raw = new DatabaseSync(path.join(directory, 'orbit.sqlite'));
  try {
    raw.prepare(`UPDATE ${table} SET created_at=?, updated_at=? WHERE id=?`).run(iso, iso, id);
  } finally { raw.close(); }
}

const lastMonthKey = () => {
  const d = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

test('timeline endpoint requires authentication', async (t) => {
  const fx = serverFixture(); await startServer(fx); t.after(() => fx.app.close());
  const res = await fetch(`${fx.base}/api/timeline`);
  assert.equal(res.status, 401);
});

test('timeline returns empty months for a brand-new user', async (t) => {
  const fx = serverFixture(); await startServer(fx); t.after(() => fx.app.close());
  const auth = await register(fx.base);
  const res = await fetch(`${fx.base}/api/timeline`, { headers: authHeaders(auth) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.months, []);
});

test('timeline includes current-month activity with stats', async (t) => {
  const fx = serverFixture(); await startServer(fx); t.after(() => fx.app.close());
  const auth = await register(fx.base);
  const mem = await fetch(`${fx.base}/api/memories`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ content: 'Started training for a marathon.' }) });
  assert.equal(mem.status, 201);
  const res = await fetch(`${fx.base}/api/timeline`, { headers: authHeaders(auth) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.months.length, 1);
  const m = body.months[0];
  assert.match(m.key, /^\d{4}-\d{2}$/);
  assert.ok(m.label.length > 0);
  assert.ok(m.narrative.length > 0);
  assert.equal(m.stats.memories, 1);
  assert.ok(Array.isArray(m.highlights));
});

test('timeline serves cached narrative for past months without regenerating', async (t) => {
  const fx = serverFixture(); await startServer(fx); t.after(() => fx.app.close());
  const auth = await register(fx.base);
  const mem = await (await fetch(`${fx.base}/api/memories`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ content: 'A memory from last month.' }) })).json();
  const key = lastMonthKey();
  backdate(fx.directory, 'memories', mem.id, `${key}-15T10:00:00.000Z`);
  fx.app.db.setTimelineNarrative(auth.user.id, key, 'Cached chapter text for testing.');
  const res = await fetch(`${fx.base}/api/timeline?months=3`, { headers: authHeaders(auth) });
  assert.equal(res.status, 200);
  const body = await res.json();
  const past = body.months.find((x) => x.key === key);
  assert.ok(past, 'past month should be present');
  assert.equal(past.narrative, 'Cached chapter text for testing.');
  assert.equal(past.stats.memories, 1);
});

test('timeline skips months with zero activity', async (t) => {
  const fx = serverFixture(); await startServer(fx); t.after(() => fx.app.close());
  const auth = await register(fx.base);
  const mem = await (await fetch(`${fx.base}/api/memories`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ content: 'Only this month has activity.' }) })).json();
  assert.ok(mem.id);
  // Backdate the auto-created "General" conversation so the current month is truly empty
  const convos = fx.app.db.listConversations(auth.user.id);
  const key = lastMonthKey();
  for (const c of convos) backdate(fx.directory, 'conversations', c.id, `${key}-01T10:00:00.000Z`);
  backdate(fx.directory, 'memories', mem.id, `${key}-15T10:00:00.000Z`);
  const res = await fetch(`${fx.base}/api/timeline?months=6`, { headers: authHeaders(auth) });
  const body = await res.json();
  assert.equal(body.months.length, 1, 'only the active month should appear');
  assert.equal(body.months[0].key, key);
});

test('timeline clamps the months parameter', async (t) => {
  const fx = serverFixture(); await startServer(fx); t.after(() => fx.app.close());
  const auth = await register(fx.base);
  for (const q of ['months=99', 'months=0', 'months=abc']) {
    const res = await fetch(`${fx.base}/api/timeline?${q}`, { headers: authHeaders(auth) });
    assert.equal(res.status, 200, q);
    const body = await res.json();
    assert.ok(Array.isArray(body.months), q);
  }
});

test('database timelineMonthData aggregates by month key', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-tl-db-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  const user = db.createUser({ email: 'u@example.com', displayName: 'U', passwordHash: 'h', passwordSalt: 's', role: 'owner' });
  const mem = db.addMemory(user.id, 'August memory');
  const raw = new DatabaseSync(path.join(directory, 'test.sqlite'));
  try {
    raw.prepare(`UPDATE memories SET created_at=?, updated_at=? WHERE id=?`).run('2026-08-10T12:00:00.000Z', '2026-08-10T12:00:00.000Z', mem.id);
  } finally { raw.close(); }
  const data = db.timelineMonthData(user.id, '2026-08');
  assert.equal(data.memories.length, 1);
  assert.equal(data.memories[0].content, 'August memory');
  const empty = db.timelineMonthData(user.id, '2026-07');
  assert.equal(empty.memories.length, 0);
  assert.equal(empty.checkins, 0);
  db.close();
});

test('database timeline narrative cache round-trips', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-tl-db-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  const user = db.createUser({ email: 'u@example.com', displayName: 'U', passwordHash: 'h', passwordSalt: 's', role: 'owner' });
  assert.equal(db.getTimelineNarrative(user.id, '2026-08'), null);
  db.setTimelineNarrative(user.id, '2026-08', 'It was a good month.');
  assert.equal(db.getTimelineNarrative(user.id, '2026-08'), 'It was a good month.');
  db.setTimelineNarrative(user.id, '2026-08', 'Updated chapter.');
  assert.equal(db.getTimelineNarrative(user.id, '2026-08'), 'Updated chapter.');
  db.close();
});
