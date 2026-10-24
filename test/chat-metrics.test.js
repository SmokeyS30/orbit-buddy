import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatMetrics } from '../src/chat-metrics.js';

test('turn metrics expose only aggregate timings and expire after an hour', () => {
  let clock = 1_000_000;
  const metrics = createChatMetrics({ now: () => clock });
  metrics.record({ queueMs: 5, databaseMs: 9, completionMs: 30,
    message: 'private conversation text', userId: 'private-account', errorMessage: 'private error' });
  metrics.record({ queueMs: 15, databaseMs: 19, completionMs: 50 });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.count, 2);
  assert.deepEqual(snapshot.timings.queueMs, { count: 2, p50: 5, p95: 15, p99: 15 });
  assert.equal(metrics.publicStatus().state, 'insufficient');
  assert.deepEqual(Object.keys(metrics.publicStatus()), ['state', 'windowMinutes']);
  assert.ok(!JSON.stringify(snapshot).includes('private'));
  clock += 60 * 60_000 + 1;
  assert.equal(metrics.snapshot().count, 0);
});

test('sustained queue delay and error rate raise an anonymous alert', () => {
  const metrics = createChatMetrics();
  for (let i = 0; i < 20; i++) metrics.record({ queueMs: 31_000, completionMs: 40_000, error: i < 5 });
  assert.equal(metrics.snapshot().state, 'degraded');
  assert.equal(metrics.snapshot().errors, 5);
  assert.equal(metrics.publicStatus().state, 'degraded');
});

test('invalid and absent stage timings are excluded from percentiles', () => {
  const metrics = createChatMetrics();
  metrics.record({ queueMs: -3, databaseMs: '10', modelFirstTokenMs: null, completionMs: 42 });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.timings.queueMs.count, 0);
  assert.equal(snapshot.timings.databaseMs.p95, null);
  assert.equal(snapshot.timings.modelFirstTokenMs.p95, null);
  assert.equal(snapshot.timings.completionMs.p95, 42);
});
