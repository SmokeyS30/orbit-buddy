// L1 Canvas v2: revision history capture + endpoints + auth.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer, captureCanvasRevision } from '../server.js';

async function fixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-canvasrev-'));
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

// A canvas-worthy document (long + structured), parameterized by revision.
function makeDoc(rev, extra = '') {
  const items = Array.from({ length: 12 }, (_, i) => `- Week ${i + 1}: topic ${rev}-${i}`).join('\n');
  const table = ['| Day | Focus |', '|---|---|', `| Mon | Hardware r${rev} |`, `| Wed | Networking r${rev} |`, `| Fri | Review r${rev} |`].join('\n');
  return [
    `# CompTIA A+ Study Plan (revision ${rev})`,
    '',
    '## Weekly schedule',
    '',
    items,
    '',
    '## Practice table',
    '',
    table,
    '',
    extra,
    'Aim for 85%+ on practice exams before booking the real thing. '.repeat(20),
  ].join('\n');
}

test('capture: first canvas message stores no revision; second snapshots the first', async (t) => {
  const { app } = await fixture(); t.after(() => app.close());
  const db = app.db;
  const user = db.createUser({ email: 'rev1@example.com', displayName: 'R', passwordHash: 'h', passwordSalt: 's', role: 'member' });
  const convo = db.ensureDefaultConversation(user.id);
  const m1 = db.addMessage(user.id, convo.id, 'assistant', makeDoc(1));
  captureCanvasRevision(db, user.id, convo.id, m1);
  assert.deepEqual(db.listCanvasRevisions(user.id, m1.id), [], 'no revisions for the first document');
  db.addMessage(user.id, convo.id, 'user', 'revise this to add more networking');
  const m2 = db.addMessage(user.id, convo.id, 'assistant', makeDoc(2, 'Extra networking section.'));
  captureCanvasRevision(db, user.id, convo.id, m2);
  const revs = db.listCanvasRevisions(user.id, m2.id);
  assert.equal(revs.length, 1, 'one revision after a single revision round');
  assert.equal(revs[0].version, 1);
  assert.equal(revs[0].content, makeDoc(1), 'the prior document content is snapshotted');
});

test('capture: revision chains carry across rounds (v1, v2 on the latest message)', async (t) => {
  const { app } = await fixture(); t.after(() => app.close());
  const db = app.db;
  const user = db.createUser({ email: 'rev2@example.com', displayName: 'R', passwordHash: 'h', passwordSalt: 's', role: 'member' });
  const convo = db.ensureDefaultConversation(user.id);
  const m1 = db.addMessage(user.id, convo.id, 'assistant', makeDoc(1));
  captureCanvasRevision(db, user.id, convo.id, m1);
  db.addMessage(user.id, convo.id, 'user', 'revise this');
  const m2 = db.addMessage(user.id, convo.id, 'assistant', makeDoc(2));
  captureCanvasRevision(db, user.id, convo.id, m2);
  db.addMessage(user.id, convo.id, 'user', 'revise this again');
  const m3 = db.addMessage(user.id, convo.id, 'assistant', makeDoc(3));
  captureCanvasRevision(db, user.id, convo.id, m3);
  const revs = db.listCanvasRevisions(user.id, m3.id);
  assert.deepEqual(revs.map((r) => r.version), [2, 1], 'newest first');
  assert.equal(revs[1].content, makeDoc(1));
  assert.equal(revs[0].content, makeDoc(2));
  const single = db.getCanvasRevision(user.id, m3.id, 1);
  assert.equal(single.content, makeDoc(1));
});

test('capture: ignores non-canvas messages and identical content', async (t) => {
  const { app } = await fixture(); t.after(() => app.close());
  const db = app.db;
  const user = db.createUser({ email: 'rev3@example.com', displayName: 'R', passwordHash: 'h', passwordSalt: 's', role: 'member' });
  const convo = db.ensureDefaultConversation(user.id);
  const m1 = db.addMessage(user.id, convo.id, 'assistant', makeDoc(1));
  captureCanvasRevision(db, user.id, convo.id, m1);
  const short = db.addMessage(user.id, convo.id, 'assistant', 'Got it, here is a quick note.');
  captureCanvasRevision(db, user.id, convo.id, short);
  assert.deepEqual(db.listCanvasRevisions(user.id, short.id), [], 'short replies never capture');
  const dup = db.addMessage(user.id, convo.id, 'assistant', makeDoc(1));
  captureCanvasRevision(db, user.id, convo.id, dup);
  assert.deepEqual(db.listCanvasRevisions(user.id, dup.id), [], 'identical content is not revisioned');
});

