import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';

async function fixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-asyncchat-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', ...extraEnv } });
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

async function waitFor(fn, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test('POST /api/chat returns 202 instantly and the reply lands in the background', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ message: 'hello there' }) });
  assert.equal(response.status, 202);
  const sent = await response.json();
  assert.ok(sent.id, '202 carries the user message id');
  assert.ok(sent.conversationId, '202 carries the conversation id');
  const landed = await waitFor(() => {
    const convo = app.db.ensureDefaultConversation(auth.userId);
    return app.db.listConversationMessages(auth.userId, convo.id, 10).some((m) => m.role === 'assistant' && m.content.includes('hello there'));
  });
  assert.ok(landed, 'assistant reply arrived in the background');
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const roles = app.db.listConversationMessages(auth.userId, convo.id, 10).map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant']);
});

test('rapid sends are queued and answered in order', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const headers = authHeaders(auth);
  const first = await fetch(`${base}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ message: 'first question' }) });
  const second = await fetch(`${base}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ message: 'second question' }) });
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  const landed = await waitFor(() => {
    const convo = app.db.ensureDefaultConversation(auth.userId);
    return app.db.listConversationMessages(auth.userId, convo.id, 10).filter((m) => m.role === 'assistant').length === 2;
  });
  assert.ok(landed, 'both replies arrived');
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const messages = app.db.listConversationMessages(auth.userId, convo.id, 10);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.ok(messages[1].content.includes('first question'), 'first reply matches first message');
  assert.ok(messages[3].content.includes('second question'), 'second reply matches second message');
});

test('a failing model call saves a graceful reply instead of a 500', async (t) => {
  const { app, base } = await fixture({ OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'http://127.0.0.1:1/v1', ALLOW_INSECURE_MODEL_URL: 'true' });
  t.after(() => app.close());
  const auth = await register(base);
  const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ message: 'will this break?' }) });
  assert.equal(response.status, 202, 'send itself still accepted');
  const landed = await waitFor(() => {
    const convo = app.db.ensureDefaultConversation(auth.userId);
    return app.db.listConversationMessages(auth.userId, convo.id, 10).some((m) => m.role === 'assistant');
  });
  assert.ok(landed, 'a reply was saved even though the model failed');
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const reply = app.db.listConversationMessages(auth.userId, convo.id, 10).find((m) => m.role === 'assistant');
  assert.ok(reply.content.includes('connection needs attention'), 'targeted connection guidance saved');
  const events = app.db.listEvents(auth.userId, 10);
  assert.ok(events.some((e) => e.type === 'chat_failed'), 'chat_failed event logged');
  const status = await (await fetch(`${base}/api/status`, { headers: { Cookie: auth.cookie } })).json();
  assert.equal(status.modelStatus.state, 'network');
  assert.equal(status.modelStatus.activeModel, null);
});
