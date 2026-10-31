import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.js';
import {
  rankSignal,
  findingKey,
  extractFindings,
  normalizeRadarRepo,
  shortRepoName,
  parseRepoListEnv,
  resolveWatchRepos,
  ghGet,
  pollRepo,
  runRadarPoll,
  deliverRadarFindings,
  getRadarBriefingItems,
  composeRadarCheckin,
  RADAR_MAX_RADAR_CHECKINS_PER_DAY,
} from '../src/radar.js';
import { toolMuteRadar, toolUnmuteRadar, toolRadarStatus } from '../src/tools.js';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-radar-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'), {});
  const user = db.createUser({ email: 'owner@example.com', displayName: 'Owner', passwordHash: 'hash', passwordSalt: 'salt', role: 'owner' });
  return { db, user };
}

const ctxFor = (db, user) => ({ db, userId: user.id });

// --- rankSignal -----------------------------------------------------------

test('rankSignal: failed run on default branch is high, elsewhere ignored', () => {
  assert.equal(rankSignal({ kind: 'run', conclusion: 'failure', branchIsDefault: true }), 'high');
  assert.equal(rankSignal({ kind: 'run', conclusion: 'failure', branchIsDefault: false }), 'ignore');
  assert.equal(rankSignal({ kind: 'run', conclusion: 'cancelled', branchIsDefault: true }), 'ignore');
  assert.equal(rankSignal({ kind: 'run', conclusion: 'success', branchIsDefault: true }), 'ignore');
  assert.equal(rankSignal({ kind: 'run', conclusion: 'success', branchIsDefault: true, isRecovery: true }), 'low');
  assert.equal(rankSignal({ kind: 'run', conclusion: 'success', branchIsDefault: false, isRecovery: true }), 'ignore');
});

test('rankSignal: alerts and PRs', () => {
  assert.equal(rankSignal({ kind: 'alert', severity: 'critical' }), 'high');
  assert.equal(rankSignal({ kind: 'alert', severity: 'high' }), 'high');
  assert.equal(rankSignal({ kind: 'alert', severity: 'medium' }), 'low');
  assert.equal(rankSignal({ kind: 'alert', severity: 'low' }), 'low');
  assert.equal(rankSignal({ kind: 'alert' }), 'ignore');
  assert.equal(rankSignal({ kind: 'pr', merged: true }), 'low');
  assert.equal(rankSignal({ kind: 'pr', merged: false }), 'ignore');
  assert.equal(rankSignal({ kind: 'commit' }), 'ignore');
  assert.equal(rankSignal({}), 'ignore');
});

// --- extractFindings ------------------------------------------------------

const FAILED_RUN = {
  id: 101, name: 'CI', run_number: 42, head_branch: 'main', conclusion: 'failure',
  html_url: 'https://github.com/SmokeyS30/orbit-buddy/actions/runs/101',
};
const FEATURE_RUN = { ...FAILED_RUN, id: 102, head_branch: 'feature-x' };
const SUCCESS_RUN = { ...FAILED_RUN, id: 103, conclusion: 'success', run_number: 43 };
const CANCELLED_RUN = { ...FAILED_RUN, id: 104, conclusion: 'cancelled' };
const CRIT_ALERT = {
  number: 7, state: 'open', html_url: 'https://github.com/x/y/security/dependabot/7',
  dependency: { package: { name: 'lodash' } },
  security_advisory: { severity: 'critical', summary: 'Prototype pollution' },
};
const MED_ALERT = {
  number: 8, state: 'open', html_url: 'https://github.com/x/y/security/dependabot/8',
  security_vulnerability: { package_name: 'axios', severity: 'medium' },
};
const DISMISSED_ALERT = { ...CRIT_ALERT, number: 9, state: 'dismissed' };
const MERGED_PR = {
  number: 55, title: 'Add radar', merged_at: '2026-10-15T10:00:00Z',
  html_url: 'https://github.com/x/y/pull/55', user: { login: 'SmokeyS30' },
};
const CLOSED_PR = { ...MERGED_PR, number: 56, merged_at: null };

