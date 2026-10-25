// Pure cutover state machine. Azure calls are injected and tested with a fake
// revision/replica API; the CLI wrapper supplies the existing Azure identity.
const imageFor = sha => 'ghcr.io/smokeys30/orbit-buddy:' + sha;
const shaFromImage = image => /^ghcr\.io\/smokeys30\/orbit-buddy:([0-9a-f]{40})$/.exec(image || '')?.[1] || null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const stopped = signal => { if (signal?.aborted) throw new Error('Operator cancelled the cutover.'); };
const validSha = sha => { if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error('A full release SHA is required.'); };

function requireReady(app, revision) {
  if (String(app?.mode).toLowerCase() !== 'single' || !app.ready || app.latest !== app.ready ||
      revision?.name !== app.ready || revision.active !== true ||
      revision.health !== 'Healthy' || !revision.image)
    throw new Error('Preflight requires one healthy ready revision.');
}

async function readyRevision({ az, sleep, signal, image, hold, oldName, attempts, allowSame = false }) {
  for (let i = 0; i < attempts; i++) {
    stopped(signal);
    const app = await az('show');
    if (String(app?.mode).toLowerCase() !== 'single')
      throw new Error('Azure revision mode changed during verification.');
    if (app?.latest && (allowSame || app.latest !== oldName)) {
      const revision = await az('revision', app.latest);
      if (revision?.image === image && revision.hold === hold &&
          revision.name === app.ready && revision.active === true && revision.health === 'Healthy')
        return revision.name;
      if (revision?.image === image && revision.health === 'Unhealthy')
        throw new Error('New revision is unhealthy.');
    }
    if (i + 1 < attempts) await sleep(20_000);
  }
  throw new Error('Expected image and hold state did not become ready.');
}

async function publicReady({ fetchJson, fetchStatic, sleep, signal, sha, hold, attempts }) {
  for (let i = 0; i < attempts; i++) {
    stopped(signal);
    try {
      const [live, ready, health] = await Promise.all(['/livez','/readyz','/healthz'].map(fetchJson));
      const staticOk = await fetchStatic();
      if ([live,ready,health].every(row => row?.ok === true && row.release === sha) &&
          staticOk === true &&
          ready.cutoverHold === hold && health.cutoverHold === hold &&
          ready.database?.driver === 'postgres' && ready.database?.state === 'ready' &&
          health.database?.driver === 'postgres' && health.database?.state === 'ready' &&
          health.backup?.configured === true && health.backup?.state === 'ready') return;
    } catch { /* old revision may still receive traffic */ }
    if (i + 1 < attempts) await sleep(10_000);
  }
  throw new Error('Public health, exact SHA, or hold state did not verify.');
}

export async function retired({ az, sleep = pause, signal, name, attempts = 30 }) {
  if (!name) throw new Error('Old revision identity is missing.');
  let empty = 0;
  for (let i = 0; i < attempts; i++) {
    stopped(signal);
    const revision = await az('revision', name);
    const replicas = await az('replicas', name);
    if (revision?.name !== name || !Array.isArray(replicas))
      throw new Error('Old revision or replica result is unknown; hold remains closed.');
    empty = revision.active === false && replicas.length === 0 ? empty + 1 : 0;
    if (empty >= 2) return;
    if (i + 1 < attempts) await sleep(10_000);
  }
  throw new Error('Old revision did not become inactive with zero replicas.');
}

// A rollback is not safe merely because the public endpoint serves a held
// revision. An older OPEN replica can still be running without traffic.
// Re-read the complete revision inventory twice and require every other
// revision, including each one observed during this operation, to be retired.
async function retiredInventory({ az, sleep, signal, current, requiredNames, attempts }) {
  let complete = 0;
  for (let i = 0; i < attempts; i++) {
    stopped(signal);
    const app = await az('show');
    if (String(app?.mode).toLowerCase() !== 'single' || app.latest !== current || app.ready !== current)
      throw new Error('Azure ready revision changed during replica verification.');
    const revisions = await az('revisions');
    const names = Array.isArray(revisions) ? revisions.map(row => row?.name) : null;
    if (!names || names.some(name => typeof name !== 'string' || !name) ||
        new Set(names).size !== names.length || !names.includes(current) ||
        requiredNames.some(name => !names.includes(name)))
      throw new Error('Revision inventory is missing, incomplete, or malformed.');
    let allRetired = true;
    for (const name of names) {
      if (name === current) continue;
      const revision = await az('revision', name);
      const replicas = await az('replicas', name);
      if (revision?.name !== name || !Array.isArray(replicas))
        throw new Error('Revision or replica state is unknown.');
      if (revision.active !== false || replicas.length !== 0) allRetired = false;
    }
    complete = allRetired ? complete + 1 : 0;
    if (complete >= 2) return;
    if (i + 1 < attempts) await sleep(10_000);
  }
  throw new Error('A predecessor revision remains active or has replicas.');
}

