// Memory connections + emotional-intelligence layer regression tests:
// pattern detection thresholds, new-vs-established phrasing, emotional tone
// detection, honesty constraints, dedup/cooldowns, caps, soul grounding.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.js';
import { createOrbitServer } from '../server.js';
import {
  MEMORY_CONNECTIONS,
  detectEmotionalTone,
  toneLabel,
  EMOTION_SHIFTS,
  trackEmotionalTone,
  loadEmotionalTrack,
  summarizeEmotionalPattern,
  detectMemoryPatterns,
  patternMaturityPhrase,
  choosePatternSurfacing,
  chooseChatSurfacingWithPatterns,
  buildEmotionalContext,
  buildPatternHint,
  buildUnifiedHint,
  handleEmotionHonesty,
  recordConnectionSurfacing,
  runMemoryConnectionPush,
} from '../src/memory-connections.js';
import { applyAdaptation } from '../src/soul.js';

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

function dbFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mc-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  const user = db.createUser({ email: 'owner@example.com', displayName: 'Owner', passwordHash: 'hash', passwordSalt: 'salt', role: 'owner' });
  return { db, user, directory };
}

// --- Emotional tone detection ---

test('tone: detects each emotional tone', () => {
  assert.equal(detectEmotionalTone("I'm so stressed about this deadline"), 'stressed');
  assert.equal(detectEmotionalTone('this is so frustrating, nothing works'), 'frustrated');
  assert.equal(detectEmotionalTone("I'm so excited for the trip!"), 'excited');
  assert.equal(detectEmotionalTone('feeling really sad today'), 'sad');
  assert.equal(detectEmotionalTone("I'm completely wiped after class"), 'burnt_out');
  assert.equal(detectEmotionalTone("I've been anxious all week"), 'anxious');
  assert.equal(detectEmotionalTone('I passed my exam!'), 'celebratory');
});

test('tone: neutral on ordinary messages; bare "tired" is not burnt out', () => {
  assert.equal(detectEmotionalTone('what is the weather like tomorrow'), 'neutral');
  assert.equal(detectEmotionalTone('quick question'), 'neutral');
  assert.equal(detectEmotionalTone('ok'), 'neutral');
  assert.equal(detectEmotionalTone("I'm tired"), 'neutral');
  assert.equal(detectEmotionalTone('why are you being so direct right now?'), 'neutral');
});

test('tone: celebration is checked before exhaustion (priority pinned)', () => {
  assert.equal(detectEmotionalTone("I passed but I'm exhausted"), 'celebratory');
});

test('tone labels are human words', () => {
  assert.equal(toneLabel('burnt_out'), 'drained');
  assert.equal(toneLabel('sad'), 'down');
  assert.equal(toneLabel('anxious'), 'on edge');
});

// --- Tone tracking ---

test('track: roundtrip, neutral skipped, per-user isolated', () => {
  const { db, user } = dbFixture();
  const other = db.createUser({ email: 'b@example.com', displayName: 'B', passwordHash: 'h', passwordSalt: 's', role: 'owner' });
  trackEmotionalTone(db, user.id, 'stressed', NOW);
  trackEmotionalTone(db, user.id, 'neutral', NOW);
  trackEmotionalTone(db, user.id, 'sad', NOW);
  const track = loadEmotionalTrack(db, user.id);
  assert.equal(track.length, 2, 'neutral is not tracked');
  assert.equal(track[0].tone, 'stressed');
  assert.equal(track[1].tone, 'sad');
  assert.equal(loadEmotionalTrack(db, other.id).length, 0, 'per-user isolated');
});

test('track: capped at the configured maximum', () => {
  const { db, user } = dbFixture();
  for (let i = 0; i < MEMORY_CONNECTIONS.trackCap + 5; i++) trackEmotionalTone(db, user.id, 'stressed', NOW + i);
  assert.equal(loadEmotionalTrack(db, user.id).length, MEMORY_CONNECTIONS.trackCap);
});

// --- Emotional patterns over time ---

// Evenings in ET: 21:00-22:00 EDT on three consecutive days.
const EVENING_TRACK = [
  { tone: 'burnt_out', at: Date.parse('2026-10-16T01:00:00Z') }, // Thu 21:00 ET
  { tone: 'stressed', at: Date.parse('2026-10-15T01:30:00Z') },  // Wed 21:30 ET
  { tone: 'burnt_out', at: Date.parse('2026-10-14T02:00:00Z') }, // Tue 22:00 ET
];

