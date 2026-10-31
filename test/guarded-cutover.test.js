import test from 'node:test';
import assert from 'node:assert/strict';
import { deployHeld, openHeld, retired } from '../scripts/guarded-cutover.mjs';
import { azureArgs, normalizeRevision, assertExpectedOpenTarget } from '../scripts/guarded-containerapp.mjs';

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
      state.revisions[next] = { name: next, image: operation === 'updateHeld' ? value : value.image,
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
  assert.equal(state.calls.filter(([op, value]) => op === 'replicas' && value === 'old').length, 3);
  assert.equal(state.calls.filter(([op]) => op === 'updateOpen').length, 0);
});

test('held deployment probes all active and inactive replica reads before its first update', async () => {
  const { state, options } = fixture();
  state.revisions.stale = { name: 'stale', image: image(oldSha), hold: true,
    active: false, health: 'Healthy', replicas: [] };
  await deployHeld({ ...options, sha: newSha });
  const update = state.calls.findIndex(([op]) => op === 'updateHeld');
  assert.ok(update > 0);
  assert.ok(state.calls.slice(0, update).some(([op]) => op === 'revisions'));
  for (const name of ['old', 'stale'])
    assert.ok(state.calls.slice(0, update).some(([op, value]) => op === 'replicas' && value === name));
});

test('denied or malformed revision inventory stops before any held image mutation', async () => {
  for (const response of [new Error('synthetic revision-list permission denied'), [],
    [{ name: 'other' }], [{ name: 'old' }, { name: 'old' }]]) {
    const { state, options } = fixture();
    const az = async (op, value) => op === 'revisions'
      ? response instanceof Error ? Promise.reject(response) : response
      : options.az(op, value);
    await assert.rejects(deployHeld({ ...options, az, sha: newSha }),
      /permission denied|unknown, incomplete, or malformed/);
    assert.equal(state.calls.some(([op]) => op.startsWith('update')), false);
  }
});

test('denied, missing, or malformed replica data stops before held image mutation', async () => {
  for (const response of [new Error('synthetic replica-list permission denied'), null, [null], ['same','same']]) {
    const { state, options } = fixture();
    state.revisions.stale = { name: 'stale', image: image(oldSha), hold: true,
      active: false, health: 'Healthy', replicas: [] };
    const az = async (op, value) => op === 'replicas' && value === 'stale'
      ? response instanceof Error ? Promise.reject(response) : response
      : options.az(op, value);
    await assert.rejects(deployHeld({ ...options, az, sha: newSha }),
      /permission denied|unknown or malformed/);
    assert.equal(state.calls.some(([op]) => op.startsWith('update')), false);
  }
});

test('unreadable revision details or inventory changes stop before held image mutation', async () => {
  for (const fail of ['details', 'changed-list']) {
    const { state, options } = fixture();
    state.revisions.stale = { name: 'stale', image: image(oldSha), hold: true,
      active: false, health: 'Healthy', replicas: [] };
    let inventories = 0;
    const az = async (op, value) => {
      if (fail === 'details' && op === 'revision' && value === 'stale')
        throw new Error('synthetic revision-show permission denied');
      if (fail === 'changed-list' && op === 'revisions' && ++inventories === 2)
        return [{ name: 'old' }];
      return options.az(op, value);
    };
    await assert.rejects(deployHeld({ ...options, az, sha: newSha }),
      /permission denied|inventory changed before mutation/);
    assert.equal(state.calls.some(([op]) => op.startsWith('update')), false);
  }
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
  assert.equal(state.calls.filter(([op, value]) => op === 'replicas' && value === 'stale').length, 5);
  assert.equal(state.calls.filter(([op, value]) => op === 'replicas' && value === 'old').length, 3);
  const update = state.calls.findIndex(([op]) => op === 'updateOpen');
  assert.ok(state.calls.slice(0, update).some(([op, value]) => op === 'replicas' && value === 'old'));
  assert.ok(state.calls.slice(0, update).some(([op, value]) => op === 'replicas' && value === 'stale'));
});

