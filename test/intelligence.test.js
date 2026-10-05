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
