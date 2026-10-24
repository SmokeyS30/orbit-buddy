import test from 'node:test';
import assert from 'node:assert/strict';
import { deployRelease } from '../scripts/deploy-containerapp.mjs';

const sha = 'a'.repeat(40);
const prior = 'ghcr.io/smokeys30/orbit-buddy:latest';
const next = `ghcr.io/smokeys30/orbit-buddy:${sha}`;

function fixture({ newHealth = 'Healthy', badPublic = false, failRollback = false } = {}) {
  let current = 'old';
  let updates = [];
  const revisions = {
    old: { name: 'old', active: true, health: 'Healthy', image: prior },
    new: { name: 'new', active: true, health: newHealth, image: next },
    restored: { name: 'restored', active: true, health: 'Healthy', image: prior },
  };
  const az = async (operation, value) => {
    if (operation === 'show') return { mode: 'Single', latest: current, ready: current };
    if (operation === 'revision') return revisions[value];
    if (operation === 'update') {
      updates.push(value);
      if (value === prior && failRollback) throw new Error('rollback API failed');
      current = value === next ? 'new' : 'restored';
      return;
    }
    throw new Error('unexpected Azure operation');
  };
  const fetchJson = async (path) => {
    const release = current === 'new' && !badPublic ? sha : undefined;
    if (path === '/livez') return { ok: true, release };
    if (path === '/readyz') return { ok: true, release, database: { driver: 'postgres', state: 'ready' } };
    return { ok: true, release, database: { driver: 'postgres', state: 'ready' }, backup: { configured: true, state: 'ready' } };
  };
  return { az, fetchJson, sleep: async () => {}, log: () => {}, revisionAttempts: 2, publicAttempts: 2, updates };
}

test('deploy gate verifies image, revision and the exact public release', async () => {
  const f = fixture();
  const result = await deployRelease({ sha, ...f });
  assert.deepEqual(result, { revision: 'new', image: next });
  assert.deepEqual(f.updates, [next]);
});

test('unhealthy revision triggers a verified rollback and fails the gate', async () => {
  const f = fixture({ newHealth: 'Unhealthy' });
  await assert.rejects(deployRelease({ sha, ...f }), /rollback verified/);
  assert.deepEqual(f.updates, [next, prior]);
});

test('healthy revision serving a different public release triggers rollback', async () => {
  const f = fixture({ badPublic: true });
  await assert.rejects(deployRelease({ sha, ...f }), /rollback verified/);
  assert.deepEqual(f.updates, [next, prior]);
});

test('failed rollback remains a failed deployment with an explicit error', async () => {
  const f = fixture({ newHealth: 'Unhealthy', failRollback: true });
  await assert.rejects(deployRelease({ sha, ...f }), /rollback verification FAILED/);
  assert.deepEqual(f.updates, [next, prior]);
});

test('an Azure update error still attempts rollback because the update may have partially applied', async () => {
  const f = fixture();
  const original = f.az;
  f.az = async (operation, value) => {
    if (operation === 'update' && value === next) {
      await original(operation, value);
      throw new Error('update timed out after creating revision');
    }
    return original(operation, value);
  };
  await assert.rejects(deployRelease({ sha, ...f }), /rollback verified/);
  assert.deepEqual(f.updates, [next, prior]);
});

test('preflight refuses to change an unhealthy existing revision', async () => {
  const f = fixture();
  const original = f.az;
  f.az = async (operation, value) => operation === 'revision' ? { ...(await original(operation, value)), health: 'Unhealthy' } : original(operation, value);
  await assert.rejects(deployRelease({ sha, ...f }), /preflight failed/);
  assert.deepEqual(f.updates, []);
});
