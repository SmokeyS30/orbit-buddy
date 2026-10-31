// Proactive memory regression tests: trigger extraction, relevance gating,
// dedup, caps, quiet hours, and explainability.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROACTIVE_MEMORY,
  extractDateTriggers,
  isOpenLoop,
  findDateCandidates,
  findOpenLoopCandidates,
  chooseChatSurfacing,
  buildSurfacingHint,
  handleProactiveMemoryWhy,
  runProactiveMemoryPush,
  alreadyOnTopic,
  recentlyDiscussed,
} from '../src/proactive-memory.js';
import { openDatabase } from '../src/database.js';
import { createOrbitServer } from '../server.js';

// Fixed "now": Fri 2026-10-16 12:00 ET (EDT = UTC-4).
const NOW = Date.parse('2026-10-16T16:00:00Z');
const TZ = 'America/New_York';

function memory(content, overrides = {}) {
  return {
    id: overrides.id || `mem-${Math.random().toString(36).slice(2, 8)}`,
    content,
    status: 'approved',
    superseded_by: null,
    confidence: 1,
    relevance_score: 1,
    created_at: '2026-10-01T12:00:00.000Z',
    ...overrides,
  };
}

// --- Trigger extraction ---

test('extractDateTriggers finds annual birthday/anniversary dates', () => {
  const t = extractDateTriggers("Mom's birthday is October 23");
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, 'annual');
  assert.equal(t[0].month, 10);
  assert.equal(t[0].day, 23);
  assert.equal(t[0].keyword, 'birthday');

  const a = extractDateTriggers('Our anniversary is June 5th, big one');
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'annual');
  assert.equal(a[0].month, 6);
  assert.equal(a[0].day, 5);
});

test('extractDateTriggers finds one-time dated events', () => {
  const t = extractDateTriggers('Dentist appointment on 2026-10-23 at 9am');
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, 'once');
  assert.deepEqual([t[0].month, t[0].day, t[0].year], [10, 23, 2026]);

  const s = extractDateTriggers('Flight to Boston on 10/25, window seat');
  assert.equal(s.length, 1);
  assert.equal(s[0].kind, 'once');
  assert.equal(s[0].month, 10);
  assert.equal(s[0].day, 25);
});

test('extractDateTriggers ignores dateless text, relative dates, and non-dates', () => {
  assert.deepEqual(extractDateTriggers('remind me tomorrow about the dentist'), []);
  assert.deepEqual(extractDateTriggers('I run 3/4 mile every day'), []);
  assert.deepEqual(extractDateTriggers('May flowers are nice'), []);
  assert.deepEqual(extractDateTriggers('Birthday on February 30'), []);
  assert.deepEqual(extractDateTriggers('just a normal memory about pizza'), []);
});

test('extractDateTriggers dedupes repeated dates in one memory', () => {
  const t = extractDateTriggers("Mom's birthday is October 23, birthday dinner October 23");
  assert.equal(t.length, 1);
});

// --- Open loops ---

test('isOpenLoop detects unfinished business', () => {
  assert.ok(isOpenLoop('I want to try that new Thai place downtown'));
  assert.ok(isOpenLoop('Need to book the dentist appointment soon'));
  assert.ok(isOpenLoop('Planning to visit the art museum next month'));
  assert.ok(isOpenLoop('Remind me to call mom about the holidays'));
  assert.ok(!isOpenLoop('I like pizza'));
  assert.ok(!isOpenLoop('My mom lives in Ohio'));
  assert.ok(!isOpenLoop('short'));
});

// --- Date candidates: gating ---

test('findDateCandidates surfaces a birthday inside the window', () => {
  const c = findDateCandidates({
    memories: [memory("Mom's birthday is October 23")],
    nowMs: NOW, timeZone: TZ,
  });
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'date');
  assert.equal(c[0].daysUntil, 7);
  assert.equal(c[0].nextDate, '2026-10-23');
  assert.ok(c[0].occurrenceKey.includes('2026-10-23'));
  assert.match(c[0].reason, /birthday/);
});

