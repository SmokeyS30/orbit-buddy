// "Catch me up" digest — a READ view over existing signals.
//
// Builds the "what happened while you were away" summary from data Orbit
// already collects: proactive check-in deliveries (events table), X6 project
// radar findings + unrecovered CI failures, calendar feed add/remove events,
// the coming agenda (existing iCal readers), and tasks due soon.
//
// The digest never invents items and never writes to signal tables — the only
// writes are to catchup_seen (so a shown/dismissed item never reappears).
// Pure helpers are unit-tested; the builder itself takes the (sync) db.

import { todayInZone, validTimeZone } from './intelligence.js';
import { getEventsForRange, dayStartMs } from './ical.js';

export const CATCHUP_AWAY_MS = 6 * 3600_000; // card shows after 6+ hours away
export const CATCHUP_SINCE_MAX_MS = 30 * 86400_000; // clamp: never look back >30d
export const CATCHUP_LIMIT = 25; // hard cap on items per digest

// Event types written by deliverProactive() in server.js — the authoritative
// log of proactive check-ins that reached the user.
export const PROACTIVE_SENT_TYPES = [
  'smart_checkin_sent',
  'quiet_nudge_sent',
  'radar_checkin_sent',
  'followup_sent',
  'routine_sent',
  'weekly_review_sent',
  'email_urgent_sent',
  'study_nudge_sent',
];
// Calendar "changes/updates" signals that already exist as events.
export const CALENDAR_CHANGE_TYPES = ['calendar_feed_added', 'calendar_feed_removed'];

