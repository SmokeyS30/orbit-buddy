// Soul core regression tests: versioned per-user soul records, chat-native
// tuning, revert, history, per-user isolation, demo neutral default, and
// WhatsApp application (same resolveSoulDirective path the shared
// runChatReplyJob uses for web + WhatsApp).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.js';
import { isDemoUser } from '../src/demo.js';
import {
  DEFAULT_SOUL_RECORD,
  NEUTRAL_SOUL_RECORD,
  normalizeSoulRecord,
  shortSoulDescription,
  buildHonestSoulSection,
  buildSoulDirective,
  resolveSoulDirective,
  parseSoulTune,
  stripSoulWrappers,
  isSoulRevert,
  isSoulHistoryRequest,
  isSoulStatusRequest,
  handleSoulCommand,
} from '../src/soul.js';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-soul-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  const user = db.createUser({ email: 'owner@example.com', displayName: 'Owner', passwordHash: 'hash', passwordSalt: 'salt', role: 'owner' });
  return { db, user };
}

test('soul: default is warm, direct, and a little playful', () => {
  assert.equal(shortSoulDescription(null), 'warm, direct, and a little playful');
  assert.equal(shortSoulDescription({}), 'warm, direct, and a little playful');
  const directive = buildSoulDirective(null, { userName: 'Owner' });
  assert.ok(directive.includes('Warmth: warm'), 'warmth line present');
  assert.ok(directive.includes('Delivery: direct'), 'directness line present');
  assert.ok(directive.includes('a little playful'), 'playfulness line present');
  assert.ok(directive.includes('casual'), 'casual tone present');
});

test('soul: record holds personality only — no personal facts', () => {
  const record = normalizeSoulRecord(DEFAULT_SOUL_RECORD);
  assert.deepEqual(Object.keys(record).sort(), ['directness', 'formality', 'name', 'playfulness', 'warmth', 'will', 'wont']);
  const directive = buildSoulDirective(record, { userName: 'Edward' });
  assert.ok(!directive.includes('Edward') || directive.includes('tuned this in chat'), 'directive names only the tuner, never stored facts');
});

test('soul: "be more playful" tunes immediately and persists a version', () => {
  const { db, user } = fixture();
  const reply = handleSoulCommand({ db, userId: user.id, message: 'be more playful' });
  assert.equal(reply, 'Got it — I’ll be more playful from here on.');
  const record = db.getSoulRecord(user.id);
  assert.equal(record.playfulness, 3);
  assert.equal(record.version, 1);
});

test('soul: "stop being so formal" and "be more direct with me"', () => {
  const { db, user } = fixture();
  assert.equal(handleSoulCommand({ db, userId: user.id, message: 'stop being so formal' }), 'Got it — I’ll be more casual from here on.');
  assert.equal(db.getSoulRecord(user.id).formality, 0);
  assert.equal(handleSoulCommand({ db, userId: user.id, message: 'be more direct with me' }), 'Got it — I’ll be more direct from here on.');
  const record = db.getSoulRecord(user.id);
  assert.equal(record.directness, 4);
  assert.equal(record.version, 2);
});

test('soul: tuning past the max is a no-op with a clear reply', () => {
  const { db, user } = fixture();
  handleSoulCommand({ db, userId: user.id, message: 'be more direct with me' }); // 3 -> 4
  const reply = handleSoulCommand({ db, userId: user.id, message: 'be more blunt' });
  assert.ok(reply.includes('already'), `expected already-at-max reply, got: ${reply}`);
  assert.equal(db.getSoulRecord(user.id).directness, 4);
  assert.equal(db.getSoulRecord(user.id).version, 1, 'no new version for a no-op tune');
});

test('soul: "go back to how you were" reverts one step', () => {
  const { db, user } = fixture();
  handleSoulCommand({ db, userId: user.id, message: 'be more playful' }); // v1: playfulness 3
  handleSoulCommand({ db, userId: user.id, message: 'be more direct with me' }); // v2: directness 4
  const reply = handleSoulCommand({ db, userId: user.id, message: 'go back to how you were' });
  assert.ok(reply.startsWith('Back to how I was'), `expected revert reply, got: ${reply}`);
  const record = db.getSoulRecord(user.id);
  assert.equal(record.playfulness, 3, 'keeps the first tune');
  assert.equal(record.directness, 3, 'undoes the second tune');
  assert.equal(record.version, 3, 'revert writes a new version (history stays append-only)');
});

