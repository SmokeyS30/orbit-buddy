import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPersonNames, isQuietHours, isoWeekKey, normalizeMemoryKind, normalizePreferences, rankMemories, todayInZone, validTimeZone } from '../src/intelligence.js';

test('normalizes memory kinds and timezone preferences', () => {
  assert.equal(normalizeMemoryKind('GOAL'), 'goal');
  assert.equal(normalizeMemoryKind('secret'), 'fact');
  assert.equal(validTimeZone('Europe/London'), 'Europe/London');
  assert.equal(validTimeZone('Not/AZone'), 'America/New_York');
  const prefs = normalizePreferences({ timeZone: 'Asia/Tokyo', quietStart: '23:15', quietEnd: '07:30', proactiveEnabled: false });
  assert.deepEqual(prefs, { timeZone: 'Asia/Tokyo', quietStart: '23:15', quietEnd: '07:30', proactiveEnabled: false, briefingTone: 'motivational', briefingLength: 'quick' });
  const custom = normalizePreferences({ briefingTone: 'chill', briefingLength: 'detailed' });
  assert.equal(custom.briefingTone, 'chill');
  assert.equal(custom.briefingLength, 'detailed');
  const invalid = normalizePreferences({ briefingTone: 'pirate', briefingLength: 'novel' });
  assert.equal(invalid.briefingTone, 'motivational');
  assert.equal(invalid.briefingLength, 'quick');
});

test('extracts person names from free text', () => {
  assert.deepEqual(extractPersonNames('I had dinner with my mom yesterday'), ['Mom']);
  assert.deepEqual(extractPersonNames('Talked to Sarah about the trip'), ['Sarah']);
  assert.deepEqual(extractPersonNames('Met John and then called my dad'), ['Dad', 'John']);
  assert.deepEqual(extractPersonNames('Going to the store on Monday'), []);
  assert.deepEqual(extractPersonNames('nothing personal here'), []);
});

test('computes ISO week keys', () => {
  // 2026-10-05 is a Monday; verify against a known reference
  assert.equal(isoWeekKey('America/New_York', Date.parse('2026-10-05T12:00:00-04:00')), '2026-W41');
  assert.equal(isoWeekKey('America/New_York', Date.parse('2026-10-04T12:00:00-04:00')), '2026-W40');
  assert.equal(isoWeekKey('UTC', Date.parse('2026-01-01T12:00:00Z')), '2026-W01');
});

test('resolves local dates and overnight quiet hours', () => {
  const instant = Date.parse('2026-10-03T02:00:00Z');
  assert.equal(todayInZone('America/Los_Angeles', instant), '2026-10-02');
  const prefs = { time_zone: 'UTC', quiet_start: '22:00', quiet_end: '08:00', proactive_enabled: 1 };
  assert.equal(isQuietHours(prefs, Date.parse('2026-10-03T23:00:00Z')), true);
  assert.equal(isQuietHours(prefs, Date.parse('2026-10-03T12:00:00Z')), false);
  assert.equal(isQuietHours({ ...prefs, proactive_enabled: 0 }, Date.parse('2026-10-03T12:00:00Z')), true);
});

test('memory ranking prioritizes lexical relevance and omits expired entries', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  const memories = [
    { id: 'unrelated', content: 'Likes gardening', kind: 'preference', confidence: 1, updated_at: '2026-10-03T00:00:00Z' },
    { id: 'flight', content: 'Always chooses aisle seats for flights', kind: 'preference', confidence: 1, updated_at: '2026-09-01T00:00:00Z' },
    { id: 'expired', content: 'Flight leaves at noon', kind: 'fact', confidence: 1, updated_at: '2026-10-03T00:00:00Z', expires_at: '2026-10-02T00:00:00Z' }
  ];
  const ranked = rankMemories(memories, 'plan a flight with my seat preference', 3, now);
  assert.equal(ranked[0].id, 'flight');
  assert.ok(!ranked.some((memory) => memory.id === 'expired'));
});