test('extractFindings ranks and filters raw GitHub payloads', () => {
  const findings = extractFindings({
    repo: 'SmokeyS30/orbit-buddy', defaultBranch: 'main',
    runs: [FAILED_RUN, FEATURE_RUN, SUCCESS_RUN, CANCELLED_RUN],
    alerts: [CRIT_ALERT, MED_ALERT, DISMISSED_ALERT],
    prs: [MERGED_PR, CLOSED_PR],
    nowMs: Date.parse('2026-10-15T12:00:00Z'),
  });
  const byKind = {};
  for (const f of findings) (byKind[f.kind] = byKind[f.kind] || []).push(f);
  assert.equal(byKind.run.length, 1);
  assert.equal(byKind.run[0].signal, 'high');
  assert.ok(byKind.run[0].title.includes('CI failed on main'));
  assert.equal(byKind.run[0].workflow, 'CI');
  assert.equal(byKind.run[0].branch, 'main');
  assert.equal(byKind.alert.length, 2);
  assert.equal(byKind.alert.find((a) => a.key.endsWith('alert:7')).signal, 'high');
  assert.equal(byKind.alert.find((a) => a.key.endsWith('alert:8')).signal, 'low');
  assert.equal(byKind.pr.length, 1);
  assert.equal(byKind.pr[0].signal, 'low');
  assert.ok(byKind.pr[0].title.includes('Merged:'));
  // keys are stable and repo-scoped
  assert.ok(byKind.run[0].key.startsWith('gh:smokeys30/orbit-buddy:run:run:101'));
});

test('extractFindings: green-again run after a known failure is low signal', () => {
  const findings = extractFindings({
    repo: 'SmokeyS30/orbit-buddy', defaultBranch: 'main',
    runs: [SUCCESS_RUN], knownFailures: new Set(['CI|main']),
    nowMs: Date.parse('2026-10-15T12:00:00Z'),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].signal, 'low');
  assert.ok(findings[0].key.endsWith(':recovered'));
  assert.ok(findings[0].title.includes('green again'));
});

test('extractFindings: success run without a known failure is ignored', () => {
  const findings = extractFindings({
    repo: 'SmokeyS30/orbit-buddy', defaultBranch: 'main', runs: [SUCCESS_RUN],
  });
  assert.equal(findings.length, 0);
});

test('extractFindings tolerates non-array and missing payloads', () => {
  assert.deepEqual(extractFindings({ repo: 'a/b', defaultBranch: 'main', runs: { workflow_runs: [] } }), []);
  assert.deepEqual(extractFindings({ repo: 'a/b' }), []);
});

// --- pure helpers ---------------------------------------------------------

test('findingKey is stable and lowercases the repo', () => {
  assert.equal(findingKey({ repo: 'SmokeyS30/Orbit-Buddy', kind: 'run', ref: 'run:1' }), 'gh:smokeys30/orbit-buddy:run:run:1');
});

test('normalizeRadarRepo handles short names, full names, and junk', () => {
  assert.equal(normalizeRadarRepo('orbit-buddy'), 'smokeys30/orbit-buddy');
  assert.equal(normalizeRadarRepo('SmokeyS30/StudyBuddy'), 'smokeys30/studybuddy');
  assert.equal(normalizeRadarRepo('  @SmokeyS30/orbit-buddy  '), 'smokeys30/orbit-buddy');
  assert.equal(normalizeRadarRepo(''), null);
  assert.equal(normalizeRadarRepo('a/b/c'), null);
  assert.equal(normalizeRadarRepo('orbit-buddy', 'OtherOwner'), 'otherowner/orbit-buddy');
});

test('shortRepoName takes the tail', () => {
  assert.equal(shortRepoName('SmokeyS30/orbit-buddy'), 'orbit-buddy');
  assert.equal(shortRepoName('orbit-buddy'), 'orbit-buddy');
});

test('parseRepoListEnv parses and caps the override list', () => {
  assert.deepEqual(parseRepoListEnv('a/b, c/d , junk'), ['a/b', 'c/d']);
  assert.deepEqual(parseRepoListEnv(''), []);
  assert.deepEqual(parseRepoListEnv(null), []);
  assert.equal(parseRepoListEnv('a/1,a/2,a/3,a/4,a/5,a/6,a/7,a/8,a/9,a/10,a/11,a/12,a/13').length, 12);
});

// --- GitHub API plumbing ---------------------------------------------------