test('soul: revert with no history explains and creates nothing', () => {
  const { db, user } = fixture();
  const reply = handleSoulCommand({ db, userId: user.id, message: 'go back to how you were' });
  assert.ok(reply.includes('nothing to go back to'), `got: ${reply}`);
  assert.equal(db.getSoulRecord(user.id), null, 'no record created by a no-op revert');
});

test('soul: history lists edits newest-first', () => {
  const { db, user } = fixture();
  handleSoulCommand({ db, userId: user.id, message: 'be more playful' });
  handleSoulCommand({ db, userId: user.id, message: 'be more casual' });
  const reply = handleSoulCommand({ db, userId: user.id, message: 'soul history' });
  assert.ok(reply.includes('v2'), `expected v2 in history, got: ${reply}`);
  assert.ok(reply.includes('v1'), `expected v1 in history, got: ${reply}`);
  assert.ok(reply.indexOf('v2') < reply.indexOf('v1'), 'newest first');
  assert.ok(reply.includes('more playful'), 'human-readable source label');
  const fresh = fixture();
  const empty = handleSoulCommand({ db: fresh.db, userId: fresh.user.id, message: 'what is your soul history' });
  assert.ok(empty.includes('haven’t shaped'), `expected empty-history reply, got: ${empty}`);
});

test('soul: per-user isolation — tuning one user never touches another', () => {
  const { db, user } = fixture();
  const other = db.createUser({ email: 'b@example.com', displayName: 'B', passwordHash: 'h', passwordSalt: 's', role: 'member' });
  handleSoulCommand({ db, userId: user.id, message: 'be more playful' });
  handleSoulCommand({ db, userId: user.id, message: 'be more playful' }); // 3 -> 4
  assert.equal(db.getSoulRecord(other.id), null, "other user has no record");
  assert.equal(db.listSoulHistory(other.id).length, 0, 'no history leaks across users');
  const otherDirective = resolveSoulDirective({ db, userId: other.id, isDemo: false, userName: 'B' });
  assert.ok(otherDirective.includes('a little playful'), 'other user still on default soul');
  const ownerDirective = resolveSoulDirective({ db, userId: user.id, isDemo: false, userName: 'Owner' });
  assert.ok(ownerDirective.includes('very playful'), 'owner sees their tuned soul');
});

test('soul: demo mode gets the neutral default and cannot tune', () => {
  const { db, user } = fixture();
  const demo = db.createDemoUser();
  assert.ok(isDemoUser(demo));
  // Owner tunes theirs first — the demo user must never see it.
  handleSoulCommand({ db, userId: user.id, message: 'be more blunt' });
  const blocked = handleSoulCommand({ db, userId: demo.id, message: 'be more playful', isDemo: true });
  assert.ok(blocked.includes('Demo mode'), `expected demo redirect, got: ${blocked}`);
  assert.equal(db.getSoulRecord(demo.id), null, 'no record created for demo users');
  const demoDirective = resolveSoulDirective({ db, userId: demo.id, isDemo: true, userName: 'Demo' });
  assert.ok(demoDirective.includes('demo default'), 'demo directive is marked neutral');
  assert.ok(!demoDirective.includes('blunt'), 'owner tuning never leaks into demo');
  const ownerDirective = resolveSoulDirective({ db, userId: user.id, isDemo: false, userName: 'Owner' });
  assert.ok(ownerDirective.includes('blunt'), 'owner keeps their tuned soul');
  assert.notEqual(demoDirective, ownerDirective);
});

test('soul: WhatsApp-linked user resolves their own tuned soul', () => {
  const { db, user } = fixture();
  db.linkWhatsApp(user.id, '+15085551234');
  handleSoulCommand({ db, userId: user.id, message: 'be more direct with me' });
  // This mirrors the shared runChatReplyJob path: the WhatsApp webhook looks
  // up the user by phone, then resolves the soul directive for the reply.
  const link = db.getUserByWhatsApp('+15085551234');
  assert.ok(link, 'phone linked');
  const waUser = db.getUserById(link.user_id);
  const directive = resolveSoulDirective({
    db,
    userId: waUser.id,
    isDemo: isDemoUser(waUser),
    userName: waUser.display_name,
  });
  assert.ok(directive.includes('Delivery: blunt'), 'WhatsApp reply carries the tuned soul');
});

test('soul: status request describes the current personality', () => {
  const { db, user } = fixture();
  const reply = handleSoulCommand({ db, userId: user.id, message: "what's your personality?" });
  assert.ok(reply.includes('warm, direct, and a little playful'), `got: ${reply}`);
});

