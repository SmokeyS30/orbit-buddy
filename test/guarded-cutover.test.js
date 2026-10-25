import test from 'node:test';
import assert from 'node:assert/strict';
import { deployHeld, openHeld, retired } from '../scripts/guarded-cutover.mjs';
import { azureArgs, normalizeRevision } from '../scripts/guarded-containerapp.mjs';

const oldSha = '1'.repeat(40);
const newSha = '2'.repeat(40);
const image = sha => `ghcr.io/smokeys30/orbit-buddy:${sha}`;
const copy = value => structuredClone(value);

function fixture({ oldHold = false } = {}) {
  const state = {
    current: 'old', counter: 0, calls: [], forcedPublic: null,
    revisions: { old: { name: 'old', image: image(oldSha), hold: oldHold,
      active: true, health: 'Healthy', replicas: ['old-1'] } },
  };
  const az = async (operation, value) => {
    state.calls.push([operation, value]);
    if (operation === 'show') return { mode: 'Single', latest: state.current, ready: state.current };
    if (operation === 'revision') return copy(state.revisions[value] || null);
    if (operation === 'revisions') return Object.keys(state.revisions).map(name => ({ name }));
    if (operation === 'replicas') return copy(state.revisions[value]?.replicas ?? null);
    if (operation === 'updateHeld' || operation === 'updateOpen') {
      const previous = state.revisions[state.current];
      const next = `r${++state.counter}`;
      previous.active = false;
      previous.replicas = [];
      state.revisions[next] = { name: next, image: operation === 'updateHeld' ? value : previous.image,
        hold: operation === 'updateHeld', active: true, health: 'Healthy', replicas: [next + '-1'] };
      state.current = next;
      return null;
    }
    throw new Error('Unknown operation');
  };
  const fetchJson = async () => {
    const current = state.forcedPublic || state.revisions[state.current];
    return { ok: true, release: current.image.split(':')[1], cutoverHold: current.hold,
      database: { driver: 'postgres', state: 'ready' }, backup: { configured: true, state: 'ready' } };
  };
  const options = { az, fetchJson, fetchStatic: async () => true, sleep: async () => {}, revisionAttempts: 2,
    publicAttempts: 2, drainAttempts: 2 };
  return { state, az, fetchJson, options };
}

test('held bootstrap verifies exact image, public hold, and two empty predecessor observations', async () => {
  const { state, options } = fixture();
  const result = await deployHeld({ ...options, sha: newSha });
  assert.equal(result.cutoverHold, true);
  assert.equal(state.revisions.old.active, false);
  assert.equal(state.revisions.old.replicas.length, 0);
  assert.equal(state.calls.filter(([op, value]) => op === 'replicas' && value === 'old').length, 2);
  assert.equal(state.calls.filter(([op]) => op === 'updateOpen').length, 0);
});

test('bootstrap failure never rolls back to an unguarded previous revision', async () => {
  const { state, az, options } = fixture();
  const unsafeAz = async (op, value) => {
    const result = await az(op, value);
    if (op === 'updateHeld') state.revisions.old.replicas = ['old-still-running'];
    return result;
  };
  await assert.rejects(deployHeld({ ...options, az: unsafeAz, sha: newSha }), /No rollback to an unguarded image/);
  assert.equal(state.calls.filter(([op]) => op === 'updateHeld').length, 1);
  assert.equal(state.calls.some(([op]) => op === 'updateOpen'), false);
});

test('ordinary HTTP failure prevents declaring the held bootstrap ready', async () => {
  const { state, options } = fixture();
  await assert.rejects(deployHeld({ ...options, fetchStatic: async () => false,
    sha: newSha, publicAttempts: 1 }), /No rollback to an unguarded image/);
  assert.equal(state.calls.filter(([op]) => op === 'updateOpen').length, 0);
});