test('findDateCandidates skips out-of-window, past, and stale dates', () => {
  // Birthday 8 days out: outside the 7-day window.
  assert.equal(findDateCandidates({ memories: [memory("Mom's birthday is October 24")], nowMs: NOW, timeZone: TZ }).length, 0);
  // Explicit past date.
  assert.equal(findDateCandidates({ memories: [memory('Dentist appointment on 2026-10-01')], nowMs: NOW, timeZone: TZ }).length, 0);
  // Year-less M/D far in the future: treated as stale, not a trigger.
  assert.equal(findDateCandidates({ memories: [memory('Dentist appointment on 3/4')], nowMs: NOW, timeZone: TZ }).length, 0);
  // Year-less M/D a few days out: triggers.
  const near = findDateCandidates({ memories: [memory('Dentist appointment on 10/20')], nowMs: NOW, timeZone: TZ });
  assert.equal(near.length, 1);
  assert.equal(near[0].daysUntil, 4);
});

test('findDateCandidates gates on confidence, relevance, status, and freshness', () => {
  const base = { nowMs: NOW, timeZone: TZ };
  const mk = (over) => [memory("Mom's birthday is October 23", over)];
  assert.equal(findDateCandidates({ memories: mk({ confidence: 0.5 }), ...base }).length, 0, 'low confidence skipped');
  assert.equal(findDateCandidates({ memories: mk({ relevance_score: 0.2 }), ...base }).length, 0, 'decayed relevance skipped');
  assert.equal(findDateCandidates({ memories: mk({ superseded_by: 'other' }), ...base }).length, 0, 'superseded skipped');
  assert.equal(findDateCandidates({ memories: mk({ created_at: '2026-10-16T09:00:00.000Z' }), ...base }).length, 0, 'saved-today skipped');
  assert.equal(findDateCandidates({ memories: mk({ confidence: 0.7 }), ...base }).length, 1, 'threshold confidence passes');
});

test('findDateCandidates dedupes surfaced occurrences and personal_dates', () => {
  const mems = [memory("Mom's birthday is October 23", { id: 'm1' })];
  const key = 'date:m1:2026-10-23';
  assert.equal(
    findDateCandidates({ memories: mems, surfacedKeys: new Set([key]), nowMs: NOW, timeZone: TZ }).length,
    0, 'already surfaced this occurrence'
  );
  assert.equal(
    findDateCandidates({ memories: mems, personalDates: [{ month: 10, day: 23 }], nowMs: NOW, timeZone: TZ }).length,
    0, 'briefing already covers this personal date'
  );
});

test('findDateCandidates sorts by soonest first', () => {
  const c = findDateCandidates({
    memories: [
      memory("Mom's birthday is October 23"),
      memory('Dentist appointment on 10/18'),
    ],
    nowMs: NOW, timeZone: TZ,
  });
  assert.equal(c.length, 2);
  assert.equal(c[0].daysUntil, 2);
  assert.equal(c[1].daysUntil, 7);
});

// --- Chat surfacing: one per turn, topical open loops ---

test('chooseChatSurfacing picks at most one, preferring due dates', () => {
  const all = [
    memory("Mom's birthday is October 23", { id: 'm1' }),
    memory('I want to try that new Thai place downtown', { id: 'm2' }),
  ];
  const picked = chooseChatSurfacing({
    allMemories: all,
    recalledMemories: [all[1], all[0]],
    userMessage: 'what should I do this weekend?',
    historyMessages: [],
    nowMs: NOW, timeZone: TZ,
  });
  assert.ok(picked, 'something chosen');
  assert.equal(picked.memory.id, 'm1', 'date trigger wins over open loop');
  assert.equal(picked.via, 'chat');
});

