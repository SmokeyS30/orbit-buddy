// Azure adapter for the reviewed, held-by-default cutover state machine.
// This is invoked only by the existing Azure OIDC deployment workflow.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { deployHeld, openHeld } from './guarded-cutover.mjs';

const execFileAsync = promisify(execFile);
const resource = ['-g', 'orbit-buddy-rg', '-n', 'orbit-buddy'];

export function azureArgs(operation, value) {
  if (operation === 'show') return ['containerapp', 'show', ...resource,
    '--query', '{mode:properties.configuration.activeRevisionsMode,latest:properties.latestRevisionName,ready:properties.latestReadyRevisionName}', '-o', 'json'];
  if (operation === 'revision') return ['containerapp', 'revision', 'show', ...resource, '--revision', value,
    '--query', '{name:name,active:properties.active,health:properties.healthState,image:properties.template.containers[0].image,env:properties.template.containers[0].env}', '-o', 'json'];
  if (operation === 'revisions') return ['containerapp', 'revision', 'list', ...resource, '--all',
    '--query', '[].{name:name}', '-o', 'json'];
  if (operation === 'replicas') return ['containerapp', 'replica', 'list', ...resource, '--revision', value,
    '--query', '[].name', '-o', 'json'];
  if (operation === 'updateHeld') return ['containerapp', 'update', ...resource,
    '--image', value, '--set-env-vars', 'ORBIT_CUTOVER_HOLD=true', '--output', 'none'];
  if (operation === 'updateOpen') return ['containerapp', 'update', ...resource,
    '--image', value.image, '--set-env-vars', 'ORBIT_CUTOVER_HOLD=false', '--output', 'none'];
  throw new Error('Unknown Azure operation.');
}

export function normalizeRevision(raw) {
  if (!raw) return { hold: null };
  const { env, ...revision } = raw;
  if (!Array.isArray(env))
    return { ...revision, hold: null }; // Unknown is never treated as safe to open or roll back.
  const values = env.filter(row => row?.name === 'ORBIT_CUTOVER_HOLD');
  const hold = values.length === 1 && values[0].value === 'true' ? true :
    values.length === 1 && values[0].value === 'false' ? false : null;
  return { ...revision, hold };
}

export function assertExpectedOpenTarget(app, revision, expected) {
  if (!expected || !/^ghcr\.io\/smokeys30\/orbit-buddy:[0-9a-f]{40}$/.test(expected.image || '') ||
      !expected.expectedRevision || String(app?.mode).toLowerCase() !== 'single' ||
      app.latest !== expected.expectedRevision || app.ready !== expected.expectedRevision ||
      revision?.name !== expected.expectedRevision || revision.active !== true ||
      revision.health !== 'Healthy' || revision.image !== expected.image || revision.hold !== true)
    throw new Error('The exact held Azure revision changed before opening.');
}

export async function cliAz(operation, value) {
  if (operation === 'updateOpen') {
    const app = await cliAz('show');
    const revision = await cliAz('revision', value?.expectedRevision);
    assertExpectedOpenTarget(app, revision, value);
  }
  const args = azureArgs(operation, value);
  let stdout;
  try {
    ({ stdout } = await execFileAsync('az', args, { maxBuffer: 1024 * 1024, timeout: 120_000 }));
  } catch {
    // Never include Azure stdout/stderr: revision JSON can contain secret references.
    throw new Error(`Azure ${operation} command failed or timed out; remote outcome may be unknown.`);
  }
  if (operation.startsWith('update')) return null;
  let raw;
  try { raw = JSON.parse(stdout); }
  catch { throw new Error(`Azure ${operation} returned invalid JSON.`); }
  return operation === 'revision' ? normalizeRevision(raw) : raw;
}

async function publicFetch(path) {
  const response = await fetch(`https://orbitbuddy.app${path}?deploy_check=${Date.now()}`,
    { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

async function publicStatic() {
  const response = await fetch(`https://orbitbuddy.app/?deploy_check=${Date.now()}`,
    { method: 'HEAD', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15_000) });
  return response.status === 200;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  process.once('SIGTERM', () => abort.abort());
  const deadline = setTimeout(() => abort.abort(), 20 * 60_000);
  deadline.unref();
  const options = { sha: process.env.RELEASE_SHA, az: cliAz, fetchJson: publicFetch,
    fetchStatic: publicStatic,
    bootstrapSha: process.env.GUARD_BOOTSTRAP_SHA,
    signal: abort.signal, log: message => console.log(message) };
  const operation = process.argv[2] === 'deploy-held' ? deployHeld :
    process.argv[2] === 'open-held' ? openHeld : null;
  if (!operation) { console.error('Use deploy-held or open-held.'); process.exitCode = 2; }
  else operation(options)
    .then(({ revision, cutoverHold }) => console.log(`Cutover verified at revision ${revision}; hold=${cutoverHold}.`))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => clearTimeout(deadline));
}
