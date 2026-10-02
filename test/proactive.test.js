import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer, parseFollowUpMarkers, stripFollowUpMarkers, quietNudgeDue } from '../server.js';

async function fixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-proactive-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-5.4-mini', ...extraEnv } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function register(base, { email = 'owner@example.com', displayName = 'Owner' } = {}) {
  const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, displayName, password: 'correct horse battery staple' }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrf, body, userId: body.user.id };
}

const authHeaders = ({ cookie, csrf }) => ({ Cookie: cookie, 'X-Orbit-CSRF': csrf, 'Content-Type': 'application/json' });

test('parseFollowUpMarkers extracts dated follow-ups', () => {
  assert.deepEqual(
    parseFollowUpMarkers('Sounds good!\n[FOLLOWUP: dentist appointment on 2026-10-08]'),
    [{ description: 'dentist appointment', date: '2026-10-08' }]
  );
  assert.equal(parseFollowUpMarkers('[FOLLOWUP: interview on 2026-10-09] and [FOLLOWUP: trip on 2026-11-01]').length, 2);
  assert.deepEqual(parseFollowUpMarkers('no markers here'), []);
  assert.deepEqual(parseFollowUpMarkers('[FOLLOWUP: someday on next week]'), []);
  assert.deepEqual(parseFollowUpMarkers(null), []);
});

test('stripFollowUpMarkers removes markers but keeps the reply', () => {
  assert.equal(stripFollowUpMarkers('Great, good luck!\n[FOLLOWUP: interview on 2026-10-09]'), 'Great, good luck!');
});

test('quietNudgeDue respects idle and cooldown windows', () => {
  const hour = 3600_000; const now = Date.now(); const ago = (ms) => new Date(now - ms).toISOString();
  assert.equal(quietNudgeDue(null, null, now), false);
  assert.equal(quietNudgeDue(ago(1 * hour), null, now), false);
  assert.equal(quietNudgeDue(ago(48 * hour), null, now), false);
  assert.equal(quietNudgeDue(ago(49 * hour), null, now), true);
  assert.equal(quietNudgeDue(ago(49 * hour), ago(24 * hour), now), false);
  assert.equal(quietNudgeDue(ago(49 * hour), ago(8 * 24 * hour), now), true);
});

test('follow-up sweep checks in on due events only', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  app.db.addMemory(auth.userId, 'Follow up: dentist appointment on 2000-01-01');
  app.db.addMemory(auth.userId, 'Follow up: future trip on 2999-01-01');
  app.db.addMemory(auth.userId, 'Just a regular memory');
  await app.runProactiveChecks();
  const remaining = app.db.listMemories(auth.userId).map((m) => m.content);
  assert.ok(!remaining.some((c) => c.includes('dentist')), 'due follow-up memory is consumed');
  assert.ok(remaining.some((c) => c.includes('future trip')), 'future follow-up stays');
  assert.ok(remaining.some((c) => c.includes('Just a regular memory')), 'other memories untouched');
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const messages = app.db.listConversationMessages(auth.userId, convo.id, 10);
  assert.ok(messages.some((m) => m.role === 'assistant'), 'follow-up lands in the conversation');
  const events = app.db.listEvents(auth.userId, 10);
  assert.ok(events.some((e) => e.type === 'followup_sent'), 'followup_sent event logged');
});

test('quiet nudge fires after 48h idle, then cools down', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  // Never chatted: no nudge, even far in the future.
  await app.runProactiveChecks(Date.now() + 30 * 24 * 3600_000);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const assistants = () => app.db.listConversationMessages(auth.userId, convo.id, 20).filter((m) => m.role === 'assistant');
  assert.equal(assistants().length, 0);
  // One chat message, then 3 days pass: nudge fires once.
  const chat = await fetch(`${base}/api/chat`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ message: 'hello' }) });
  assert.equal(chat.status, 201);
  const future = Date.now() + 3 * 24 * 3600_000;
  await app.runProactiveChecks(future);
  const afterFirst = assistants().length;
  assert.ok(afterFirst >= 1, 'quiet nudge message saved');
  assert.ok(app.db.getLastQuietNudgeAt(auth.userId), 'nudge timestamp recorded');
  // Second run inside the cooldown window: no duplicate.
  await app.runProactiveChecks(future + 3600_000);
  assert.equal(assistants().length, afterFirst, 'no duplicate nudge in cooldown');
});