// Test stub for fetch: routes are [pathname, response] pairs matched exactly
// against the parsed URL path (no substring checks on URLs — exact matching
// keeps CodeQL's URL-sanitization check quiet). A response with a `status`
// field simulates an HTTP error.
function stubFetch(routes) {
  const byPath = new Map(routes);
  return async (url) => {
    const urlStr = String(url);
    const pathname = new URL(urlStr).pathname;
    if (!byPath.has(pathname)) throw new Error(`unexpected fetch: ${urlStr}`);
    const response = byPath.get(pathname);
    if (response && typeof response.status === 'number') {
      return { ok: false, status: response.status, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => response };
  };
}

test('ghGet returns 403/404 quietly and throws on other errors', async () => {
  const f403 = stubFetch([['/x', { status: 403 }]]);
  assert.deepEqual(await ghGet('/x', 'tok', { fetchImpl: f403 }), { status: 403, data: null });
  const f404 = stubFetch([['/x', { status: 404 }]]);
  assert.deepEqual(await ghGet('/x', 'tok', { fetchImpl: f404 }), { status: 404, data: null });
  const f500 = stubFetch([['/x', { status: 500 }]]);
  await assert.rejects(() => ghGet('/x', 'tok', { fetchImpl: f500 }), /GitHub API 500/);
  const fok = stubFetch([['/x', { hello: 1 }]]);
  assert.deepEqual(await ghGet('/x', 'tok', { fetchImpl: fok }), { status: 200, data: { hello: 1 } });
});

test('resolveWatchRepos: env override wins over discovery', async () => {
  const fetchImpl = stubFetch([]);
  const repos = await resolveWatchRepos({ token: 't', env: { RADAR_REPOS: 'a/b, c/d' }, fetchImpl });
  assert.deepEqual(repos, ['a/b', 'c/d']);
});

test('resolveWatchRepos: discovery filters forks/archived, sorts by push, caps at 6', async () => {
  const mk = (full_name, pushed_at, extra = {}) => ({ full_name, pushed_at, fork: false, archived: false, ...extra });
  const data = [
    mk('o/old', '2026-01-01T00:00:00Z'),
    mk('o/fork', '2026-10-15T00:00:00Z', { fork: true }),
    mk('o/arch', '2026-10-15T00:00:00Z', { archived: true }),
    ...[1, 2, 3, 4, 5, 6, 7].map((i) => mk(`o/r${i}`, `2026-10-${String(i).padStart(2, '0')}T00:00:00Z`)),
  ];
  const fetchImpl = stubFetch([['/users/SmokeyS30/repos', data]]);
  const repos = await resolveWatchRepos({ token: 't', env: {}, fetchImpl });
  assert.equal(repos.length, 6);
  assert.ok(!repos.includes('o/fork') && !repos.includes('o/arch') && !repos.includes('o/old'));
  assert.deepEqual(repos, ['o/r7', 'o/r6', 'o/r5', 'o/r4', 'o/r3', 'o/r2']);
});

test('pollRepo unwraps workflow_runs and tolerates missing alert scope', async () => {
  const fetchImpl = stubFetch([
    ['/repos/o/r/actions/runs', { workflow_runs: [FAILED_RUN] }],
    ['/repos/o/r/dependabot/alerts', { status: 403 }],
    ['/repos/o/r/pulls', [MERGED_PR]],
    ['/repos/o/r', { default_branch: 'main' }],
  ]);
  const out = await pollRepo({ owner: 'o', repo: 'r', token: 't', fetchImpl });
  assert.equal(out.fullName, 'o/r');
  assert.equal(out.defaultBranch, 'main');
  assert.equal(out.runs.length, 1);
  assert.deepEqual(out.alerts, []);
  assert.equal(out.prs.length, 1);
});

// --- DB round-trips --------------------------------------------------------

function sampleFinding(over = {}) {
  return {
    key: 'gh:smokeys30/orbit-buddy:run:run:101',
    repo: 'SmokeyS30/orbit-buddy', kind: 'run', signal: 'high',
    title: 'CI failed on main (orbit-buddy)', detail: 'Actions run #42 failed.',
    url: 'https://github.com/x', workflow: 'CI', branch: 'main',
    foundAt: '2026-10-15T12:00:00.000Z', ...over,
  };
}

test('radar findings: store, seen, dedupe, recent list', () => {
  const { db } = fixture();
  assert.equal(db.radarFindingSeen('gh:a:b:c'), false);
  db.storeRadarFinding(sampleFinding());
  assert.equal(db.radarFindingSeen('gh:smokeys30/orbit-buddy:run:run:101'), true);
  db.storeRadarFinding(sampleFinding()); // storing twice is a no-op
  db.storeRadarFinding(sampleFinding({ key: 'gh:smokeys30/orbit-buddy:pr:pr:55', kind: 'pr', signal: 'low', title: 'Merged: x' }));
  const recent = db.listRecentRadarFindings(10);
  assert.equal(recent.length, 2);
  assert.ok(recent[0].finding_key && recent[1].finding_key);
});

test('listRadarUnrecoveredFailures tracks failures until a recovery lands', () => {
  const { db } = fixture();
  const plain = () => db.listRadarUnrecoveredFailures('SmokeyS30/orbit-buddy').map((r) => ({ workflow: r.workflow, branch: r.branch }));
  assert.deepEqual(plain(), []);
  db.storeRadarFinding(sampleFinding());
  assert.deepEqual(plain(), [{ workflow: 'CI', branch: 'main' }]);
  db.storeRadarFinding(sampleFinding({ key: 'gh:smokeys30/orbit-buddy:run:run:103:recovered', signal: 'low', title: 'CI is green again' }));
  assert.deepEqual(plain(), []);
});

test('radar deliveries: mark once, never twice', () => {
  const { db, user } = fixture();
  db.storeRadarFinding(sampleFinding({ key: 'k1', title: 'K1' }));
  assert.equal(db.radarFindingDelivered('k1', user.id), false);
  db.markRadarFindingDelivered('k1', user.id);
  assert.equal(db.radarFindingDelivered('k1', user.id), true);
  db.markRadarFindingDelivered('k1', user.id); // idempotent
  assert.equal(db.radarFindingDelivered('k1', user.id), true);
});

test('radar mutes: mute/unmute round-trip, case-insensitive', () => {
  const { db, user } = fixture();
  assert.equal(db.isRadarMuted(user.id, 'SmokeyS30/orbit-buddy'), false);
  db.muteRadarRepo(user.id, 'SmokeyS30/Orbit-Buddy');
  assert.equal(db.isRadarMuted(user.id, 'smokeys30/orbit-buddy'), true);
  assert.equal(db.isRadarMuted(user.id, 'SmokeyS30/studybuddy-ai-server'), false);
  assert.deepEqual(db.listRadarMutes(user.id).map((m) => m.repo), ['smokeys30/orbit-buddy']);
  assert.equal(db.unmuteRadarRepo(user.id, 'SMOKEYS30/ORBIT-BUDDY'), true);
  assert.equal(db.isRadarMuted(user.id, 'smokeys30/orbit-buddy'), false);
  assert.equal(db.unmuteRadarRepo(user.id, 'smokeys30/orbit-buddy'), false);
});

// --- runRadarPoll ----------------------------------------------------------

function pollFixture({ runs = [FAILED_RUN], alerts = [], prs = [], repos } = {}) {
  const repoList = repos || [{ full_name: 'SmokeyS30/orbit-buddy', pushed_at: '2026-10-15T00:00:00Z', fork: false, archived: false }];
  return stubFetch([
    ['/users/SmokeyS30/repos', repoList],
    ['/repos/SmokeyS30/orbit-buddy/actions/runs', { workflow_runs: runs }],
    ['/repos/SmokeyS30/orbit-buddy/dependabot/alerts', alerts],
    ['/repos/SmokeyS30/orbit-buddy/pulls', prs],
    ['/repos/SmokeyS30/orbit-buddy', { default_branch: 'main' }],
  ]);
}

test('runRadarPoll skips without a token and within the poll interval', async () => {
  const { db } = fixture();
  const noToken = await runRadarPoll({ db, env: {}, nowMs: 1_000 });
  assert.equal(noToken.skipped, 'no-token');
  assert.equal(db.getSetting('radar_last_poll'), null);

  const fetchImpl = pollFixture();
  const first = await runRadarPoll({ db, env: { GITHUB_RADAR_TOKEN: 't' }, nowMs: 2_000, fetchImpl });
  assert.equal(first.skipped, null);
  assert.equal(first.checked, 1);
  assert.equal(first.surfaced.length, 1);
  assert.equal(first.surfaced[0].signal, 'high');

  const tooSoon = await runRadarPoll({ db, env: { GITHUB_RADAR_TOKEN: 't' }, nowMs: 3_000, fetchImpl });
  assert.equal(tooSoon.skipped, 'too-soon');
  assert.equal(tooSoon.surfaced.length, 0);
});

test('radar stops new GitHub requests and state writes after proactive pause',async()=>{
  const {db}=fixture();
  let active=true,calls=0;
  const fetchImpl=async()=>{calls++;active=false;return{ok:true,status:200,json:async()=>({default_branch:'main'})};};
  await assert.rejects(runRadarPoll({db,env:{GITHUB_RADAR_TOKEN:'synthetic',RADAR_REPOS:'Synthetic/repo'},nowMs:10_000,fetchImpl,
    assertActive:()=>{if(!active)throw Object.assign(new Error('paused'),{code:'PROACTIVE_DEFERRED'});}}),
  error=>error.code==='PROACTIVE_DEFERRED');
  assert.equal(calls,1);
  assert.equal(db.getSetting('radar_last_poll'),null);
});

test('runRadarPoll dedupes: a second poll surfaces nothing new', async () => {
  const { db } = fixture();
  const env = { GITHUB_RADAR_TOKEN: 't' };
  const fetchImpl = pollFixture();
  const first = await runRadarPoll({ db, env, nowMs: 1_000, fetchImpl });
  assert.equal(first.surfaced.length, 1);
  const second = await runRadarPoll({ db, env, nowMs: 1_000 + 31 * 60_000, fetchImpl });
  assert.equal(second.skipped, null);
  assert.equal(second.surfaced.length, 0);
});

test('runRadarPoll tolerates a failing repo and keeps polling others', async () => {
  const { db } = fixture();
  const repoList = [
    { full_name: 'SmokeyS30/good', pushed_at: '2026-10-15T00:00:00Z', fork: false, archived: false },
    { full_name: 'SmokeyS30/bad', pushed_at: '2026-10-14T00:00:00Z', fork: false, archived: false },
  ];
  // Exact pathname matching (no URL substring checks) — the bad repo fails
  // on every endpoint while the good repo answers normally.
  const fetchImpl = async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === '/users/SmokeyS30/repos') return { ok: true, status: 200, json: async () => repoList };
    if (pathname === '/repos/SmokeyS30/bad' || pathname === '/repos/SmokeyS30/bad/actions/runs'
        || pathname === '/repos/SmokeyS30/bad/dependabot/alerts' || pathname === '/repos/SmokeyS30/bad/pulls') {
      throw new Error('boom');
    }
    if (pathname === '/repos/SmokeyS30/good') return { ok: true, status: 200, json: async () => ({ default_branch: 'main' }) };
    if (pathname === '/repos/SmokeyS30/good/actions/runs') return { ok: true, status: 200, json: async () => ({ workflow_runs: [FAILED_RUN] }) };
    if (pathname === '/repos/SmokeyS30/good/dependabot/alerts') return { ok: false, status: 403, json: async () => ({}) };
    if (pathname === '/repos/SmokeyS30/good/pulls') return { ok: true, status: 200, json: async () => [] };
    throw new Error(`unexpected ${String(url)}`);
  };
  const out = await runRadarPoll({ db, env: { GITHUB_RADAR_TOKEN: 't' }, nowMs: 1_000, fetchImpl });
  assert.equal(out.checked, 1);
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].repo, 'SmokeyS30/bad');
  assert.equal(out.surfaced.length, 1);
});

