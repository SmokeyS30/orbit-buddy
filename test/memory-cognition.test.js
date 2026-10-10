import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRelevance, detectContradiction, lastMentionedLabel } from '../src/intelligence.js';

test('lastMentionedLabel produces human-readable recency', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  assert.equal(lastMentionedLabel({ last_mentioned_at: '2026-10-10T08:00:00Z' }, now), 'earlier today');
  assert.equal(lastMentionedLabel({ last_mentioned_at: '2026-10-09T12:00:00Z' }, now), 'yesterday');
  assert.equal(lastMentionedLabel({ last_mentioned_at: '2026-10-07T12:00:00Z' }, now), '3 days ago');
  assert.equal(lastMentionedLabel({ last_mentioned_at: '2026-10-03T12:00:00Z' }, now), 'a week ago');
  assert.equal(lastMentionedLabel({ last_mentioned_at: '2026-09-26T12:00:00Z' }, now), '2 weeks ago');
  assert.equal(lastMentionedLabel({ last_mentioned_at: '2026-09-10T12:00:00Z' }, now), 'a month ago');
  assert.equal(lastMentionedLabel({ last_mentioned_at: '2026-08-01T12:00:00Z' }, now), '2 months ago');
  assert.equal(lastMentionedLabel({ last_mentioned_at: '2025-10-10T12:00:00Z' }, now), 'a year ago');
  // Falls back to updated_at / created_at when last_mentioned_at is absent
  assert.equal(lastMentionedLabel({ updated_at: '2026-10-09T12:00:00Z' }, now), 'yesterday');
  assert.equal(lastMentionedLabel({}, now), null);
});

test('detectContradiction flags negation-polarity mismatches with keyword overlap', () => {
  const existing = [
    { id: 'm1', content: 'User enjoys drinking coffee every morning', status: 'approved' },
    { id: 'm2', content: 'User lives in Brewster Massachusetts', status: 'approved' },
    { id: 'm3', content: 'User archived old laptop', status: 'archived' },
  ];
  // Contradiction: same topic, opposite polarity
  const hit = detectContradiction('User does not enjoy drinking coffee anymore', existing);
  assert.ok(hit, 'expected a contradiction to be detected');
  assert.equal(hit.contradicted.id, 'm1');
  assert.ok(hit.confidence >= 0.5);

  // No contradiction: same polarity (both affirmative)
  const noHit = detectContradiction('User enjoys drinking tea every morning', existing);
  assert.equal(noHit, null);

  // No contradiction: unrelated topic
  const unrelated = detectContradiction('User never watches horror movies at night', existing);
  assert.equal(unrelated, null);

  // Too short to evaluate
  assert.equal(detectContradiction('Hi there', existing), null);

  // Superseded memories are skipped
  const withSuperseded = [
    { id: 'm1', content: 'User enjoys drinking coffee every morning', status: 'approved', superseded_by: 'm9' },
  ];
  assert.equal(detectContradiction('User does not enjoy drinking coffee anymore', withSuperseded), null);
});

test('calculateRelevance decays with inactivity and respects the floor', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const fresh = { relevance_score: 1.0, last_mentioned_at: '2026-10-10T11:00:00Z' };
  assert.ok(Math.abs(calculateRelevance(fresh, now) - 1.0) < 0.01, 'fresh memory keeps full relevance');

  // 4 weeks inactive: 1.0 * 0.95^4 ≈ 0.8145
  const monthOld = { relevance_score: 1.0, last_mentioned_at: '2026-09-12T12:00:00Z' };
  const decayed = calculateRelevance(monthOld, now);
  assert.ok(Math.abs(decayed - 0.8145) < 0.01, `expected ~0.8145, got ${decayed}`);

  // Very old: floored at 0.1
  const ancient = { relevance_score: 1.0, last_mentioned_at: '2020-01-01T00:00:00Z' };
  assert.equal(calculateRelevance(ancient, now), 0.1);

  // Missing score defaults to 1.0 before decay
  const noScore = { last_mentioned_at: '2026-10-10T11:00:00Z' };
  assert.ok(Math.abs(calculateRelevance(noScore, now) - 1.0) < 0.01);

  // Never exceeds 1.0
  const boosted = { relevance_score: 5.0, last_mentioned_at: '2026-10-10T11:00:00Z' };
  assert.ok(calculateRelevance(boosted, now) <= 1.0);
});