test('failed deployment from a positively verified held revision rolls back only to held', async () => {
  const { state, options } = fixture({ oldHold: true });
  const fetchJson = async () => {
    if (state.current !== 'old') throw new Error('synthetic public failure');
    return options.fetchJson();
  };
  await assert.rejects(deployHeld({ ...options, fetchJson, sha: newSha, publicAttempts: 1 }), /held rollback verification FAILED/);
  assert.equal(state.calls.some(([op, value]) => op === 'updateHeld' && value === image(oldSha)), true);
  assert.equal(state.calls.some(([op]) => op === 'updateOpen'), false);
});

test('a failed held update does not retry when Azure may already have applied it', async () => {
  const { state, options } = fixture();
  const az = async (op, value) => {
    const result = await options.az(op, value);
    if (op === 'updateHeld') throw new Error('synthetic timeout after commit');
    return result;
  };
  await assert.rejects(deployHeld({ ...options, az, sha: newSha }), /hold=true.*No rollback to an unguarded image/);
  assert.equal(state.calls.filter(([op]) => op === 'updateHeld').length, 1);
});

test('held predecessor rollback succeeds after exact desired image fails public health', async () => {
  const { state, options } = fixture({ oldHold: true });
  const fetchJson = async path => {
    if (state.revisions[state.current].image === image(newSha)) throw new Error('synthetic health failure');
    return options.fetchJson(path);
  };
  await assert.rejects(deployHeld({ ...options, fetchJson, sha: newSha, publicAttempts: 1 }), /held rollback verified/);
  assert.equal(state.revisions[state.current].hold, true);
  assert.equal(state.revisions[state.current].image, image(oldSha));
});

test('opening is refused while any predecessor still runs, including a stale replica', async () => {
  const { state, options } = fixture({ oldHold: true });
  state.revisions.old.image = image(newSha);
  state.revisions.stale = { name: 'stale', image: image(oldSha), hold: true,
    active: false, health: 'Healthy', replicas: ['stale-1'] };
  await assert.rejects(openHeld({ ...options, sha: newSha, bootstrapSha: oldSha }), /inactive with zero replicas/);
  assert.equal(state.calls.some(([op]) => op === 'updateOpen'), false);
});

test('opening exact held image succeeds only after all predecessors retire', async () => {
  const { state, options } = fixture({ oldHold: true });
  state.revisions.old.image = image(newSha);
  state.revisions.stale = { name: 'stale', image: image(oldSha), hold: true,
    active: false, health: 'Healthy', replicas: [] };
  const result = await openHeld({ ...options, sha: newSha, bootstrapSha: oldSha });
  assert.equal(result.cutoverHold, false);
  assert.equal(state.revisions[result.revision].image, image(newSha));
  assert.equal(state.calls.filter(([op, value]) => op === 'replicas' && value === 'stale').length, 2);
  assert.equal(state.calls.filter(([op, value]) => op === 'replicas' && value === 'old').length, 2);
});

test('inactive flag is required even when replica list is empty', async () => {
  const { state, options } = fixture({ oldHold: true });
  state.revisions.old.image = image(newSha);
  state.revisions.stale = { name: 'stale', image: image(oldSha), hold: true,
    active: true, health: 'Healthy', replicas: [] };
  await assert.rejects(openHeld({ ...options, sha: newSha, bootstrapSha: oldSha }), /inactive with zero replicas/);
  assert.equal(state.calls.some(([op]) => op === 'updateOpen'), false);
});

