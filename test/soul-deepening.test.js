// Deepening soul regression tests: history digest rendering, promise
// callbacks (latest direction wins, revert cancels), revert consistency
// (current record authoritative), milestone restraint, demo exclusion,
// and per-user isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.js';
import {
  DEFAULT_SOUL_RECORD,
  shortSoulDescription,
  buildSoulDirective,
  handleSoulCommand,
  resolveAdaptiveSoulDirective,
  activeStylePromise,
  relationshipMilestone,
  shapingTrail,
  learnedLabels,
  buildSoulHistoryDigest,
  getMilestonePromptedAt,
  markMilestonePrompted,
} from '../src/soul.js';

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-10-16T19:00:00-04:00');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-soul-deep-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  const user = db.createUser({ email: 'owner@example.com', displayName: 'Owner', passwordHash: 'hash', passwordSalt: 'salt', role: 'owner' });
  const other = db.createUser({ email: 'other@example.com', displayName: 'Other', passwordHash: 'hash', passwordSalt: 'salt', role: 'owner' });
  return { db, user, other };
}

// Synthetic history rows, newest first — lets tests backdate tunings.
function synthRows(nowMs, ...specs) {
  return specs.map(([source, daysAgo], i) => ({
    source,
    created_at: new Date(nowMs - daysAgo * DAY).toISOString(),
    version: specs.length - i,
  }));
}

// --- digest rendering ----------------------------------------------------

test('deepening: no digest when there is no history', () => {
  assert.equal(buildSoulHistoryDigest({ userName: 'Owner', historyRows: [], record: DEFAULT_SOUL_RECORD, nowMs: NOW }), null);
  assert.equal(buildSoulHistoryDigest({ userName: 'Owner', historyRows: null, record: DEFAULT_SOUL_RECORD, nowMs: NOW }), null);
});

test('deepening: digest names current state, the road here, and learnings', () => {
  const { db, user } = fixture();
  handleSoulCommand({ db, userId: user.id, message: 'be more blunt' });
  handleSoulCommand({ db, userId: user.id, message: 'be more playful' });
  const rows = db.listSoulHistory(user.id, 12);
  const record = db.getSoulRecord(user.id);
  const digest = buildSoulHistoryDigest({ userName: 'Owner', historyRows: rows, record, nowMs: NOW });
  assert.ok(digest, 'digest built');
  const text = digest.lines.join('\n');
  assert.ok(text.includes('Where things stand'), 'current-state line present');
  assert.ok(text.includes(shortSoulDescription(record)), 'current state matches the CURRENT record');
  assert.ok(text.includes('The road here'), 'trail present');
  assert.ok(text.includes('more playful'), 'latest tune in trail');
  assert.ok(text.includes('more direct'), 'earlier tune in trail');
  assert.ok(!text.includes('Milestone'), 'no milestone for a fresh relationship');
  assert.equal(digest.milestoneOffered, false);
});

test('deepening: directive carries the digest; demo gets none', () => {
  const { db, user } = fixture();
  handleSoulCommand({ db, userId: user.id, message: 'be more playful' });
  const directive = resolveAdaptiveSoulDirective({ db, userId: user.id, isDemo: false, userName: 'Owner', message: 'hey', timeZone: 'America/New_York', nowMs: NOW });
  assert.ok(directive.includes('Continuity'), 'digest in directive');
  assert.ok(directive.includes('Where things stand'), 'current-state line in directive');
  const demo = resolveAdaptiveSoulDirective({ db, userId: user.id, isDemo: true, userName: 'Demo', message: 'hey', timeZone: 'America/New_York', nowMs: NOW });
  assert.ok(!demo.includes('Continuity'), 'demo: no history awareness');
  assert.ok(demo.includes('neutral'), 'demo: neutral soul');
  assert.equal(getMilestonePromptedAt(db, user.id), null, 'demo writes no milestone marker');
});

test('deepening: plain directive without digest still renders (backward compat)', () => {
  const directive = buildSoulDirective(DEFAULT_SOUL_RECORD, { userName: 'Owner' });
  assert.ok(!directive.includes('Continuity'), 'no digest section without history');
  assert.ok(directive.includes('Warmth: warm'), 'personality intact');
});

// --- promises ------------------------------------------------------------

test('deepening: the most recent tune is the promise in force', () => {
  const { db, user } = fixture();
  handleSoulCommand({ db, userId: user.id, message: 'be more blunt' });
  handleSoulCommand({ db, userId: user.id, message: 'be gentler' });
  const promise = activeStylePromise(db.listSoulHistory(user.id, 12));
  assert.ok(promise, 'a promise is active');
  assert.equal(promise.phrase, 'gentler', 'latest direction wins');
});

