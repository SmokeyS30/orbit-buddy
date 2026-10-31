// X6 "Project radar" — ambient, read-only awareness of the user's GitHub work.
//
// Orbit keeps a light watch on the user's repos (failed Actions runs on the
// default branch, new Dependabot/security alerts, merged PRs) and surfaces
// what actually matters — high-signal findings arrive as proactive check-ins,
// quieter ones as Today-tab briefing items. Never noise: every finding is
// ranked, deduplicated (a finding is never surfaced twice), and per-repo mutes
// are honored.
//
// READ-ONLY BY CONTRACT: this module only ever issues HTTP GET requests to
// the GitHub REST API. There is deliberately no POST/PUT/PATCH/DELETE anywhere
// in this file — no auto-merges, no issue creation, no comments. The token
// (GITHUB_RADAR_TOKEN) should carry read-only scopes (repo read for private
// repos, security_events read for Dependabot alerts). The token is read from
// env at poll time and is never logged, stored, or returned in any payload.

import { todayInZone, validTimeZone } from './intelligence.js';

export const RADAR_POLL_INTERVAL_MS = 30 * 60_000; // poll GitHub at most every 30 minutes
export const RADAR_ERROR_BACKOFF_MS = 5 * 60_000; // retry sooner after a failed poll
export const RADAR_MAX_REPOS = 6; // a handful of repos keeps every poll cheap
export const RADAR_MAX_RADAR_CHECKINS_PER_DAY = 1; // conservative: well inside the 2/day smart check-in rule
export const RADAR_BRIEFING_DAYS = 3; // briefing shows findings from the last 3 days
export const RADAR_BRIEFING_LIMIT = 5; // …capped at 5 items
export const RADAR_TOKEN_ENV = 'GITHUB_RADAR_TOKEN';
export const RADAR_REPOS_ENV = 'RADAR_REPOS'; // optional comma-separated "owner/repo" override
export const RADAR_OWNER_ENV = 'GITHUB_RADAR_OWNER';
export const RADAR_DEFAULT_OWNER = 'SmokeyS30';

const GH_API = 'https://api.github.com';
const USER_AGENT = 'orbit-buddy-radar/1.0';

// ---------------------------------------------------------------------------
// GitHub API (GET only — read-only by contract)
// ---------------------------------------------------------------------------

/**
 * GET a GitHub REST API path. Returns { status, data }. 403/404 are returned
 * (not thrown) — they mean the token lacks a scope or the feature is disabled
 * (e.g. Dependabot alerts on a repo without them), so the caller skips quietly.
 * Never logs the token.
 */
export async function ghGet(path, token, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${GH_API}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 403 || res.status === 404) return { status: res.status, data: null };
  if (!res.ok) throw new Error(`GitHub API ${res.status} on ${path}`);
  return { status: res.status, data: await res.json() };
}

/** Parse the RADAR_REPOS env override: comma-separated "owner/repo" values. Pure. */
export function parseRepoListEnv(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.includes('/') && /^[^/\s]+\/[^/\s]+$/.test(s))
    .slice(0, RADAR_MAX_REPOS * 2);
}

/**
 * Resolve the repos to watch. An explicit RADAR_REPOS list wins; otherwise
 * discover the owner's most recently pushed non-fork, non-archived repos and
 * take the top few. Discovery is one cheap request per poll.
 */
export async function resolveWatchRepos({ token, owner, env = process.env, fetchImpl = fetch, assertActive = () => {} } = {}) {
  const configured = parseRepoListEnv(env[RADAR_REPOS_ENV]);
  if (configured.length) return configured.slice(0, RADAR_MAX_REPOS);
  const login = String(env[RADAR_OWNER_ENV] || owner || RADAR_DEFAULT_OWNER).replace(/^@/, '').trim() || RADAR_DEFAULT_OWNER;
  await assertActive();
  const { data } = await ghGet(`/users/${encodeURIComponent(login)}/repos?per_page=100&sort=pushed`, token, { fetchImpl });
  return (Array.isArray(data) ? data : [])
    .filter((r) => r && !r.fork && !r.archived && typeof r.full_name === 'string')
    .sort((a, b) => String(b.pushed_at || '').localeCompare(String(a.pushed_at || '')))
    .slice(0, RADAR_MAX_REPOS)
    .map((r) => r.full_name);
}

