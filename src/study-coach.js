// Study coach: shared quiz, weak-spot, streak, and proactive-scheduling logic.
// Used by the chat tools (src/tools.js) and the proactive runner (server.js).
// DB access is via the passed db handle (sync facade for both SQLite and
// PostgreSQL), so this module stays driver-agnostic.
//
// Quiz session state lives in-memory per userId (module-level Map). This is a
// deliberate tradeoff, documented here: quizzes are short interactive sessions
// (minutes), and every answer is persisted to study_attempts, so a server
// restart only ends the in-progress session — weak-spot tracking, streaks,
// and the question bank all survive. No extra session table needed.

import { randomUUID } from 'node:crypto';
import { dayStartMs } from './ical.js';

export const STUDY_EXAMS = ['A+ Core 1', 'A+ Core 2', 'Security+', 'CCNA'];

// Days of wrong-answer history that count toward weak-spot detection.
export const WEAK_SPOT_DAYS = 14;
// A topic is "weak" when it has at least this many wrong answers in the window.
export const WEAK_SPOT_MIN_WRONG = 2;

// Calendar titles that look like study sessions.
export const STUDY_EVENT_RE = /\b(stud(y|ying)|comptia|security\s*\+|sy0-?701|a\s*\+\s*(core\s*)?[12]?|220-?120[12]|ccna|200-?301|professor\s*messer|certblaster|exam\s*prep)\b/i;

const EXAM_ALIASES = [
  { exam: 'Security+', re: /(security\s*\+|sy0-?701|sec\s*\+)/i },
  { exam: 'A+ Core 1', re: /(a\s*\+\s*core\s*1|220-?1201|core\s*1)/i },
  { exam: 'A+ Core 2', re: /(a\s*\+\s*core\s*2|220-?1202|core\s*2)/i },
  { exam: 'CCNA', re: /(ccna|200-?301)/i },
];

export function normalizeStudyExam(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  for (const { exam, re } of EXAM_ALIASES) {
    if (re.test(text)) return exam;
  }
  // Bare "A+" without a core number defaults to Core 1 (his first exam).
  if (/\ba\s*\+/i.test(text)) return 'A+ Core 1';
  return null;
}

export function isStudyEvent(title) {
  return STUDY_EVENT_RE.test(String(title || ''));
}

// ---------------------------------------------------------------------------
// Quiz sessions (in-memory)
// ---------------------------------------------------------------------------

const quizSessions = new Map(); // userId -> session

function shapeQuestion(row) {
  let choices = [];
  try {
    const parsed = JSON.parse(row.choices);
    if (Array.isArray(parsed)) choices = parsed.map((c) => String(c));
  } catch { /* malformed bank row: filtered out below */ }
  return {
    id: row.id,
    exam: row.exam,
    topic: row.topic,
    question: row.question,
    choices: choices.map((text, i) => ({ letter: 'ABCD'[i] || String(i + 1), text })),
    correctIndex: Number(row.correct_index),
    explanation: row.explanation,
  };
}

function presentQuestion(q) {
  return {
    questionId: q.id,
    topic: q.topic,
    question: q.question,
    choices: q.choices,
  };
}

function pickNext(bank, session) {
  let candidates = bank.filter((q) => !session.askedIds.has(q.id));
  let restarted = false;
  if (!candidates.length) {
    // Bank exhausted mid-quiz: reshuffle rather than stopping.
    candidates = bank.slice();
    session.askedIds.clear();
    restarted = true;
  }
  const next = candidates[Math.floor(Math.random() * candidates.length)];
  return { next, restarted };
}

function parseAnswer(input, choices) {
  const text = String(input || '').trim();
  if (!text) return -1;
  const letter = text.match(/^([a-d])[\).\s]*$/i);
  if (letter) return letter[1].toUpperCase().charCodeAt(0) - 65;
  const digit = text.match(/^([1-4])[\).\s]*$/);
  if (digit) return Number(digit[1]) - 1;
  const lower = text.toLowerCase();
  for (let i = 0; i < choices.length; i += 1) {
    const choice = String(choices[i].text).toLowerCase();
    if (choice === lower) return i;
  }
  // Forgiving match: user pasted/typed the start of a choice.
  if (lower.length >= 4) {
    for (let i = 0; i < choices.length; i += 1) {
      if (String(choices[i].text).toLowerCase().startsWith(lower)) return i;
    }
  }
  return -1;
}