test('findTimePatterns detects clear weekday and daypart peaks', async (t) => {
  const { findTimePatterns } = await import('../src/intelligence.js');
  // Build timestamps: 12 Tuesday mornings (10am ET) in America/New_York
  // 2026-10-06 is a Tuesday
  const base = Date.UTC(2026, 9, 6, 14, 0, 0); // 10am EDT = 14:00 UTC
  const stamps = [];
  for (let w = 0; w < 12; w++) stamps.push(base + w * 7 * 86400_000);
  // Add 2 scattered messages (noise)
  stamps.push(Date.UTC(2026, 9, 8, 2, 0, 0), Date.UTC(2026, 9, 10, 20, 0, 0));
  const patterns = findTimePatterns(stamps, 'America/New_York');
  assert.ok(patterns.length >= 1, 'detects at least one pattern');
  const wd = patterns.find((p) => p.kind === 'weekday');
  assert.ok(wd, 'detects weekday peak');
  assert.ok(wd.label.includes('Tuesday'), `label mentions Tuesday: ${wd.label}`);
  const dp = patterns.find((p) => p.kind === 'daypart');
  assert.ok(dp, 'detects daypart peak');
  assert.ok(dp.label.includes('morning'), `label mentions morning: ${dp.label}`);
});

test('findTimePatterns stays quiet on flat distributions', async () => {
  const { findTimePatterns } = await import('../src/intelligence.js');
  // Evenly spread across the week and dayparts: 4 per day (morning/afternoon/evening/night)
  const stamps = [];
  for (let d = 0; d < 7; d++) for (const h of [13, 18, 23, 4]) {
    stamps.push(Date.UTC(2026, 9, 4 + d, h, 0, 0));
  }
  assert.deepEqual(findTimePatterns(stamps, 'America/New_York'), [], 'no false peak on flat data');
  assert.deepEqual(findTimePatterns([1, 2, 3], 'America/New_York'), [], 'too few samples');
  assert.deepEqual(findTimePatterns([], 'America/New_York'), [], 'empty input');
});

test('nextPersonalDateOccurrence computes days until with wraparound', async () => {
  const { nextPersonalDateOccurrence, ordinalSuffix } = await import('../src/intelligence.js');
  const tz = 'America/New_York';
  // Fixed "now": Oct 6, 2026 12:00 UTC = Oct 6 08:00 EDT
  const nowMs = Date.UTC(2026, 9, 6, 12, 0, 0);
  // Same day
  let r = nextPersonalDateOccurrence(10, 6, tz, nowMs);
  assert.equal(r.daysUntil, 0);
  assert.equal(r.occurrenceYear, 2026);
  // Tomorrow
  r = nextPersonalDateOccurrence(10, 7, tz, nowMs);
  assert.equal(r.daysUntil, 1);
  // 7 days out
  r = nextPersonalDateOccurrence(10, 13, tz, nowMs);
  assert.equal(r.daysUntil, 7);
  // Past date wraps to next year
  r = nextPersonalDateOccurrence(10, 5, tz, nowMs);
  assert.equal(r.occurrenceYear, 2027);
  assert.ok(r.daysUntil > 300);
  // Feb 29 on non-leap year -> Feb 28
  r = nextPersonalDateOccurrence(2, 29, tz, Date.UTC(2026, 0, 15, 12, 0, 0));
  assert.equal(r.nextDate, '2026-02-28');
  // Feb 29 on leap year stays Feb 29
  r = nextPersonalDateOccurrence(2, 29, tz, Date.UTC(2028, 0, 15, 12, 0, 0));
  assert.equal(r.nextDate, '2028-02-29');
  // Ordinals
  assert.equal(ordinalSuffix(1), '1st');
  assert.equal(ordinalSuffix(2), '2nd');
  assert.equal(ordinalSuffix(3), '3rd');
  assert.equal(ordinalSuffix(10), '10th');
  assert.equal(ordinalSuffix(11), '11th');
  assert.equal(ordinalSuffix(21), '21st');
  assert.equal(ordinalSuffix(22), '22nd');
  assert.equal(ordinalSuffix(23), '23rd');
});