/** Normalize a user-typed repo ("orbit-buddy" or "SmokeyS30/orbit-buddy") to lowercase "owner/repo". Pure. */
export function normalizeRadarRepo(input, owner = RADAR_DEFAULT_OWNER) {
  const t = String(input || '').trim().replace(/^@/, '');
  if (!t) return null;
  const full = t.includes('/') ? t : `${owner}/${t}`;
  const parts = full.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return `${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
}

/** Short repo label for messages ("orbit-buddy"). Pure. */
export function shortRepoName(fullName) {
  const parts = String(fullName || '').split('/');
  return parts[parts.length - 1] || String(fullName || '');
}

// ---------------------------------------------------------------------------
// Findings: extraction + signal ranking
// ---------------------------------------------------------------------------

/** Stable dedupe key for a finding. Pure. */
export function findingKey({ repo, kind, ref }) {
  return `gh:${String(repo).toLowerCase()}:${kind}:${ref}`;
}

/**
 * Rank a finding candidate to a signal. Pure.
 * - failed Actions run on the default branch → 'high' (check-in worthy)
 * - successful run that recovers a previously failed workflow → 'low' (briefing)
 * - critical/high security alert → 'high'; medium/low → 'low'
 * - merged PR → 'low' (briefing item at most)
 * - everything else (cancelled/skipped runs, feature-branch failures, routine noise) → 'ignore'
 */
export function rankSignal(candidate = {}) {
  const c = candidate;
  if (c.kind === 'run') {
    if (c.conclusion === 'failure' && c.branchIsDefault) return 'high';
    if (c.conclusion === 'success' && c.isRecovery && c.branchIsDefault) return 'low';
    return 'ignore';
  }
  if (c.kind === 'alert') {
    if (c.severity === 'critical' || c.severity === 'high') return 'high';
    if (c.severity) return 'low';
    return 'ignore';
  }
  if (c.kind === 'pr') return c.merged ? 'low' : 'ignore';
  return 'ignore';
}

function alertSeverity(alert) {
  const s = String(
    alert?.security_advisory?.severity || alert?.security_vulnerability?.severity || ''
  ).toLowerCase();
  return ['critical', 'high', 'medium', 'low'].includes(s) ? s : 'medium';
}

/**
 * Turn raw GitHub API results for one repo into ranked finding objects.
 * `knownFailures` is a Set of "workflow|branch" keys with a previously
 * surfaced failure that hasn't recovered — used to spot green-again runs.
 * Routine pushes are deliberately ignored (merged PRs cover notable changes).
 * Pure.
 */
export function extractFindings({ repo, defaultBranch, runs, alerts, prs, knownFailures = new Set(), nowMs = Date.now() }) {
  const findings = [];
  const branch = defaultBranch || 'main';
  const foundAt = new Date(nowMs).toISOString();
  const runList = Array.isArray(runs) ? runs : [];
  const alertList = Array.isArray(alerts) ? alerts : [];
  const prList = Array.isArray(prs) ? prs : [];

  for (const run of runList) {
    if (!run || typeof run !== 'object') continue;
    const branchIsDefault = run.head_branch === branch;
    const key = findingKey({ repo, kind: 'run', ref: `run:${run.id}` });
    if (run.conclusion === 'failure' && branchIsDefault) {
      findings.push({
        key, repo, kind: 'run', signal: rankSignal({ kind: 'run', conclusion: 'failure', branchIsDefault }),
        title: `${run.name || 'Workflow'} failed on ${branch} (${shortRepoName(repo)})`,
        detail: `Actions run #${run.run_number ?? '?'} failed.`,
        url: run.html_url || null,
        workflow: run.name || null, branch, foundAt,
      });
    } else if (run.conclusion === 'success' && branchIsDefault && knownFailures.has(`${run.name || ''}|${branch}`)) {
      findings.push({
        key: findingKey({ repo, kind: 'run', ref: `run:${run.id}:recovered` }),
        repo, kind: 'run', signal: rankSignal({ kind: 'run', conclusion: 'success', branchIsDefault, isRecovery: true }),
        title: `${run.name || 'Workflow'} is green again on ${branch} (${shortRepoName(repo)})`,
        detail: `Actions run #${run.run_number ?? '?'} succeeded after a failure.`,
        url: run.html_url || null,
        workflow: run.name || null, branch, foundAt,
      });
    }
  }

  for (const alert of alertList) {
    if (!alert || typeof alert !== 'object' || alert.state !== 'open') continue;
    const severity = alertSeverity(alert);
    const pkg = alert?.dependency?.package?.name || alert?.security_vulnerability?.package_name || 'a dependency';
    findings.push({
      key: findingKey({ repo, kind: 'alert', ref: `alert:${alert.number}` }),
      repo, kind: 'alert', signal: rankSignal({ kind: 'alert', severity }),
      title: `${severity} security alert: ${pkg}`,
      detail: String(alert?.security_advisory?.summary || '').slice(0, 160) || 'Open Dependabot/security alert.',
      url: alert.html_url || null,
      workflow: null, branch: null, foundAt,
    });
  }

  for (const pr of prList) {
    if (!pr || typeof pr !== 'object' || !pr.merged_at) continue;
    findings.push({
      key: findingKey({ repo, kind: 'pr', ref: `pr:${pr.number}` }),
      repo, kind: 'pr', signal: rankSignal({ kind: 'pr', merged: true }),
      title: `Merged: ${String(pr.title || 'a pull request').slice(0, 80)} (${shortRepoName(repo)})`,
      detail: `PR #${pr.number} merged${pr.user?.login ? ` by ${pr.user.login}` : ''}.`,
      url: pr.html_url || null,
      workflow: null, branch: null, foundAt,
    });
  }

  return findings.filter((f) => f.signal === 'high' || f.signal === 'low');
}