test('chooseChatSurfacing volunteers a topical open loop once, then cools down', () => {
  const loop = memory('I want to try that new Thai place downtown', { id: 'm2' });
  const args = {
    allMemories: [loop],
    recalledMemories: [loop],
    userMessage: 'any dinner ideas tonight?',
    historyMessages: [],
    nowMs: NOW, timeZone: TZ,
  };
  const first = chooseChatSurfacing({ ...args, surfacedRows: [] });
  assert.ok(first, 'open loop volunteered when topical');
  assert.equal(first.kind, 'open_loop');
  assert.equal(first.occurrenceKey, 'loop:m2');

  // Volunteered 1 day ago: inside the 14-day cooldown.
  const recent = [{ occurrence_key: 'loop:m2', surfaced_at: new Date(NOW - 86400_000).toISOString() }];
  assert.equal(chooseChatSurfacing({ ...args, surfacedRows: recent }), null, 'cooldown respected');

  // Volunteered 20 days ago: eligible again.
  const old = [{ occurrence_key: 'loop:m2', surfaced_at: new Date(NOW - 20 * 86400_000).toISOString() }];
  assert.ok(chooseChatSurfacing({ ...args, surfacedRows: old }), 'eligible after cooldown');
});

test('chooseChatSurfacing skips open loops that are not topically relevant', () => {
  const loop = memory('I want to try that new Thai place downtown', { id: 'm2' });
  const other = memory('I like pizza', { id: 'm3' });
  // Loop not in top-3 recalled: not timely.
  assert.equal(chooseChatSurfacing({
    allMemories: [loop, other],
    recalledMemories: [other],
    userMessage: 'help me debug this code',
    historyMessages: [],
    nowMs: NOW, timeZone: TZ,
  }), null, 'off-topic loop stays silent');
});

test('chooseChatSurfacing does not volunteer what is already being discussed', () => {
  const mems = [memory("Mom's birthday is October 23", { id: 'm1' })];
  // User is asking about it directly: the model answers from context; no volunteering needed.
  assert.equal(chooseChatSurfacing({
    allMemories: mems,
    recalledMemories: mems,
    userMessage: "when is my mom's birthday again?",
    historyMessages: [],
    nowMs: NOW, timeZone: TZ,
  }), null, 'already on topic');
  // Already covered in recent history.
  assert.equal(chooseChatSurfacing({
    allMemories: mems,
    recalledMemories: mems,
    userMessage: 'what else is new?',
    historyMessages: [{ role: 'assistant', content: "Heads up — Mom's birthday is October 23, just a week away!" }],
    nowMs: NOW, timeZone: TZ,
  }), null, 'recently discussed');
});

test('alreadyOnTopic and recentlyDiscussed behave', () => {
  assert.ok(alreadyOnTopic("when is my mom's birthday?", "Mom's birthday is October 23"), 'direct question about the topic');
  assert.ok(alreadyOnTopic('need to buy a birthday gift for mom', "Mom's birthday is October 23"), 'strong overlap, no volunteering needed');
  assert.ok(!alreadyOnTopic('what should I do this weekend?', "Mom's birthday is October 23"), 'unrelated message keeps the proactive win');
  assert.ok(!alreadyOnTopic('what is the weather?', "Mom's birthday is October 23"));
  assert.ok(recentlyDiscussed([{ content: 'x'.repeat(10) + "Mom's birthday is October 23" }], "Mom's birthday is October 23"));
  assert.ok(!recentlyDiscussed([{ content: 'something else entirely' }], "Mom's birthday is October 23"));
});