test('deepening: promise line follows the newest direction, no guilt about the old one', () => {
  const rows = synthRows(NOW,
    ['tune:directness-1', 10], // "gentler" — most recent
    ['tune:directness+1', 45], // "more direct" — older
  );
  const digest = buildSoulHistoryDigest({ userName: 'Owner', historyRows: rows, record: DEFAULT_SOUL_RECORD, nowMs: NOW });
  const promiseLines = digest.lines.filter((l) => l.includes('Style promise in force'));
  assert.equal(promiseLines.length, 1, 'exactly one promise line');
  assert.ok(promiseLines[0].includes('gentler'), 'promise is the newest direction');
  assert.ok(!promiseLines[0].includes('more direct'), 'old direction not framed as a promise');
  assert.ok(promiseLines[0].includes('very rarely'), 'rarity guidance present');
  assert.ok(promiseLines[0].includes('follow the newest one'), 'follow-latest instruction present');
});

test('deepening: revert cancels the promise; a new tune re-establishes it', () => {
  const { db, user } = fixture();
  handleSoulCommand({ db, userId: user.id, message: 'be more blunt' }); // v1
  handleSoulCommand({ db, userId: user.id, message: 'be more playful' }); // v2
  handleSoulCommand({ db, userId: user.id, message: 'go back to how you were' }); // v3 = revert to v1
  assert.equal(activeStylePromise(db.listSoulHistory(user.id, 12)), null, 'revert cancels the promise');
  const rows = db.listSoulHistory(user.id, 12);
  const digest = buildSoulHistoryDigest({ userName: 'Owner', historyRows: rows, record: db.getSoulRecord(user.id), nowMs: NOW });
  assert.ok(!digest.lines.join('\n').includes('Style promise in force'), 'no promise line after revert');
  assert.ok(shapingTrail(rows).join(' ').includes('reverted one step'), 'trail names the revert');
  handleSoulCommand({ db, userId: user.id, message: 'be warmer' });
  const promise = activeStylePromise(db.listSoulHistory(user.id, 12));
  assert.ok(promise, 'new tune re-establishes a promise');
  assert.equal(promise.phrase, 'warmer');
});

test('deepening: promise freshness window — too fresh and too stale stay silent', () => {
  const fresh = synthRows(NOW, ['tune:directness+1', 1]);
  const freshDigest = buildSoulHistoryDigest({ userName: 'Owner', historyRows: fresh, record: DEFAULT_SOUL_RECORD, nowMs: NOW });
  assert.ok(!freshDigest.lines.join('\n').includes('Style promise in force'), 'yesterday\u2019s tune is still the news — no callback yet');
  const stale = synthRows(NOW, ['tune:directness+1', 90]);
  const staleDigest = buildSoulHistoryDigest({ userName: 'Owner', historyRows: stale, record: DEFAULT_SOUL_RECORD, nowMs: NOW });
  assert.ok(!staleDigest.lines.join('\n').includes('Style promise in force'), 'a 90-day-old promise is stale — no callback');
  const ripe = synthRows(NOW, ['tune:directness+1', 10]);
  const ripeDigest = buildSoulHistoryDigest({ userName: 'Owner', historyRows: ripe, record: DEFAULT_SOUL_RECORD, nowMs: NOW });
  assert.ok(ripeDigest.lines.join('\n').includes('Style promise in force'), 'a 10-day-old promise may get a light nod');
});

test('deepening: learnings never cancel a promise', () => {
  const rows = synthRows(NOW,
    ['learn:evening:directness+', 2],
    ['tune:directness+1', 10],
  );
  const promise = activeStylePromise(rows);
  assert.ok(promise, 'learning rows do not cancel the promise');
  assert.equal(promise.phrase, 'more direct');
  const digest = buildSoulHistoryDigest({ userName: 'Owner', historyRows: rows, record: DEFAULT_SOUL_RECORD, nowMs: NOW });
  assert.ok(learnedLabels(rows).length >= 1, 'learning labels present');
  assert.ok(digest.lines.join('\n').includes('Read-the-room learnings'), 'learnings get their own line');
});

// --- consistency guard: the present is authoritative ----------------------

test('deepening: after a revert, the digest obeys the present, not the undone past', () => {
  const { db, user } = fixture();
  handleSoulCommand({ db, userId: user.id, message: 'be more blunt' }); // v1: directness 3→4
  handleSoulCommand({ db, userId: user.id, message: 'be more playful' }); // v2: playfulness 2→3
  handleSoulCommand({ db, userId: user.id, message: 'go back to how you were' }); // v3: back to v1
  const record = db.getSoulRecord(user.id);
  assert.equal(record.directness, 4, 'first tune kept');
  assert.equal(record.playfulness, 2, 'second tune undone');
  const digest = buildSoulHistoryDigest({ userName: 'Owner', historyRows: db.listSoulHistory(user.id, 12), record, nowMs: NOW });
  const text = digest.lines.join('\n');
  assert.ok(text.includes('Where things stand'), 'current-state line present');
  assert.ok(text.includes(shortSoulDescription(record)), 'line reflects the CURRENT record');
  assert.ok(!/Where things stand[^\n]*more playful/.test(text), 'undone tune not presented as current');
  assert.ok(text.includes('The road here'), 'the journey is still referenced');
});