/**
 * Deterministic, plain-text check-in for a high-signal finding — warm but
 * plain (no markdown emphasis, matching his chat style). No model call: alert
 * content is structured, so a template reads fine and costs nothing.
 */
export function composeRadarCheckin(finding) {
  const repo = shortRepoName(finding.repo);
  const link = finding.url ? ` ${finding.url}` : '';
  if (finding.kind === 'run') {
    return `Heads up — ${finding.workflow || 'a workflow'} failed on ${finding.branch || 'main'} in ${repo}. Worth a look when you get a chance:${link}`;
  }
  if (finding.kind === 'alert') {
    const what = finding.title.replace(/^(critical|high|medium|low) security alert:\s*/i, '');
    const why = finding.detail ? ` — ${finding.detail}` : '';
    return `Security heads-up in ${repo}: ${what}${why}. Details here:${link}`;
  }
  return `Quick note on ${repo}: ${finding.title}.${link}`;
}

// ---------------------------------------------------------------------------
// Poll: fetch, rank, dedupe, store
// ---------------------------------------------------------------------------

/** Fetch the radar sources for one repo (all GET). Returns raw API payloads. */
export async function pollRepo({ owner, repo, token, fetchImpl = fetch, assertActive = () => {} }) {
  const full = `${owner}/${repo}`;
  const enc = encodeURIComponent;
  await assertActive();
  const { data: info } = await ghGet(`/repos/${enc(owner)}/${enc(repo)}`, token, { fetchImpl });
  const defaultBranch = info?.default_branch || 'main';
  await assertActive();
  const { data: runsData } = await ghGet(
    `/repos/${enc(owner)}/${enc(repo)}/actions/runs?per_page=10&branch=${enc(defaultBranch)}`, token, { fetchImpl });
  // Dependabot alerts need the security_events scope; 403/404 → skipped quietly.
  await assertActive();
  const { data: alerts } = await ghGet(
    `/repos/${enc(owner)}/${enc(repo)}/dependabot/alerts?state=open&per_page=10`, token, { fetchImpl });
  await assertActive();
  const { data: prs } = await ghGet(
    `/repos/${enc(owner)}/${enc(repo)}/pulls?state=closed&per_page=10&sort=updated&direction=desc`, token, { fetchImpl });
  return {
    fullName: full,
    defaultBranch,
    runs: Array.isArray(runsData?.workflow_runs) ? runsData.workflow_runs : [],
    alerts: Array.isArray(alerts) ? alerts : [],
    prs: Array.isArray(prs) ? prs : [],
  };
}

