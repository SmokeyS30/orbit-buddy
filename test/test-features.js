import assert from 'node:assert';
import { cosineSimilarity, semanticRank, hybridRank } from '../src/semantic-search.js';
import { searchMessages, formatSearchResults } from '../src/conversation-search.js';
import { buildTimeline, formatTimeline } from '../src/memory-timeline.js';

// --- cosineSimilarity ---
{
  const sim = cosineSimilarity([1, 0, 0], [1, 0, 0]);
  assert.strictEqual(sim, 1, 'identical vectors => 1');

  const orth = cosineSimilarity([1, 0], [0, 1]);
  assert.ok(Math.abs(orth) < 1e-9, 'orthogonal vectors => 0');

  const partial = cosineSimilarity([1, 1], [1, 0]);
  assert.ok(Math.abs(partial - Math.SQRT1_2) < 1e-9, 'known partial similarity');

  assert.strictEqual(cosineSimilarity([], []), 0, 'empty vectors => 0');
  assert.strictEqual(cosineSimilarity([1, 2], [1]), 0, 'length mismatch => 0');
  assert.strictEqual(cosineSimilarity([0, 0], [1, 1]), 0, 'zero vector => 0');
}

// --- semanticRank ---
{
  const memories = [
    { id: 'a', content: 'likes pizza', embedding: JSON.stringify([1, 0, 0]) },
    { id: 'b', content: 'likes pasta', embedding: JSON.stringify([0.9, 0.1, 0]) },
    { id: 'c', content: 'dislikes rain', embedding: JSON.stringify([0, 0, 1]) },
    { id: 'd', content: 'no embedding here' },
  ];
  const ranked = semanticRank(memories, [1, 0, 0], 10);
  assert.strictEqual(ranked.length, 2, 'skips memory without embedding and zero-similarity');
  assert.strictEqual(ranked[0].memory.id, 'a', 'best match first');
  assert.strictEqual(ranked[1].memory.id, 'b', 'second best next');
  assert.ok(ranked[0].score >= ranked[1].score, 'descending scores');

  const limited = semanticRank(memories, [1, 0, 0], 2);
  assert.strictEqual(limited.length, 2, 'limit respected');
}

// --- hybridRank ---
{
  const memories = [
    { id: 'kw', content: 'pepperoni pizza dinner', embedding: JSON.stringify([0, 0, 1]) },
    { id: 'sem', content: 'italian food evening', embedding: JSON.stringify([1, 0, 0]) },
  ];
  const ranked = hybridRank(memories, 'dinner ideas', [1, 0, 0], 10);
  assert.strictEqual(ranked.length, 2, 'both returned');
  // 'kw' has keyword hit for "dinner" but zero semantic; 'sem' has semantic 1 but no keyword
  const kwEntry = ranked.find((r) => r.memory.id === 'kw');
  const semEntry = ranked.find((r) => r.memory.id === 'sem');
  assert.ok(Math.abs(kwEntry.score - 0.4 * (1 / 2)) < 1e-9, 'keyword-only falls back to kw score');
  assert.ok(Math.abs(semEntry.score - 0.6 * 1) < 1e-9, 'semantic-only weighted at 0.6');
  assert.ok(semEntry.score > kwEntry.score, 'semantic weight wins here');
}

// --- searchMessages ---
{
  const messages = [
    { id: 'm1', content: 'I love pepperoni pizza more than anything else in the world', created_at: '2026-10-08T12:00:00Z' },
    { id: 'm2', content: 'The weather is nice today', created_at: '2026-10-09T12:00:00Z' },
    { id: 'm3', content: 'pizza pizza pizza, all I ever think about is pizza', created_at: '2026-10-01T12:00:00Z' },
  ];
  const results = searchMessages(messages, 'pizza', 20);
  assert.strictEqual(results.length, 2, 'two matches');
  // m3 has 4 matches vs m1's 1, but m3 is older — match count dominates
  assert.strictEqual(results[0].message.id, 'm3', 'higher match count ranks first');
  assert.ok(results[0].excerpt.includes('...') || results[0].excerpt.length <= 160, 'excerpt bounded');
  assert.ok(results[0].score > results[1].score, 'scores descending');

  const none = searchMessages(messages, 'zyxwv', 20);
  assert.strictEqual(none.length, 0, 'no matches => empty');

  const empty = searchMessages(messages, '', 20);
  assert.strictEqual(empty.length, 0, 'empty query => empty');
}

// --- formatSearchResults ---
{
  const results = [
    { message: { created_at: '2026-10-08T14:05:00Z' }, excerpt: 'pepperoni pizza...' },
  ];
  const formatted = formatSearchResults(results);
  assert.strictEqual(formatted.length, 1);
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} — /.test(formatted[0]), 'timestamp format');
  assert.ok(formatted[0].includes('pepperoni pizza...'), 'excerpt included');
}

// --- buildTimeline ---
{
  const memories = [
    { id: 'old', content: 'pepperoni is favorite', created_at: '2026-10-08T10:00:00Z', superseded_by: 'new' },
    { id: 'new', content: 'mushrooms is favorite', created_at: '2026-10-10T10:00:00Z', superseded_by: null },
    { id: 'unrelated', content: 'likes hiking', created_at: '2026-10-09T10:00:00Z', superseded_by: null },
  ];
  const tl = buildTimeline('new', memories);
  assert.strictEqual(tl.length, 2, 'chain of two');
  assert.strictEqual(tl[0].id, 'old', 'oldest first');
  assert.strictEqual(tl[0].event, 'superseded');
  assert.strictEqual(tl[1].id, 'new', 'newest last');
  assert.strictEqual(tl[1].event, 'current');

  // Starting from the old end still resolves the full chain
  const tl2 = buildTimeline('old', memories);
  assert.strictEqual(tl2.length, 2, 'chain resolves from either end');
  assert.strictEqual(tl2[1].event, 'current');

  const missing = buildTimeline('nope', memories);
  assert.deepStrictEqual(missing, [], 'unknown id => empty');

  const single = buildTimeline('unrelated', memories);
  assert.strictEqual(single.length, 1);
  assert.strictEqual(single[0].event, 'current');
}

// --- buildTimeline longer chain ---
{
  const memories = [
    { id: 'v1', content: 'first', created_at: '2026-10-01T10:00:00Z', superseded_by: 'v2' },
    { id: 'v2', content: 'second', created_at: '2026-10-05T10:00:00Z', superseded_by: 'v3' },
    { id: 'v3', content: 'third', created_at: '2026-10-10T10:00:00Z', superseded_by: null },
  ];
  const tl = buildTimeline('v2', memories);
  assert.deepStrictEqual(tl.map((e) => e.id), ['v1', 'v2', 'v3'], 'full chain in order');
  assert.deepStrictEqual(tl.map((e) => e.event), ['superseded', 'superseded', 'current']);
}

// --- formatTimeline ---
{
  const tl = [
    { id: 'old', content: 'pepperoni is favorite', created_at: '2026-10-08T10:00:00Z', event: 'superseded' },
    { id: 'new', content: 'mushrooms is favorite', created_at: '2026-10-10T10:00:00Z', event: 'current' },
  ];
  const out = formatTimeline(tl);
  assert.ok(out.includes('Oct 8'), 'first date');
  assert.ok(out.includes('Oct 10'), 'second date');
  assert.ok(out.includes('(current)'), 'current marker');
  assert.ok(out.includes('→'), 'arrow separator');
  assert.strictEqual(formatTimeline([]), '', 'empty => empty string');
}

console.log('All tests passed.');