test('runRadarPoll: error backoff after discovery failure', async () => {
  const { db } = fixture();
  const badDiscovery = stubFetch([]);
  const env = { GITHUB_RADAR_TOKEN: 't' };
  const first = await runRadarPoll({ db, env, nowMs: 1_000, fetchImpl: badDiscovery });
  assert.equal(first.skipped, 'discovery-failed');
  const backed = await runRadarPoll({ db, env, nowMs: 2_000, fetchImpl: pollFixture() });
  assert.equal(backed.skipped, 'error-backoff');
  const later = await runRadarPoll({ db, env, nowMs: 1_000 + 6 * 60_000, fetchImpl: pollFixture() });
  assert.equal(later.skipped, null);
  assert.equal(later.surfaced.length, 1);
});

test('runRadarPoll: discovery failure after lease loss does not write error state', async () => {
  const { db } = fixture();
  db.setSetting('radar_last_error', 'existing error');
  db.setSetting('radar_last_error_at', '500');
  let failDiscovery, markDiscoveryStarted;
  const discoveryStarted = new Promise((resolve) => { markDiscoveryStarted = resolve; });
  const fetchImpl = () => new Promise((_, reject) => {
    failDiscovery = reject;
    markDiscoveryStarted();
  });
  let activeChecks = 0;
  const assertActive = async () => {
    activeChecks++;
    if (activeChecks === 3) throw Object.assign(new Error('lease lost'), { code: 'PROACTIVE_LEASE_LOST' });
  };
  const poll = runRadarPoll({
    db,
    env: { GITHUB_RADAR_TOKEN: 't' },
    nowMs: 600_000,
    fetchImpl,
    assertActive,
  });
  await discoveryStarted;
  failDiscovery(new Error('discovery failed'));
  await assert.rejects(poll, (error) => error.code === 'PROACTIVE_LEASE_LOST');
  assert.equal(db.getSetting('radar_last_error'), 'existing error');
  assert.equal(db.getSetting('radar_last_error_at'), '500');
});