/**
 * Run one radar poll: resolve repos, fetch sources, rank findings, store the
 * new ones. Returns { skipped, checked, surfaced, errors }. Never throws for
 * per-repo failures — one bad repo must not sink the others.
 */
export async function runRadarPoll({ db, env = process.env, nowMs = Date.now(), fetchImpl = fetch, assertActive = () => {} } = {}) {
  const summary = { skipped: null, checked: 0, surfaced: [], errors: [] };
  const token = env[RADAR_TOKEN_ENV];
  if (!token) return { ...summary, skipped: 'no-token' };
  const lastPoll = Number(db.getSetting('radar_last_poll') || 0);
  if (lastPoll > 0 && nowMs - lastPoll < RADAR_POLL_INTERVAL_MS) return { ...summary, skipped: 'too-soon' };
  const lastErrorAt = Number(db.getSetting('radar_last_error_at') || 0);
  if (nowMs - lastErrorAt < RADAR_ERROR_BACKOFF_MS && db.getSetting('radar_last_error')) {
    return { ...summary, skipped: 'error-backoff' };
  }

  let repos;
  try {
    await assertActive();
    repos = await resolveWatchRepos({ token, env, fetchImpl, assertActive });
  } catch (error) {
    if(error?.code==='PROACTIVE_DEFERRED'||error?.code==='PROACTIVE_LEASE_LOST')throw error;
    await assertActive();
    db.setSetting('radar_last_error', String((error && error.message) || error).slice(0, 200));
    db.setSetting('radar_last_error_at', String(nowMs));
    return { ...summary, skipped: 'discovery-failed' };
  }
  if (!repos.length) {
    await assertActive();
    db.setSetting('radar_last_poll', String(nowMs));
    return { ...summary, skipped: 'no-repos' };
  }

  for (const full of repos) {
    const [owner, repo] = String(full).split('/');
    if (!owner || !repo) continue;
    try {
      await assertActive();
      const { fullName, defaultBranch, runs, alerts, prs } = await pollRepo({ owner, repo, token, fetchImpl, assertActive });
      await assertActive();
      summary.checked++;
      const knownFailures = new Set(
        (db.listRadarUnrecoveredFailures(fullName) || []).map((r) => `${r.workflow}|${r.branch}`));
      const findings = extractFindings({ repo: fullName, defaultBranch, runs, alerts, prs, knownFailures, nowMs });
      for (const f of findings) {
        if (db.radarFindingSeen(f.key)) continue; // dedupe: never surface the same finding twice
        db.storeRadarFinding(f);
        summary.surfaced.push(f);
      }
    } catch (error) {
      if(error?.code==='PROACTIVE_DEFERRED'||error?.code==='PROACTIVE_LEASE_LOST')throw error;
      // One repo failing (rate limit, renamed, transient) never sinks the poll.
      summary.errors.push({ repo: full, error: String((error && error.message) || error).slice(0, 160) });
    }
  }

  await assertActive();
  db.setSetting('radar_last_poll', String(nowMs));
  try { db.setSetting('radar_last_error', ''); } catch { /* best effort */ }
  return summary;
}

