// Single-revision deployment gate. The same function is exercised with a fake
// Azure API in test/deploy-safety.test.js; the CLI adapter below is deliberately
// small so a failed verification always reaches the rollback path.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const resource = ['-g', 'orbit-buddy-rg', '-n', 'orbit-buddy'];
const imageFor = (sha) => `ghcr.io/smokeys30/orbit-buddy:${sha}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function deployRelease({ sha, az, fetchJson, sleep = pause, log = console.log,
  revisionAttempts = 30, publicAttempts = 8 } = {}) {
  if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error('A full 40-character release SHA is required.');
  const desiredImage = imageFor(sha);
  const app = await az('show');
  if (String(app?.mode).toLowerCase() !== 'single' || !app.ready) {
    throw new Error('Deployment preflight failed: a single active ready revision is required.');
  }
  const previous = await az('revision', app.ready);
  if (previous?.name !== app.ready || previous.active !== true || previous.health !== 'Healthy' || !previous.image) {
    throw new Error('Deployment preflight failed: the previous revision is not healthy and active.');
  }
  // A full SHA tag allows public rollback identity checking on subsequent
  // releases. The first rollout can inherit an older :latest image without a
  // public release field; its Azure image and health are still verified.
  const previousSha = /^ghcr\.io\/smokeys30\/orbit-buddy:([0-9a-f]{40})$/.exec(previous.image)?.[1] || null;
  let verifiedPreviousSha = null;
  if (previousSha) {
    try {
      const oldHealth = await fetchJson('/healthz');
      if (oldHealth.release === previousSha) verifiedPreviousSha = previousSha;
    } catch { /* The revision check remains the rollback identity gate. */ }
  }
  log(`Deploying ${sha} from revision ${previous.name}.`);

  async function verifyRevision(image, oldName) {
    for (let attempt = 1; attempt <= revisionAttempts; attempt++) {
      const current = await az('show');
      const name = current?.latest;
      if (name && (name !== oldName || image === previous.image)) {
        const revision = await az('revision', name);
        if (revision?.name === name && revision.image === image) {
          if (revision.health === 'Unhealthy') throw new Error('New Azure revision is unhealthy.');
          if (revision.health === 'Healthy' && revision.active === true && current.ready === name) {
            log(`Azure revision ${name} is healthy with the expected image.`);
            return name;
          }
        }
      }
      if (attempt < revisionAttempts) await sleep(20_000);
    }
    throw new Error('Azure revision did not become healthy with the expected image.');
  }

  async function verifyPublic(expectedSha) {
    for (let attempt = 1; attempt <= publicAttempts; attempt++) {
      try {
        const [live, ready, health] = await Promise.all([
          fetchJson('/livez'), fetchJson('/readyz'), fetchJson('/healthz'),
        ]);
        const releaseMatches = !expectedSha || [live, ready, health].every((part) => part.release === expectedSha);
        if (releaseMatches && live.ok === true && ready.ok === true && health.ok === true &&
          ready.database?.driver === 'postgres' && ready.database?.state === 'ready' &&
          health.database?.driver === 'postgres' && health.database?.state === 'ready' &&
          health.backup?.configured === true && health.backup?.state === 'ready') {
          log(`Public /livez, /readyz and /healthz verified${expectedSha ? ` for ${expectedSha}` : ''}.`);
          return;
        }
      } catch { /* The old revision may still be receiving traffic. */ }
      if (attempt < publicAttempts) await sleep(10_000);
    }
    throw new Error('Public health or release identity verification failed.');
  }

  try {
    await az('update', desiredImage);
    const deployed = await verifyRevision(desiredImage, previous.name);
    await verifyPublic(sha);
    const final = await az('show');
    if (final.ready !== deployed || final.latest !== deployed) throw new Error('Azure release changed during public verification.');
    const finalRevision = await az('revision', deployed);
    if (finalRevision.image !== desiredImage || finalRevision.health !== 'Healthy' || finalRevision.active !== true) {
      throw new Error('Azure release identity changed during public verification.');
    }
    return { revision: deployed, image: desiredImage };
  } catch (error) {
    log(`Deployment failed: ${error.message} Starting rollback to ${previous.image}.`);
    try {
      await az('update', previous.image);
      await verifyRevision(previous.image, '');
      await verifyPublic(verifiedPreviousSha);
      throw Object.assign(new Error(`Deployment failed and rollback verified: ${error.message}`), { rollbackVerified: true });
    } catch (rollbackError) {
      if (rollbackError.rollbackVerified) throw rollbackError;
      throw new Error(`Deployment failed: ${error.message}; rollback verification FAILED: ${rollbackError.message}`);
    }
  }
}

async function cliAz(operation, value) {
  let args;
  if (operation === 'show') {
    args = ['containerapp', 'show', ...resource, '--query', '{mode:properties.configuration.activeRevisionsMode,latest:properties.latestRevisionName,ready:properties.latestReadyRevisionName}', '-o', 'json'];
  } else if (operation === 'revision') {
    args = ['containerapp', 'revision', 'show', ...resource, '--revision', value, '--query', '{name:name,active:properties.active,health:properties.healthState,image:properties.template.containers[0].image}', '-o', 'json'];
  } else if (operation === 'update') {
    args = ['containerapp', 'update', ...resource, '--image', value, '--output', 'none'];
  } else throw new Error('Unknown Azure operation.');
  try {
    const { stdout } = await execFileAsync('az', args, { maxBuffer: 1024 * 1024 });
    return operation === 'update' ? null : JSON.parse(stdout);
  } catch {
    throw new Error(`Azure ${operation} command failed.`);
  }
}

async function publicFetch(path) {
  const url = `https://orbitbuddy.app${path}?deploy_check=${Date.now()}`;
  const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Retained only for historical rollback regression tests. This CLI would
  // reactivate an unguarded predecessor during the guarded cutover.
  console.error('Legacy deploy command is disabled. Use guarded-containerapp.mjs.');
  process.exitCode = 2;
}