test('buildSurfacingHint names the memory, the reason, and the why-line', () => {
  const hint = buildSurfacingHint({ memory: memory("Mom's birthday is October 23"), reason: 'birthday is in 7 days (October 23)' });
  assert.match(hint, /Mom's birthday is October 23/);
  assert.match(hint, /birthday is in 7 days/);
  assert.match(hint, /one memory per reply/i);
  assert.match(hint, /saved 2026-10-01/);
});

// --- Background push ---

function stubDb(overrides = {}) {
  const calls = { delivered: [], events: [], surfaced: [] };
  return {
    calls,
    listMemories: () => overrides.memories || [],
    listPersonalDates: () => [],
    listMemorySurfacings: () => [],
    recordMemorySurfacing: (userId, row) => { calls.surfaced.push(row); return true; },
    addEvent: (userId, type, message) => { calls.events.push(type); },
    ...overrides.fns,
  };
}

test('runProactiveMemoryPush sends one gentle push and records it', async () => {
  const db = stubDb({ memories: [memory("Mom's birthday is October 23", { id: 'm1' })] });
  const model = { respond: async () => ({ text: 'Heads up — your mom’s birthday is next week! Want gift ideas?', toolCalls: [] }) };
  const user = { id: 'u1', display_name: 'Edward' };
  let claimed = false;
  const sent = await runProactiveMemoryPush({
    db, model, user, timeZone: TZ, nowMs: NOW, buddyName: 'Orbit',
    claimSlot: () => { claimed = true; return true; },
    releaseSlot: () => {},
    deliver: async (text, eventMessage) => { db.calls.delivered.push({ text, eventMessage }); },
  });
  assert.equal(sent, 1);
  assert.ok(claimed, 'shared proactive slot claimed');
  assert.equal(db.calls.delivered.length, 1);
  assert.match(db.calls.delivered[0].text, /mom’s birthday/);
  assert.equal(db.calls.surfaced.length, 1);
  assert.equal(db.calls.surfaced[0].occurrenceKey, 'date:m1:2026-10-23');
  assert.equal(db.calls.surfaced[0].via, 'proactive');
  assert.ok(db.calls.events.includes('memory_surfaced_proactive'));
});

test('runProactiveMemoryPush respects the shared cap and never throws', async () => {
  const db = stubDb({ memories: [memory("Mom's birthday is October 23", { id: 'm1' })] });
  let released = false;
  const sent = await runProactiveMemoryPush({
    db, model: { respond: async () => ({ text: 'hi', toolCalls: [] }) },
    user: { id: 'u1' }, timeZone: TZ, nowMs: NOW, buddyName: 'Orbit',
    claimSlot: () => false, // cap exhausted
    releaseSlot: () => { released = true; },
    deliver: async () => { db.calls.delivered.push(1); },
  });
  assert.equal(sent, 0, 'no slot, no push');
  assert.equal(db.calls.delivered.length, 0);
  assert.equal(db.calls.surfaced.length, 0);
  assert.ok(!released, 'nothing to release when nothing was claimed');

  // Model failure: slot released, nothing recorded, no throw.
  const db2 = stubDb({ memories: [memory("Mom's birthday is October 23", { id: 'm1' })] });
  let released2 = false;
  const sent2 = await runProactiveMemoryPush({
    db: db2, model: { respond: async () => { throw new Error('boom'); } },
    user: { id: 'u1' }, timeZone: TZ, nowMs: NOW, buddyName: 'Orbit',
    claimSlot: () => true,
    releaseSlot: () => { released2 = true; },
    deliver: async () => { db2.calls.delivered.push(1); },
  });
  assert.equal(sent2, 0);
  assert.ok(released2, 'slot released on failure');
  assert.equal(db2.calls.surfaced.length, 0);

  // No candidates: silent.
  const db3 = stubDb({ memories: [memory('I like pizza')] });
  assert.equal(await runProactiveMemoryPush({
    db: db3, model: { respond: async () => ({ text: 'hi', toolCalls: [] }) },
    user: { id: 'u1' }, timeZone: TZ, nowMs: NOW, buddyName: 'Orbit',
    claimSlot: () => true, releaseSlot: () => {},
    deliver: async () => { db3.calls.delivered.push(1); },
  }), 0);
});

// --- Explainability ---

test('handleProactiveMemoryWhy answers from the surfacing record', () => {
  const db = {
    getLastMemorySurfacing: () => ({
      memory_id: 'm1',
      content_snapshot: "Mom's birthday is October 23",
      memory_created_at: '2026-10-01T12:00:00.000Z',
      reason: 'birthday is in 7 days (October 23)',
      surfaced_at: new Date(Date.now() - 3600_000).toISOString(),
    }),
  };
  const answer = handleProactiveMemoryWhy({ db, userId: 'u1', message: 'why are you telling me this?' });
  assert.ok(answer);
  assert.match(answer, /Mom's birthday is October 23/);
  assert.match(answer, /2026-10-01/);
  assert.match(answer, /birthday is in 7 days/);
});

test('handleProactiveMemoryWhy stays silent without a recent surfacing', () => {
  const noneDb = { getLastMemorySurfacing: () => null };
  assert.equal(handleProactiveMemoryWhy({ db: noneDb, userId: 'u1', message: 'why did you mention that?' }), null);
  const oldDb = {
    getLastMemorySurfacing: () => ({ content_snapshot: 'x', surfaced_at: new Date(Date.now() - 30 * 86400_000).toISOString() }),
  };
  assert.equal(handleProactiveMemoryWhy({ db: oldDb, userId: 'u1', message: 'why are you telling me this?' }), null, 'stale surfacing');
  assert.equal(handleProactiveMemoryWhy({ db: noneDb, userId: 'u1', message: 'what time is it?' }), null, 'not a why-question');
  assert.equal(handleProactiveMemoryWhy({ db: noneDb, userId: 'u1', message: 'why is the sky blue?' }), null, 'unrelated why');
});

// --- SQLite persistence ---

test('SQLite: surfacing records dedupe on occurrence key and read back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-pmsql-'));
  const db = openDatabase(path.join(dir, 'test.sqlite'));
  try {
    const user = db.createUser({ email: 'pm@example.com', displayName: 'PM', passwordHash: 'h', passwordSalt: 's', role: 'owner' });
    assert.equal(db.getMemorySurfacing(user.id, 'k1'), null);
    assert.equal(db.getLastMemorySurfacing(user.id), null);
    const row = { memoryId: 'm1', occurrenceKey: 'date:m1:2026-10-23', kind: 'date', via: 'proactive', reason: 'birthday is in 7 days (October 23)', contentSnapshot: "Mom's birthday is October 23", memoryCreatedAt: '2026-10-01T12:00:00.000Z' };
    assert.equal(db.recordMemorySurfacing(user.id, row), true, 'first record stored');
    assert.equal(db.recordMemorySurfacing(user.id, row), false, 'duplicate occurrence ignored');
    const got = db.getMemorySurfacing(user.id, 'date:m1:2026-10-23');
    assert.ok(got);
    assert.equal(got.kind, 'date');
    assert.equal(got.via, 'proactive');
    assert.equal(got.content_snapshot, "Mom's birthday is October 23");
    assert.equal(db.listMemorySurfacings(user.id, 10).length, 1);
    assert.equal(db.getLastMemorySurfacing(user.id).occurrence_key, 'date:m1:2026-10-23');
    assert.equal(db.recordMemorySurfacing(user.id, { ...row, occurrenceKey: 'loop:m2', kind: 'open_loop', via: 'chat' }), true);
    assert.equal(db.listMemorySurfacings(user.id, 10).length, 2);
    assert.equal(db.recordMemorySurfacing(null, row), false, 'missing user rejected');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Server integration: background push, caps, quiet hours ---

async function fixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-pm-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', ...extraEnv } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function register(base) {
  const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `pm-${Date.now()}@example.com`, displayName: 'Owner', password: 'correct horse battery staple' }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  const cookie=response.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${base}/api/ai-sharing-consent`,{method:'POST',headers:{Cookie:cookie,'X-Orbit-CSRF':body.csrf,'Content-Type':'application/json'},body:'{"accepted":true}'})).status,200);
  return { userId: body.user.id };
}

test('background push fires once per occurrence through the shared pipeline', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const { userId } = await register(base);
  app.db.setPreferences(userId, { timeZone: 'America/New_York', quietStart: '00:00', quietEnd: '00:00' });
  // Birthday 5 days after the run: inside the window whenever the test runs.
  // The run is 2 days out so the memory (saved "today") is eligible.
  const runAt = Date.now() + 2 * 86400_000;
  const bday = new Date(runAt + 5 * 86400_000);
  const bdayLabel = `${bday.toLocaleString('en-US', { month: 'long', timeZone: 'America/New_York' })} ${bday.toLocaleString('en-US', { day: 'numeric', timeZone: 'America/New_York' })}`;
  const bdayKey = bday.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  app.db.addMemory(userId, `Mom's birthday is ${bdayLabel}`);
  await app.runProactiveChecks(runAt);
  const surfaced = app.db.listMemorySurfacings(userId, 10);
  assert.equal(surfaced.length, 1, 'one surfacing recorded');
  assert.equal(surfaced[0].via, 'proactive');
  assert.match(surfaced[0].reason, /birthday/);
  assert.equal(surfaced[0].occurrence_key, `date:${surfaced[0].memory_id}:${bdayKey}`);
  const events = app.db.listEvents(userId, 50).map((e) => e.type);
  assert.ok(events.includes('memory_proactive_sent'), 'pipeline event logged');
  assert.ok(events.includes('memory_surfaced_proactive'));
  const convo = app.db.ensureDefaultConversation(userId);
  const messages = app.db.listConversationMessages(userId, convo.id, 10);
  assert.ok(messages.some((m) => m.role === 'assistant' && !/^Welcome, /.test(m.content || '')), 'push lands in the conversation');

  // Second run the next day: no repeat (occurrence dedup + daily cap).
  await app.runProactiveChecks(runAt + 86400_000);
  assert.equal(app.db.listMemorySurfacings(userId, 10).length, 1, 'no duplicate surfacing');
});

function etParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  return { h: Number(parts.find((p) => p.type === 'hour').value), m: Number(parts.find((p) => p.type === 'minute').value) };
}

test('background push stays silent during quiet hours', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const { userId } = await register(base);
  const runAt = Date.now() + 2 * 86400_000;
  // Quiet window bracketing the run time, so the test is deterministic
  // regardless of when it executes.
  const { h, m } = etParts(runAt);
  const pad = (n) => String(n).padStart(2, '0');
  app.db.setPreferences(userId, {
    timeZone: 'America/New_York',
    quietStart: `${pad((h + 22) % 24)}:${pad(m)}`,
    quietEnd: `${pad((h + 2) % 24)}:${pad(m)}`,
  });
  const bday = new Date(runAt + 5 * 86400_000);
  const bdayLabel = `${bday.toLocaleString('en-US', { month: 'long', timeZone: 'America/New_York' })} ${bday.toLocaleString('en-US', { day: 'numeric', timeZone: 'America/New_York' })}`;
  app.db.addMemory(userId, `Mom's birthday is ${bdayLabel}`);
  await app.runProactiveChecks(runAt);
  assert.equal(app.db.listMemorySurfacings(userId, 10).length, 0, 'no surfacing in quiet hours');
  const events = app.db.listEvents(userId, 50).map((e) => e.type);
  assert.ok(!events.includes('memory_proactive_sent'), 'no push event in quiet hours');
});