async function finalState(az, image, hold, name) {
  const app = await az('show');
  const revision = await az('revision', name);
  if (String(app?.mode).toLowerCase() !== 'single' || app.ready !== name || app.latest !== name || revision?.image !== image ||
      revision.hold !== hold || revision.active !== true || revision.health !== 'Healthy')
    throw new Error('Azure release identity changed during verification.');
}

async function observeReady(az) {
  try {
    const app = await az('show');
    if (!app?.ready || !app?.latest || app.ready !== app.latest) return null;
    const revision = await az('revision', app.ready);
    return revision?.name === app.ready ? revision : null;
  } catch { return null; }
}

const limits = options => ({
  sleep: options.sleep || pause,
  revisionAttempts: options.revisionAttempts || 30,
  publicAttempts: options.publicAttempts || 8,
  drainAttempts: options.drainAttempts || 30,
});

export async function deployHeld(options) {
  const { sha, az, fetchJson, fetchStatic, signal, log = () => {} } = options;
  validSha(sha); stopped(signal);
  const { sleep, revisionAttempts, publicAttempts, drainAttempts } = limits(options);
  const desired = imageFor(sha);
  const app = await az('show');
  const previous = await az('revision', app?.ready);
  requireReady(app, previous);
  const previousSha = shaFromImage(previous.image);
  let rollbackTargetHeld = false;
  if (previous.hold === true && previousSha) {
    try {
      const health = await fetchJson('/healthz');
      rollbackTargetHeld = health?.ok === true && health.release === previousSha &&
        health.cutoverHold === true;
    } catch { /* positive proof required before any rollback */ }
  }
  let attempted = false, deployed = null;
  try {
    stopped(signal);
    const before = await az('show');
    const beforeRevision = await az('revision', previous.name);
    requireReady(before, beforeRevision);
    if (before.ready !== previous.name || beforeRevision.image !== previous.image ||
        beforeRevision.hold !== previous.hold)
      throw new Error('Current Azure revision changed before deployment.');
    attempted = true;
    await az('updateHeld', desired);
    deployed = await readyRevision({ az, sleep, signal, image: desired, hold: true,
      oldName: previous.name, attempts: revisionAttempts });
    await publicReady({ fetchJson, fetchStatic, sleep, signal, sha, hold: true, attempts: publicAttempts });
    await retiredInventory({ az, sleep, signal, current: deployed,
      requiredNames: [previous.name], attempts: drainAttempts });
    await finalState(az, desired, true, deployed);
    log('Held revision verified; previous revision has no replicas.');
    return { revision: deployed, image: desired, cutoverHold: true };
  } catch (error) {
    if (!attempted) throw error;
    const observed = await observeReady(az);
    if (!rollbackTargetHeld)
      throw new Error('Held deployment failed: ' + error.message +
        `. Current ready revision ${observed?.name || 'unknown'} has hold=${observed?.hold ?? 'unknown'}. ` +
        'No rollback to an unguarded image was attempted; reconcile Azure state before proceeding.');
    if (observed?.name === previous.name && observed.hold === true)
      throw new Error('Held deployment failed; previous held revision remains ready. Check for a pending Azure update before proceeding.');
    if (!observed || observed.image !== desired || observed.hold !== true)
      throw new Error('Held deployment failed; ready revision outcome is unknown or unexpected. No blind rollback was attempted.');
    try {
      await az('updateHeld', previous.image);
      const restored = await readyRevision({ az, sleep, image: previous.image, hold: true,
        oldName: deployed || previous.name, attempts: revisionAttempts, allowSame: !deployed });
      await publicReady({ fetchJson, fetchStatic, sleep, sha: previousSha, hold: true, attempts: publicAttempts });
      await retiredInventory({ az, sleep, current: restored,
        requiredNames: [...new Set([previous.name, observed.name, deployed].filter(Boolean))],
        attempts: drainAttempts });
      await finalState(az, previous.image, true, restored);
      throw Object.assign(new Error('Held deployment failed; held rollback verified: ' + error.message),
        { rollbackVerified: true });
    } catch (rollbackError) {
      if (rollbackError.rollbackVerified) throw rollbackError;
      throw new Error('Held deployment failed: ' + error.message +
        '; held rollback verification FAILED: ' + rollbackError.message);
    }
  }
}