// --- deliverRadarFindings ---------------------------------------------------

test('deliverRadarFindings: high signal only, one per day, marks delivered', async () => {
  const { db, user } = fixture();
  const sent = [];
  const high = sampleFinding();
  const low = sampleFinding({ key: 'gh:smokeys30/orbit-buddy:pr:pr:1', kind: 'pr', signal: 'low', title: 'Merged: x' });
  db.storeRadarFinding(high);
  db.storeRadarFinding(low);
  const out = await deliverRadarFindings({
    db, surfaced: [high, low], nowMs: Date.parse('2026-10-15T15:00:00Z'),
    isQuiet: () => false,
    deliver: async ({ text }) => { sent.push(text); },
  });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes('CI failed on main'));
  assert.ok(!sent[0].includes('*')); // plain text, no markdown emphasis
  assert.deepEqual(out, [{ userId: user.id, key: high.key }]);
  assert.equal(db.radarFindingDelivered(high.key, user.id), true);

  // second run same day: daily cap reached, nothing more sent
  const out2 = await deliverRadarFindings({
    db, surfaced: [sampleFinding({ key: 'gh:smokeys30/orbit-buddy:run:run:999' })],
    nowMs: Date.parse('2026-10-15T16:00:00Z'), isQuiet: () => false,
    deliver: async ({ text }) => { sent.push(text); },
  });
  assert.equal(out2.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(RADAR_MAX_RADAR_CHECKINS_PER_DAY, 1);
});