test('soul: compound messages are never swallowed by tuning', () => {
  const { db, user } = fixture();
  // Tune phrases embedded in a real question fall through to normal chat.
  assert.equal(handleSoulCommand({ db, userId: user.id, message: "don't sugarcoat it, how bad is the damage?" }), null);
  assert.equal(handleSoulCommand({ db, userId: user.id, message: 'can you be more direct in your summary of the report?' }), null);
  assert.equal(db.getSoulRecord(user.id), null, 'no record created by a non-command');
});

test('soul: polite wrappers still tune ("please be more playful")', () => {
  const { db, user } = fixture();
  assert.equal(handleSoulCommand({ db, userId: user.id, message: 'please be more playful' }), 'Got it — I’ll be more playful from here on.');
  assert.equal(handleSoulCommand({ db, userId: user.id, message: 'be more casual from now on' }), 'Got it — I’ll be more casual from here on.');
  assert.equal(handleSoulCommand({ db, userId: user.id, message: 'Hey, be more direct with me!' }), 'Got it — I’ll be more direct from here on.');
  assert.equal(stripSoulWrappers("  Don't sugarcoat. "), 'dont sugarcoat');
});

test('soul: non-commands pass through untouched', () => {
  const { db, user } = fixture();
  assert.equal(handleSoulCommand({ db, userId: user.id, message: 'what is the weather like?' }), null);
  assert.equal(handleSoulCommand({ db, userId: user.id, message: 'remember that I like tea' }), null);
  assert.equal(handleSoulCommand({ db, userId: user.id, message: '' }), null);
  assert.equal(handleSoulCommand({ db, userId: user.id, message: 'x'.repeat(301) }), null);
  assert.equal(handleSoulCommand({ db, userId: user.id, message: 'go back' }), null, '"go back" alone is not a revert');
});

test('soul: intent matchers cover the required phrases', () => {
  assert.deepEqual(parseSoulTune('be more playful').axis, 'playfulness');
  assert.deepEqual(parseSoulTune('stop being so formal'), { axis: 'formality', delta: -1, reply: 'more casual' });
  assert.deepEqual(parseSoulTune('be more direct with me'), { axis: 'directness', delta: 1, reply: 'more direct' });
  assert.ok(isSoulRevert('go back to how you were'));
  assert.ok(isSoulRevert('revert'));
  assert.ok(isSoulHistoryRequest('soul history'));
  assert.ok(isSoulStatusRequest("what's your personality?"));
  assert.ok(!isSoulStatusRequest('what is the capital of France?'));
});

test('soul: normalizeSoulRecord clamps and fills defaults', () => {
  const record = normalizeSoulRecord({ warmth: 99, directness: -5, bogus: 'x' });
  assert.equal(record.warmth, 4);
  assert.equal(record.directness, 0);
  assert.equal(record.playfulness, 2, 'missing axis falls back to default');
  assert.ok(!('bogus' in record), 'unknown fields dropped');
  assert.equal(shortSoulDescription(NEUTRAL_SOUL_RECORD), 'friendly, straightforward, and restrained');
});

// ---------------------------------------------------------------------------
// Honest soul: "challenge them kindly" as a soul-layer trait whose delivery
// scales with the directness axis. Prompt-only, no new infra, no new commands.
// ---------------------------------------------------------------------------

test('soul: honest feedback block is in every directive', () => {
  const directive = buildSoulDirective(DEFAULT_SOUL_RECORD, { userName: 'Owner' });
  assert.ok(directive.includes('Honest feedback'), 'honest section header present');
  assert.ok(directive.includes('Challenge them kindly'), 'kind challenge posture named');
  assert.ok(directive.includes('agreement you don\u2019t mean is not kindness'), 'anti-sycophancy baseline');
});

test('soul: honest calibration — challenge when it matters, stay warm when it doesn\u2019t', () => {
  const section = buildHonestSoulSection(DEFAULT_SOUL_RECORD, {});
  assert.ok(section.includes('factually wrong'), 'challenge factual errors');
  assert.ok(section.includes('clear flaw'), 'challenge weak ideas');
  assert.ok(section.includes('rationalizing away a goal'), 'challenge goal avoidance');
  assert.ok(section.includes('venting'), 'stay warm when venting');
  assert.ok(section.includes('celebrating'), 'stay warm when celebrating');
  assert.ok(section.includes('low-stakes opinions'), 'stay warm on low-stakes opinions');
  assert.ok(section.includes('don\u2019t fact-check their feelings'), 'feelings are not for fact-checking');
});

test('soul: kindness is load-bearing — observation alone is never the whole message', () => {
  const section = buildHonestSoulSection(DEFAULT_SOUL_RECORD, {});
  assert.ok(section.includes('honest observation + why it matters'), 'observation+matters+alternative pattern');
  assert.ok(section.includes('constructive alternative'), 'alternative required');
  assert.ok(section.includes('The observation alone is never the whole message'), 'never just "that\'s a bad idea"');
});