test('emotional pattern: three evenings drained → established', () => {
  const p = summarizeEmotionalPattern({ track: EVENING_TRACK, nowMs: NOW, timeZone: TZ });
  assert.ok(p, 'pattern found');
  assert.equal(p.maturity, 'established');
  assert.equal(p.days, 3);
  assert.equal(p.phrase, "You've seemed drained the last three evenings.");
});

test('emotional pattern: two days → emerging, tentative phrasing', () => {
  const p = summarizeEmotionalPattern({ track: EVENING_TRACK.slice(0, 2), nowMs: NOW, timeZone: TZ });
  assert.ok(p, 'pattern found');
  assert.equal(p.maturity, 'emerging');
  assert.match(p.phrase, /starting to notice/);
  assert.match(p.phrase, /couple of/);
});

test('emotional pattern: never a single day', () => {
  assert.equal(summarizeEmotionalPattern({ track: EVENING_TRACK.slice(0, 1), nowMs: NOW, timeZone: TZ }), null);
  assert.equal(summarizeEmotionalPattern({ track: [], nowMs: NOW, timeZone: TZ }), null);
});

test('emotional pattern: broken runs and mixed families are not patterns', () => {
  // Gap day breaks the run.
  const gapped = [
    { tone: 'burnt_out', at: Date.parse('2026-10-16T01:00:00Z') },
    { tone: 'burnt_out', at: Date.parse('2026-10-13T01:00:00Z') },
  ];
  assert.equal(summarizeEmotionalPattern({ track: gapped, nowMs: NOW, timeZone: TZ }), null);
  // Different families on consecutive days.
  const mixed = [
    { tone: 'burnt_out', at: Date.parse('2026-10-16T01:00:00Z') },
    { tone: 'sad', at: Date.parse('2026-10-15T01:00:00Z') },
  ];
  assert.equal(summarizeEmotionalPattern({ track: mixed, nowMs: NOW, timeZone: TZ }), null);
});

test('emotional pattern: daytime wording vs evening wording', () => {
  const days = [
    { tone: 'sad', at: Date.parse('2026-10-15T18:00:00Z') }, // 14:00 ET
    { tone: 'sad', at: Date.parse('2026-10-14T18:00:00Z') },
  ];
  const p = summarizeEmotionalPattern({ track: days, nowMs: NOW, timeZone: TZ });
  assert.ok(p);
  assert.match(p.phrase, /days/);
  assert.ok(!/evenings/.test(p.phrase));
});

// --- Memory pattern detection ---

const DRAIN_MEMORIES = [
  memory('wiped after my chemistry class on Thursday, completely drained'),
  memory('so tired after Thursday\u2019s class again, can barely think straight'),
  memory('another Thursday class left me exhausted and completely wiped out'),
];
const ASPIRATION_MEMORIES = [
  memory('I want to learn Spanish this year, starting with basics'),
  memory('really want to learn Spanish, maybe a tutor for the fall'),
];
const AVOIDANCE_MEMORIES = [
  memory('I keep saying I\u2019ll study for the Security+ exam but haven\u2019t opened the book yet'),
  memory('keep saying I\u2019ll finally study tonight, the exam is next month'),
];

test('patterns: three linked memories → established drain pattern', () => {
  const patterns = detectMemoryPatterns({ memories: DRAIN_MEMORIES, nowMs: NOW });
  assert.equal(patterns.length, 1);
  const p = patterns[0];
  assert.equal(p.kind, 'drain');
  assert.equal(p.maturity, 'established');
  assert.equal(p.occurrences.length, 3);
  assert.ok(p.id.startsWith('pattern:drain:'), 'stable id');
  assert.ok(p.theme.includes('class') && p.theme.includes('thursday'));
});

test('patterns: two linked memories → emerging, never a single data point', () => {
  const two = detectMemoryPatterns({ memories: ASPIRATION_MEMORIES, nowMs: NOW });
  assert.equal(two.length, 1);
  assert.equal(two[0].maturity, 'emerging');
  assert.equal(two[0].kind, 'aspiration');
  const one = detectMemoryPatterns({ memories: [ASPIRATION_MEMORIES[0]], nowMs: NOW });
  assert.equal(one.length, 0, 'a single memory is never a pattern');
  assert.equal(detectMemoryPatterns({ memories: [], nowMs: NOW }).length, 0);
});

