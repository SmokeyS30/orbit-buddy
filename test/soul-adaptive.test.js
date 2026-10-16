// Adaptive soul regression tests: context-driven personality shifts, gradual
// bounds, signal-based continuous learning (no ratings/popups), learnings on
// the soul record, chat-native explainability, and demo-mode static neutral.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.js';
import {
  normalizeSoulRecord,
  buildSoulDirective,
  handleSoulCommand,
  detectConversationMood,
  detectAdaptationSignals,
  timeBucketFor,
  loadAdaptationState,
  applyAdaptation,
  promoteAdaptationLearning,
  resolveAdaptiveSoulDirective,
  detectAdaptationWhy,
  handleAdaptationCommand,
} from '../src/soul.js';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-soul-adapt-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  const user = db.createUser({ email: 'owner@example.com', displayName: 'Owner', passwordHash: 'hash', passwordSalt: 'salt', role: 'owner' });
  return { db, user };
}

// Fixed evening hour in America/New_York: 2026-10-16T22:00:00Z = 18:00 EDT.
const EVENING_MS = Date.parse('2026-10-16T22:00:00Z');
const MORNING_MS = Date.parse('2026-10-16T12:00:00Z'); // 08:00 EDT.

test('adaptive: mood detection — rushed, venting, joking, focused, celebrating, neutral', () => {
  assert.equal(detectConversationMood('quick question before my meeting'), 'rushed');
  assert.equal(detectConversationMood('ugh, I need to vent for a sec'), 'venting');
  // venting beats rushed: "just need to vent" is venting, not rushing.
  assert.equal(detectConversationMood('I just need to vent quickly'), 'venting');
  assert.equal(detectConversationMood('lol that is so funny'), 'joking');
  assert.equal(detectConversationMood("let's get to work, deadline Friday"), 'focused');
  assert.equal(detectConversationMood('I did it, I passed!'), 'celebrating');
  assert.equal(detectConversationMood('what is the weather like tomorrow'), 'neutral');
});

test('adaptive: shifts move gradually — one step per turn, bounded at ±1', () => {
  const { db, user } = fixture();
  const a1 = applyAdaptation({ db, userId: user.id, message: 'quick question, in a hurry', timeZone: 'America/New_York', nowMs: EVENING_MS });
  assert.equal(a1.shifts.directness, 1, 'directness moves one step toward rushed target');
  assert.equal(a1.shifts.playfulness, -1, 'playfulness moves one step toward rushed target');
  const a2 = applyAdaptation({ db, userId: user.id, message: 'quick question, in a hurry', timeZone: 'America/New_York', nowMs: EVENING_MS });
  assert.equal(a2.shifts.directness, 1, 'never exceeds +1');
  assert.equal(a2.shifts.playfulness, -1, 'never exceeds -1');
  // Neutral mood decays back toward 0, one step per turn.
  const a3 = applyAdaptation({ db, userId: user.id, message: 'what is the weather like', timeZone: 'America/New_York', nowMs: EVENING_MS });
  assert.equal(a3.shifts.directness, 0);
  assert.equal(a3.shifts.playfulness, 0);
});

test('adaptive: shifts modulate the tuned anchor, never override it', () => {
  const { db, user } = fixture();
  // Tune directness to max (blunt) — the anchor.
  handleSoulCommand({ db, userId: user.id, message: 'be more blunt', isDemo: false });
  let record = normalizeSoulRecord(db.getSoulRecord(user.id));
  assert.equal(record.directness, 4);
  applyAdaptation({ db, userId: user.id, message: 'quick question, in a hurry', timeZone: 'America/New_York', nowMs: EVENING_MS });
  const directive = resolveAdaptiveSoulDirective({ db, userId: user.id, isDemo: false, userName: 'Owner', message: 'quick question', timeZone: 'America/New_York', nowMs: EVENING_MS });
  assert.ok(directive.includes('Delivery: blunt'), 'effective directness clamps at 4, not 5');
  // Explicit tuning resets the adaptation shift on that axis — anchor wins.
  handleSoulCommand({ db, userId: user.id, message: 'be gentler', isDemo: false });
  const state = loadAdaptationState(db, user.id);
  assert.equal(state.shifts.directness, 0, 'explicit tuning clears the adapted shift');
});

test('adaptive: "just give me the answer" shifts toward directness immediately', () => {
  const { db, user } = fixture();
  const a = applyAdaptation({ db, userId: user.id, message: 'just give me the answer', timeZone: 'America/New_York', nowMs: EVENING_MS });
  assert.equal(a.shifts.directness, 1);
  assert.ok(a.reason.includes('just the answer'));
  const signals = detectAdaptationSignals('just give me the answer', loadAdaptationState(db, user.id));
  assert.ok(signals.some((s) => s.kind === 'explicit_direct'));
});

