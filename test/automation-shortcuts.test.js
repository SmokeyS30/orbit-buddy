import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';

async function fixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-shortcuts-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-5.4-mini', ...extraEnv } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function register(base) {
  const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple' }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrf, userId: body.user.id };
}

const authHeaders = ({ cookie, csrf }) => ({ Cookie: cookie, 'X-Orbit-CSRF': csrf, 'Content-Type': 'application/json' });

async function createToken(base, auth, label, scopes) {
  const response = await fetch(`${base}/api/automation-tokens`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ label, scopes }) });
  assert.equal(response.status, 201);
  return response.json();
}

test('token creation accepts scopes and rejects empty or unknown scopes', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const created = await createToken(base, auth, 'Shortcuts', ['chat:ask', 'memories:create']);
  assert.ok(created.token.startsWith('orbit_'));
  assert.equal(created.scopes, 'chat:ask memories:create');
  const empty = await fetch(`${base}/api/automation-tokens`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ label: 'x', scopes: [] }) });
  assert.equal(empty.status, 400);
  const bogus = await fetch(`${base}/api/automation-tokens`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ label: 'x', scopes: ['admin:everything'] }) });
  assert.equal(bogus.status, 400);
});

test('POST /api/automation/ask answers asynchronously with the chat:ask scope and saves the exchange', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const { token } = await createToken(base, auth, 'Shortcuts', ['chat:ask']);
  const bearer = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const response = await fetch(`${base}/api/automation/ask`, { method: 'POST', headers: bearer, body: JSON.stringify({ message: 'What is on my calendar today?' }) });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  assert.ok(id, 'returns a request id');
  let answer = null;
  for (let i = 0; i < 50 && answer === null; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const poll = await fetch(`${base}/api/automation/ask/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(poll.status, 200);
    const state = await poll.json();
    if (state.state === 'done') answer = state.answer;
    else assert.equal(state.state, 'working');
  }
  assert.equal(typeof answer, 'string');
  assert.ok(answer.length > 0);
  assert.ok(!answer.includes('SUGGEST_MEMORY'), 'markers stripped from the answer');
  const conversation = app.db.ensureDefaultConversation(auth.userId);
  const messages = app.db.listConversationMessages(auth.userId, conversation.id, 10);
  const roles = messages.map((m) => m.role);
  assert.ok(roles.includes('user') && roles.includes('assistant'), 'exchange persisted to the default conversation');
  assert.equal((await fetch(`${base}/api/automation/ask/no-such-id`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
});

test('GET /api/automation/ask/:id/answer returns plain text only when done', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const { token } = await createToken(base, auth, 'Shortcuts', ['chat:ask']);
  const bearer = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const response = await fetch(`${base}/api/automation/ask`, { method: 'POST', headers: bearer, body: JSON.stringify({ message: 'hi' }) });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  let answer = null;
  for (let i = 0; i < 50 && answer === null; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const poll = await fetch(`${base}/api/automation/ask/${id}/answer`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(poll.status, 200);
    assert.ok(poll.headers.get('content-type').includes('text/plain'));
    const body = await poll.text();
    if (body) answer = body;
  }
  assert.ok(answer && answer.length > 0, 'answer arrives as plain text');
  assert.equal((await fetch(`${base}/api/automation/ask/no-such-id/answer`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
});

test('POST /api/automation/ask rejects missing auth and insufficient scope', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  assert.equal((await fetch(`${base}/api/automation/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'hi' }) })).status, 401);
  const { token } = await createToken(base, auth, 'Tasks only', ['tasks:create']);
  const scoped = await fetch(`${base}/api/automation/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ message: 'hi' }) });
  assert.equal(scoped.status, 403);
});

test('POST /api/automation/memories saves with memories:create and rejects without it', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const { token } = await createToken(base, auth, 'Shortcuts', ['memories:create']);
  const bearer = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const response = await fetch(`${base}/api/automation/memories`, { method: 'POST', headers: bearer, body: JSON.stringify({ content: 'Edward prefers oat milk lattes.' }) });
  assert.equal(response.status, 201);
  const memories = app.db.listMemories(auth.userId);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].content, 'Edward prefers oat milk lattes.');
  const { token: taskToken } = await createToken(base, auth, 'Tasks only', ['tasks:create']);
  const denied = await fetch(`${base}/api/automation/memories`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${taskToken}` }, body: JSON.stringify({ content: 'nope' }) });
  assert.equal(denied.status, 403);
});
