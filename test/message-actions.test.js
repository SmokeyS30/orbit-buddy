// W1: per-message actions (regenerate / copy / delete).
// Regenerate: 202, old assistant message replaced, new turn lands through the
// normal pipeline (demo model in test), history capped at the target turn, and
// the shared 'chat' rate limiter is engaged. Delete: removes the whole turn,
// 404 on unknown id, 403 on another user's message.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createOrbitServer } from '../server.js';

async function fixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-msgactions-'));
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

async function waitFor(fn, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function seedTurn(app, userId, convoId, userText, assistantText) {
  const userMsg = app.db.addMessage(userId, convoId, 'user', userText);
  const assistantMsg = app.db.addMessage(userId, convoId, 'assistant', assistantText);
  return { userMsg, assistantMsg };
}

// Space messages seconds apart so ordering assertions are deterministic
// (rapid inserts could otherwise share a millisecond timestamp).
function spaceOut(app, userId, messages, stepMs = 10000) {
  const base = Date.now() - messages.length * stepMs;
  messages.forEach((m, i) => app.db.retimeMessage(userId, m.id, new Date(base + i * stepMs).toISOString()));
}

test('regenerate replaces the assistant turn and resubmits through the normal pipeline', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const headers = authHeaders(auth);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const { userMsg, assistantMsg } = seedTurn(app, auth.userId, convo.id, 'REGEN-UNIQUE-PROMPT-1', 'ORIGINAL-ANSWER-1');

  const response = await fetch(`${base}/api/chat/messages/${assistantMsg.id}/regenerate`, { method: 'POST', headers });
  assert.equal(response.status, 202);
  const sent = await response.json();
  assert.equal(sent.status, 'working');
  assert.equal(sent.regenerated, true);
  assert.equal(sent.id, userMsg.id, 'client gets the user message id to track the stream');
  assert.equal(sent.conversationId, convo.id);
  // The old assistant message is replaced immediately (the turn is re-run).
  assert.equal(app.db.getMessage(auth.userId, assistantMsg.id), undefined);
  assert.ok(app.db.getMessage(auth.userId, userMsg.id), 'the user message stays');

  const landed = await waitFor(() => {
    const msgs = app.db.listConversationMessages(auth.userId, convo.id, 10);
    const idx = msgs.findIndex((m) => m.id === userMsg.id);
    return idx !== -1 && msgs.slice(idx + 1).some((m) => m.role === 'assistant' && m.content.includes('REGEN-UNIQUE-PROMPT-1'));
  });
  assert.ok(landed, 'new assistant turn landed, resubmitted from the original user message');
  const msgs = app.db.listConversationMessages(auth.userId, convo.id, 10);
  const fresh = msgs.find((m) => m.role === 'assistant' && m.id !== assistantMsg.id);
  assert.ok(!fresh.content.includes('ORIGINAL-ANSWER-1'), 'the old answer is gone, not echoed back');
});

test('regenerate resubmits only up to the target turn', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const headers = authHeaders(auth);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const first = seedTurn(app, auth.userId, convo.id, 'EARLY-TURN-PROMPT', 'early answer');
  const second = seedTurn(app, auth.userId, convo.id, 'LATER-TURN-PROMPT', 'later answer');
  spaceOut(app, auth.userId, [first.userMsg, first.assistantMsg, second.userMsg, second.assistantMsg]);

  const response = await fetch(`${base}/api/chat/messages/${first.assistantMsg.id}/regenerate`, { method: 'POST', headers });
  assert.equal(response.status, 202);
  const landed = await waitFor(() => {
    const msgs = app.db.listConversationMessages(auth.userId, convo.id, 10);
    const idx = msgs.findIndex((m) => m.id === first.userMsg.id);
    return idx !== -1 && msgs.slice(idx + 1).some((m) => m.role === 'assistant' && m.content.includes('EARLY-TURN-PROMPT'));
  });
  assert.ok(landed, 'new answer anchored at the target turn');
  const roles = app.db.listConversationMessages(auth.userId, convo.id, 10).map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant'], 'later turns are untouched, in order');
  const ids = app.db.listConversationMessages(auth.userId, convo.id, 10).map((m) => m.id);
  assert.deepEqual(ids, [first.userMsg.id, ids[1], second.userMsg.id, second.assistantMsg.id], 'regenerated answer replaced the old one in place');
  assert.notEqual(ids[1], first.assistantMsg.id, 'it is a new message, not the old one');
  assert.ok(app.db.getMessage(auth.userId, second.userMsg.id), 'later user message kept');
  assert.ok(app.db.getMessage(auth.userId, second.assistantMsg.id), 'later assistant message kept');
});