/** True when `sinceMs` is old enough to warrant the away card. Pure. */
export function isAwayEnough(sinceMs, nowMs = Date.now()) {
  if (!Number.isFinite(sinceMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - sinceMs >= CATCHUP_AWAY_MS;
}

/** Clamp a client-supplied `since` to [now-30d, now]. Pure. */
export function clampSinceMs(sinceMs, nowMs = Date.now()) {
  if (!Number.isFinite(sinceMs)) return null;
  return Math.min(Math.max(sinceMs, nowMs - CATCHUP_SINCE_MAX_MS), nowMs);
}

function truncate(text, max = 140) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function timeLabel(ms, zone, allDay) {
  if (allDay) return 'All day';
  try {
    return new Date(ms).toLocaleTimeString('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function dayStrOf(ms, zone) {
  try {
    return new Date(ms).toLocaleDateString('en-CA', { timeZone: zone });
  } catch {
    return '';
  }
}

const KIND_ICON = { checkin: '💬', radar: '📡', ci: '🔴', calendar: '📅', agenda: '🗓️', task: '✅' };
export function catchupIcon(kind) {
  return KIND_ICON[kind] || '•';
}

/**
 * Build the digest. `db` is the sync database handle (SQLite directly, or the
 * sync Postgres wrapper in production). Returns items in display order:
 * missed items newest-first, then upcoming items soonest-first.
 *
 * Each item: { key, kind, section ('missed'|'upcoming'), title, detail, at,
 *   deepLink?: {view}, url? }
 */
export async function buildCatchupDigest(db, userId, { sinceMs, nowMs = Date.now(), timeZone } = {}) {
  const zone = validTimeZone(timeZone);
  const since = clampSinceMs(sinceMs, nowMs);
  const sinceIso = since == null ? new Date(nowMs - 24 * 3600_000).toISOString() : new Date(since).toISOString();
  const items = [];
  const push = (item) => {
    if (items.length < CATCHUP_LIMIT) items.push(item);
  };

  let seenKeys = new Set();
  try {
    seenKeys = new Set(db.listCatchupSeenKeys(userId) || []);
  } catch {
    seenKeys = new Set();
  }
  const fresh = (key) => key && !seenKeys.has(key);

  // 1+3. Missed proactive check-ins + calendar feed changes (events table).
  let events = [];
  try {
    events = db.listCatchupEvents(userId, sinceIso, 60) || [];
  } catch {
    events = [];
  }
  for (const ev of events) {
    const key = `evt:${ev.id}`;
    if (!fresh(key)) continue;
    if (PROACTIVE_SENT_TYPES.includes(ev.type)) {
      push({
        key, kind: 'checkin', section: 'missed',
        title: truncate(ev.message, 140),
        detail: ev.detail ? truncate(ev.detail, 160) : 'Proactive check-in',
        at: ev.created_at, deepLink: { view: 'today' },
      });
    } else if (CALENDAR_CHANGE_TYPES.includes(ev.type)) {
      push({
        key, kind: 'calendar', section: 'missed',
        title: truncate(ev.message, 140),
        detail: 'Calendar',
        at: ev.created_at, deepLink: { view: 'connections' },
      });
    }
  }

  // 2. Project radar findings not yet delivered as check-ins (radar owns
  // alerting; the digest only summarizes what the radar hasn't surfaced).
  let findings = [];
  try {
    findings = db.listUndeliveredRadarFindingsSince(userId, sinceIso, 15) || [];
  } catch {
    findings = [];
  }
  for (const f of findings) {
    const key = `radar:${f.finding_key}`;
    if (!fresh(key)) continue;
    push({
      key, kind: 'radar', section: 'missed',
      title: truncate(f.title, 140) || 'Repo update',
      detail: `${String(f.repo || '').split('/').pop()}${f.signal === 'high' ? ' · needs attention' : ''}`,
      at: f.found_at || f.created_at,
      ...(f.url ? { url: f.url } : { deepLink: { view: 'today' } }),
    });
  }

  // 5. Failed CI / alerts still unrecovered (X6 data, summarized — no dupes of
  // the radar's own check-ins because delivered findings are excluded above
  // and the key includes the failure date, so a dismissed episode never
  // reappears but a genuinely new failure does).
  let unrecovered = [];
  try {
    unrecovered = db.listUnrecoveredFailureDetails(10) || [];
  } catch {
    unrecovered = [];
  }
  for (const u of unrecovered) {
    const day = String(u.found_at || '').slice(0, 10);
    const key = `ci:${String(u.repo || '').toLowerCase()}:${String(u.workflow || '').toLowerCase()}:${String(u.branch || '').toLowerCase()}:${day}`;
    if (!fresh(key)) continue;
    // One summary per workflow/branch: rows are newest-first, so the first
    // one seen wins and older failures of the same episode collapse into it.
    const dedupe = `${String(u.repo || '').toLowerCase()}|${String(u.workflow || '').toLowerCase()}|${String(u.branch || '').toLowerCase()}`;
    if (items.some((i) => i.kind === 'ci' && i.dedupe === dedupe)) continue;
    push({
      key, kind: 'ci', section: 'missed', dedupe,
      title: `Still failing: ${u.workflow} on ${u.branch}`,
      detail: String(u.repo || '').split('/').pop(),
      at: u.found_at,
      ...(u.url ? { url: u.url } : { deepLink: { view: 'reliability' } }),
    });
  }

  const missed = items.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

  // 4. What's coming up today/tomorrow (calendar + tasks due) — current state,
  // not gated on `since`, but still keyed so dismissed items never reappear.
  const upcoming = [];
  const todayStr = todayInZone(zone, nowMs);
  try {
    const { events: agenda } = await getEventsForRange(
      db, userId, dayStartMs(todayStr, 0, zone), dayStartMs(todayStr, 2, zone), zone
    );
    for (const e of (agenda || []).slice(0, 10)) {
      const day = dayStrOf(e.startMs, zone);
      const key = `agenda:${day}:${e.feedId}:${e.uid}:${e.startMs}`;
      if (!fresh(key)) continue;
      upcoming.push({
        key, kind: 'agenda', section: 'upcoming',
        title: truncate(e.title, 140) || 'Calendar event',
        detail: `${day === todayStr ? 'Today' : 'Tomorrow'} · ${timeLabel(e.startMs, zone, e.allDay)}${e.calendar ? ` · ${e.calendar}` : ''}`,
        at: new Date(e.startMs).toISOString(),
        deepLink: { view: 'today' },
      });
    }
  } catch {
    // A failing feed must never break the digest.
  }
  try {
    const cutoffIso = new Date(dayStartMs(todayStr, 2, zone)).toISOString();
    const tasks = db.listTasksDueBefore(userId, cutoffIso, 10) || [];
    for (const t of tasks) {
      const key = `task:${t.id}`;
      if (!fresh(key)) continue;
      const dueDay = String(t.schedule_at || '').slice(0, 10);
      upcoming.push({
        key, kind: 'task', section: 'upcoming',
        title: truncate(t.title, 140),
        detail: `Due ${dueDay === todayStr ? 'today' : dueDay || 'soon'}`,
        at: t.schedule_at,
        deepLink: { view: 'tasks' },
      });
    }
  } catch {
    // Tasks must never break the digest either.
  }
  upcoming.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));

  return {
    items: [...missed, ...upcoming].slice(0, CATCHUP_LIMIT),
    generatedAt: new Date(nowMs).toISOString(),
    windowStart: sinceIso,
  };
}