test('adaptive: pushback after a playful turn eases off playfulness', () => {
  const { db, user } = fixture();
  // Get playful first.
  applyAdaptation({ db, userId: user.id, message: 'lol tell me something funny', timeZone: 'America/New_York', nowMs: EVENING_MS });
  let state = loadAdaptationState(db, user.id);
  assert.equal(state.shifts.playfulness, 1);
  // Push back.
  const a = applyAdaptation({ db, userId: user.id, message: 'stop joking, this is serious', timeZone: 'America/New_York', nowMs: EVENING_MS });
  assert.equal(a.shifts.playfulness, 0, 'eases off playfulness toward 0');
  assert.ok(a.reason.length > 0, 'reason recorded for explainability');
});

test('adaptive: short reply after playful turn is a signal', () => {
  const { db, user } = fixture();
  const state = loadAdaptationState(db, user.id);
  state.shifts.playfulness = 1;
  state.userLens = [120, 110, 130];
  const signals = detectAdaptationSignals('ok', state);
  assert.ok(signals.some((s) => s.kind === 'short_after_playful'));
});

test('adaptive: repeated signals promote a learning to the soul record + history', () => {
  const { db, user } = fixture();
  // "just give me the answer" carries weight 2; threshold is 3 — two turns promote.
  applyAdaptation({ db, userId: user.id, message: 'just give me the answer', timeZone: 'America/New_York', nowMs: EVENING_MS });
  applyAdaptation({ db, userId: user.id, message: 'just give me the answer please', timeZone: 'America/New_York', nowMs: EVENING_MS });
  const record = normalizeSoulRecord(db.getSoulRecord(user.id));
  assert.equal(record.learnings.length, 1);
  assert.equal(record.learnings[0].label, 'evenings: prefers direct');
  const history = db.listSoulHistory(user.id, 5);
  assert.ok(history.some((h) => /^learn:evening:directness\+$/.test(h.source)), 'learning has a history entry');
});

test('adaptive: learnings show in soul history and revert with "go back to how you were"', () => {
  const { db, user } = fixture();
  handleSoulCommand({ db, userId: user.id, message: 'be more playful', isDemo: false });
  promoteAdaptationLearning(db, user.id, 'morning', 'directness', 1);
  let historyReply = handleSoulCommand({ db, userId: user.id, message: 'soul history', isDemo: false });
  assert.ok(historyReply.includes('learned: mornings: prefers direct'), 'learning labeled in history');
  handleSoulCommand({ db, userId: user.id, message: 'go back to how you were', isDemo: false });
  const record = normalizeSoulRecord(db.getSoulRecord(user.id));
  assert.equal(record.learnings.length, 0, 'revert removes the learning');
});

test('adaptive: learnings render as read-the-room notes in the directive', () => {
  const { db, user } = fixture();
  promoteAdaptationLearning(db, user.id, 'evening', 'warmth', 1);
  const directive = buildSoulDirective(db.getSoulRecord(user.id), {
    userName: 'Owner',
    adaptation: { shifts: { warmth: 1, directness: 0, playfulness: 0, formality: 0 }, reason: 'test reason', learnings: [] },
  });
  assert.ok(directive.includes('Current read on the conversation: test reason'), 'current read rendered');
  assert.ok(directive.includes('Read-the-room notes'), 'learnings section rendered');
  assert.ok(directive.includes('evenings: warmer works'), 'learning label rendered');
  assert.ok(directive.includes('Warmth: very warm'), 'effective axis uses shift (warm 3 + 1)');
});

test('adaptive: explainability — "why are you being so direct right now?"', () => {
  const { db, user } = fixture();
  applyAdaptation({ db, userId: user.id, message: 'quick question, in a hurry', timeZone: 'America/New_York', nowMs: EVENING_MS });
  const reply = handleAdaptationCommand({ db, userId: user.id, message: 'why are you being so direct right now?', isDemo: false });
  assert.ok(reply, 'answered');
  assert.ok(/direct/i.test(reply), 'names the adapted axis');
  assert.ok(/rushed/i.test(reply), 'gives the reason');
  assert.ok(/stop adapting/i.test(reply), 'offers the off-ramp');
  assert.equal(detectAdaptationWhy('why are you being so playful?'), 'playfulness');
  assert.equal(detectAdaptationWhy('why are you acting like this?'), 'general');
  assert.equal(detectAdaptationWhy('why is the sky blue'), null, 'not an adaptation question');
});

