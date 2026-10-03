const MEMORY_KINDS = new Set(['fact', 'preference', 'goal', 'project', 'decision', 'relationship']);
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'had', 'has', 'have',
  'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'we',
  'were', 'what', 'when', 'where', 'which', 'who', 'will', 'with', 'you', 'your'
]);

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

function tokenize(value) {
  return [...new Set(String(value || '').toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,}/g) || [])]
    .filter((token) => !STOP_WORDS.has(token))
    .map((token) => token.length > 3 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token);
}

export function rankMemories(memories, query, limit = 8, nowMs = Date.now()) {
  const wanted = new Set(tokenize(query));
  return (memories || [])
    .filter((memory) => memory.status !== 'archived')
    .filter((memory) => !memory.expires_at || new Date(memory.expires_at).valueOf() > nowMs)
    .map((memory, index) => {
      const tokens = tokenize(memory.content);
      const overlap = tokens.reduce((count, token) => count + (wanted.has(token) ? 1 : 0), 0);
      const exact = wanted.size && String(memory.content).toLowerCase().includes(String(query).trim().toLowerCase()) ? 4 : 0;
      const ageDays = Math.max(0, (nowMs - new Date(memory.last_confirmed_at || memory.updated_at || memory.created_at).valueOf()) / 86400_000);
      const recency = Math.max(0, 2 - Math.log10(ageDays + 1));
      const confidence = Number.isFinite(Number(memory.confidence)) ? Number(memory.confidence) : 1;
      const kindBoost = ['preference', 'goal', 'project', 'decision'].includes(memory.kind) ? 0.5 : 0;
      return { memory, score: exact + overlap * 3 + recency + confidence + kindBoost - index * 0.001 };
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
  return { timeZone, quietStart, quietEnd, proactiveEnabled };
}