test('revision or replica unknown and cancellation fail closed before opening', async () => {
  const { state, options } = fixture({ oldHold: true });
  state.revisions.old.image = image(newSha);
  const az = async (op, value) => op === 'replicas' ? null : options.az(op, value);
  state.revisions.stale = { name: 'stale', image: image(oldSha), hold: true,
    active: false, health: 'Healthy', replicas: [] };
  await assert.rejects(openHeld({ ...options, az, sha: newSha, bootstrapSha: oldSha }), /unknown/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(openHeld({ ...options, sha: newSha, bootstrapSha: oldSha, signal: abort.signal }), /cancelled/);
  assert.equal(state.calls.some(([op]) => op === 'updateOpen'), false);
});

test('open failure tries only a held rollback of the same image', async () => {
  const { state, options } = fixture({ oldHold: true });
  state.revisions.old.image = image(newSha);
  state.revisions.stale = { name: 'stale', image: image(oldSha), hold: true,
    active: false, health: 'Healthy', replicas: [] };
  let failOpen = false;
  const fetchJson = async path => {
    if (failOpen && state.revisions[state.current].hold === false)
      throw new Error('synthetic bad public health');
    return options.fetchJson(path);
  };
  const az = async (op, value) => {
    const result = await options.az(op, value);
    if (op === 'updateOpen') failOpen = true;
    return result;
  };
  await assert.rejects(openHeld({ ...options, az, fetchJson, sha: newSha, bootstrapSha: oldSha, publicAttempts: 1 }), /held rollback verified/);
  assert.equal(state.revisions[state.current].hold, true);
  assert.equal(state.revisions[state.current].image, image(newSha));
});

test('open command committed then errored, so observed open state is restored to held', async () => {
  const { state, options } = fixture({ oldHold: true });
  state.revisions.old.image = image(newSha);
  state.revisions.stale = { name: 'stale', image: image(oldSha), hold: true,
    active: false, health: 'Healthy', replicas: [] };
  const az = async (op, value) => {
    const result = await options.az(op, value);
    if (op === 'updateOpen') throw new Error('synthetic timeout after commit');
    return result;
  };
  await assert.rejects(openHeld({ ...options, az, sha: newSha, bootstrapSha: oldSha }), /held rollback verified/);
  assert.equal(state.revisions[state.current].hold, true);
  assert.equal(state.calls.filter(([op]) => op === 'updateOpen').length, 1);
});

test('operator cancellation after open mutation restores held state', async () => {
  const { state, options } = fixture({ oldHold: true });
  state.revisions.old.image = image(newSha);
  state.revisions.stale = { name: 'stale', image: image(oldSha), hold: true,
    active: false, health: 'Healthy', replicas: [] };
  const abort = new AbortController();
  const az = async (op, value) => {
    const result = await options.az(op, value);
    if (op === 'updateOpen') abort.abort();
    return result;
  };
  await assert.rejects(openHeld({ ...options, az, sha: newSha, bootstrapSha: oldSha, signal: abort.signal }), /held rollback verified/);
  assert.equal(state.revisions[state.current].hold, true);
});

test('first guard image cannot be opened and unrelated stale revisions do not authorize opening', async () => {
  const { state, options } = fixture({ oldHold: true });
  state.revisions.old.image = image(newSha);
  await assert.rejects(openHeld({ ...options, sha: newSha, bootstrapSha: newSha }), /bootstrap guard image cannot be opened/);
  await assert.rejects(openHeld({ ...options, sha: newSha, bootstrapSha: oldSha }), /retired held bootstrap guard revision/);
  assert.equal(state.calls.some(([op]) => op === 'updateOpen'), false);
});

test('Azure command builder preserves other env vars and excludes secret-bearing output', () => {
  assert.deepEqual(azureArgs('updateHeld', image(newSha)).slice(-4),
    ['--set-env-vars', 'ORBIT_CUTOVER_HOLD=true', '--output', 'none']);
  assert.equal(azureArgs('updateOpen').includes('--set-env-vars'), true);
  assert.equal(azureArgs('replicas', 'old').includes('--revision'), true);
  assert.equal(normalizeRevision({ name: 'old', env: [{ name: 'SECRET', value: 'unlogged' }] }).hold, null);
  assert.equal(normalizeRevision({ name: 'new', env: [{ name: 'ORBIT_CUTOVER_HOLD', value: 'true' }] }).hold, true);
});