test('adaptive: stop/start adapting and forget what was learned', () => {
  const { db, user } = fixture();
  promoteAdaptationLearning(db, user.id, 'morning', 'directness', 1);
  const stop = handleAdaptationCommand({ db, userId: user.id, message: 'stop adapting', isDemo: false });
  assert.ok(stop.includes('stop adapting'), 'disable confirmed');
  const a = applyAdaptation({ db, userId: user.id, message: 'quick question, in a hurry', timeZone: 'America/New_York', nowMs: EVENING_MS });
  assert.deepEqual(a.shifts, { warmth: 0, directness: 0, playfulness: 0, formality: 0 }, 'disabled: no shifts');
  const directive = resolveAdaptiveSoulDirective({ db, userId: user.id, isDemo: false, userName: 'Owner', message: 'quick question', timeZone: 'America/New_York', nowMs: EVENING_MS });
  assert.ok(!directive.includes('Current read'), 'disabled: no adaptation layer in directive');
  const start = handleAdaptationCommand({ db, userId: user.id, message: 'start adapting', isDemo: false });
  assert.ok(start.includes('reading the room'), 'enable confirmed');
  const clear = handleAdaptationCommand({ db, userId: user.id, message: "forget what you've learned", isDemo: false });
  assert.ok(clear.includes('Cleared'), 'clear confirmed');
  assert.equal(normalizeSoulRecord(db.getSoulRecord(user.id)).learnings.length, 0);
  const history = db.listSoulHistory(user.id, 5);
  assert.ok(history.some((h) => h.source === 'learn-clear'));
});

test('adaptive: time buckets — morning vs evening learnings differ', () => {
  assert.equal(timeBucketFor(new Date(MORNING_MS), 'America/New_York'), 'morning');
  assert.equal(timeBucketFor(new Date(EVENING_MS), 'America/New_York'), 'evening');
  const { db, user } = fixture();
  promoteAdaptationLearning(db, user.id, 'morning', 'directness', 1);
  promoteAdaptationLearning(db, user.id, 'evening', 'warmth', 1);
  const labels = normalizeSoulRecord(db.getSoulRecord(user.id)).learnings.map((l) => l.label);
  assert.deepEqual(labels, ['mornings: prefers direct', 'evenings: warmer works']);
  // Conflicting learning for the same bucket+axis replaces, not duplicates.
  promoteAdaptationLearning(db, user.id, 'morning', 'directness', -1);
  const labels2 = normalizeSoulRecord(db.getSoulRecord(user.id)).learnings.map((l) => l.label).sort();
  assert.deepEqual(labels2, ['evenings: warmer works', 'mornings: prefers gentle'].sort());
});

test('adaptive: per-user isolation', () => {
  const { db, user } = fixture();
  const other = db.createUser({ email: 'b@example.com', displayName: 'B', passwordHash: 'h', passwordSalt: 's', role: 'owner' });
  applyAdaptation({ db, userId: user.id, message: 'quick question, in a hurry', timeZone: 'America/New_York', nowMs: EVENING_MS });
  promoteAdaptationLearning(db, user.id, 'evening', 'directness', 1);
  const otherState = loadAdaptationState(db, other.id);
  assert.deepEqual(otherState.shifts, { warmth: 0, directness: 0, playfulness: 0, formality: 0 });
  assert.equal(normalizeSoulRecord(db.getSoulRecord(other.id)).learnings.length, 0);
});

test('adaptive: demo mode is static neutral — no state, no learning', () => {
  const { db, user } = fixture();
  const directive = resolveAdaptiveSoulDirective({ db, userId: user.id, isDemo: true, userName: 'Demo', message: 'quick question, in a hurry', timeZone: 'America/New_York', nowMs: EVENING_MS });
  assert.ok(directive.includes('demo default'), 'neutral demo directive');
  assert.ok(!directive.includes('Current read'), 'no adaptation layer in demo');
  assert.equal(db.getSetting(`soul_adapt_${user.id}`), null, 'no adaptation state created for demo');
  const why = handleAdaptationCommand({ db, userId: user.id, message: 'why are you being so direct?', isDemo: true });
  assert.ok(why.includes('demo mode'), 'neutral demo explain answer');
  const stop = handleAdaptationCommand({ db, userId: user.id, message: 'stop adapting', isDemo: true });
  assert.ok(stop.includes('Demo mode'), 'demo control answer');
});

test('adaptive: warm engagement leans in', () => {
  const { db, user } = fixture();
  const a = applyAdaptation({ db, userId: user.id, message: 'haha that is amazing, love it', timeZone: 'America/New_York', nowMs: EVENING_MS });
  assert.ok(a.shifts.warmth >= 0, 'warmth does not decrease on warm engagement');
  const signals = detectAdaptationSignals('thanks so much, that was perfect', loadAdaptationState(db, user.id));
  assert.ok(signals.some((s) => s.kind === 'warm_engagement'));
});