test('deliverRadarFindings: skips muted repos, quiet hours, and spent slots', async () => {
  const { db, user } = fixture();
  db.muteRadarRepo(user.id, 'smokeys30/orbit-buddy');
  const sent = [];
  const out = await deliverRadarFindings({
    db, surfaced: [sampleFinding()], nowMs: Date.parse('2026-10-15T15:00:00Z'),
    isQuiet: () => false, deliver: async ({ text }) => { sent.push(text); },
  });
  assert.equal(out.length, 0);
  assert.equal(sent.length, 0);

  db.unmuteRadarRepo(user.id, 'smokeys30/orbit-buddy');
  const quiet = await deliverRadarFindings({
    db, surfaced: [sampleFinding()], nowMs: Date.parse('2026-10-15T15:00:00Z'),
    isQuiet: () => true, deliver: async ({ text }) => { sent.push(text); },
  });
  assert.equal(quiet.length, 0);

  // proactive slot exhausted by other outreach → radar waits
  const today = '2026-10-15';
  db.claimProactiveSlot(user.id, today); db.claimProactiveSlot(user.id, today); db.claimProactiveSlot(user.id, today);
  const spent = await deliverRadarFindings({
    db, surfaced: [sampleFinding()], nowMs: Date.parse('2026-10-15T15:00:00Z'),
    isQuiet: () => false, deliver: async ({ text }) => { sent.push(text); },
  });
  assert.equal(spent.length, 0);
  assert.equal(sent.length, 0);
});