test('capture: revisions are immutable (duplicate version rejected)', async (t) => {
  const { app } = await fixture(); t.after(() => app.close());
  const db = app.db;
  const user = db.createUser({ email: 'rev4@example.com', displayName: 'R', passwordHash: 'h', passwordSalt: 's', role: 'member' });
  const convo = db.ensureDefaultConversation(user.id);
  const m1 = db.addMessage(user.id, convo.id, 'assistant', makeDoc(1));
  captureCanvasRevision(db, user.id, convo.id, m1);
  const m2 = db.addMessage(user.id, convo.id, 'assistant', makeDoc(2));
  captureCanvasRevision(db, user.id, convo.id, m2);
  assert.throws(() => db.addCanvasRevision(user.id, m2.id, 1, 'tampered'), 'UNIQUE(message_id, version) enforced');
  assert.equal(db.listCanvasRevisions(user.id, m2.id)[0].content, makeDoc(1), 'original revision intact');
});

test('endpoints: unauthenticated revision reads are 401', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const m1 = app.db.addMessage(auth.userId, convo.id, 'assistant', makeDoc(1));
  for (const url of [
    `${base}/api/canvas/${m1.id}/revisions`,
    `${base}/api/canvas/${m1.id}/revisions/1`,
  ]) {
    const r = await fetch(url);
    assert.equal(r.status, 401, url);
  }
  const r = await fetch(`${base}/api/canvas/${m1.id}/revisions/1/restore`, { method: 'POST' });
  assert.equal(r.status, 401);
});

test('endpoints: list/single newest-first with previews; 404 on unknown', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const headers = authHeaders(auth);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const m1 = app.db.addMessage(auth.userId, convo.id, 'assistant', makeDoc(1));
  captureCanvasRevision(app.db, auth.userId, convo.id, m1);
  const m2 = app.db.addMessage(auth.userId, convo.id, 'assistant', makeDoc(2));
  captureCanvasRevision(app.db, auth.userId, convo.id, m2);

  const list = await fetch(`${base}/api/canvas/${m2.id}/revisions`, { headers });
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.messageId, m2.id);
  assert.equal(body.current.content, makeDoc(2));
  assert.deepEqual(body.revisions.map((r) => r.version), [1]);
  assert.ok(body.revisions[0].preview.length <= 240 && !('content' in body.revisions[0]), 'list carries previews only');

  const single = await fetch(`${base}/api/canvas/${m2.id}/revisions/1`, { headers });
  assert.equal(single.status, 200);
  assert.equal((await single.json()).content, makeDoc(1), 'full content on single fetch');

  const missing = await fetch(`${base}/api/canvas/${m2.id}/revisions/9`, { headers });
  assert.equal(missing.status, 404);
  const unknown = await fetch(`${base}/api/canvas/12345678-1234-1234-1234-123456789012/revisions`, { headers });
  assert.equal(unknown.status, 404);
});

test('endpoints: cross-user message id is 404', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const a = await register(base, 'a@example.com');
  const b = app.db.createUser({ email: 'b@example.com', displayName: 'B', passwordHash: 'h', passwordSalt: 's', role: 'member' });
  const convo = app.db.ensureDefaultConversation(b.id);
  const m = app.db.addMessage(b.id, convo.id, 'assistant', makeDoc(1));
  const r = await fetch(`${base}/api/canvas/${m.id}/revisions`, { headers: authHeaders(a) });
  assert.equal(r.status, 404);
});

test('endpoints: restore versions the pre-restore content and sets message content', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const headers = authHeaders(auth);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const m1 = app.db.addMessage(auth.userId, convo.id, 'assistant', makeDoc(1));
  captureCanvasRevision(app.db, auth.userId, convo.id, m1);
  const m2 = app.db.addMessage(auth.userId, convo.id, 'assistant', makeDoc(2));
  captureCanvasRevision(app.db, auth.userId, convo.id, m2);

  const res = await fetch(`${base}/api/canvas/${m2.id}/revisions/1/restore`, { method: 'POST', headers });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.version, 1);
  assert.equal(out.keptAsVersion, 2, 'pre-restore content kept as a new revision');
  assert.equal(out.content, makeDoc(1));

  assert.equal(app.db.getMessage(auth.userId, m2.id).content, makeDoc(1), 'message content now shows the restored version');
  const revs = app.db.listCanvasRevisions(auth.userId, m2.id);
  assert.deepEqual(revs.map((r) => r.version), [2, 1], 'history grows: kept current is newest');
  assert.equal(revs[0].content, makeDoc(2), 'nothing was lost');

  // Restoring the already-current version is a no-op (no duplicate revision).
  const again = await fetch(`${base}/api/canvas/${m2.id}/revisions/1/restore`, { method: 'POST', headers });
  assert.equal((await again.json()).keptAsVersion, null);
  assert.equal(app.db.listCanvasRevisions(auth.userId, m2.id).length, 2);
});