test('patterns: avoidance classification', () => {
  const patterns = detectMemoryPatterns({ memories: AVOIDANCE_MEMORIES, nowMs: NOW });
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].kind, 'avoidance');
});

test('patterns: excludes superseded, low-confidence, and unrelated memories', () => {
  const memories = [
    ...DRAIN_MEMORIES,
    memory('wiped after Thursday class again, totally spent', { superseded_by: 'other' }),
    memory('Thursday class drained me once more', { confidence: 0.2 }),
    memory('my favorite pizza topping is pepperoni'),
  ];
  const patterns = detectMemoryPatterns({ memories, nowMs: NOW });
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].occurrences.length, 3, 'excluded memories do not count');
});

test('patterns: ids are stable across runs', () => {
  const a = detectMemoryPatterns({ memories: DRAIN_MEMORIES, nowMs: NOW })[0].id;
  const b = detectMemoryPatterns({ memories: [...DRAIN_MEMORIES].reverse(), nowMs: NOW })[0].id;
  assert.equal(a, b);
});

test('maturity phrasing: emerging vs established', () => {
  assert.match(patternMaturityPhrase('emerging'), /starting to notice/);
  assert.match(patternMaturityPhrase('established'), /keeps coming up/);
});

// --- Choosing + dedup ---

test('choosePatternSurfacing: skips recently surfaced patterns (cooldown)', () => {
  const patterns = detectMemoryPatterns({ memories: DRAIN_MEMORIES, nowMs: NOW });
  const surfacedRows = [{ occurrence_key: patterns[0].id, surfaced_at: new Date(NOW - 86400_000).toISOString(), kind: 'pattern' }];
  const got = choosePatternSurfacing({ allMemories: DRAIN_MEMORIES, surfacedRows, nowMs: NOW, timeZone: TZ });
  assert.equal(got, null, 'inside the 21-day cooldown: no repeat');
});

test('choosePatternSurfacing: established outranks emerging', () => {
  const memories = [...DRAIN_MEMORIES, ...ASPIRATION_MEMORIES];
  const got = choosePatternSurfacing({ allMemories: memories, nowMs: NOW, timeZone: TZ });
  assert.ok(got);
  assert.equal(got.kind, 'pattern');
  assert.equal(got.pattern.maturity, 'established');
});

test('choosePatternSurfacing: emotional pattern surfaces when no memory pattern', () => {
  const got = choosePatternSurfacing({
    allMemories: [memory('my favorite pizza topping is pepperoni')],
    toneTrack: EVENING_TRACK, nowMs: NOW, timeZone: TZ,
  });
  assert.ok(got);
  assert.equal(got.kind, 'emotion');
  assert.equal(got.occurrenceKey, 'emotion:drained');
  assert.match(got.reason, /three evenings/);
});

test('choosePatternSurfacing: emotional cooldown dedups', () => {
  const surfacedRows = [{ occurrence_key: 'emotion:drained', surfaced_at: new Date(NOW - 86400_000).toISOString(), kind: 'emotion' }];
  const got = choosePatternSurfacing({
    allMemories: [memory('my favorite pizza topping is pepperoni')],
    surfacedRows, toneTrack: EVENING_TRACK, nowMs: NOW, timeZone: TZ,
  });
  assert.equal(got, null, 'inside the 7-day emotional cooldown: no repeat');
});

const DATE_MEMORY = memory('Dentist appointment on October 20');
const LOOP_MEMORY = memory('I want to try that Thai place downtown');

test('unified chooser: date triggers beat patterns', () => {
  const got = chooseChatSurfacingWithPatterns({
    allMemories: [...DRAIN_MEMORIES, DATE_MEMORY], recalledMemories: [], personalDates: [],
    historyMessages: [], userMessage: 'hey', surfacedKeys: new Set(), surfacedRows: [],
    toneTrack: [], nowMs: NOW, timeZone: TZ,
  });
  assert.ok(got);
  assert.equal(got.kind, 'date');
});