export async function openHeld(options) {
  const { sha, bootstrapSha, az, fetchJson, fetchStatic, signal, log = () => {} } = options;
  validSha(sha); validSha(bootstrapSha); stopped(signal);
  if (sha === bootstrapSha) throw new Error('The bootstrap guard image cannot be opened.');
  const { sleep, revisionAttempts, publicAttempts, drainAttempts } = limits(options);
  const image = imageFor(sha);
  const app = await az('show');
  const prior = await az('revision', app?.ready);
  requireReady(app, prior);
  if (prior.image !== image || prior.hold !== true)
    throw new Error('Only the exact healthy held image can be opened.');
  await publicReady({ fetchJson, fetchStatic, sleep, signal, sha, hold: true, attempts: publicAttempts });
  const revisions = await az('revisions');
  if (!Array.isArray(revisions) || !revisions.some(row => row.name === prior.name))
    throw new Error('Revision inventory is unknown; hold remains closed.');
  let bootstrapFound = false;
  for (const revision of revisions) {
    if (revision.name !== prior.name) {
      const details = await az('revision', revision.name);
      if (details?.image === imageFor(bootstrapSha) && details.hold === true)
        bootstrapFound = true;
      await retired({ az, sleep, signal, name: revision.name, attempts: drainAttempts });
    }
  }
  if (!bootstrapFound) throw new Error('A retired held bootstrap guard revision is required before opening.');
  let attempted = false, opened = null;
  try {
    stopped(signal);
    await finalState(az, image, true, prior.name);
    attempted = true;
    await az('updateOpen', { image, expectedRevision: prior.name });
    opened = await readyRevision({ az, sleep, signal, image, hold: false,
      oldName: prior.name, attempts: revisionAttempts });
    await publicReady({ fetchJson, fetchStatic, sleep, signal, sha, hold: false, attempts: publicAttempts });
    await retiredInventory({ az, sleep, signal, current: opened,
      requiredNames: [prior.name], attempts: drainAttempts });
    await finalState(az, image, false, opened);
    log('Opened revision verified; held predecessor has no replicas.');
    return { revision: opened, image, cutoverHold: false };
  } catch (error) {
    if (!attempted) throw error;
    const observed = await observeReady(az);
    if (!observed || observed.image !== image || ![true, false].includes(observed.hold))
      throw new Error('Open failed; Azure ready state is unknown or unexpected. No blind update was attempted: ' + error.message);
    if (observed.name === prior.name && observed.hold === true)
      throw new Error('Open failed; prior held revision is still ready. Check for a pending Azure update before proceeding: ' + error.message);
    if (observed.hold === true)
      throw new Error('Open failed; a held revision is ready. Check prior revision drain before proceeding: ' + error.message);
    try {
      await az('updateHeld', image);
      const restored = await readyRevision({ az, sleep, image, hold: true,
        oldName: opened || prior.name, attempts: revisionAttempts, allowSame: !opened });
      await publicReady({ fetchJson, fetchStatic, sleep, sha, hold: true, attempts: publicAttempts });
      await retiredInventory({ az, sleep, current: restored,
        requiredNames: [...new Set([prior.name, observed.name, opened].filter(Boolean))],
        attempts: drainAttempts });
      await finalState(az, image, true, restored);
      throw Object.assign(new Error('Open failed; held rollback verified: ' + error.message),
        { rollbackVerified: true });
    } catch (rollbackError) {
      if (rollbackError.rollbackVerified) throw rollbackError;
      throw new Error('Open failed: ' + error.message +
        '; held rollback verification FAILED: ' + rollbackError.message);
    }
  }
}
