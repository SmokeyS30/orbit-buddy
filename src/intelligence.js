const MEMORY_KINDS = new Set(['fact', 'preference', 'goal', 'project', 'decision', 'relationship']);
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'had', 'has', 'have',
  'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'we',
  'were', 'what', 'when', 'where', 'which', 'who', 'will', 'with', 'you', 'your'
]);
const WEEKDAY_INDEX = new Map([['Sun', 0], ['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6]]);

export function normalizeMemoryKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  return MEMORY_KINDS.has(kind) ? kind : 'fact';
}

export function validTimeZone(value, fallback = 'America/New_York') {
  const zone = String(value || '').trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    return fallback;
  }
}

export function todayInZone(timeZone, nowMs = Date.now()) {
  return new Date(nowMs).toLocaleDateString('en-CA', { timeZone: validTimeZone(timeZone) });
}

// Personal dates: days until the next occurrence of a month/day, handling year
// wraparound and Feb 29 (celebrated Feb 28 in non-leap years). Returns
// { daysUntil, nextDate: 'YYYY-MM-DD', occurrenceYear }.
export function nextPersonalDateOccurrence(month, day, timeZone, nowMs = Date.now()) {
  const zone = validTimeZone(timeZone);
  const todayStr = todayInZone(zone, nowMs);
  const [ty, tm, td] = todayStr.split('-').map(Number);
  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const effDay = (m, d, y) => (m === 2 && d === 29 && !isLeap(y) ? 28 : d);
  const toMs = (y, m, d) => Date.UTC(y, m - 1, d);
  const todayMs = toMs(ty, tm, td);
  for (let y = ty; y <= ty + 1; y++) {
    const ed = effDay(month, day, y);
    const ms = toMs(y, month, ed);
    if (ms >= todayMs) {
      return {
        daysUntil: Math.round((ms - todayMs) / 86400_000),
        nextDate: `${y}-${String(month).padStart(2, '0')}-${String(ed).padStart(2, '0')}`,
        occurrenceYear: y
      };
    }
  }
  // Fallback (should not happen): next year
  const ed = effDay(month, day, ty + 1);
  return { daysUntil: 366, nextDate: `${ty + 1}-${String(month).padStart(2, '0')}-${String(ed).padStart(2, '0')}`, occurrenceYear: ty + 1 };
}

export function ordinalSuffix(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function validDateString(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const check = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return check.getUTCFullYear() === Number(year) && check.getUTCMonth() === Number(month) - 1 && check.getUTCDate() === Number(day)
    ? `${year}-${month}-${day}` : null;
}

export function validTimeString(value, fallback = null) {
  const time = String(value || '').trim();
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : fallback;
}

export function normalizePriority(value, fallback = 2) {
  const priority = Math.round(Number(value));
  return Number.isFinite(priority) ? Math.max(1, Math.min(priority, 3)) : fallback;
}

export function localDateTimeParts(timeZone, nowMs = Date.now()) {
  const zone = validTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'
  }).formatToParts(new Date(nowMs));
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}`,
    weekday: WEEKDAY_INDEX.get(value('weekday')) ?? 0,
    timeZone: zone
  };
}

export function routineDue(routine, timeZone, nowMs = Date.now()) {
  if (!routine || routine.enabled === 0 || routine.enabled === false) return false;
  const local = localDateTimeParts(timeZone, nowMs);
  if (routine.last_error && routine.updated_at && nowMs - new Date(routine.updated_at).valueOf() < 15 * 60_000) return false;
  if (routine.last_run_date === local.date || local.time < validTimeString(routine.time_local, '09:00')) return false;
  if (routine.cadence === 'weekdays' && (local.weekday === 0 || local.weekday === 6)) return false;
  if (routine.cadence === 'weekly' && local.weekday !== Number(routine.day_of_week)) return false;
  return ['daily', 'weekdays', 'weekly'].includes(routine.cadence);
}

export function rankGoals(goals, limit = 5, nowDate = todayInZone('America/New_York')) {
  const todayMs = Date.parse(`${nowDate}T00:00:00Z`);
  return (goals || []).filter((goal) => goal.status === 'active').map((goal, index) => {
    const priority = normalizePriority(goal.priority);
    const progress = Math.max(0, Math.min(Number(goal.progress) || 0, 100));
    let urgency = 0;
    if (goal.target_date) {
      const days = Math.floor((Date.parse(`${goal.target_date}T00:00:00Z`) - todayMs) / 86400_000);
      urgency = days < 0 ? 5 : days === 0 ? 4 : days <= 7 ? 3 : days <= 30 ? 1 : 0;
    }
    return { goal, score: priority * 3 + urgency + (100 - progress) / 100 - index * 0.001 };
  }).sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(Number(limit) || 5, 20)))
    .map(({ goal }) => goal);
}

function tokenize(value) {
  return [...new Set(String(value || '').toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,}/g) || [])]
    .filter((token) => !STOP_WORDS.has(token))
    .map((token) => token.length > 3 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token);
}

// Episodic recall: human-readable "last mentioned X ago" label for a memory.
// Uses last_mentioned_at when available, falling back to confirmation/update/create times.
export function lastMentionedLabel(memory, nowMs = Date.now()) {
  const ts = memory.last_mentioned_at || memory.last_confirmed_at || memory.updated_at || memory.created_at;
  if (!ts) return null;
  const days = Math.max(0, Math.floor((nowMs - new Date(ts).valueOf()) / 86400_000));
  if (days === 0) return 'earlier today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) { const w = Math.floor(days / 7); return w === 1 ? 'a week ago' : `${w} weeks ago`; }
  if (days < 365) { const m = Math.floor(days / 30); return m === 1 ? 'a month ago' : `${m} months ago`; }
  const y = Math.floor(days / 365); return y === 1 ? 'a year ago' : `${y} years ago`;
}

const NEGATION_WORDS = new Set(['not', 'no', 'never', "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't", "can't", "cannot", "won't", "shouldn't", "wouldn't", "couldn't", "haven't", "hasn't", "hadn't", 'none', 'neither', 'nor']);

function hasNegation(text) {
  const lower = String(text || '').toLowerCase();
  for (const neg of NEGATION_WORDS) {
    if (lower.includes(neg)) return true;
  }
  return false;
}

// Contradiction detection: finds an existing memory that the new content likely
// contradicts, via keyword overlap plus negation-polarity mismatch.
// Returns { contradicted, confidence } or null. Never auto-deletes.
export function detectContradiction(newContent, existingMemories) {
  const newTokens = new Set(tokenize(newContent));
  if (newTokens.size < 3) return null;
  const newNegated = hasNegation(newContent);
  let best = null;
  let bestScore = 0;
  for (const memory of existingMemories || []) {
    if (!memory || memory.status === 'archived' || memory.superseded_by) continue;
    const memTokens = new Set(tokenize(memory.content));
    if (memTokens.size < 3) continue;
    // Only flag when negation polarity differs (one affirms, the other denies).
    if (hasNegation(memory.content) === newNegated) continue;
    const overlap = [...newTokens].filter((t) => memTokens.has(t)).length;
    const similarity = overlap / Math.min(newTokens.size, memTokens.size);
    if (similarity >= 0.5 && similarity > bestScore) {
      bestScore = similarity;
      best = memory;
    }
  }
  return best ? { contradicted: best, confidence: bestScore } : null;
}

// Memory decay: relevance fades 5% per week of inactivity, floored at 0.1.
// Called by applyMemoryDecay during the daily learning cycle.
export function calculateRelevance(memory, nowMs = Date.now()) {
  const current = Number.isFinite(Number(memory.relevance_score)) ? Number(memory.relevance_score) : 1.0;
  const ts = memory.last_mentioned_at || memory.last_confirmed_at || memory.updated_at || memory.created_at;
  if (!ts) return Math.max(0.1, Math.min(1.0, current));
  const weeksInactive = Math.max(0, (nowMs - new Date(ts).valueOf()) / (86400_000 * 7));
  const decayed = current * Math.pow(0.95, weeksInactive);
  return Math.max(0.1, Math.min(1.0, decayed));
}

export function rankMemories(memories, query, limit = 8, nowMs = Date.now()) {
  const wanted = new Set(tokenize(query));
  return (memories || [])
    .filter((memory) => memory.status !== 'archived')
    .filter((memory) => !memory.superseded_by)
    .filter((memory) => !memory.expires_at || new Date(memory.expires_at).valueOf() > nowMs)
    .map((memory, index) => {
      const tokens = tokenize(memory.content);
      const overlap = tokens.reduce((count, token) => count + (wanted.has(token) ? 1 : 0), 0);
      const exact = wanted.size && String(memory.content).toLowerCase().includes(String(query).trim().toLowerCase()) ? 4 : 0;
      const ageDays = Math.max(0, (nowMs - new Date(memory.last_confirmed_at || memory.updated_at || memory.created_at).valueOf()) / 86400_000);
      const recency = Math.max(0, 2 - Math.log10(ageDays + 1));
      const confidence = Number.isFinite(Number(memory.confidence)) ? Number(memory.confidence) : 1;
      const kindBoost = ['preference', 'goal', 'project', 'decision'].includes(memory.kind) ? 0.5 : 0;
      const relevance = Number.isFinite(Number(memory.relevance_score)) ? Number(memory.relevance_score) : 1;
      return { memory, score: exact + overlap * 3 + recency + confidence + kindBoost + relevance - index * 0.001 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(Number(limit) || 8, 20)))
    .map(({ memory }) => memory);
}

function clockMinutes(value, fallback) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return fallback;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number(match[1]) < 24 && Number(match[2]) < 60 ? minutes : fallback;
}

export function isQuietHours(preferences, nowMs = Date.now()) {
  if (!preferences || preferences.proactive_enabled === 0 || preferences.proactiveEnabled === false) return true;
  const zone = validTimeZone(preferences.time_zone || preferences.timeZone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(nowMs));
  const current = Number(parts.find((part) => part.type === 'hour')?.value || 0) * 60
    + Number(parts.find((part) => part.type === 'minute')?.value || 0);
  const start = clockMinutes(preferences.quiet_start || preferences.quietStart, 22 * 60);
  const end = clockMinutes(preferences.quiet_end || preferences.quietEnd, 8 * 60);
  if (start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function normalizePreferences(value = {}, current = {}) {
  const timeZone = validTimeZone(value.timeZone ?? value.time_zone ?? current.time_zone ?? 'America/New_York');
  const quietStart = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value.quietStart ?? value.quiet_start ?? ''))
    ? String(value.quietStart ?? value.quiet_start) : (current.quiet_start || '22:00');
  const quietEnd = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value.quietEnd ?? value.quiet_end ?? ''))
    ? String(value.quietEnd ?? value.quiet_end) : (current.quiet_end || '08:00');
  const proactiveEnabled = value.proactiveEnabled === undefined && value.proactive_enabled === undefined
    ? current.proactive_enabled !== 0
    : value.proactiveEnabled === true || value.proactive_enabled === 1;
  const briefingToneRaw = String(value.briefingTone ?? value.briefing_tone ?? current.briefing_tone ?? '').toLowerCase();
  const briefingTone = ['motivational', 'chill', 'direct'].includes(briefingToneRaw) ? briefingToneRaw : (current.briefing_tone || 'motivational');
  const briefingLengthRaw = String(value.briefingLength ?? value.briefing_length ?? current.briefing_length ?? '').toLowerCase();
  const briefingLength = ['quick', 'detailed'].includes(briefingLengthRaw) ? briefingLengthRaw : (current.briefing_length || 'quick');
  return { timeZone, quietStart, quietEnd, proactiveEnabled, briefingTone, briefingLength };
}

const RELATIONSHIP_NAMES = {
  mom: 'Mom', dad: 'Dad', mother: 'Mom', father: 'Dad', brother: 'Brother', sister: 'Sister',
  wife: 'Wife', husband: 'Husband', partner: 'Partner', girlfriend: 'Girlfriend',
  boyfriend: 'Boyfriend', son: 'Son', daughter: 'Daughter'
};
const NAME_STOPLIST = new Set(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
  'Christmas', 'Thanksgiving', 'Easter', 'Halloween']);

// Heuristic extraction of person names from free text, for people-mention tracking.
export function extractPersonNames(text) {
  const found = new Set();
  const src = String(text || '');
  for (const m of src.matchAll(/\bmy\s+(mom|dad|mother|father|brother|sister|wife|husband|partner|girlfriend|boyfriend|son|daughter)s?\b/gi)) {
    found.add(RELATIONSHIP_NAMES[m[1].toLowerCase()]);
  }
  for (const m of src.matchAll(/\b(talked to|met|with|called|texted|emailed|saw|visited|dinner with|lunch with)\s+([A-Za-z][a-z]{1,19})\b/gi)) {
    const name = m[2];
    if (/^[A-Z][a-z]{1,19}$/.test(name) && !NAME_STOPLIST.has(name)) found.add(name);
  }
  return [...found].slice(0, 10);
}

// ISO week key like "2026-W40" for the given instant in the given time zone.
export function isoWeekKey(timeZone, nowMs = Date.now()) {
  const local = localDateTimeParts(timeZone, nowMs);
  const [y, m, d] = local.date.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  const year = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const fday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fday + 3);
  const week = 1 + Math.round((date - firstThursday) / (7 * 86400_000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// Find clear activity-time patterns from an array of millisecond timestamps.
// Returns up to 3 patterns like {kind:'weekday'|'daypart', label, count, total}.
// A pattern only qualifies with a clear peak (not a flat distribution) and a
// minimum sample size, to avoid noise.
export function findTimePatterns(timestamps, timeZone = 'America/New_York', minCount = 5) {
  const entries = (timestamps || []).filter((t) => Number.isFinite(t));
  if (entries.length < minCount) return [];
  const zone = validTimeZone(timeZone);
  const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const weekdayCounts = new Array(7).fill(0);
  const daypartCounts = { morning: 0, afternoon: 0, evening: 0, night: 0 };
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
  for (const ts of entries) {
    const parts = fmt.formatToParts(new Date(ts));
    const get = (type) => parts.find((p) => p.type === type)?.value || '';
    const wdi = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    if (wdi >= 0) weekdayCounts[wdi]++;
    const hour = Number(get('hour'));
    if (Number.isFinite(hour)) {
      if (hour >= 5 && hour < 12) daypartCounts.morning++;
      else if (hour >= 12 && hour < 18) daypartCounts.afternoon++;
      else if (hour >= 18 && hour < 23) daypartCounts.evening++;
      else daypartCounts.night++;
    }
  }
  const total = entries.length;
  const patterns = [];
  // Weekday peak: top day has >= 2x the uniform share
  const topWd = weekdayCounts.indexOf(Math.max(...weekdayCounts));
  if (weekdayCounts[topWd] >= minCount && weekdayCounts[topWd] >= 2 * (total / 7)) {
    patterns.push({ kind: 'weekday', label: `Most active on ${weekdayNames[topWd]}s`, count: weekdayCounts[topWd], total });
  }
  // Daypart peak: top part has >= 1.8x the uniform share
  const dpEntries = Object.entries(daypartCounts);
  const topDp = dpEntries.reduce((a, b) => (b[1] > a[1] ? b : a));
  if (topDp[1] >= minCount && topDp[1] >= 1.8 * (total / 4)) {
    patterns.push({ kind: 'daypart', label: `Tends to be active in the ${topDp[0]}`, count: topDp[1], total });
  }
  return patterns.slice(0, 3);
}