test('unified chooser: patterns beat open loops', () => {
  const got = chooseChatSurfacingWithPatterns({
    allMemories: [...ASPIRATION_MEMORIES, LOOP_MEMORY], recalledMemories: [LOOP_MEMORY], personalDates: [],
    historyMessages: [], userMessage: 'hey', surfacedKeys: new Set(), surfacedRows: [],
    toneTrack: [], nowMs: NOW, timeZone: TZ,
  });
  assert.ok(got);
  assert.equal(got.kind, 'pattern');
});

test('unified chooser: open loop still surfaces when nothing stronger', () => {
  const got = chooseChatSurfacingWithPatterns({
    allMemories: [LOOP_MEMORY], recalledMemories: [LOOP_MEMORY], personalDates: [],
    historyMessages: [], userMessage: 'hey', surfacedKeys: new Set(), surfacedRows: [],
    toneTrack: [], nowMs: NOW, timeZone: TZ,
  });
  assert.ok(got);
  assert.equal(got.kind, 'open_loop');
});

// --- Prompt rendering + honesty ---

test('emotional context states the honesty contract verbatim', () => {
  const ctx = buildEmotionalContext({ userName: 'Edward', tone: 'stressed', emotionPhrase: 'You\u2019ve seemed drained the last three evenings.' });
  assert.match(ctx, /do NOT feel/);
  assert.match(ctx, /never claim to feel anything/i);
  assert.match(ctx, /three evenings/);
  assert.match(ctx, /seems stressed/);
  const plain = buildEmotionalContext({ userName: 'Edward', tone: 'neutral', emotionPhrase: null });
  assert.match(plain, /do NOT feel/);
});

test('unified hint dispatches: pattern vs date', () => {
  const pattern = detectMemoryPatterns({ memories: DRAIN_MEMORIES, nowMs: NOW })[0];
  const hint = buildUnifiedHint({ kind: 'pattern', pattern, memory: pattern.memories[0] });
  assert.match(hint, /Pattern insight/);
  assert.match(hint, /never a fortune-cookie generality/);
  assert.match(hint, /MODEL, not a feeling/);
  const dateHint = buildUnifiedHint({ kind: 'date', memory: DATE_MEMORY, reason: 'appointment is in 4 days' });
  assert.match(dateHint, /Proactive memory/);
});

test('pattern hint: avoidance gets the honest-kindness guidance', () => {
  const pattern = detectMemoryPatterns({ memories: AVOIDANCE_MEMORIES, nowMs: NOW })[0];
  const hint = buildPatternHint({ kind: 'pattern', pattern, memory: pattern.memories[0] });
  assert.match(hint, /never judgment/i);
  assert.match(hint, /constructive/);
});

