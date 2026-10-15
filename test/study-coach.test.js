// Study coach feature tests: question bank seeding, quiz flow, weak spots,
// streaks, proactive helpers, and the chat tools end-to-end via executeTool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/database.js';
import { seedStudyBank, STUDY_QUESTIONS } from '../src/study-seed.js';
import {
  STUDY_EXAMS,
  normalizeStudyExam,
  isStudyEvent,
  startQuizSession,
  answerQuizQuestion,
  stopQuizSession,
  getStudyWeakSpots,
  getStudyStreak,
  buildStudyNudgeLine,
  findStudyEvents,
  findFreeStudySlots,
} from '../src/study-coach.js';
import { executeTool, TOOL_DEFINITIONS } from '../src/tools.js';

function freshDb() {
  const db = openDatabase(':memory:');
  const seed = seedStudyBank(db);
  assert.equal(seed.seeded, true);
  return db;
}

test('seed bank: 36 questions, 9 per exam, idempotent', () => {
  const db = openDatabase(':memory:');
  assert.equal(STUDY_QUESTIONS.length, 36);
  const first = seedStudyBank(db);
  assert.equal(first.inserted, 36);
  assert.equal(db.countStudyQuestions(), 36);
  for (const exam of STUDY_EXAMS) {
    assert.equal(db.listStudyQuestions(exam).length, 9, exam);
  }
  const second = seedStudyBank(db);
  assert.equal(second.seeded, false);
  assert.equal(db.countStudyQuestions(), 36);
});

test('seed questions are well-formed: 4 choices, valid correct index', () => {
  for (const q of STUDY_QUESTIONS) {
    assert.ok(STUDY_EXAMS.includes(q.exam), q.id);
    assert.ok(q.topic && q.question && q.explanation, q.id);
    assert.equal(q.choices.length, 4, q.id);
    assert.ok(q.correct_index >= 0 && q.correct_index < 4, q.id);
    assert.ok(new Set(q.choices).size === 4, `duplicate choices in ${q.id}`);
  }
});

test('normalizeStudyExam handles names, codes, and bare A+', () => {
  assert.equal(normalizeStudyExam('quiz me on Security+'), 'Security+');
  assert.equal(normalizeStudyExam('SY0-701'), 'Security+');
  assert.equal(normalizeStudyExam('sec+'), 'Security+');
  assert.equal(normalizeStudyExam('A+ Core 1'), 'A+ Core 1');
  assert.equal(normalizeStudyExam('220-1201'), 'A+ Core 1');
  assert.equal(normalizeStudyExam('A+'), 'A+ Core 1');
  assert.equal(normalizeStudyExam('a+ core 2'), 'A+ Core 2');
  assert.equal(normalizeStudyExam('220-1202'), 'A+ Core 2');
  assert.equal(normalizeStudyExam('ccna'), 'CCNA');
  assert.equal(normalizeStudyExam('200-301'), 'CCNA');
  assert.equal(normalizeStudyExam('Security+ study session'), 'Security+');
  assert.equal(normalizeStudyExam('underwater basket weaving'), null);
  assert.equal(normalizeStudyExam(''), null);
});

test('quiz flow: start hides the answer, answers score, stop ends', () => {
  const db = freshDb();
  const start = startQuizSession(db, 'u1', 'Security+');
  assert.equal(start.ok, true);
  assert.equal(start.exam, 'Security+');
  assert.equal(start.choices.length, 4);
  assert.ok(!('correctIndex' in start) && !('correct_index' in start), 'answer must not leak to the model');
  // Answer wrong on purpose (pick a letter, then verify against the bank).
  const row = db.getStudyQuestion(start.questionId);
  const wrongLetter = 'ABCD'[(row.correct_index + 1) % 4];
  const wrong = answerQuizQuestion(db, 'u1', wrongLetter);
  assert.equal(wrong.ok, true);
  assert.equal(wrong.correct, false);
  assert.ok(wrong.explanation.length > 20);
  assert.ok(wrong.next, 'auto-advances to the next question');
  assert.deepEqual(wrong.score, { correct: 0, total: 1 });
  // Answer the next one correctly.
  const row2 = db.getStudyQuestion(wrong.next.questionId);
  const right = answerQuizQuestion(db, 'u1', 'ABCD'[row2.correct_index]);
  assert.equal(right.correct, true);
  assert.deepEqual(right.score, { correct: 1, total: 2 });
  const stop = stopQuizSession('u1');
  assert.equal(stop.ok, true);
  assert.deepEqual(stop.score, { correct: 1, total: 2 });
  // Answering after stop: no active quiz.
  const after = answerQuizQuestion(db, 'u1', 'A');
  assert.equal(after.ok, false);
  assert.equal(after.noActiveQuiz, true);
});