test('background push shares the 3/day proactive cap', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const { userId } = await register(base);
  app.db.setPreferences(userId, { timeZone: 'America/New_York', quietStart: '00:00', quietEnd: '00:00' });
  const runAt = Date.now() + 2 * 86400_000;
  const bday = new Date(runAt + 5 * 86400_000);
  const bdayLabel = `${bday.toLocaleString('en-US', { month: 'long', timeZone: 'America/New_York' })} ${bday.toLocaleString('en-US', { day: 'numeric', timeZone: 'America/New_York' })}`;
  app.db.addMemory(userId, `Mom's birthday is ${bdayLabel}`);
  const today = new Date(runAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  // Exhaust the shared cap first.
  assert.ok(app.db.claimProactiveSlot(userId, today));
  assert.ok(app.db.claimProactiveSlot(userId, today));
  assert.ok(app.db.claimProactiveSlot(userId, today));
  assert.equal(app.db.claimProactiveSlot(userId, today), false, 'cap exhausted');
  await app.runProactiveChecks(runAt);
  assert.equal(app.db.listMemorySurfacings(userId, 10).length, 0, 'no push when the shared cap is exhausted');
});

// --- Polish (2026-10-16): emotion "why" reads naturally, no double-subject ---

test('handleProactiveMemoryWhy emotion branch reads like a person', () => {
  const db = {
    getLastMemorySurfacing: () => ({
      kind: 'emotion',
      content_snapshot: "You've seemed drained the last three evenings.",
      surfaced_at: new Date(Date.now() - 3600_000).toISOString(),
    }),
  };
  const answer = handleProactiveMemoryWhy({ db, userId: 'u1', message: 'why did you mention that?' });
  assert.ok(answer);
  assert.match(answer, /because you've seemed drained/i);
  assert.ok(!/noticed You/i.test(answer), 'no doubled "I\'ve noticed You\'ve"');
  assert.match(answer, /not something I feel/i);
});
