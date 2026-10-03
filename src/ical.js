import rrulePkg from 'rrule';
import { assertPublicUrl, FETCH_TIMEOUT_MS } from './net.js';

const { rrulestr } = rrulePkg;

export const FEED_TTL_MS = 15 * 60_000;
const FEED_MAX_BYTES = 1_000_000;
export const DEFAULT_ZONE = 'America/New_York';

// ---------------------------------------------------------------------------
// ICS text parsing
// ---------------------------------------------------------------------------

function unfoldLines(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

function unescapeText(value) {
  return String(value).replace(/\\([\\;,nN])/g, (match, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

function parseProperty(line) {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segments = left.split(';');
  const name = segments[0].toUpperCase();
  const params = {};
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf('=');
    if (eq !== -1) params[segment.slice(0, eq).toUpperCase()] = segment.slice(eq + 1);
  }
  return { name, params, value };
}

function parseDateValue(value, params = {}) {
  const text = String(value || '').trim();
  if (/^\d{8}$/.test(text) || params.VALUE === 'DATE') {
    const y = +text.slice(0, 4), mo = +text.slice(4, 6), d = +text.slice(6, 8);
    if (!y || !mo || !d) return null;
    return { allDay: true, y, mo, d };
  }
  const match = text.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, zulu] = match;
  const tzid = typeof params.TZID === 'string' ? params.TZID.replace(/^"|"$/g, '') : null;
  return { allDay: false, y: +y, mo: +mo, d: +d, h: +h, mi: +mi, s: +s, utc: zulu === 'Z', tzid: zulu ? null : tzid };
}

function parseDuration(value) {
  if (!value) return null;
  const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(value).trim());
  if (!match) return null;
  const [, weeks, days, hours, minutes, seconds] = match.map((v) => (v == null ? 0 : +v));
  return ((((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function finishEvent(props) {
  const find = (name) => props.find((p) => p.name === name) || null;
  const get = (name) => {
    const p = find(name);
    return p ? { params: p.params, value: unescapeText(p.value) } : null;
  };
  const dtstart = parseDateValue(get('DTSTART')?.value, get('DTSTART')?.params);
  return {
    uid: get('UID')?.value || null,
    summary: get('SUMMARY')?.value?.trim() || '(no title)',
    description: get('DESCRIPTION')?.value || '',
    location: get('LOCATION')?.value || '',
    status: (get('STATUS')?.value || '').toUpperCase(),
    dtstart,
    dtend: parseDateValue(get('DTEND')?.value, get('DTEND')?.params),
    duration: parseDuration(get('DURATION')?.value),
    rrule: get('RRULE')?.value || null,
    exdates: props.filter((p) => p.name === 'EXDATE').flatMap((p) =>
      String(p.value).split(',').map((v) => parseDateValue(v, p.params)).filter(Boolean)
    ),
    recurrenceId: parseDateValue(get('RECURRENCE-ID')?.value, get('RECURRENCE-ID')?.params)
  };
}

export function parseIcs(text) {
  const events = [];
  let current = null;
  for (const line of unfoldLines(text)) {
    if (!line) continue;
    if (line === 'BEGIN:VEVENT') { current = []; continue; }
    if (line === 'END:VEVENT') {
      if (current) events.push(finishEvent(current));
      current = null;
      continue;
    }
    if (current) {
      const prop = parseProperty(line);
      if (prop) current.push(prop);
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Timezones (DST-safe wall-clock handling)
// ---------------------------------------------------------------------------

const dtfCache = new Map();
function dtfFor(timeZone) {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    dtfCache.set(timeZone, dtf);
  }
  return dtf;
}

export function validZone(timeZone) {
  const zone = String(timeZone || '').trim();
  if (!zone) return null;
  try {
    dtfFor(zone).format(new Date(0));
    return zone;
  } catch {
    return null;
  }
}

function zoneOffsetMs(timeZone, utcMs) {
  const parts = {};
  for (const part of dtfFor(timeZone).formatToParts(new Date(utcMs))) parts[part.type] = part.value;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, (+parts.hour % 24), +parts.minute, +parts.second);
  return asUtc - utcMs;
}

// Converts a wall-clock time in `timeZone` to a UTC timestamp, using the offset
// in effect on that date so recurring events keep their local time across DST.
export function zonedWallToUtcMs(wall, timeZone) {
  const target = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h || 0, wall.mi || 0, wall.s || 0);
  let utc = target;
  // Anchor every round to the target wall time; the offset is re-measured at
  // the latest guess so the loop converges even across a DST transition.
  for (let i = 0; i < 3; i += 1) utc = target - zoneOffsetMs(timeZone, utc);
  return utc;
}

export function wallPartsInZone(utcMs, timeZone) {
  const parts = {};
  for (const part of dtfFor(timeZone).formatToParts(new Date(utcMs))) parts[part.type] = part.value;
  return { y: +parts.year, mo: +parts.month, d: +parts.day, h: (+parts.hour % 24), mi: +parts.minute, s: +parts.second };
}

function datePropToUtcMs(dp, defaultZone) {
  if (!dp) return null;
  if (dp.allDay) return Date.UTC(dp.y, dp.mo - 1, dp.d);
  if (dp.utc) return Date.UTC(dp.y, dp.mo - 1, dp.d, dp.h, dp.mi, dp.s);
  return zonedWallToUtcMs(dp, validZone(dp.tzid) || defaultZone);
}

const pad = (n) => String(n).padStart(2, '0');
function floatingString(dp) {
  const base = `${dp.y}${pad(dp.mo)}${pad(dp.d)}`;
  return dp.allDay ? base : `${base}T${pad(dp.h)}${pad(dp.mi)}${pad(dp.s)}`;
}

// ---------------------------------------------------------------------------
// Recurrence expansion
// ---------------------------------------------------------------------------

function toInstance(ev, startMs, allDay, durationMs) {
  return {
    uid: ev.uid,
    title: ev.summary,
    description: ev.description,
    location: ev.location,
    startMs,
    endMs: startMs + durationMs,
    allDay,
    instanceStartMs: startMs
  };
}

function eventDurationMs(ev, dp, defaultZone) {
  if (ev.dtend) {
    const endMs = datePropToUtcMs(ev.dtend, defaultZone);
    const startMs = datePropToUtcMs(dp, defaultZone);
    if (endMs != null && startMs != null && endMs >= startMs) return endMs - startMs;
  }
  if (ev.duration != null) return ev.duration;
  return dp.allDay ? 24 * 3600_000 : 0;
}

function expandSingle(ev, dp, defaultZone) {
  const startMs = datePropToUtcMs(dp, defaultZone);
  if (startMs == null) return [];
  return [toInstance(ev, startMs, !!dp.allDay, eventDurationMs(ev, dp, defaultZone))];
}

function expandRecurring(ev, defaultZone, rangeStartMs, rangeEndMs) {
  const dp = ev.dtstart;
  const zone = dp.allDay ? 'UTC' : (validZone(dp.tzid) || defaultZone);
  const durationMs = eventDurationMs(ev, dp, defaultZone);
  let set;
  try {
    set = rrulestr(`DTSTART:${floatingString(dp)}\nRRULE:${ev.rrule}`, { forceset: true });
  } catch {
    return expandSingle(ev, dp, defaultZone);
  }
  // EXDATEs are exclusions in wall-clock terms for the event's zone.
  for (const ex of ev.exdates) {
    const exMs = datePropToUtcMs(ex, defaultZone);
    if (exMs == null) continue;
    const wall = ex.allDay ? { y: ex.y, mo: ex.mo, d: ex.d, h: 0, mi: 0, s: 0 } : wallPartsInZone(exMs, zone);
    set.exdate(new Date(Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s)));
  }
  // Expand a padded window in floating (wall-clock) terms so DST shifts land right.
  const padMs = 2 * 86400_000;
  const lo = new Date(Math.max(0, rangeStartMs - padMs));
  const hi = new Date(rangeEndMs + padMs);
  const out = [];
  for (const occ of set.between(lo, hi)) {
    const wall = {
      y: occ.getUTCFullYear(), mo: occ.getUTCMonth() + 1, d: occ.getUTCDate(),
      h: occ.getUTCHours(), mi: occ.getUTCMinutes(), s: occ.getUTCSeconds()
    };
    const startMs = dp.allDay ? Date.UTC(wall.y, wall.mo - 1, wall.d) : zonedWallToUtcMs(wall, zone);
    out.push(toInstance(ev, startMs, !!dp.allDay, durationMs));
  }
  return out;
}

export function expandEvents(vevents, rangeStartMs, rangeEndMs, defaultZone = DEFAULT_ZONE) {
  const out = [];
  const overrides = [];
  for (const ev of vevents) {
    if (!ev || ev.status === 'CANCELLED' || !ev.uid || !ev.dtstart) continue;
    if (ev.recurrenceId) { overrides.push(ev); continue; }
    const instances = ev.rrule ? expandRecurring(ev, defaultZone, rangeStartMs, rangeEndMs) : expandSingle(ev, ev.dtstart, defaultZone);
    for (const inst of instances) out.push(inst);
  }
  for (const ov of overrides) {
    const ridMs = datePropToUtcMs(ov.recurrenceId, defaultZone);
    const expanded = ov.rrule ? expandRecurring(ov, defaultZone, rangeStartMs, rangeEndMs) : expandSingle(ov, ov.dtstart, defaultZone);
    const idx = ridMs == null ? -1 : out.findIndex((e) => e.uid === ov.uid && e.instanceStartMs === ridMs);
    if (idx !== -1) out.splice(idx, 1, ...expanded);
    else for (const e of expanded) out.push(e);
  }
  return out
    .filter((e) => e.endMs > rangeStartMs && e.startMs < rangeEndMs)
    .sort((a, b) => a.startMs - b.startMs);
}

// ---------------------------------------------------------------------------
// Feed fetching with caching
// ---------------------------------------------------------------------------

const feedCache = new Map(); // feedId -> {fetchedAt, vevents, error}

// Apple Calendar share links use the webcal:// scheme, which is plain HTTPS
// with a calendar label. Normalize to https:// before any validation/fetch.
export function normalizeFeedUrl(url) {
  const text = String(url || '').trim();
  return text.replace(/^webcals?:\/\//i, 'https://');
}

export async function fetchFeedText(url) {
  let current = await assertPublicUrl(normalizeFeedUrl(url));
  let response = null;
  for (let hop = 0; hop < 6; hop += 1) {
    try {
      response = await fetch(current, {
        headers: { 'User-Agent': 'orbit-buddy/1.0 (calendar reader)', Accept: 'text/calendar' },
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
    } catch (error) {
      throw new Error(`Could not fetch that calendar: ${error.message}`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('That calendar redirect had no target.');
      // Re-check after redirects: a public URL must not bounce into the private network.
      current = await assertPublicUrl(new URL(location, current).toString());
      continue;
    }
    break;
  }
  if (!response.ok) throw new Error(`Calendar fetch failed (HTTP ${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > FEED_MAX_BYTES) throw new Error('That calendar feed is too large.');
  return buffer.toString('utf8');
}

export async function getFeedVevents(feed) {
  const cached = feedCache.get(feed.id);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < FEED_TTL_MS) return cached;
  const entry = { fetchedAt: now, vevents: cached?.vevents || [], error: null };
  try {
    entry.vevents = parseIcs(await fetchFeedText(feed.url));
  } catch (error) {
    entry.error = String(error?.message || error).slice(0, 200);
  }
  feedCache.set(feed.id, entry);
  return entry;
}

export function dropFeedCache(feedId) {
  feedCache.delete(feedId);
}

// Merges events across all of the user's feeds for [rangeStartMs, rangeEndMs).
export async function getEventsForRange(db, userId, rangeStartMs, rangeEndMs, defaultZone = DEFAULT_ZONE) {
  const feeds = db.listCalendarFeeds(userId);
  const events = [];
  const feedErrors = [];
  for (const feed of feeds) {
    const { vevents, error } = await getFeedVevents(feed);
    if (error) feedErrors.push({ label: feed.label, error });
    for (const event of expandEvents(vevents, rangeStartMs, rangeEndMs, defaultZone)) {
      events.push({ ...event, calendar: feed.label, feedId: feed.id });
    }
  }
  events.sort((a, b) => a.startMs - b.startMs);
  return { events, feedErrors, feeds: feeds.map((f) => ({ id: f.id, label: f.label })) };
}

// Start of `dayOffset` days after `dateStr` (YYYY-MM-DD) in `timeZone`, as UTC ms.
export function dayStartMs(dateStr, dayOffset, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!match) return null;
  const [, y, mo, d] = match;
  const base = zonedWallToUtcMs({ y: +y, mo: +mo, d: +d, h: 0, mi: 0, s: 0 }, validZone(timeZone) || DEFAULT_ZONE);
  return base + dayOffset * 86400_000;
}
