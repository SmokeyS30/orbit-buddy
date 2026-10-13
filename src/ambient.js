// Orbit Buddy ambient context ("Orbit remembers the room").
//
// With explicit per-session permission (asked in chat, never a toggle), Orbit
// notes the situation around a conversation — time of day, day of week, and a
// location label the user gives themselves ("at the cabin") — and uses it
// later unprompted. Everything is stored as ordinary memories the user can see
// and delete; nothing leaves the server.
//
// Conservative by design:
// - No geolocation, no device signals, no network lookups. The only inputs
//   are the clock (in the user's timezone) and the user's own words.
// - Place labels are extracted only from explicit self-location statements
//   ("I'm at the cabin"), never inferred from context.
// - One ambient memory per day max; repeats within 14 days are not re-stored.
// - Rhythms need 3+ distinct days before they're recorded.

/** Bucket an hour (0-23) into a coarse time of day. Pure. */
export function timeBucket(hour) {
  const h = Number(hour);
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'night';
}

/** Weekday name in the user's timezone. Pure. */
export function weekdayInZone(nowMs, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(new Date(nowMs));
}

/** Hour of day (0-23) in the user's timezone. Pure. */
export function hourInZone(nowMs, timeZone) {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).format(new Date(nowMs)));
  return h === 24 ? 0 : h; // some locales report midnight as 24
}

/** YYYY-MM-DD in the user's timezone. Pure. */
export function dayInZone(nowMs, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
}

// Phrases that look like places but aren't — never treat as a location label.
const PLACE_BLOCKLIST = [
  'a loss', 'the end', 'the edge', 'risk', 'stake', 'odds', 'fault', 'war',
  'peace', 'the point', 'the moment', 'the time', 'a meeting', 'a call',
  'the phone', 'the run', 'the move', 'the hook', 'the go', 'the way',
  'the door', 'the table',
];
function isBlockedPlace(label) {
  return PLACE_BLOCKLIST.some((b) => label === b || label.startsWith(b + ' '));
}

/**
 * Extract a self-declared location label from a user message.
 * Only matches explicit self-location statements ("I'm at the cabin",
 * "working at the office today, call me", "on the train"). Returns a
 * normalized label like "the cabin", or null. Pure and deliberately
 * conservative: misses are fine, false positives are not.
 */
export function extractPlaceLabel(text) {
  const t = String(text || '');
  const patterns = [
    // "I'm at/in the cabin"
    /\bi['’]m\s+(?:currently\s+|right now\s+|still\s+)?(?:at|in)\s+(the\s+)?([a-z0-9][a-z0-9'’\- ]{1,40})/i,
    // "…me… at the office…" — a self-reference shortly before "at X"
    /\b(?:i|me|we|us)\b[^.!?]{0,50}?\bat\s+(the\s+)?([a-z0-9][a-z0-9'’\- ]{1,40})/i,
    // "working at the office" — present participle implies the speaker
    /\b(?:working|sitting|staying|stuck|hanging|chilling)\b[^.!?]{0,30}?\bat\s+(the\s+)?([a-z0-9][a-z0-9'’\- ]{1,40})/i,
    // Transit is unambiguous
    /\bon\s+(the\s+)?(train|bus|plane|flight)\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (!m) continue;
    let label = ((m[1] || '') + (m[2] || '')).trim().toLowerCase();
    // Cut at clause boundaries: "at the cabin, working late" -> "the cabin".
    label = label.split(/[,.;:!?—–]\s/)[0].trim();
    // Strip trailing temporal adverbs: "at the office today" -> "the office".
    label = label.replace(/\s+(right now|this (morning|afternoon|evening|week|weekend)|today|tonight|tomorrow|now|currently|lately)$/, '').trim();
    const words = label.split(/\s+/);
    if (words.length > 4 || label.length < 3) continue;
    // Must look like a place, not a time ("at 5") or fragment.
    if (!/^(the\s+)?[a-z]/.test(label)) continue;
    if (isBlockedPlace(label)) continue;
    return label;
  }
  return null;
}

/** Capture the ambient snapshot for one user message. Pure. */
export function ambientSnapshot({ message, nowMs, timeZone }) {
  const tz = timeZone || 'America/New_York';
  const weekday = weekdayInZone(nowMs, tz);
  const bucket = timeBucket(hourInZone(nowMs, tz));
  const place = extractPlaceLabel(message);
  return { weekday, bucket, place, day: dayInZone(nowMs, tz) };
}

/** Machine-readable prefix so rhythm detection can parse stored memories. */
export function ambientMemoryContent({ weekday, bucket, place }) {
  const tag = place ? `${weekday}|${bucket}|${place}` : `${weekday}|${bucket}|`;
  const readable = `${weekday} ${bucket}${place ? ` — ${place}` : ''}`;
  return `Ambient context [${tag}]: chatted ${readable}.`;
}

/** Parse a stored ambient memory back into an observation. Pure. */
export function parseAmbientMemory(content) {
  const m = /^Ambient context \[([A-Za-z]+)\|([a-z]+)\|([^\]]*)\]:/.exec(String(content || ''));
  if (!m) return null;
  return { weekday: m[1], bucket: m[2], place: m[3] || null };
}

/**
 * Detect rhythms: the same weekday+bucket(+place) seen on 3+ distinct days.
 * observations: [{weekday, bucket, place, day}]. Pure.
 */
export function detectRhythms(observations) {
  const groups = new Map();
  for (const o of observations || []) {
    if (!o || !o.weekday || !o.bucket || !o.day) continue;
    const key = `${o.weekday}|${o.bucket}|${o.place || ''}`;
    let g = groups.get(key);
    if (!g) { g = { weekday: o.weekday, bucket: o.bucket, place: o.place || null, days: new Set() }; groups.set(key, g); }
    g.days.add(o.day);
  }
  const rhythms = [];
  for (const g of groups.values()) {
    if (g.days.size >= 3) rhythms.push({ weekday: g.weekday, bucket: g.bucket, place: g.place, count: g.days.size });
  }
  rhythms.sort((a, b) => b.count - a.count);
  return rhythms;
}

/** Human sentence for a detected rhythm. Pure. */
export function rhythmSentence(r) {
  const when = `${r.weekday} ${r.bucket}s`;
  const where = r.place ? ` (${r.place})` : '';
  return `often chats on ${when}${where} — ${r.count} separate days`;
}

/** Machine-readable marker for stored rhythm memories (dedup). */
export function rhythmKey(r) {
  return `rhythm:${r.weekday}|${r.bucket}|${r.place || ''}`;
}
