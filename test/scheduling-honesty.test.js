import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSchedulingClaim,
  parseMonthDay,
  resolveClaimDate,
  enforceSchedulingHonesty,
  SCHEDULING_TOOL_NAMES,
} from '../src/scheduling-honesty.js';

// Fixed "now" for deterministic date tests: Sat 2026-10-17.
const NOW = new Date('2026-10-17T14:00:00Z');
const TZ = 'America/New_York';

function fakeDb() {
  const followUps = [];
  const events = [];
  return {
    addFollowUp: (userId, { description, dueDate, sourceMessageId }) => {
      const rec = { id: 'fu-1', user_id: userId, description, due_date: dueDate, dueDate, sourceMessageId };
      followUps.push(rec);
      return rec;
    },
    addEvent: (userId, kind, text) => { events.push({ userId, kind, text }); },
    _followUps: followUps,
    _events: events,
  };
}

test('detectSchedulingClaim finds past-tense claims', () => {
  const c = detectSchedulingClaim("I've scheduled a check-in for November 6 to see whether it arrived.");
  assert.ok(c);
  assert.equal(c.kind, 'past');
  assert.equal(c.description, 'check-in');
  assert.equal(c.datePhrase, 'November 6');
});

test('detectSchedulingClaim finds future promises', () => {
  const c = detectSchedulingClaim("I'll remind you tomorrow about the meeting.");
  assert.ok(c);
  assert.equal(c.kind, 'future');
});

test('detectSchedulingClaim ignores offers and non-claims', () => {
  assert.equal(detectSchedulingClaim('I can schedule that for you if you want.'), null);
  assert.equal(detectSchedulingClaim('The meeting is on November 6.'), null);
  assert.equal(detectSchedulingClaim(''), null);
  assert.equal(detectSchedulingClaim(null), null);
});

test('parseMonthDay handles "November 6"', () => {
  assert.equal(parseMonthDay('November 6', TZ, NOW), '2026-11-06');
  assert.equal(parseMonthDay('Nov 6', TZ, NOW), '2026-11-06');
});

test('parseMonthDay rolls past dates to next year', () => {
  // Oct 17 now; "January 5" already passed this year.
  assert.equal(parseMonthDay('January 5', TZ, NOW), '2027-01-05');
});

test('parseMonthDay rejects impossible dates', () => {
  assert.equal(parseMonthDay('February 30', TZ, NOW), null);
  assert.equal(parseMonthDay('not a date', TZ, NOW), null);
});

test('resolveClaimDate handles relative phrases', () => {
  assert.equal(resolveClaimDate('tomorrow', TZ, NOW), '2026-10-18');
});

test('enforceSchedulingHonesty does nothing when a scheduling tool was called', () => {
  const db = fakeDb();
  const answer = "I've scheduled a check-in for November 6.";
  const { answer: out, created } = enforceSchedulingHonesty({
    answer, toolCalls: [{ name: 'schedule_followup' }], db, userId: 'u1', timeZone: TZ,
  });
  assert.equal(out, answer);
  assert.equal(created, null);
  assert.equal(db._followUps.length, 0);
});

test('enforceSchedulingHonesty auto-creates the follow-up on hallucinated claim', () => {
  const db = fakeDb();
  const answer = "I've scheduled a check-in for November 6 to see whether it arrived.";
  const { answer: out, created } = enforceSchedulingHonesty({
    answer, toolCalls: [], db, userId: 'u1', timeZone: TZ, sourceMessageId: 'm1',
  });
  assert.ok(created);
  assert.equal(created.description, 'check-in');
  assert.equal(created.due_date, '2026-11-06');
  // The answer stands — it's now true.
  assert.equal(out, answer);
  assert.ok(db._events.some((e) => e.kind === 'followup_noted'));
});

test('enforceSchedulingHonesty rewrites when creation fails', () => {
  const db = fakeDb();
  db.addFollowUp = () => { throw new Error('db down'); };
  const answer = "I've scheduled a check-in for November 6.";
  const { answer: out, created, corrected } = enforceSchedulingHonesty({
    answer, toolCalls: [], db, userId: 'u1', timeZone: TZ,
  });
  assert.equal(created, null);
  assert.equal(corrected, true);
  assert.ok(!/I've scheduled/i.test(out), 'false claim removed');
  assert.ok(db._followUps.length === 0);
});

test('enforceSchedulingHonesty ignores vague non-date claims', () => {
  const db = fakeDb();
  const answer = "I've scheduled a thing for someday soon.";
  const { answer: out, created } = enforceSchedulingHonesty({
    answer, toolCalls: [], db, userId: 'u1', timeZone: TZ,
  });
  // "someday soon" isn't a parseable date — not treated as a claim.
  assert.equal(out, answer);
  assert.equal(created, null);
  assert.equal(db._followUps.length, 0);
});

test('enforceSchedulingHonesty passes through clean replies', () => {
  const db = fakeDb();
  const answer = 'Sounds good, let me know how it goes!';
  const { answer: out, created } = enforceSchedulingHonesty({
    answer, toolCalls: [], db, userId: 'u1', timeZone: TZ,
  });
  assert.equal(out, answer);
  assert.equal(created, null);
});

test('SCHEDULING_TOOL_NAMES covers the write tools', () => {
  assert.ok(SCHEDULING_TOOL_NAMES.has('create_task'));
  assert.ok(SCHEDULING_TOOL_NAMES.has('schedule_followup'));
  assert.ok(SCHEDULING_TOOL_NAMES.has('create_routine'));
});
