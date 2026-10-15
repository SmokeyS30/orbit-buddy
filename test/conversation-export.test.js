// W3: conversation share/export.
// GET /api/chat/conversations/:id/export?format=markdown|pdf — own
// conversations only: 401 unauthenticated, 404 unknown id, 403 another
// user's conversation; 200 with the right content-type for both formats;
// markdown has roles/timestamps in order with code blocks preserved; the
// PDF is produced by the existing Canvas print-flow pipeline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createOrbitServer } from '../server.js';

async function fixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-export-'));
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

const exportUrl = (base, convoId, format) => `${base}/api/chat/conversations/${convoId}/export?format=${format}`;

test('export: 401 unauthenticated, 404 unknown id, 403 another user\'s conversation', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const headers = authHeaders(auth);
  const convo = app.db.ensureDefaultConversation(auth.userId);

  const anon = await fetch(exportUrl(base, convo.id, 'markdown'));
  assert.equal(anon.status, 401);

  const missing = await fetch(exportUrl(base, randomUUID(), 'markdown'), { headers });
  assert.equal(missing.status, 404);

  const other = app.db.createUser({ email: 'other@example.com', displayName: 'Other', passwordHash: 'x', passwordSalt: 'y', role: 'member' });
  const otherConvo = app.db.ensureDefaultConversation(other.id);
  const forbidden = await fetch(exportUrl(base, otherConvo.id, 'markdown'), { headers });
  assert.equal(forbidden.status, 403);

  const forbiddenPdf = await fetch(exportUrl(base, otherConvo.id, 'pdf'), { headers });
  assert.equal(forbiddenPdf.status, 403);
});

test('export markdown: roles, timestamps, order, code blocks preserved', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const headers = authHeaders(auth);
  const convo = app.db.createConversation(auth.userId, 'Study plan');
  const m1 = app.db.addMessage(auth.userId, convo.id, 'user', 'EXPORT-USER-FIRST make me a plan');
  const m2 = app.db.addMessage(auth.userId, convo.id, 'assistant', 'EXPORT-ASSISTANT-FIRST\n\n```js\nconst x = 1;\n```');
  const m3 = app.db.addMessage(auth.userId, convo.id, 'user', 'EXPORT-USER-SECOND thanks');
  const m4 = app.db.addMessage(auth.userId, convo.id, 'assistant', 'EXPORT-ASSISTANT-SECOND you are welcome');
  // Space messages seconds apart so ordering assertions are deterministic.
  const anchor = Date.now() - 4 * 10000;
  [m1, m2, m3, m4].forEach((m, i) => app.db.retimeMessage(auth.userId, m.id, new Date(anchor + i * 10000).toISOString()));

  const response = await fetch(exportUrl(base, convo.id, 'markdown'), { headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/markdown/);
  assert.match(response.headers.get('content-disposition') || '', /\.md"?$/);
  const text = await response.text();
  const i1 = text.indexOf('EXPORT-USER-FIRST'), i2 = text.indexOf('EXPORT-ASSISTANT-FIRST');
  const i3 = text.indexOf('EXPORT-USER-SECOND'), i4 = text.indexOf('EXPORT-ASSISTANT-SECOND');
  assert.ok(i1 !== -1 && i2 !== -1 && i3 !== -1 && i4 !== -1, 'all four messages present');
  assert.ok(i1 < i2 && i2 < i3 && i3 < i4, 'messages in chronological order');
  assert.ok(text.includes('# Study plan'), 'conversation title is the heading');
  assert.ok(text.includes('## You · '), 'user role labeled with timestamp');
  assert.ok(text.includes('## Orbit · '), 'assistant role labeled with timestamp');
  assert.ok(text.includes('```js\nconst x = 1;\n```'), 'code blocks preserved');
  assert.ok(!text.includes(m1.id), 'no internal message ids leak');
});

test('export markdown strips internal model markers', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const headers = authHeaders(auth);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  app.db.addMessage(auth.userId, convo.id, 'user', 'hi');
  app.db.addMessage(auth.userId, convo.id, 'assistant', 'MARKED-ANSWER[SUGGEST_MEMORY: user likes tea][FOLLOWUP: 2026-10-20 call mom]');

  const response = await fetch(exportUrl(base, convo.id, 'markdown'), { headers });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(text.includes('MARKED-ANSWER'), 'message body kept');
  assert.ok(!text.includes('SUGGEST_MEMORY'), 'memory suggestion marker stripped');
  assert.ok(!text.includes('FOLLOWUP:'), 'follow-up marker stripped');
});

test('export pdf: correct content-type and a real PDF from the Canvas pipeline', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const headers = authHeaders(auth);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  app.db.addMessage(auth.userId, convo.id, 'user', 'PDF-CHECK question');
  app.db.addMessage(auth.userId, convo.id, 'assistant', 'PDF-CHECK answer');

  const response = await fetch(exportUrl(base, convo.id, 'pdf'), { headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /application\/pdf/);
  const buf = Buffer.from(await response.arrayBuffer());
  assert.equal(buf.slice(0, 4).toString('latin1'), '%PDF', 'PDF header present (markdownToPdfBuffer pipeline)');
});

test('export: unknown format is rejected', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const headers = authHeaders(auth);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const response = await fetch(exportUrl(base, convo.id, 'docx'), { headers });
  assert.equal(response.status, 400);
});

test('export: format defaults to markdown', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const headers = authHeaders(auth);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const response = await fetch(`${base}/api/chat/conversations/${convo.id}/export`, { headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/markdown/);
});