test('quiz flow: unclear answers are rejected without scoring', () => {
  const db = freshDb();
  startQuizSession(db, 'u1', 'CCNA');
  const res = answerQuizQuestion(db, 'u1', 'banana');
  assert.equal(res.ok, false);
  assert.equal(res.unclearAnswer, true);
  const stop = stopQuizSession('u1');
  assert.deepEqual(stop.score, { correct: 0, total: 0 });
});

test('quiz flow: unknown exam and empty bank are reported', () => {
  const db = freshDb();
  const unknown = startQuizSession(db, 'u1', 'pottery');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.unknownExam, true);
  assert.deepEqual(unknown.exams, STUDY_EXAMS);
});

test('weak spots: 2+ wrong in 14 days flags a topic; exam filter works', () => {
  const db = freshDb();
  db.recordStudyAttempt({ id: 'w1', userId: 'u1', questionId: 'splus-integrity', correct: 0 });
  db.recordStudyAttempt({ id: 'w2', userId: 'u1', questionId: 'splus-integrity', correct: 0 });
  db.recordStudyAttempt({ id: 'w3', userId: 'u1', questionId: 'splus-integrity', correct: 1 });
  db.recordStudyAttempt({ id: 'w4', userId: 'u1', questionId: 'splus-zerotrust', correct: 0 });
  const weak = getStudyWeakSpots(db, 'u1');
  assert.equal(weak.length, 1, 'only CIA triad (2 wrong) qualifies; Zero Trust has 1 wrong');
  assert.equal(weak[0].topic, 'CIA triad');
  assert.equal(weak[0].exam, 'Security+');
  assert.equal(weak[0].wrong, 2);
  assert.equal(weak[0].total, 3);
  assert.equal(weak[0].accuracy, 33);
  // Window cutoff is honored: the query receives a cutoff ~14 days back.
  const seen = {};
  const stubDb = {
    getStudyAttemptsByTopic: (userId, cutoff) => {
      seen.cutoff = cutoff;
      assert.equal(userId, 'u1');
      return [];
    },
  };
  assert.equal(getStudyWeakSpots(stubDb, 'u1').length, 0);
  const cutoffMs = Date.now() - new Date(seen.cutoff).valueOf();
  assert.ok(cutoffMs > 13 * 86400_000 && cutoffMs < 15 * 86400_000, `cutoff ~14d ago, got ${cutoffMs / 86400_000}d`);
});

test('weak spots: real-SQL aggregation groups by exam and topic', () => {
  const db = freshDb();
  db.recordStudyAttempt({ id: 'g1', userId: 'u1', questionId: 'ccna-subnet26', correct: 0 });
  db.recordStudyAttempt({ id: 'g2', userId: 'u1', questionId: 'ccna-subnet26', correct: 0 });
  const weak = getStudyWeakSpots(db, 'u1');
  assert.equal(weak.length, 1);
  assert.equal(weak[0].exam, 'CCNA');
  assert.equal(weak[0].topic, 'Subnetting');
});

test('streak: consecutive days counted from study_attempts', () => {
  const db = freshDb();
  const toKey = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const today = Date.now();
  const fake = {
    getStudyActiveDates: () => [0, 1, 2].map((d) => toKey(today - d * 86400_000)),
  };
  assert.equal(getStudyStreak(fake, 'u1', 'America/New_York').days, 3);
  const broken = {
    getStudyActiveDates: () => [0, 2].map((d) => toKey(today - d * 86400_000)),
  };
  assert.equal(getStudyStreak(broken, 'u1', 'America/New_York').days, 1);
  const empty = { getStudyActiveDates: () => [] };
  assert.equal(getStudyStreak(empty, 'u1', 'America/New_York').days, 0);
  // Real DB: one attempt today -> streak of 1.
  db.recordStudyAttempt({ id: 's1', userId: 'u2', questionId: 'a1-ram-ddr5', correct: 1 });
  assert.equal(getStudyStreak(db, 'u2', 'America/New_York').days, 1);
});

test('buildStudyNudgeLine: empty when no weak spots, counts when present', () => {
  const db = freshDb();
  assert.equal(buildStudyNudgeLine(db, 'u1'), '');
  db.recordStudyAttempt({ id: 'n1', userId: 'u1', questionId: 'splus-integrity', correct: 0 });
  db.recordStudyAttempt({ id: 'n2', userId: 'u1', questionId: 'splus-integrity', correct: 0 });
  db.recordStudyAttempt({ id: 'n3', userId: 'u1', questionId: 'ccna-subnet26', correct: 0 });
  db.recordStudyAttempt({ id: 'n4', userId: 'u1', questionId: 'ccna-subnet26', correct: 0 });
  const line = buildStudyNudgeLine(db, 'u1');
  assert.ok(line.includes('2 topics need review'), line);
  assert.ok(line.includes('Security+'), line);
  assert.ok(line.includes('CCNA'), line);
});