test('deepening: digest renders the given record even when history disagrees', () => {
  const rows = synthRows(NOW, ['tune:directness+1', 10]);
  const custom = { ...DEFAULT_SOUL_RECORD, directness: 0, warmth: 0 };
  const digest = buildSoulHistoryDigest({ userName: 'Owner', historyRows: rows, record: custom, nowMs: NOW });
  const currentLine = digest.lines.find((l) => l.includes('Where things stand'));
  assert.ok(currentLine.includes(shortSoulDescription(custom)), 'present state wins over history');
  assert.ok(!currentLine.includes('more direct'), 'history tune not smuggled into the present');
});

// --- milestones -----------------------------------------------------------

test('deepening: relationship milestones by age', () => {
  const first = NOW - 45 * DAY;
  assert.equal(relationshipMilestone({ firstChangeAt: NOW - 10 * DAY, nowMs: NOW }), null, '10 days: no milestone');
  assert.equal(relationshipMilestone({ firstChangeAt: NOW - 30 * DAY, nowMs: NOW }).label, 'about a month');
  assert.equal(relationshipMilestone({ firstChangeAt: first, nowMs: NOW }).label, 'about a month');
  assert.equal(relationshipMilestone({ firstChangeAt: NOW - 100 * DAY, nowMs: NOW }).label, 'a few months');
  assert.equal(relationshipMilestone({ firstChangeAt: NOW - 200 * DAY, nowMs: NOW }).label, 'about half a year');
  assert.equal(relationshipMilestone({ firstChangeAt: NOW - 400 * DAY, nowMs: NOW }).label, 'a year');
  assert.equal(relationshipMilestone({ firstChangeAt: NaN, nowMs: NOW }), null, 'bad date: null');
  assert.equal(relationshipMilestone({ firstChangeAt: NOW + DAY, nowMs: NOW }), null, 'future date: null');
});

test('deepening: milestone line is rare — offered once per 30 days, one warm line', () => {
  const rows = synthRows(NOW, ['tune:directness+1', 45], ['tune:playfulness+1', 60]);
  const first = buildSoulHistoryDigest({ userName: 'Owner', historyRows: rows, record: DEFAULT_SOUL_RECORD, nowMs: NOW, milestoneLastPromptedAt: null });
  assert.equal(first.milestoneOffered, true, 'first offer');
  const line = first.lines.find((l) => l.includes('Milestone'));
  assert.ok(line, 'milestone line present');
  assert.ok(line.includes('about a month'), 'milestone label');
  assert.ok(line.includes('never saccharine'), 'restraint instruction');
  assert.ok(line.split('\n').length === 1, 'one line, not a paragraph');

  const recent = buildSoulHistoryDigest({ userName: 'Owner', historyRows: rows, record: DEFAULT_SOUL_RECORD, nowMs: NOW, milestoneLastPromptedAt: NOW - 10 * DAY });
  assert.equal(recent.milestoneOffered, false, 'suppressed within 30 days');
  assert.ok(!recent.lines.join('\n').includes('Milestone'), 'no milestone line');

  const refill = buildSoulHistoryDigest({ userName: 'Owner', historyRows: rows, record: DEFAULT_SOUL_RECORD, nowMs: NOW, milestoneLastPromptedAt: NOW - 40 * DAY });
  assert.equal(refill.milestoneOffered, true, 'offered again after 30 days');
});

test('deepening: milestone marker round-trips per user', () => {
  const { db, user, other } = fixture();
  assert.equal(getMilestonePromptedAt(db, user.id), null, 'starts unset');
  markMilestonePrompted(db, user.id, NOW);
  assert.equal(getMilestonePromptedAt(db, user.id), NOW, 'stored');
  assert.equal(getMilestonePromptedAt(db, other.id), null, 'per-user isolated');
});

// --- isolation ------------------------------------------------------------

test('deepening: history is per-user — one user\u2019s journey never shapes another\u2019s digest', () => {
  const { db, user, other } = fixture();
  handleSoulCommand({ db, userId: user.id, message: 'be more blunt' });
  const otherRows = db.listSoulHistory(other.id, 12);
  assert.equal(otherRows.length, 0, 'other user has no history');
  assert.equal(buildSoulHistoryDigest({ userName: 'Other', historyRows: otherRows, record: db.getSoulRecord(other.id), nowMs: NOW }), null, 'no digest from nothing');
  const otherDirective = resolveAdaptiveSoulDirective({ db, userId: other.id, isDemo: false, userName: 'Other', message: 'hey', timeZone: 'America/New_York', nowMs: NOW });
  assert.ok(!otherDirective.includes('Continuity'), 'untouched user gets no digest');
});