// ---------------------------------------------------------------------------
// Delivery: high-signal → check-in; low-signal → briefing items
// ---------------------------------------------------------------------------

/**
 * Deliver newly surfaced high-signal findings as proactive check-ins.
 * - one radar check-in per user per day (conservative, inside the 2/day rule)
 * - consumes the shared proactive slot (3/day budget across all outreach)
 * - skips muted repos, quiet hours, and already-delivered findings
 * `isQuiet(prefs, nowMs)` and `deliver({ user, finding, text })` are injected.
 */
export async function deliverRadarFindings({ db, surfaced = [], nowMs = Date.now(), isQuiet = () => false, deliver }) {
  const delivered = [];
  const highs = (surfaced || []).filter((f) => f && f.signal === 'high');
  if (!highs.length || typeof deliver !== 'function') return delivered;
  for (const user of db.listUsers()) {
    if (user.disabled) continue;
    let prefs = {};
    try { prefs = db.getPreferences(user.id) || {}; } catch { /* prefs stay empty */ }
    if (isQuiet(prefs, nowMs)) continue;
    const timeZone = validTimeZone(prefs.time_zone) || 'America/New_York';
    const today = todayInZone(timeZone, nowMs);
    const countKey = `radar_checkin_count_${user.id}_${today}`;
    const mutes = new Set((db.listRadarMutes(user.id) || []).map((m) => String(m.repo).toLowerCase()));
    for (const finding of highs) {
      if (mutes.has(String(finding.repo).toLowerCase())) continue; // per-project mute
      if (db.radarFindingDelivered(finding.key, user.id)) continue; // never twice
      const sentToday = Number(db.getSetting(countKey) || 0);
      if (sentToday >= RADAR_MAX_RADAR_CHECKINS_PER_DAY) break;
      const slotToken = db.reserveProactiveSlot ? db.reserveProactiveSlot(user.id, today) : db.claimProactiveSlot(user.id, today);
      if (!slotToken) break; // shared daily outreach budget
      try {
        const text = composeRadarCheckin(finding);
        const outcome = await deliver({ user, finding, text, slotToken, localDate: today });
        if (outcome === false || outcome?.recorded === false) { db.releaseProactiveSlot(user.id, today, slotToken); continue; }
        db.markRadarFindingDelivered(finding.key, user.id);
        db.setSetting(countKey, String(sentToday + 1));
        delivered.push({ userId: user.id, key: finding.key });
      } catch (error) {
        db.releaseProactiveSlot(user.id, today, slotToken);
        db.addEvent(user.id, 'radar_checkin_failed', `Could not send project-radar check-in for ${finding.title}.`, String((error && error.message) || error).slice(0, 200));
      }
    }
  }
  return delivered;
}

/**
 * Low-noise briefing items for the Today tab: recent findings (both signals —
 * high ones were already check-in delivered, this is a quiet reminder),
 * muted repos excluded, newest first, capped.
 */
export function getRadarBriefingItems(db, userId, { nowMs = Date.now(), days = RADAR_BRIEFING_DAYS, limit = RADAR_BRIEFING_LIMIT } = {}) {
  const mutes = new Set((db.listRadarMutes(userId) || []).map((m) => String(m.repo).toLowerCase()));
  const cutoffMs = nowMs - days * 86400_000;
  return (db.listRecentRadarFindings(limit * 4) || [])
    .filter((f) => {
      if (!f || !f.finding_key) return false;
      if (mutes.has(String(f.repo).toLowerCase())) return false;
      const at = Date.parse(f.found_at || f.created_at || '');
      return Number.isFinite(at) && at >= cutoffMs;
    })
    .slice(0, limit)
    .map((f) => ({
      id: f.finding_key,
      repo: f.repo,
      kind: f.kind,
      signal: f.signal,
      title: f.title,
      detail: f.detail,
      url: f.url,
      foundAt: f.found_at,
    }));
}