export function startQuizSession(db, userId, examInput) {
  const exam = normalizeStudyExam(examInput);
  if (!exam) return { ok: false, unknownExam: true, exams: STUDY_EXAMS };
  const bank = (db.listStudyQuestions(exam) || []).map(shapeQuestion)
    .filter((q) => q.choices.length >= 2 && q.correctIndex >= 0 && q.correctIndex < q.choices.length);
  if (!bank.length) return { ok: false, emptyBank: true, exam };
  const session = { exam, bank, askedIds: new Set(), correct: 0, total: 0, current: null };
  const { next } = pickNext(bank, session);
  session.current = next;
  session.askedIds.add(next.id);
  quizSessions.set(userId, session);
  return { ok: true, exam, ...presentQuestion(next), score: { correct: 0, total: 0 }, bankRestarted: false };
}

export function answerQuizQuestion(db, userId, answerInput) {
  const session = quizSessions.get(userId);
  if (!session || !session.current) return { ok: false, noActiveQuiz: true };
  const q = session.current;
  const chosen = parseAnswer(answerInput, q.choices);
  if (chosen < 0 || chosen >= q.choices.length) {
    return { ok: false, unclearAnswer: true, choices: q.choices };
  }
  const correct = chosen === q.correctIndex;
  session.total += 1;
  if (correct) session.correct += 1;
  // Every answer is a study-activity record: drives weak spots + streaks even
  // if the process restarts mid-quiz.
  try {
    db.recordStudyAttempt({ id: randomUUID(), userId, questionId: q.id, correct: correct ? 1 : 0 });
  } catch { /* best-effort: the quiz flow must not break on a logging failure */ }
  session.current = null;
  const { next, restarted } = pickNext(session.bank, session);
  let nextPayload = null;
  if (next) {
    session.current = next;
    session.askedIds.add(next.id);
    nextPayload = presentQuestion(next);
  }
  return {
    ok: true,
    correct,
    yourAnswer: q.choices[chosen].text,
    yourLetter: q.choices[chosen].letter,
    correctAnswer: q.choices[q.correctIndex].text,
    correctLetter: q.choices[q.correctIndex].letter,
    explanation: q.explanation,
    score: { correct: session.correct, total: session.total },
    next: nextPayload,
    bankRestarted: restarted,
    quizComplete: !nextPayload,
  };
}

export function stopQuizSession(userId) {
  const session = quizSessions.get(userId);
  quizSessions.delete(userId);
  if (!session) return { ok: false, noActiveQuiz: true };
  return { ok: true, exam: session.exam, score: { correct: session.correct, total: session.total } };
}

export function getActiveQuizExam(userId) {
  return quizSessions.get(userId)?.exam || null;
}

// ---------------------------------------------------------------------------
// Weak spots + streaks (derived from study_attempts — no extra tables)
// ---------------------------------------------------------------------------

// Weak-topic heuristic (kept simple on purpose): a topic is weak when it has
// at least WEAK_SPOT_MIN_WRONG wrong answers in the last WEAK_SPOT_DAYS days.
// Returns [{ exam, topic, wrong, total, accuracy }] sorted worst-first.
export function getStudyWeakSpots(db, userId, days = WEAK_SPOT_DAYS) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = db.getStudyAttemptsByTopic(userId, cutoff) || [];
  return rows
    .map((r) => {
      const total = Number(r.total) || 0;
      const wrong = Number(r.wrong) || 0;
      return {
        exam: r.exam,
        topic: r.topic,
        wrong,
        total,
        accuracy: total ? Math.round((100 * (total - wrong)) / total) : 0,
      };
    })
    .filter((r) => r.wrong >= WEAK_SPOT_MIN_WRONG)
    .sort((a, b) => b.wrong - a.wrong || a.accuracy - b.accuracy);
}