test('denied current replica read prevents opening a held revision', async () => {
  const { state, options } = fixture({ oldHold: true });
  state.revisions.old.image = image(newSha);
  state.revisions.stale = { name: 'stale', image: image(oldSha), hold: true,
    active: false, health: 'Healthy', replicas: [] };
  const az = async (op, value) => op === 'replicas' && value === 'old'
    ? Promise.reject(new Error('synthetic current-replica permission denied')) : options.az(op, value);
  await assert.rejects(openHeld({ ...options, az, sha: newSha, bootstrapSha: oldSha }), /permission denied/);
  assert.equal(state.calls.some(([op]) => op.startsWith('update')), false);
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

test('applied-then-errored open cannot claim held rollback while old OPEN replica remains', async () => {
  const { state, options } = fixture({ oldHold: true });
  state.revisions.old.image = image(newSha);
  state.revisions.stale = { name: 'stale', image: image(oldSha), hold: true,
    active: false, health: 'Healthy', replicas: [] };
  let openName;
  const az = async (op, value) => {
    const result = await options.az(op, value);
    if (op === 'updateOpen') {
      openName = state.current;
      throw new Error('synthetic timeout after commit');
    }
    if (op === 'updateHeld' && openName)
      state.revisions[openName].replicas = ['old-open-still-running'];
    return result;
  };
  await assert.rejects(openHeld({ ...options, az, sha: newSha, bootstrapSha: oldSha }),
    /held rollback verification FAILED: A predecessor revision remains active or has replicas/);
  assert.equal(state.revisions[state.current].hold, true);
  assert.deepEqual(state.revisions[openName].replicas, ['old-open-still-running']);
});

test('applied-then-errored open verifies rollback only after explicit OPEN replica drain', async () => {
  const { state, options } = fixture({ oldHold: true });
  state.revisions.old.image = image(newSha);
  state.revisions.stale = { name: 'stale', image: image(oldSha), hold: true,
    active: false, health: 'Healthy', replicas: [] };
  let openName;
  const az = async (op, value) => {
    const result = await options.az(op, value);
    if (op === 'updateOpen') {
      openName = state.current;
      throw new Error('synthetic timeout after commit');
    }
    if (op === 'updateHeld' && openName)
      state.revisions[openName].replicas = ['old-open-still-running'];
    return result;
  };
  const sleep = async () => {
    if (openName && state.revisions[openName].replicas.length)
      state.revisions[openName].replicas = [];
  };
  await assert.rejects(openHeld({ ...options, az, sleep, drainAttempts: 3,
    sha: newSha, bootstrapSha: oldSha }), /held rollback verified/);
  assert.equal(state.revisions[openName].replicas.length, 0);
  assert.ok(state.calls.filter(([op, value]) => op === 'replicas' && value === openName).length >= 3);
});

test('cancelled open cannot claim rollback with old OPEN replicas or failed replica query', async () => {
  const { state, options } = fixture({ oldHold: true });
  state.revisions.old.image = image(newSha);
  state.revisions.stale = { name: 'stale', image: image(oldSha), hold: true,
    active: false, health: 'Healthy', replicas: [] };
  const abort = new AbortController();
  let openName;
  const az = async (op, value) => {
    if (op === 'replicas' && value === openName) throw new Error('synthetic replica query failure');
    const result = await options.az(op, value);
    if (op === 'updateOpen') { openName = state.current; abort.abort(); }
    return result;
  };
  await assert.rejects(openHeld({ ...options, az, signal: abort.signal,
    sha: newSha, bootstrapSha: oldSha }),
  /held rollback verification FAILED: synthetic replica query failure/);
  assert.equal(state.revisions[state.current].hold, true);
});

test('cancelled open with retained OPEN replica never reports verified rollback', async () => {
  const { state, options } = fixture({ oldHold: true });
  state.revisions.old.image = image(newSha);
  state.revisions.stale = { name: 'stale', image: image(oldSha), hold: true,
    active: false, health: 'Healthy', replicas: [] };
  const abort = new AbortController();
  let openName;
  const az = async (op, value) => {
    const result = await options.az(op, value);
    if (op === 'updateOpen') { openName = state.current; abort.abort(); }
    if (op === 'updateHeld' && openName)
      state.revisions[openName].replicas = ['cancelled-open-still-running'];
    return result;
  };
  await assert.rejects(openHeld({ ...options, az, signal: abort.signal,
    sha: newSha, bootstrapSha: oldSha }),
  /held rollback verification FAILED: A predecessor revision remains active or has replicas/);
  assert.deepEqual(state.revisions[openName].replicas, ['cancelled-open-still-running']);
});

test('uncertain Azure ready state after open mutation does not trigger blind rollback', async () => {
  const { state, options } = fixture({ oldHold: true });
  state.revisions.old.image = image(newSha);
  state.revisions.stale = { name: 'stale', image: image(oldSha), hold: true,
    active: false, health: 'Healthy', replicas: [] };
  let updateAttempted = false;
  const az = async (op, value) => {
    if (op === 'show' && updateAttempted)
      return { mode: 'Single', latest: state.current, ready: 'old' };
    const result = await options.az(op, value);
    if (op === 'updateOpen') { updateAttempted = true; throw new Error('synthetic uncertain timeout'); }
    return result;
  };
  await assert.rejects(openHeld({ ...options, az, sha: newSha, bootstrapSha: oldSha }),
    /Azure ready state is unknown or unexpected. No blind update was attempted/);
  assert.equal(state.calls.filter(([op]) => op === 'updateHeld').length, 0);
});

test('unexpected revision mode during verification cannot be called a safe opening', async () => {
  const { state, options } = fixture({ oldHold: true });
  state.revisions.old.image = image(newSha);
  state.revisions.stale = { name: 'stale', image: image(oldSha), hold: true,
    active: false, health: 'Healthy', replicas: [] };
  let opening = false;
  const az = async (op, value) => {
    if (op === 'show' && opening)
      return { mode: 'Multiple', latest: state.current, ready: state.current };
    const result = await options.az(op, value);
    if (op === 'updateOpen') opening = true;
    return result;
  };
  await assert.rejects(openHeld({ ...options, az, sha: newSha, bootstrapSha: oldSha }),
    /held rollback verification FAILED|Azure ready state is unknown or unexpected/);
});

test('missing observed OPEN revision from inventory prevents rollback success', async () => {
  const { state, options } = fixture({ oldHold: true });
  state.revisions.old.image = image(newSha);
  state.revisions.stale = { name: 'stale', image: image(oldSha), hold: true,
    active: false, health: 'Healthy', replicas: [] };
  let openName;
  const az = async (op, value) => {
    if (op === 'revisions' && openName && state.current !== openName)
      return Object.keys(state.revisions).filter(name => name !== openName).map(name => ({ name }));
    const result = await options.az(op, value);
    if (op === 'updateOpen') { openName = state.current; throw new Error('synthetic timeout'); }
    return result;
  };
  await assert.rejects(openHeld({ ...options, az, sha: newSha, bootstrapSha: oldSha }),
    /held rollback verification FAILED: Revision inventory is missing, incomplete, or malformed/);
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
  const openArgs=azureArgs('updateOpen',{image:image(newSha),expectedRevision:'old'});
  assert.equal(openArgs.includes('--set-env-vars'), true);
  assert.equal(openArgs.includes(image(newSha)), true);
  assert.equal(azureArgs('replicas', 'old').includes('--revision'), true);
  assert.equal(azureArgs('revisions').includes('--all'), true);
  assert.equal(normalizeRevision({ name: 'old', env: [{ name: 'SECRET', value: 'unlogged' }] }).hold, null);
  assert.equal(normalizeRevision({ name: 'new', env: [{ name: 'ORBIT_CUTOVER_HOLD', value: 'true' }] }).hold, true);
});

test('opening command rejects an out-of-band revision or image before mutation', () => {
  const expected={image:image(newSha),expectedRevision:'held'};
  const app={mode:'Single',latest:'held',ready:'held'};
  const revision={name:'held',active:true,health:'Healthy',image:image(newSha),hold:true};
  assert.doesNotThrow(()=>assertExpectedOpenTarget(app,revision,expected));
  assert.throws(()=>assertExpectedOpenTarget({...app,latest:'intruder'},revision,expected),/changed before opening/);
  assert.throws(()=>assertExpectedOpenTarget(app,{...revision,image:image(oldSha)},expected),/changed before opening/);
  assert.throws(()=>assertExpectedOpenTarget({...app,mode:'Multiple'},revision,expected),/changed before opening/);
});

test('a mismatched revision name is not accepted as a drained predecessor', async () => {
  const az=async(op)=>op==='revision'?{name:'different',active:false}:[];
  await assert.rejects(retired({az,name:'expected',attempts:1,sleep:async()=>{}}),/unknown/);
});