test('regenerate validation: auth, unknown id, wrong role, no user message', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const headers = authHeaders(auth);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const { userMsg, assistantMsg } = seedTurn(app, auth.userId, convo.id, 'hello', 'hi there');

  // Unauthenticated.
  const anon = await fetch(`${base}/api/chat/messages/${assistantMsg.id}/regenerate`, { method: 'POST' });
  assert.equal(anon.status, 401);
  // Unknown id.
  const missing = await fetch(`${base}/api/chat/messages/${randomUUID()}/regenerate`, { method: 'POST', headers });
  assert.equal(missing.status, 404);
  // User messages cannot be regenerated.
  const wrongRole = await fetch(`${base}/api/chat/messages/${userMsg.id}/regenerate`, { method: 'POST', headers });
  assert.equal(wrongRole.status, 400);
  // An assistant message with no preceding user message (e.g. proactive note).
  const orphan = app.db.addMessage(auth.userId, convo.id, 'assistant', 'a proactive note');
  const orphaned = await fetch(`${base}/api/chat/messages/${orphan.id}/regenerate`, { method: 'POST', headers });
  assert.equal(orphaned.status, 400);
});

test('regenerate shares the normal chat rate limit (no bypass)', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const headers = authHeaders(auth);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const { assistantMsg } = seedTurn(app, auth.userId, convo.id, 'rate-limit seed', 'seed answer');
  // Burn the shared 'chat' scope: 30 sends are allowed, the 31st is limited.
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${base}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ message: `filler ${i}` }) });
    assert.equal(r.status, 202);
  }
  const limited = await fetch(`${base}/api/chat/messages/${assistantMsg.id}/regenerate`, { method: 'POST', headers });
  assert.equal(limited.status, 429, 'regenerate consumes the same per-user chat limit');
});

test('delete removes the whole turn (assistant reply + the user message it answered)', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const headers = authHeaders(auth);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const { userMsg, assistantMsg } = seedTurn(app, auth.userId, convo.id, 'turn to delete', 'answer to delete');

  const response = await fetch(`${base}/api/chat/messages/${assistantMsg.id}`, { method: 'DELETE', headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(new Set(body.deleted), new Set([assistantMsg.id, userMsg.id]));
  assert.equal(app.db.getMessage(auth.userId, assistantMsg.id), undefined);
  assert.equal(app.db.getMessage(auth.userId, userMsg.id), undefined);
  assert.deepEqual(app.db.listConversationMessages(auth.userId, convo.id, 10), []);
});

test('delete on a user message removes it plus the following assistant reply only', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const headers = authHeaders(auth);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const first = seedTurn(app, auth.userId, convo.id, 'keep me', 'keep my answer');
  const dangling = app.db.addMessage(auth.userId, convo.id, 'user', 'dangling user message');

  const response = await fetch(`${base}/api/chat/messages/${first.userMsg.id}`, { method: 'DELETE', headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(new Set(body.deleted), new Set([first.userMsg.id, first.assistantMsg.id]));
  const remaining = app.db.listConversationMessages(auth.userId, convo.id, 10);
  assert.deepEqual(remaining.map((m) => m.id), [dangling.id]);
});

test('delete: 404 on unknown id, 403 on another user\'s message', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const headers = authHeaders(auth);
  const missing = await fetch(`${base}/api/chat/messages/${randomUUID()}`, { method: 'DELETE', headers });
  assert.equal(missing.status, 404);

  const other = app.db.createUser({ email: 'other@example.com', displayName: 'Other', passwordHash: 'x', passwordSalt: 'y', role: 'member' });
  const otherConvo = app.db.ensureDefaultConversation(other.id);
  const otherMsg = app.db.addMessage(other.id, otherConvo.id, 'user', 'not yours');
  const forbidden = await fetch(`${base}/api/chat/messages/${otherMsg.id}`, { method: 'DELETE', headers });
  assert.equal(forbidden.status, 403);
  assert.ok(app.db.getMessage(other.id, otherMsg.id), 'other user\'s message untouched');
});