// Consecutive local days with at least one recorded quiz answer, ending today
// (or yesterday — today's session may not have happened yet). Pure read of
// study_attempts; nothing to write or migrate.
export function getStudyStreak(db, userId, timeZone) {
  const days = db.getStudyActiveDates(userId) || [];
  const set = new Set(days);
  const dayMs = 86400_000;
  const toKey = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone });
  const todayKey = toKey(Date.now());
  let cursor = Date.now();
  if (!set.has(todayKey)) cursor -= dayMs;
  let streak = 0;
  while (set.has(toKey(cursor))) {
    streak += 1;
    cursor -= dayMs;
  }
  return { days: streak, lastActiveDate: days[0] || null };
}

export function getLastStudyActivity(db, userId) {
  try {
    return db.getLastStudyActivity(userId) || null;
  } catch {
    return null;
  }
}

// One-line briefing nudge, or '' when there is nothing to surface. Never nags
// when empty — the caller only appends it when non-empty.
export function buildStudyNudgeLine(db, userId) {
  let weak = [];
  try { weak = getStudyWeakSpots(db, userId); } catch { return ''; }
  if (!weak.length) return '';
  const byExam = new Map();
  for (const w of weak) {
    if (!byExam.has(w.exam)) byExam.set(w.exam, []);
    byExam.get(w.exam).push(w.topic);
  }
  const parts = [...byExam.entries()].map(([exam, topics]) => {
    const shown = topics.slice(0, 3).join(', ');
    const more = topics.length > 3 ? ` +${topics.length - 3} more` : '';
    return `${topics.length} ${exam} topic${topics.length === 1 ? '' : 's'} (${shown}${more})`;
  });
  const total = weak.length;
  return `${total} ${total === 1 ? 'topic needs' : 'topics need'} review based on recent quiz misses: ${parts.join('; ')}.`;
}

// ---------------------------------------------------------------------------
// Proactive scheduling helpers
// ---------------------------------------------------------------------------

export function findStudyEvents(events) {
  return (events || []).filter((e) => !e.allDay && isStudyEvent(e.title));
}

// Free blocks of at least minMinutes inside the 09:00–21:00 local window for
// each of the next `days` days. Returns [{ dateStr, dayLabel, startMs, endMs }]
// spread across days (first gap per day), capped at maxSlots.
export function findFreeStudySlots(events, timeZone, todayStr, nowMs, { days = 7, minMinutes = 60, maxSlots = 3 } = {}) {
  const busy = (events || [])
    .filter((e) => !e.allDay && e.startMs && e.endMs)
    .map((e) => ({ start: e.startMs, end: e.endMs }))
    .sort((a, b) => a.start - b.start);
  const slots = [];
  const minMs = minMinutes * 60_000;
  const toDayLabel = (dateStr) => new Date(`${dateStr}T12:00:00Z`)
    .toLocaleDateString('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' });
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
  for (let d = 0; d < days && slots.length < maxSlots; d += 1) {
    const dayStart = dayStartMs(todayStr, d, timeZone);
    if (!dayStart) continue;
    const windowStart = dayStart + 9 * 3600_000;
    const windowEnd = dayStart + 21 * 3600_000;
    const dayBusy = busy
      .filter((b) => b.end > windowStart && b.start < windowEnd)
      .map((b) => ({ start: Math.max(b.start, windowStart), end: Math.min(b.end, windowEnd) }));
    // Merge overlaps, then find gaps.
    dayBusy.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const b of dayBusy) {
      const last = merged[merged.length - 1];
      if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
      else merged.push({ ...b });
    }
    let cursor = Math.max(windowStart, d === 0 ? nowMs : windowStart);
    for (const b of [...merged, { start: windowEnd, end: windowEnd }]) {
      if (b.start - cursor >= minMs) {
        const dateStr = new Date(dayStart).toLocaleDateString('en-CA', { timeZone });
        slots.push({
          dateStr,
          dayLabel: toDayLabel(dateStr),
          startMs: cursor,
          endMs: cursor + minMs,
          label: `${toDayLabel(dateStr)} ${fmtTime(cursor)}–${fmtTime(cursor + minMs)}`,
        });
        break; // one slot per day keeps the suggestion spread out
      }
      cursor = Math.max(cursor, b.end);
    }
  }
  return slots;
}
