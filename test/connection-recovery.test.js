import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canAttemptNetwork, createConnectionRecovery, isTransportError } from '../public/connection-recovery.js';

function fakeClock() {
  const jobs = new Map();
  let nextId = 0;
  return {
    jobs,
    schedule(fn, delay) { const id = ++nextId; jobs.set(id, { fn, delay }); return id; },
    cancel(id) { jobs.delete(id); },
    fire() {
      const [id, job] = jobs.entries().next().value;
      jobs.delete(id);
      job.fn();
      return job.delay;
    },
  };
}

test('a failed first connection retries until the network becomes usable', async () => {
  const clock = fakeClock();
  let calls = 0;
  const recovery = createConnectionRecovery(() => ++calls < 3 ? 'retry' : 'connected', clock);
  assert.equal(await recovery.attempt(), 'retry');
  assert.equal(clock.fire(), 1000);
  assert.equal(await recovery.wake(), 'retry');
  assert.equal(clock.fire(), 2000);
  assert.equal(await recovery.wake(), 'connected');
  assert.equal(calls, 3);
  assert.equal(clock.jobs.size, 0);
});

test('repeated failures cap the retry delay at 30 seconds', async () => {
  const clock = fakeClock();
  const recovery = createConnectionRecovery(() => 'retry', clock);
  assert.equal(await recovery.attempt(), 'retry');
  for(const expected of [1000, 2000, 5000, 10000, 30000, 30000]) {
    assert.equal(clock.fire(), expected);
    assert.equal(await recovery.wake(), 'retry');
  }
  recovery.stop();
});

test('recovery pauses while hidden, wakes on foreground, and stops on authentication', async () => {
  const clock = fakeClock();
  let visible = false;
  let calls = 0;
  const recovery = createConnectionRecovery(() => ++calls === 1 ? 'retry' : 'auth', {
    ...clock, visible: () => visible,
  });
  assert.equal(await recovery.attempt(), 'retry');
  assert.equal(clock.jobs.size, 0);
  visible = true;
  assert.equal(await recovery.wake(), 'auth');
  assert.equal(calls, 2);
  assert.equal(clock.jobs.size, 0);
});

test('network wake-ups do not start duplicate connection attempts', async () => {
  let finish;
  let calls = 0;
  const recovery = createConnectionRecovery(() => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  });
  const first = recovery.attempt();
  const second = recovery.wake();
  assert.strictEqual(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish('connected');
  assert.equal(await first, 'connected');
});

test('leaving the page cancels a pending retry and restoration can wake it', async () => {
  const clock = fakeClock();
  let calls = 0;
  const recovery = createConnectionRecovery(() => ++calls === 1 ? 'retry' : 'connected', clock);
  assert.equal(await recovery.attempt(), 'retry');
  assert.equal(clock.jobs.size, 1);
  recovery.stop();
  assert.equal(clock.jobs.size, 0);
  assert.equal(await recovery.attempt(), 'stopped');
  assert.equal(await recovery.wake(), 'connected');
  assert.equal(calls, 2);
});

test('leaving during an in-flight request cannot schedule another retry', async () => {
  const clock = fakeClock();
  let finish;
  const recovery = createConnectionRecovery(() => new Promise((resolve) => { finish = resolve; }), clock);
  const inFlight = recovery.attempt();
  await Promise.resolve();
  recovery.stop();
  finish('retry');
  assert.equal(await inFlight, 'retry');
  assert.equal(clock.jobs.size, 0);
});

test('native HTTPS attempts ignore a false online hint; HTTP errors are not transport failures', () => {
  assert.equal(canAttemptNetwork(true, false), true);
  assert.equal(canAttemptNetwork(false, false), false);
  assert.equal(isTransportError(new Error('Load failed'), true, false), true);
  assert.equal(isTransportError(new Error('Request timed out.'), true, true), true);
  assert.equal(isTransportError({ status: 401, message: 'Load failed' }, true, false), false);
});

test('app startup, foreground, and chat paths use recovery and real native fetches', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /connectionRecovery\.attempt\(\)/);
  assert.match(source, /window\.addEventListener\('online',refreshConnection\)/);
  assert.match(source, /visibilitychange',\(\)=>\{if\(!document\.hidden\)refreshConnection\(\)/);
  assert.match(source, /window\.addEventListener\('pagehide',\(\)=>connectionRecovery\.stop\(\)\)/);
  assert.equal((source.match(/if\(!canAttemptNetwork\(IS_NATIVE,navigator\.onLine\)\)/g) || []).length, 3);
  assert.doesNotMatch(source, /if\(!navigator\.onLine\)/);
});
