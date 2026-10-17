// Scheduling honesty guardrail (2026-10-17).
//
// Root cause: Orbit told Edward "I've scheduled a check-in for November 6"
// without calling any scheduling tool — a hallucinated claim. The system
// prompt already says "only claim creation AFTER the tool returns", but the
// model ignored it. Instructions alone aren't reliable; this is a
// server-side enforcement layer.
//
// When the model's reply claims to have scheduled something but no
// scheduling tool was called this turn, we make the claim true: parse the
// date + description from the reply and create the follow-up for real.
// If we can't parse it, we rewrite the reply to remove the false claim
// rather than let a lie through.
//
// Invisible complexity: no UI, no toggles. Orbit just stops lying.
//
// Self-contained by design: zero imports from the app's dependency chain,
// so this guardrail can never break the chat flow it protects.

export const SCHEDULING_TOOL_NAMES = new Set(['create_task', 'schedule_followup', 'create_routine']);

// Minimal relative-date resolver (mirrors src/tools.js resolveRelativeDate
// for the phrases that appear in scheduling claims). Kept local so this
// module has no imports.
function resolveRelativeDateLocal(value, timeZone = 'America/New_York', now = new Date()) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const zone = timeZone || 'America/New_York';
  let local;
  try {
    local = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch (_) {
    local = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }
  const [y, m, d] = local.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const fmt = (dt) => dt.toISOString().slice(0, 10);
  const addDays = (dt, n) => new Date(dt.getTime() + n * 86400000);
  const q = raw.toLowerCase().replace(/\s+/g, ' ');
  if (q === 'today' || q === 'tonight') return fmt(base);
  if (q === 'tomorrow') return fmt(addDays(base, 1));
  if (q === 'day after tomorrow') return fmt(addDays(base, 2));
  if (q === 'next week') return fmt(addDays(base, 7));
  const weekdays = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const named = /^(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(q);
  if (named) {
    const target = weekdays[named[2]];
    const dow = base.getUTCDay();
    if (named[1]) return fmt(addDays(base, ((target - dow + 7) % 7 || 7) + 7));
    return fmt(addDays(base, (target - dow + 7) % 7));
  }
  return null;
}

// Past-tense claims: "I've scheduled a check-in for November 6",
// "I scheduled a reminder for tomorrow", "I've set up a follow-up for Nov 6".
// The date phrase is matched precisely (month-day, relative phrase, or ISO)
// so trailing sentence text isn't swallowed.
const MONTH_RE = '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\\w*\\s+\\d{1,2}(?:st|nd|rd|th)?';
const RELATIVE_RE = '(?:today|tonight|tomorrow|day after tomorrow|next week|next\\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|sunday|monday|tuesday|wednesday|thursday|friday|saturday)';
const ISO_RE = '\\d{4}-\\d{2}-\\d{2}';
const DATE_PHRASE_RE = `(?:${MONTH_RE}|${RELATIVE_RE}|${ISO_RE})`;
const PAST_CLAIM_RE = new RegExp(
  `\\bi(?:'ve|\u2019ve| have)\\s+(?:scheduled|set\\s+up|created)\\s+(?:a\\s+|an\\s+|the\\s+)?([^.,;!?\\n]{1,60}?)\\s+for\\s+(${DATE_PHRASE_RE})`, 'i'
);

// Future promises: "I'll remind you tomorrow", "I'll check in on November 6",
// "I'll follow up next Friday". These are promises the user will hold us to.
const FUTURE_CLAIM_RE = new RegExp(
  `\\bi(?:'ll|\u2019ll| will)\\s+(remind you|check in|follow up)\\s+(?:on\\s+|for\\s+)?(${DATE_PHRASE_RE})`, 'i'
);

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

// Parse "November 6" / "Nov 6" into YYYY-MM-DD. Rolls to next year if the
// date already passed this year. Returns null when unparseable.
export function parseMonthDay(phrase, timeZone = 'America/New_York', now = new Date()) {
  const m = /^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\w*\s+(\d{1,2})(?:st|nd|rd|th)?$/i.exec(String(phrase || '').trim());
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  const day = Number(m[2]);
  if (!month || day < 1 || day > 31) return null;
  const local = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  let year = Number(local.slice(0, 4));
  const todayStr = local;
  const candidate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Basic sanity: reject impossible dates like Feb 30.
  const check = new Date(`${candidate}T12:00:00Z`);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  if (candidate < todayStr) year += 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Resolve a date phrase from a scheduling claim into YYYY-MM-DD.
export function resolveClaimDate(phrase, timeZone = 'America/New_York', now = new Date()) {
  const cleaned = String(phrase || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return null;
  // 1. Relative phrases via the local resolver ("tomorrow", "next Friday").
  const relative = resolveRelativeDateLocal(cleaned, timeZone, now);
  if (relative) return relative;
  // 2. "November 6" style.
  const monthDay = parseMonthDay(cleaned, timeZone, now);
  if (monthDay) return monthDay;
  return null;
}

// Detect a scheduling claim in the model's reply text.
// Returns { kind: 'past'|'future', description, datePhrase, match } or null.
export function detectSchedulingClaim(text) {
  if (typeof text !== 'string' || !text) return null;
  let m = PAST_CLAIM_RE.exec(text);
  if (m) {
    return { kind: 'past', description: m[1].trim(), datePhrase: m[2].trim(), match: m[0] };
  }
  m = FUTURE_CLAIM_RE.exec(text);
  if (m) {
    return { kind: 'future', description: m[1].trim(), datePhrase: m[2].trim(), match: m[0] };
  }
  return null;
}

// Clean a raw description like "a check-in" into "check-in".
function cleanDescription(raw, fallback) {
  let d = String(raw || '').trim().replace(/^(a|an|the)\s+/i, '').slice(0, 120);
  if (!d) d = fallback || 'follow-up';
  return d;
}

/**
 * Enforce scheduling honesty on a model reply.
 *
 * If the reply claims scheduling but no scheduling tool was called this
 * turn, create the follow-up for real from the parsed intent. If the intent
 * can't be parsed, rewrite the reply to drop the false claim.
 *
 * Returns { answer, created } where created is the follow-up record or null.
 */
export function enforceSchedulingHonesty({ answer, toolCalls = [], db, userId, timeZone = 'America/New_York', sourceMessageId = null, userMessage = '' }) {
  const calledSchedulingTool = (toolCalls || []).some((tc) => SCHEDULING_TOOL_NAMES.has(tc?.name));
  if (calledSchedulingTool) return { answer, created: null };

  const claim = detectSchedulingClaim(answer);
  if (!claim) return { answer, created: null };

  const date = resolveClaimDate(claim.datePhrase, timeZone);
  // For future promises ("I'll remind you"), derive a description from the
  // user's message when the claim itself is vague.
  let description = cleanDescription(claim.description);
  if (claim.kind === 'future' && /^(remind you|check in|follow up)$/i.test(description)) {
    const topic = String(userMessage || '').trim().slice(0, 80);
    description = topic ? `follow-up: ${topic}` : 'follow-up';
  }

  if (date) {
    try {
      const followUp = db.addFollowUp(userId, { description, dueDate: date, sourceMessageId });
      db.addEvent(userId, 'followup_noted', `Will check in about "${description}" after ${date}.`);
      return { answer, created: followUp };
    } catch (error) {
      console.error('scheduling honesty auto-create failed', error && error.message);
    }
  }

  // Couldn't parse or create — rewrite the reply to drop the false claim
  // rather than let Orbit lie. Keep it warm and offer to actually do it.
  const corrected = answer.replace(claim.match, `I can set that up`).trim();
  const finalAnswer = /[.!?]$/.test(corrected)
    ? corrected
    : `${corrected}. Want me to schedule it?`;
  return { answer: finalAnswer, created: null, corrected: true };
}
