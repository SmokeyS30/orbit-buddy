import { sha256, safeText } from './security.js';

const severityRank = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

function workflowFilesChanged(payload) {
  const files = [];
  for (const commit of payload.commits || []) files.push(...(commit.added || []), ...(commit.modified || []), ...(commit.removed || []));
  return files.some((file) => String(file).startsWith('.github/workflows/'));
}

function severityFor(score) {
  if (score >= 80) return 'critical';
  if (score >= 55) return 'high';
  if (score >= 30) return 'medium';
  if (score >= 10) return 'low';
  return 'info';
}

function signal(code, score, title, recommendation) {
  return { code, score, title, recommendation };
}

function eventSignals(eventName, action, payload) {
  const signals = [];
  if (eventName === 'public' || (eventName === 'repository' && payload.repository?.private === false && ['publicized', 'edited'].includes(action))) {
    signals.push(signal('repository-public', 90, 'Repository visibility changed to public', 'Confirm the visibility change and review the repository for exposed credentials or private material.'));
  }
  if (eventName === 'repository' && action === 'deleted') {
    signals.push(signal('repository-deleted', 85, 'Repository was deleted', 'Confirm the deletion in the GitHub security log and preserve provider audit records.'));
  }
  if (eventName === 'repository' && action === 'transferred') {
    signals.push(signal('repository-transferred', 80, 'Repository ownership changed', 'Confirm the transfer destination and review collaborator and App access.'));
  }
  if (eventName === 'repository' && action === 'edited' && payload.changes?.default_branch) {
    signals.push(signal('default-branch-changed', 55, 'Default branch changed', 'Confirm the new default branch and verify its ruleset and required checks.'));
  }
  if (eventName === 'deploy_key' && action === 'created') {
    const writable = payload.key?.read_only === false;
    signals.push(signal(writable ? 'writable-deploy-key-created' : 'deploy-key-created', writable ? 80 : 55,
      writable ? 'Writable deploy key was added' : 'Deploy key was added', 'Verify the key fingerprint and remove it in GitHub if it is not expected.'));
  }
  if (eventName === 'branch_protection_rule' && action === 'deleted') {
    signals.push(signal('branch-protection-deleted', 65, 'Branch protection was deleted', 'Review the change in GitHub and restore the expected rule or ruleset after approval.'));
  }
  if (eventName === 'push' && payload.forced === true) {
    signals.push(signal('force-push', 70, 'Force push detected', 'Review the pushed commit range and restore the protected branch only after confirming the expected history.'));
  }
  if (eventName === 'push' && workflowFilesChanged(payload)) {
    signals.push(signal('workflow-changed', 35, 'GitHub Actions workflow changed', 'Review the workflow diff, token permissions, action pins, and untrusted-input handling.'));
  }
  if (eventName === 'member' && action === 'added') {
    const permission = String(payload.changes?.permission?.to || (payload.member?.permissions?.admin && 'admin') || '').toLowerCase();
    signals.push(signal(permission === 'admin' ? 'admin-collaborator-added' : 'collaborator-added', permission === 'admin' ? 60 : 35,
      permission === 'admin' ? 'Administrator collaborator was added' : 'Repository collaborator was added', 'Confirm the collaborator and granted role in GitHub.'));
  }
  if (eventName === 'membership' && ['added', 'edited'].includes(action)) {
    signals.push(signal('organization-membership-changed', 35, 'Organization membership changed', 'Confirm the member and role in the organization audit log.'));
  }
  if (eventName === 'installation' && ['deleted', 'suspend'].includes(action)) {
    signals.push(signal('sentinel-installation-disabled', 75, 'Sentinel installation was disabled', 'Confirm the App change and restore monitoring only after verifying the account.'));
  }
  if (eventName === 'secret_scanning_alert') {
    const bypassed = action === 'validated' || payload.alert?.push_protection_bypassed;
    signals.push(signal(bypassed ? 'secret-protection-bypassed' : 'secret-alert', bypassed ? 95 : 85,
      bypassed ? 'Secret push protection was bypassed' : 'GitHub detected an exposed secret', 'Review the alert in GitHub, rotate the credential, and remove it from history if exposure is confirmed.'));
  }
  return signals;
}

function recentUrgentCount(recentEvents, nowMs) {
  const cutoff = nowMs - 10 * 60_000;
  return recentEvents.filter((event) => ['critical', 'high'].includes(event.risk) && Date.parse(event.received_at) >= cutoff).length;
}

function incidentKeyFor({ eventName, action, target, deliveryId, now }) {
  // deliveryId is unique per webhook; the fallback adds randomness so two
  // webhooks in the same millisecond can't silently merge into one incident.
  const seed = deliveryId || [eventName, action, target, now.toISOString(), Math.random().toString(36).slice(2)].join(':');
  return 'shield:' + sha256(seed);
}

export function assessShieldEvent({ eventName, action, payload, repository = null, recentEvents = [], deliveryId, now = new Date() }) {
  const signals = eventSignals(eventName, action, payload);
  const burstCount = recentUrgentCount(recentEvents, now.valueOf());
  if (signals.length && burstCount >= 2) {
    signals.push(signal('urgent-event-burst', Math.min(20, burstCount * 5), 'Multiple urgent changes occurred within ten minutes', 'Treat the events as one incident and review the GitHub security or organization audit log.'));
  }

  const score = Math.min(100, signals.reduce((sum, item) => sum + item.score, 0));
  const severity = severityFor(score);
  const primary = [...signals].sort((left, right) => right.score - left.score)[0] || null;
  const sender = safeText(payload.sender?.login || '', 80).toLowerCase();
  const actorHash = sender ? sha256(sender).slice(0, 16) : null;
  const target = safeText(repository?.full_name || payload.repository?.full_name || payload.organization?.login || payload.installation?.account?.login || 'GitHub installation', 180);

  if (!primary || score < 30) return { score, severity, signals: signals.map(({ code }) => code), incident: null };
  const incident = {
    incidentKey: incidentKeyFor({ eventName, action, target, deliveryId, now }),
    installationId: Number(payload.installation?.id || 0) || null,
    repoId: repository?.id || null,
    severity,
    score,
    title: primary.title,
    evidence: `${target}: ${primary.title}. Daybreak Shield recorded metadata only; confirm intent in GitHub before taking action.`,
    actorHash,
    signals: signals.map(({ code }) => code),
    recommendedAction: primary.recommendation
  };
  return { score, severity, signals: incident.signals, incident };
}

export { incidentKeyFor };

export function higherSeverity(left, right) {
  return severityRank[left] >= severityRank[right] ? left : right;
}
