// Today-tab morning briefing (web app bigger bet B1).
// Assembles the data the app already has — weather, calendar agenda, focus
// goals, memory anniversaries, open approvals, follow-ups, reliability — into
// one generated morning page. Presentation lives in the frontend; this module
// only gathers and shapes the data. No model calls: deterministic, cheap.

import { toolGetWeather } from './tools.js';
import { getEventsForRange, dayStartMs, DEFAULT_ZONE } from './ical.js';
import { todayInZone, nextPersonalDateOccurrence, validTimeZone } from './intelligence.js';

// Parse the fixed-format text returned by toolGetWeather into structured data.
// Returns null when the text doesn't match (weather section renders as absent).
export function parseWeatherText(text) {
  const src = String(text || '');
  const locMatch = src.match(/^Weather for (.+):$/m);
  const curMatch = src.match(/CURRENT:\s*(-?\d+)\s*°F,\s*([^,\n]+),\s*wind\s*(\d+)\s*mph/);
  if (!curMatch) return null;
  const forecast = [];
  const re = /^[ \t]{2}(\w+):\s*([^,\n]+),\s*high\s*(-?\d+)\s*°F\s*\/\s*low\s*(-?\d+)\s*°F/gm;
  let m;
  while ((m = re.exec(src)) && forecast.length < 3) {
    forecast.push({ day: m[1], condition: m[2].trim(), highF: Number(m[3]), lowF: Number(m[4]) });
  }
  return {
    location: (locMatch ? locMatch[1] : '').trim() || null,
    current: { tempF: Number(curMatch[1]), condition: curMatch[2].trim(), windMph: Number(curMatch[3]) },
    forecast,
  };
}

function greetingForHour(hour) {
  if (hour < 5) return 'Up late';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function timeLabel(ms, timeZone) {
  return new Date(ms).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
}

function countdownLabel(daysUntil) {
  if (daysUntil <= 0) return 'today';
  if (daysUntil === 1) return 'tomorrow';
  return `in ${daysUntil} days`;
}

// Build the full morning briefing payload for a user. `db` is the database
// handle; `reliability` is the reliabilityFor(userId) summary (may be null).
// `getWeather` is injectable for tests.
export async function buildTodayBriefing(db, userId, { getWeather = toolGetWeather, nowMs = Date.now(), reliability = null } = {}) {
  const prefs = db.getPreferences(userId) || {};
  const timeZone = validTimeZone(prefs.time_zone) || DEFAULT_ZONE;
  const todayStr = todayInZone(timeZone, nowMs);
  const hour = Number(new Date(nowMs).toLocaleString('en-US', { timeZone, hour: 'numeric', hour12: false }));
  const dateLabel = new Date(`${todayStr}T12:00:00Z`).toLocaleDateString('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric' });

  // Weather (best effort — section hides on failure)
  let weather = null;
  try {
    weather = parseWeatherText(await getWeather({ location: 'Brewster, MA' }));
  } catch { weather = null; }

  // Calendar agenda: today + tomorrow (partitioned by local day)
  let agenda = [];
  let tomorrowCount = 0;
  try {
    const { events } = await getEventsForRange(db, userId, dayStartMs(todayStr, 0, timeZone), dayStartMs(todayStr, 2, timeZone), timeZone);
    const localDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone });
    const tomorrowStr = new Date(Date.parse(`${todayStr}T12:00:00Z`) + 86400_000).toLocaleDateString('en-CA', { timeZone });
    for (const e of events || []) {
      const day = localDay(e.startMs);
      if (day === tomorrowStr) { tomorrowCount++; continue; }
      if (day !== todayStr) continue;
      agenda.push({
        title: e.title || 'Untitled event',
        allDay: !!e.allDay,
        timeLabel: e.allDay ? 'All day' : timeLabel(e.startMs, timeZone),
        endLabel: e.allDay || !e.endMs ? null : timeLabel(e.endMs, timeZone),
        location: e.location || null,
        calendar: e.calendar || null,
      });
    }
  } catch { agenda = []; }

  // Focus goals: top active goals by priority
  let focusGoals = [];
  try {
    focusGoals = (db.listGoals(userId) || [])
      .filter((g) => g.status === 'active')
      .sort((a, b) => (a.priority || 2) - (b.priority || 2) || (b.progress || 0) - (a.progress || 0))
      .slice(0, 3)
      .map((g) => {
        let streak = 0;
        try { streak = db.getGoalStreak(userId, g.id, todayStr) || 0; } catch {}
        return { id: g.id, title: g.title, progress: g.progress || 0, nextStep: g.next_step || null, targetDate: g.target_date || null, streak };
      });
  } catch { focusGoals = []; }

  // Memory anniversaries: personal dates with an occurrence in the next 14 days
  let anniversaries = [];
  try {
    anniversaries = (db.listPersonalDates(userId) || [])
      .map((d) => {
        let occ;
        try { occ = nextPersonalDateOccurrence(d.month, d.day, timeZone, nowMs); } catch { return null; }
        if (!occ || occ.daysUntil > 14) return null;
        let years = null;
        if (d.year && String(d.type || '').toLowerCase() === 'anniversary') {
          years = occ.occurrenceYear - d.year;
        }
        return { label: d.label, type: d.type || 'other', when: countdownLabel(occ.daysUntil), daysUntil: occ.daysUntil, years: years > 0 ? years : null };
      })
      .filter(Boolean)
      .sort((a, b) => a.daysUntil - b.daysUntil)
      .slice(0, 4);
  } catch { anniversaries = []; }

  // Open loops: pending approvals, approval-gated tasks, soon-due follow-ups
  let approvals = [];
  let waitingTasks = [];
  let followUps = [];
  try {
    approvals = (db.listApprovals(userId) || []).filter((a) => a.status === 'pending')
      .map((a) => ({ id: a.id, title: a.title, kind: a.kind }));
    waitingTasks = (db.listTasks(userId) || []).filter((t) => t.status === 'waiting_approval')
      .map((t) => ({ id: t.id, title: t.title }));
    const horizon = new Date(Date.parse(`${todayStr}T12:00:00Z`) + 3 * 86400_000).toISOString().slice(0, 10);
    followUps = (db.listFollowUps(userId) || [])
      .filter((f) => f.due_date <= horizon)
      .map((f) => ({ id: f.id, description: f.description, dueDate: f.due_date, overdue: f.due_date < todayStr }));
  } catch { /* sections stay empty */ }

  // Systems status (B4): one quiet line by default
  let systems = null;
  if (reliability) {
    const failures = (reliability.recentFailures || []).length;
    systems = {
      ok: failures === 0,
      chatSuccessRate: reliability.chat ? reliability.chat.successRate : null,
      failureCount: failures,
      pendingApprovals: reliability.pendingApprovals || 0,
    };
  }

  return {
    date: todayStr,
    dateLabel,
    greeting: greetingForHour(hour),
    generatedAt: new Date(nowMs).toISOString(),
    weather,
    agenda,
    tomorrowCount,
    focusGoals,
    anniversaries,
    openLoops: { approvals, waitingTasks, followUps },
    openLoopCount: approvals.length + waitingTasks.length + followUps.length,
    systems,
  };
}