test('deliverRadarFindings: delivery failure releases the slot and logs an event', async () => {
  const { db, user } = fixture();
  db.storeRadarFinding(sampleFinding());
  const out = await deliverRadarFindings({
    db, surfaced: [sampleFinding()], nowMs: Date.parse('2026-10-15T15:00:00Z'),
    isQuiet: () => false,
    deliver: async () => { throw new Error('push down'); },
  });
  assert.equal(out.length, 0);
  assert.equal(db.radarFindingDelivered(sampleFinding().key, user.id), false);
  // slot released: claiming 3 fresh slots still works
  const today = '2026-10-15';
  assert.equal(db.claimProactiveSlot(user.id, today), true);
  assert.equal(db.claimProactiveSlot(user.id, today), true);
  assert.equal(db.claimProactiveSlot(user.id, today), true);
  assert.equal(db.claimProactiveSlot(user.id, today), false);
});

// --- briefing items --------------------------------------------------------

test('getRadarBriefingItems: recent, capped, mute-aware', () => {
  const { db, user } = fixture();
  const nowMs = Date.parse('2026-10-15T15:00:00Z');
  db.storeRadarFinding(sampleFinding({ key: 'k1', foundAt: '2026-10-15T10:00:00.000Z' }));
  db.storeRadarFinding(sampleFinding({ key: 'k2', repo: 'SmokeyS30/studybuddy-ai-server', title: 'Other', foundAt: '2026-10-14T10:00:00.000Z' }));
  db.storeRadarFinding(sampleFinding({ key: 'k3', title: 'Old', foundAt: '2026-10-01T10:00:00.000Z' }));
  let items = getRadarBriefingItems(db, user.id, { nowMs });
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 'k1');

  db.muteRadarRepo(user.id, 'smokeys30/studybuddy-ai-server');
  items = getRadarBriefingItems(db, user.id, { nowMs });
  assert.deepEqual(items.map((i) => i.id), ['k1']);

  items = getRadarBriefingItems(db, user.id, { nowMs, limit: 1 });
  assert.equal(items.length, 1);
});

// --- check-in text ---------------------------------------------------------

// Exact-equality assertions on the composed copy (no URL substring checks).
test('composeRadarCheckin is plain text with repo, workflow, branch, link', () => {
  const text = composeRadarCheckin(sampleFinding());
  assert.equal(text, 'Heads up — CI failed on main in orbit-buddy. Worth a look when you get a chance: https://github.com/x');
  const alertText = composeRadarCheckin(sampleFinding({ kind: 'alert', title: 'high security alert: lodash', detail: 'Prototype pollution' }));
  assert.equal(alertText, 'Security heads-up in orbit-buddy: lodash — Prototype pollution. Details here: https://github.com/x');
  const prText = composeRadarCheckin(sampleFinding({ kind: 'pr', title: 'Merged: Add radar (orbit-buddy)' }));
  assert.equal(prText, 'Quick note on orbit-buddy: Merged: Add radar (orbit-buddy). https://github.com/x');
});

// --- chat tools ------------------------------------------------------------

test('radar chat tools: mute, unmute, status', () => {
  const { db, user } = fixture();
  const ctx = ctxFor(db, user);

  const muted = toolMuteRadar({ repo: 'orbit-buddy' }, ctx);
  assert.equal(muted.muted, true);
  assert.equal(muted.repo, 'smokeys30/orbit-buddy');
  assert.ok(muted.message.includes('orbit-buddy'));
  assert.equal(db.isRadarMuted(user.id, 'smokeys30/orbit-buddy'), true);

  const status = toolRadarStatus({}, ctx);
  assert.deepEqual(status.mutedRepos, ['smokeys30/orbit-buddy']);
  assert.equal(status.tokenConfigured, false);
  assert.ok(Array.isArray(status.recentFindings));

  const unmuted = toolUnmuteRadar({ repo: 'SmokeyS30/orbit-buddy' }, ctx);
  assert.equal(unmuted.unmuted, true);
  assert.equal(db.isRadarMuted(user.id, 'smokeys30/orbit-buddy'), false);
  const again = toolUnmuteRadar({ repo: 'orbit-buddy' }, ctx);
  assert.equal(again.unmuted, false);
  assert.ok(again.message.includes("wasn't muted"));

  assert.throws(() => toolMuteRadar({ repo: '' }, ctx), /needs a repo/);
  assert.throws(() => toolMuteRadar({ repo: 'x' }, null), /not available in this context/);
});

test('radar tools require a user context', () => {
  assert.throws(() => toolRadarStatus({}, null), /not available/);
});
