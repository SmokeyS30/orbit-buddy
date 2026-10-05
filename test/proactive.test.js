import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer, parseFollowUpMarkers, stripFollowUpMarkers, quietNudgeDue } from '../server.js';

async function fixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-proactive-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', ...extraEnv } });
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
  app.db.setPreferences(auth.userId, { quietStart: '00:00', quietEnd: '00:00' });
  app.db.addFollowUp(auth.userId, { description: 'dentist appointment', dueDate: '2000-01-01' });
  app.db.addFollowUp(auth.userId, { description: 'future trip', dueDate: '2999-01-01' });
  app.db.addMemory(auth.userId, 'Just a regular memory');
  await app.runProactiveChecks();
  const remaining = app.db.listFollowUps(auth.userId).map((item) => item.description);
  assert.ok(!remaining.includes('dentist appointment'), 'due follow-up is completed');
  assert.ok(remaining.includes('future trip'), 'future follow-up stays');
  assert.ok(app.db.listMemories(auth.userId).some((item) => item.content.includes('regular memory')), 'memories are untouched');
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const messages = app.db.listConversationMessages(auth.userId, convo.id, 10);
  assert.ok(messages.some((m) => m.role === 'assistant'), 'follow-up lands in the conversation');
  const events = app.db.listEvents(auth.userId, 10);
  assert.ok(events.some((e) => e.type === 'followup_sent'), 'followup_sent event logged');
});

test('quiet nudge fires after 48h idle, then cools down', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  app.db.setPreferences(auth.userId, { quietStart: '00:00', quietEnd: '00:00' });
  // Never chatted: no nudge, even far in the future.
  await app.runProactiveChecks(Date.now() + 30 * 24 * 3600_000);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const assistants = () => app.db.listConversationMessages(auth.userId, convo.id, 20).filter((m) => m.role === 'assistant');
  assert.equal(assistants().length, 0);
  // One chat message, then 3 days pass: nudge fires once.
  const chat = await fetch(`${base}/api/chat`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ message: 'hello' }) });
  assert.equal(chat.status, 202);
  // The reply now lands in the background; wait for it before the nudge checks.
  const landed = Date.now();
  while (Date.now() - landed < 8000) {
    const c = app.db.ensureDefaultConversation(auth.userId);
    if (app.db.listConversationMessages(auth.userId, c.id, 20).some((m) => m.role === 'assistant')) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const future = Date.now() + 3 * 24 * 3600_000;
  await app.runProactiveChecks(future);
  const afterFirst = assistants().length;
  assert.ok(afterFirst >= 1, 'quiet nudge message saved');
  assert.ok(app.db.getLastQuietNudgeAt(auth.userId), 'nudge timestamp recorded');
  // Second run inside the cooldown window: no duplicate.
  await app.runProactiveChecks(future + 3600_000);
  assert.equal(assistants().length, afterFirst, 'no duplicate nudge in cooldown');
});

test('a due routine creates one proactive briefing and does not repeat that day', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  app.db.setPreferences(auth.userId, { timeZone: 'UTC', quietStart: '00:00', quietEnd: '00:00' });
  const routine = app.db.addRoutine(auth.userId, { title: 'Morning focus', prompt: 'Prepare my focus', kind: 'briefing', cadence: 'daily', timeLocal: '00:00' });
  const now = Date.parse('2026-10-03T12:00:00Z');
  await app.runProactiveChecks(now);
  const first = app.db.getRoutine(auth.userId, routine.id);
  assert.equal(first.last_run_date, '2026-10-03');
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const count = app.db.listConversationMessages(auth.userId, convo.id, 20).filter((m) => m.role === 'assistant').length;
  await app.runProactiveChecks(now + 3600_000);
  assert.equal(app.db.listConversationMessages(auth.userId, convo.id, 20).filter((m) => m.role === 'assistant').length, count);
  assert.ok(app.db.listEvents(auth.userId, 20).some((event) => event.type === 'routine_sent'));
});

test('follow-ups are priority ordered and capped at three proactive messages per day', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  app.db.setPreferences(auth.userId, { timeZone: 'UTC', quietStart: '00:00', quietEnd: '00:00' });
  for (const [description, priority] of [['low priority', 1], ['high one', 3], ['high two', 3], ['normal', 2]]) {
    app.db.addFollowUp(auth.userId, { description, dueDate: '2026-10-03', priority });
  }
  await app.runProactiveChecks(Date.parse('2026-10-03T12:00:00Z'));
  const remaining = app.db.listFollowUps(auth.userId);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].description, 'low priority');
  assert.equal(app.db.listEvents(auth.userId, 20).filter((event) => event.type === 'followup_sent').length, 3);
});

test('weekly review runs once per Sunday with real activity', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  app.db.setPreferences(auth.userId, { quietStart: '00:00', quietEnd: '00:00' });
  const task = app.db.addTask(auth.userId, { title: 'Finish report', prompt: 'Write it' });
  app.db.completeTask(auth.userId, task.id, 'done');
  app.db.addMemory(auth.userId, 'Learned something new this week');
  const sunday = Date.parse('2026-10-04T15:00:00Z'); // Sunday, 11:00 AM EDT
  await app.runProactiveChecks(sunday);
  const events = app.db.listEvents(auth.userId, 20);
  assert.ok(events.some((e) => e.type === 'weekly_review_sent'), 'weekly review delivered');
  assert.equal(app.db.getSetting(`weekly_review_last_${auth.userId}`), '2026-W40');
  const count = events.filter((e) => e.type === 'weekly_review_sent').length;
  await app.runProactiveChecks(sunday + 3600_000);
  const again = app.db.listEvents(auth.userId, 20);
  assert.equal(again.filter((e) => e.type === 'weekly_review_sent').length, count, 'no duplicate review in the same week');
});

test('weekly review skips on non-Sundays and quiet weeks', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  app.db.setPreferences(auth.userId, { quietStart: '00:00', quietEnd: '00:00' });
  const monday = Date.parse('2026-10-05T15:00:00Z'); // Monday
  await app.runProactiveChecks(monday);
  assert.ok(!app.db.listEvents(auth.userId, 20).some((e) => e.type === 'weekly_review_sent'), 'no review on Monday');
  const sunday = Date.parse('2026-10-11T15:00:00Z'); // Sunday, but no activity at all
  await app.runProactiveChecks(sunday);
  assert.ok(!app.db.listEvents(auth.userId, 20).some((e) => e.type === 'weekly_review_sent'), 'no review for an empty week');
});