test('soul: never cruel, never smug, never piling on', () => {
  const section = buildHonestSoulSection(DEFAULT_SOUL_RECORD, {});
  assert.ok(section.includes('Never cruel, never smug'), 'anti-cruelty named');
  assert.ok(section.includes('I told you so'), 'no told-you-so energy');
  assert.ok(section.includes('no piling on'), 'no pile-on when down');
  assert.ok(section.includes('support first'), 'support first, challenge later');
});

test('soul: honesty delivery scales with directness — gentle to blunt, kind at every level', () => {
  const gentle = buildHonestSoulSection({ directness: 0 }, {});
  assert.ok(gentle.includes('ask a curious question instead of contradicting'), 'directness 0: question, not contradiction');
  const diplomatic = buildHonestSoulSection({ directness: 1 }, {});
  assert.ok(diplomatic.includes('honest but cushioned'), 'directness 1: cushion');
  const plain = buildHonestSoulSection({ directness: 3 }, {});
  assert.ok(plain.includes('plain and friendly'), 'directness 3: plain and friendly');
  const blunt = buildHonestSoulSection({ directness: 4 }, {});
  assert.ok(blunt.includes('zero softening'), 'directness 4: blunt');
  assert.ok(blunt.includes('never cutting'), 'directness 4: still kind, never cutting');
});

test('soul: "be more blunt" moves the honesty posture up; "be gentler" moves it down', () => {
  const { db, user } = fixture();
  const before = resolveSoulDirective({ db, userId: user.id, userName: 'Owner' });
  assert.ok(before.includes('plain and friendly'), 'default directness 3 delivery');
  const reply = handleSoulCommand({ db, userId: user.id, message: 'be more blunt' });
  assert.ok(reply.includes('more direct'), 'tune command acknowledged');
  const blunt = resolveSoulDirective({ db, userId: user.id, userName: 'Owner' });
  assert.ok(blunt.includes('zero softening'), 'honesty posture stronger after "be more blunt"');
  assert.ok(!blunt.includes('ask a curious question'), 'gentle delivery gone');
  handleSoulCommand({ db, userId: user.id, message: 'be gentler' });
  handleSoulCommand({ db, userId: user.id, message: 'be gentler' });
  handleSoulCommand({ db, userId: user.id, message: 'be gentler' });
  const soft = resolveSoulDirective({ db, userId: user.id, userName: 'Owner' });
  assert.ok(soft.includes('honest but cushioned'), 'honesty posture softer after three "be gentler"');
});

test('soul: honest section is per-user — tuned soul only affects its owner', () => {
  const { db, user } = fixture();
  const other = db.createUser({ email: 'other@example.com', displayName: 'Other', passwordHash: 'h', passwordSalt: 's', role: 'member' });
  handleSoulCommand({ db, userId: user.id, message: 'be more blunt' });
  const mine = resolveSoulDirective({ db, userId: user.id, userName: 'Owner' });
  const theirs = resolveSoulDirective({ db, userId: other.id, userName: 'Other' });
  assert.ok(mine.includes('zero softening'), 'my tuned soul applies to me');
  assert.ok(!theirs.includes('zero softening'), 'my tuned soul does not leak to another user');
  assert.ok(theirs.includes('plain and friendly'), 'other user keeps the default honesty delivery');
});

test('soul: demo keeps the honest posture but gentle and neutral', () => {
  const { db, user } = fixture();
  const directive = resolveSoulDirective({ db, userId: user.id, isDemo: true, userName: 'Demo' });
  assert.ok(directive.includes('Honest feedback'), 'honest posture still present in demo');
  assert.ok(directive.includes('challenge only clearly-wrong facts'), 'demo challenges facts only');
  assert.ok(directive.includes('never personal patterns or goals'), 'demo never challenges personal patterns');
  assert.ok(directive.includes('didn\u2019t ask for a relationship'), 'demo framing named');
  const nonDemo = resolveSoulDirective({ db, userId: user.id, userName: 'Owner' });
  assert.ok(!nonDemo.includes('didn\u2019t ask for a relationship'), 'demo framing absent for real users');
});

test('soul: honest feedback flows through the shared prompt pipeline (web + WhatsApp)', () => {
  const { db, user } = fixture();
  const directive = resolveSoulDirective({ db, userId: user.id, userName: 'Owner' });
  assert.ok(directive.includes('Honest feedback'), 'soul directive carries the honest section into the prompt');
});