test('honesty: "are you sad?" gets an honest no — no performed feelings', () => {
  const reply = handleEmotionHonesty({ message: 'are you sad?', tone: 'neutral' });
  assert.ok(reply);
  assert.match(reply, /^No/);
  assert.match(reply, /don\u2019t feel things/);
  assert.ok(!/I feel|I am sad|I'm sad|so sad today/i.test(reply), 'never performs the feeling');
});

test('honesty: tone-aware closer when he is heavy', () => {
  const reply = handleEmotionHonesty({ message: 'are you okay?', tone: 'burnt_out' });
  assert.ok(reply);
  assert.match(reply, /^No/);
  assert.match(reply, /drained/);
});

test('honesty: does not fire on ordinary messages', () => {
  assert.equal(handleEmotionHonesty({ message: 'what is the weather like', tone: 'neutral' }), null);
  assert.equal(handleEmotionHonesty({ message: 'how are you?', tone: 'neutral' }), null, 'casual greeting untouched');
  assert.equal(handleEmotionHonesty({ message: 'are you coming to dinner?', tone: 'neutral' }), null);
});

test('honesty: "do you feel" variant matches', () => {
  const reply = handleEmotionHonesty({ message: 'do you feel tired?', tone: 'neutral' });
  assert.ok(reply);
  assert.match(reply, /^No/);
});

test('why-explainability: emotion surfacings get the modeled-not-felt answer', async () => {
  const { handleProactiveMemoryWhy } = await import('../src/proactive-memory.js');
  const { db, user } = dbFixture();
  db.recordMemorySurfacing(user.id, {
    memoryId: 'emotion', occurrenceKey: 'emotion:drained', kind: 'emotion', via: 'chat',
    reason: 'emotional pattern: test', contentSnapshot: 'You\u2019ve seemed drained the last three evenings.',
  });
  const reply = handleProactiveMemoryWhy({ db, userId: user.id, message: 'why are you telling me this?' });
  assert.ok(reply);
  assert.match(reply, /modeling from your messages/);
  assert.match(reply, /not something I feel/);
  assert.ok(!/in my notes/.test(reply), 'emotion rows are not "in my notes"');
});

// --- Adaptive soul grounding ---

test('soul: emotional tone grounds adaptation when no mood matched', () => {
  const { db, user } = dbFixture();
  const a = applyAdaptation({ db, userId: user.id, message: "I've been so anxious all week", timeZone: TZ, nowMs: NOW });
  assert.equal(a.shifts.warmth, 1, 'anxious → warmer');
  assert.match(a.reason, /on edge/);
  assert.match(a.whyPast, /on edge/);
});

test('soul: burnt out eases directness', () => {
  const { db, user } = dbFixture();
  const a = applyAdaptation({ db, userId: user.id, message: "I'm completely wiped after class", timeZone: TZ, nowMs: NOW });
  assert.equal(a.shifts.warmth, 1);
  assert.equal(a.shifts.directness, -1);
});

test('soul: explicit moods keep priority over emotional tones', () => {
  const { db, user } = dbFixture();
  // Venting matches the venting mood (not just the stressed tone) — the
  // mood's own reason wins.
  const a = applyAdaptation({ db, userId: user.id, message: 'ugh, I need to vent for a sec', timeZone: TZ, nowMs: NOW });
  assert.match(a.reason, /could use some space/, 'venting mood reason, not the emotion fallback');
});

test('soul: neutral messages are untouched by the emotion branch', () => {
  const { db, user } = dbFixture();
  const a = applyAdaptation({ db, userId: user.id, message: 'what is the weather like', timeZone: TZ, nowMs: NOW });
  assert.deepEqual(a.shifts, { warmth: 0, directness: 0, playfulness: 0, formality: 0 });
});

// --- Surfacing record / touch ---

test('recordConnectionSurfacing: inserts and refreshes surfaced_at', () => {
  const { db, user } = dbFixture();
  const pattern = detectMemoryPatterns({ memories: DRAIN_MEMORIES, nowMs: NOW })[0];
  const candidate = { kind: 'pattern', via: 'chat', occurrenceKey: pattern.id, memory: pattern.memories[0], reason: 'test', pattern };
  recordConnectionSurfacing(db, user.id, candidate);
  let row = db.getMemorySurfacing(user.id, pattern.id);
  assert.ok(row);
  assert.equal(row.kind, 'pattern');
  assert.equal(row.via, 'chat');
  const first = row.surfaced_at;
  assert.ok(db.touchMemorySurfacing(user.id, pattern.id), 'touch hits the row');
  row = db.getMemorySurfacing(user.id, pattern.id);
  assert.ok(row.surfaced_at >= first, 'surfaced_at refreshed');
  assert.equal(db.touchMemorySurfacing(user.id, 'pattern:nope:x'), false, 'missing key → false');
});

test('recordConnectionSurfacing: emotion rows use the sentinel memory id', () => {
  const { db, user } = dbFixture();
  recordConnectionSurfacing(db, user.id, { kind: 'emotion', via: 'chat', occurrenceKey: 'emotion:drained', memory: null, snapshot: 'phrase', reason: 'test' });
  const row = db.getMemorySurfacing(user.id, 'emotion:drained');
  assert.ok(row);
  assert.equal(row.memory_id, 'emotion');
  assert.equal(row.content_snapshot, 'phrase');
});

// --- Background push ---

function stubDb(memories, surfacedRows = []) {
  const recorded = [];
  return {
    recorded,
    listMemories: () => memories,
    listMemorySurfacings: () => surfacedRows,
    getSetting: () => null,
    setSetting: () => {},
    recordMemorySurfacing: (userId, row) => { recorded.push(row); return true; },
    touchMemorySurfacing: () => true,
    addEvent: () => {},
  };
}
const stubModel = (text = 'A genuine insight, composed.') => ({ respond: async () => ({ text }) });
const stubUser = { id: 'u1', display_name: 'Edward' };

test('push: established pattern is pushed once, recorded, slot respected', async () => {
  const db = stubDb(DRAIN_MEMORIES);
  let claimed = false; let released = false; let delivered = null;
  const sent = await runMemoryConnectionPush({
    db, model: stubModel(), user: stubUser, timeZone: TZ, nowMs: NOW, buddyName: 'Orbit',
    claimSlot: () => { claimed = true; return true; },
    releaseSlot: () => { released = true; },
    deliver: async (text, msg) => { delivered = { text, msg }; },
  });
  assert.equal(sent, 1);
  assert.ok(claimed);
  assert.ok(!released, 'slot kept on success');
  assert.ok(delivered && delivered.text.length > 0);
  assert.equal(db.recorded.length, 1);
  assert.equal(db.recorded[0].kind, 'pattern');
  assert.equal(db.recorded[0].via, 'proactive');
  assert.ok(db.recorded[0].occurrenceKey.startsWith('pattern:drain:'));
});

test('push: no slot → silent, emerging patterns never pushed', async () => {
  const db = stubDb(DRAIN_MEMORIES);
  const sent = await runMemoryConnectionPush({
    db, model: stubModel(), user: stubUser, timeZone: TZ, nowMs: NOW, buddyName: 'Orbit',
    claimSlot: () => false, releaseSlot: () => {}, deliver: async () => { throw new Error('must not deliver'); },
  });
  assert.equal(sent, 0);
  const db2 = stubDb(ASPIRATION_MEMORIES); // emerging only
  const sent2 = await runMemoryConnectionPush({
    db: db2, model: stubModel(), user: stubUser, timeZone: TZ, nowMs: NOW, buddyName: 'Orbit',
    claimSlot: () => true, releaseSlot: () => {}, deliver: async () => {},
  });
  assert.equal(sent2, 0, 'emerging patterns are chat-aside material only');
});

test('push: established emotional pattern is pushed when no memory pattern', async () => {
  const db = stubDb([memory('my favorite pizza topping is pepperoni')]);
  // Seed the track through the real settings-backed functions.
  const real = dbFixture();
  for (const e of EVENING_TRACK) trackEmotionalTone(real.db, real.user.id, e.tone, e.at);
  const dbWithTrack = { ...db, getSetting: (k) => real.db.getSetting(k) };
  let delivered = null;
  const sent = await runMemoryConnectionPush({
    db: dbWithTrack, model: stubModel(), user: { ...stubUser, id: real.user.id }, timeZone: TZ, nowMs: NOW, buddyName: 'Orbit',
    claimSlot: () => true, releaseSlot: () => {}, deliver: async (text) => { delivered = text; },
  });
  assert.equal(sent, 1);
  assert.ok(delivered);
  assert.equal(dbWithTrack.recorded[0].kind, 'emotion');
  assert.equal(dbWithTrack.recorded[0].memoryId, 'emotion');
});

test('push: model failure releases the slot and never throws', async () => {
  const db = stubDb(DRAIN_MEMORIES);
  let released = false;
  const sent = await runMemoryConnectionPush({
    db, model: { respond: async () => { throw new Error('boom'); } }, user: stubUser, timeZone: TZ, nowMs: NOW, buddyName: 'Orbit',
    claimSlot: () => true, releaseSlot: () => { released = true; }, deliver: async () => {},
  });
  assert.equal(sent, 0);
  assert.ok(released);
});

test('push: db read failure never throws', async () => {
  const sent = await runMemoryConnectionPush({
    db: { listMemories: () => { throw new Error('db down'); } },
    model: stubModel(), user: stubUser, timeZone: TZ, nowMs: NOW, buddyName: 'Orbit',
    claimSlot: () => true, releaseSlot: () => {}, deliver: async () => {},
  });
  assert.equal(sent, 0);
});

// --- Server integration: push through the shared pipeline ---

async function serverFixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mc-srv-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', ...extraEnv } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function register(base) {
  const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `mc-${Date.now()}@example.com`, displayName: 'Owner', password: 'correct horse battery staple' }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  const cookie=response.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${base}/api/ai-sharing-consent`,{method:'POST',headers:{Cookie:cookie,'X-Orbit-CSRF':body.csrf,'Content-Type':'application/json'},body:'{"accepted":true}'})).status,200);
  return { userId: body.user.id };
}

test('server: established pattern pushes once through the shared pipeline', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const { userId } = await register(base);
  app.db.setPreferences(userId, { timeZone: 'America/New_York', quietStart: '00:00', quietEnd: '00:00' });
  const runAt = Date.now() + 2 * 86400_000;
  // Aspiration memories: consistent intentions that the contradiction
  // detector leaves alone (drain phrasings can false-positive there).
  app.db.addMemory(userId, 'I want to learn Spanish this year, starting with basics');
  app.db.addMemory(userId, 'really want to learn Spanish, maybe a tutor for the fall');
  app.db.addMemory(userId, 'still want to learn Spanish, thinking about a class in the spring');
  await app.runProactiveChecks(runAt);
  const surfaced = app.db.listMemorySurfacings(userId, 10);
  const patternRows = surfaced.filter((r) => r.kind === 'pattern');
  assert.equal(patternRows.length, 1, 'one pattern surfacing recorded');
  assert.equal(patternRows[0].via, 'proactive');
  assert.ok(patternRows[0].occurrence_key.startsWith('pattern:aspiration:'), `key was ${patternRows[0].occurrence_key}`);
  const events = app.db.listEvents(userId, 50).map((e) => e.type);
  assert.ok(events.includes('memory_connection_proactive_sent'), 'pipeline event logged');
  // Second run the next day: no repeat (cooldown + daily cap).
  await app.runProactiveChecks(runAt + 86400_000);
  assert.equal(app.db.listMemorySurfacings(userId, 10).filter((r) => r.kind === 'pattern').length, 1, 'no duplicate insight');
});

test('server: emerging patterns never push', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const { userId } = await register(base);
  app.db.setPreferences(userId, { timeZone: 'America/New_York', quietStart: '00:00', quietEnd: '00:00' });
  const runAt = Date.now() + 2 * 86400_000;
  app.db.addMemory(userId, 'I want to learn Spanish this year, starting with basics');
  app.db.addMemory(userId, 'really want to learn Spanish, maybe a tutor for the fall');
  await app.runProactiveChecks(runAt);
  assert.equal(app.db.listMemorySurfacings(userId, 10).filter((r) => r.kind === 'pattern').length, 0, 'emerging stays chat-only');
});

test('server: memory-connection push stays silent in quiet hours', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const { userId } = await register(base);
  const runAt = Date.now() + 2 * 86400_000;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(runAt));
  const h = Number(parts.find((p) => p.type === 'hour').value); const m = Number(parts.find((p) => p.type === 'minute').value);
  const pad = (n) => String(n).padStart(2, '0');
  app.db.setPreferences(userId, {
    timeZone: 'America/New_York',
    quietStart: `${pad((h + 22) % 24)}:${pad(m)}`,
    quietEnd: `${pad((h + 2) % 24)}:${pad(m)}`,
  });
  app.db.addMemory(userId, 'I want to learn Spanish this year, starting with basics');
  app.db.addMemory(userId, 'really want to learn Spanish, maybe a tutor for the fall');
  app.db.addMemory(userId, 'still want to learn Spanish, thinking about a class in the spring');
  await app.runProactiveChecks(runAt);
  assert.equal(app.db.listMemorySurfacings(userId, 10).length, 0, 'no surfacing in quiet hours');
});

// --- Polish (2026-10-16): emotional context uses the user's name, never a hardcoded one ---

test('emotional context names the user instead of hardcoding Edward', () => {
  const ctx = buildEmotionalContext({ userName: 'Jordan', tone: 'stressed', emotionPhrase: null });
  assert.match(ctx, /Jordan’s emotional patterns/);
  assert.match(ctx, /Jordan seems stressed/);
  const anon = buildEmotionalContext({ userName: '', tone: 'stressed', emotionPhrase: null });
  assert.match(anon, /the user’s emotional patterns/);
  assert.match(anon, /the user seems stressed/);
  assert.ok(!anon.includes('Edward'));
});

test('pattern hint never hardcodes gender', () => {
  const pattern = detectMemoryPatterns({ memories: DRAIN_MEMORIES, nowMs: NOW })[0];
  const hint = buildUnifiedHint({ kind: 'pattern', pattern, memory: pattern.memories[0] });
  assert.ok(!/\bhe can\b/i.test(hint), 'no hardcoded "he"');
  assert.ok(!/matters to him/i.test(hint), 'no hardcoded "him"');
});