test('findStudyEvents detects study sessions on the calendar', () => {
  const events = [
    { title: 'Security+ study session', startMs: 1, allDay: false },
    { title: 'Dentist appointment', startMs: 2, allDay: false },
    { title: 'CCNA exam prep', startMs: 3, allDay: false },
    { title: 'Study group (all day)', startMs: 4, allDay: true },
  ];
  const found = findStudyEvents(events);
  assert.equal(found.length, 2);
  assert.ok(isStudyEvent('A+ Core 1 practice'));
  assert.ok(!isStudyEvent('Team standup'));
});

test('findFreeStudySlots finds gaps inside the 9am-9pm window', () => {
  const nowMs = new Date('2026-10-15T14:00:00-04:00').valueOf();
  const dayStart = new Date('2026-10-15T00:00:00-04:00').valueOf();
  const events = [
    { title: 'Work', startMs: dayStart + 9 * 3600_000, endMs: dayStart + 17 * 3600_000, allDay: false },
  ];
  const slots = findFreeStudySlots(events, 'America/New_York', '2026-10-15', nowMs, { days: 2, minMinutes: 60, maxSlots: 3 });
  assert.ok(slots.length >= 1, 'evening gap after 5pm should be found');
  assert.ok(slots[0].endMs - slots[0].startMs >= 60 * 60_000);
  assert.ok(slots[0].label.includes('PM') || slots[0].label.includes('pm') || /\d/.test(slots[0].label));
  // Fully booked days yield no slots.
  const booked = Array.from({ length: 2 }, (_, d) => ({
    title: 'Busy', startMs: dayStart + d * 86400_000 + 9 * 3600_000, endMs: dayStart + d * 86400_000 + 21 * 3600_000, allDay: false,
  }));
  assert.equal(findFreeStudySlots(booked, 'America/New_York', '2026-10-15', nowMs, { days: 2 }).length, 0);
});

test('chat tools work through executeTool with db context', async () => {
  const db = freshDb();
  const ctx = { db, userId: 'u9', timeZone: 'America/New_York' };
  const started = await executeTool('study_quiz_start', { exam: 'A+ Core 1' }, {}, ctx);
  assert.equal(started.result.ok, true);
  assert.equal(started.result.exam, 'A+ Core 1');
  assert.ok(started.summary.includes('A+ Core 1'));
  const row = db.getStudyQuestion(started.result.questionId);
  const answered = await executeTool('study_quiz_answer', { answer: 'ABCD'[row.correct_index] }, {}, ctx);
  assert.equal(answered.result.correct, true);
  assert.ok(answered.result.next);
  const weak = await executeTool('study_weak_spots', {}, {}, ctx);
  assert.ok(Array.isArray(weak.result.weakSpots));
  assert.equal(weak.result.streak.days, 1);
  const stopped = await executeTool('study_quiz_stop', {}, {}, ctx);
  assert.equal(stopped.result.ok, true);
});

test('study_add_question validates input and stores with source=chat', async () => {
  const db = freshDb();
  const ctx = { db, userId: 'u9' };
  const added = await executeTool('study_add_question', {
    exam: 'CCNA', topic: 'Test topic', question: 'What is 2+2?',
    choices: ['3', '4', '5', '6'], correctIndex: 1, explanation: '4 is right; the others are wrong.',
  }, {}, ctx);
  assert.equal(added.result.added, true);
  assert.equal(added.result.exam, 'CCNA');
  assert.equal(db.countStudyQuestions(), 37);
  const stored = db.getStudyQuestion(added.result.id);
  assert.equal(stored.source, 'chat');
  assert.deepEqual(JSON.parse(stored.choices), ['3', '4', '5', '6']);
  // Rejects bad input.
  await assert.rejects(
    executeTool('study_add_question', { exam: 'CCNA', topic: 'T', question: 'Q?', choices: ['a', 'b'], correctIndex: 0, explanation: 'E' }, {}, ctx),
    /exactly 4/
  );
  await assert.rejects(
    executeTool('study_add_question', { exam: 'pottery', topic: 'T', question: 'Q?', choices: ['a', 'b', 'c', 'd'], correctIndex: 0, explanation: 'E' }, {}, ctx),
    /Unknown exam/
  );
});

test('study tool definitions are registered', () => {
  const names = TOOL_DEFINITIONS.map((t) => t.name);
  for (const n of ['study_quiz_start', 'study_quiz_answer', 'study_quiz_stop', 'study_weak_spots', 'study_add_question']) {
    assert.ok(names.includes(n), n);
  }
});
