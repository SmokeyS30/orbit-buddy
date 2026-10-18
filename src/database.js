import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const now = () => new Date().toISOString();

export function openDatabase(filePath) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const sql = new DatabaseSync(filePath);
  fs.chmodSync(filePath, 0o600);
  sql.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  sql.exec(`
    CREATE TABLE IF NOT EXISTS installations (
      id INTEGER PRIMARY KEY, account_login TEXT NOT NULL, account_type TEXT NOT NULL,
      target_type TEXT, suspended INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0,
      shield_locked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_scan_at TEXT, next_scan_at TEXT
    );
    CREATE TABLE IF NOT EXISTS repositories (
      id INTEGER PRIMARY KEY, installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
      owner TEXT NOT NULL, name TEXT NOT NULL, full_name TEXT NOT NULL, private INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, default_branch TEXT NOT NULL DEFAULT 'main', visibility TEXT,
      last_seen_at TEXT NOT NULL, scan_status TEXT NOT NULL DEFAULT 'pending', UNIQUE(installation_id, full_name)
    );
    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY, installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
      repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL UNIQUE,
      severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low','info')),
      title TEXT NOT NULL, evidence TEXT NOT NULL, source TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','resolved','accepted')) DEFAULT 'open',
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      delivery_id TEXT PRIMARY KEY, installation_id INTEGER, repo_id INTEGER, event TEXT NOT NULL,
      action TEXT, risk TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      github_id INTEGER PRIMARY KEY, login TEXT NOT NULL, avatar_url TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(github_id) ON DELETE CASCADE,
      github_token_encrypted TEXT NOT NULL, csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      state_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS installation_access (
      user_id INTEGER NOT NULL REFERENCES users(github_id) ON DELETE CASCADE,
      installation_id INTEGER NOT NULL, checked_at TEXT NOT NULL, PRIMARY KEY(user_id, installation_id)
    );
    CREATE TABLE IF NOT EXISTS scan_summaries (
      id TEXT PRIMARY KEY, installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
      summary TEXT NOT NULL, model TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shield_incidents (
      id TEXT PRIMARY KEY, incident_key TEXT NOT NULL UNIQUE,
      installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
      repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
      severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low','info')),
      score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100), title TEXT NOT NULL,
      evidence TEXT NOT NULL, actor_hash TEXT, signals_json TEXT NOT NULL,
      recommended_action TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','acknowledged')) DEFAULT 'open',
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, acknowledged_at TEXT,
      reopened_count INTEGER NOT NULL DEFAULT 0
    );
    -- approval_actions was scaffolded in v0.1.0 but never used; the approval
    -- gate for consequential changes is the explicit confirmation step
    -- (e.g. typing PUBLISH before a security report is posted as an issue).
    DROP TABLE IF EXISTS approval_actions;
    CREATE INDEX IF NOT EXISTS idx_repo_installation ON repositories(installation_id, full_name);
    CREATE INDEX IF NOT EXISTS idx_findings_installation ON findings(installation_id, status, severity);
    CREATE INDEX IF NOT EXISTS idx_findings_repo ON findings(repo_id, status);
    CREATE INDEX IF NOT EXISTS idx_events_installation ON events(installation_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_shield_installation ON shield_incidents(installation_id, status, score DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);

  const installationColumns = new Set(sql.prepare('PRAGMA table_info(installations)').all().map((column) => column.name));
  if (!installationColumns.has('shield_locked')) sql.exec('ALTER TABLE installations ADD COLUMN shield_locked INTEGER NOT NULL DEFAULT 0');
  const shieldColumns = new Set(sql.prepare('PRAGMA table_info(shield_incidents)').all().map((column) => column.name));
  if (!shieldColumns.has('reopened_count')) sql.exec('ALTER TABLE shield_incidents ADD COLUMN reopened_count INTEGER NOT NULL DEFAULT 0');

  const statements = {
    installation: sql.prepare('SELECT * FROM installations WHERE id=?'),
    installations: sql.prepare('SELECT * FROM installations ORDER BY account_login COLLATE NOCASE'),
    dueInstallations: sql.prepare(`SELECT * FROM installations WHERE suspended=0 AND paused=0
      AND (next_scan_at IS NULL OR next_scan_at<=?) ORDER BY COALESCE(next_scan_at,created_at) LIMIT ?`),
    upsertInstallation: sql.prepare(`INSERT INTO installations
      (id,account_login,account_type,target_type,suspended,paused,created_at,updated_at,next_scan_at)
      VALUES(?,?,?,?,?,0,?,?,?) ON CONFLICT(id) DO UPDATE SET account_login=excluded.account_login,
      account_type=excluded.account_type,target_type=excluded.target_type,suspended=excluded.suspended,updated_at=excluded.updated_at`),
    suspendInstallation: sql.prepare('UPDATE installations SET suspended=?,updated_at=? WHERE id=?'),
    pauseInstallation: sql.prepare('UPDATE installations SET paused=?,updated_at=? WHERE id=?'),
    shieldLockInstallation: sql.prepare('UPDATE installations SET shield_locked=?,updated_at=? WHERE id=?'),
    scheduleInstallation: sql.prepare('UPDATE installations SET next_scan_at=?,updated_at=? WHERE id=?'),
    completeScan: sql.prepare('UPDATE installations SET last_scan_at=?,next_scan_at=?,updated_at=? WHERE id=?'),
    repo: sql.prepare('SELECT * FROM repositories WHERE installation_id=? AND full_name=?'),
    repoById: sql.prepare('SELECT * FROM repositories WHERE id=? AND installation_id=?'),
    repos: sql.prepare('SELECT * FROM repositories WHERE installation_id=? ORDER BY full_name COLLATE NOCASE'),
    upsertRepo: sql.prepare(`INSERT INTO repositories
      (id,installation_id,owner,name,full_name,private,archived,default_branch,visibility,last_seen_at,scan_status)
      VALUES(?,?,?,?,?,?,?,?,?,?,'pending') ON CONFLICT(id) DO UPDATE SET installation_id=excluded.installation_id,
      owner=excluded.owner,name=excluded.name,full_name=excluded.full_name,private=excluded.private,
      archived=excluded.archived,default_branch=excluded.default_branch,visibility=excluded.visibility,last_seen_at=excluded.last_seen_at`),
    markRepoScan: sql.prepare('UPDATE repositories SET scan_status=?,last_seen_at=? WHERE id=?'),
    removeRepo: sql.prepare('DELETE FROM repositories WHERE installation_id=? AND id=?'),
    findingByFingerprint: sql.prepare('SELECT * FROM findings WHERE fingerprint=?'),
    findingById: sql.prepare('SELECT * FROM findings WHERE id=?'),
    insertFinding: sql.prepare(`INSERT INTO findings VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)`),
    updateFinding: sql.prepare(`UPDATE findings SET severity=?,title=?,evidence=?,source=?,status='open',last_seen_at=?,resolved_at=NULL WHERE fingerprint=?`),
    resolveFinding: sql.prepare(`UPDATE findings SET status='resolved',resolved_at=?,last_seen_at=? WHERE fingerprint=? AND status='open'`),
    acceptFinding: sql.prepare(`UPDATE findings SET status='accepted',last_seen_at=? WHERE id=? AND installation_id=?`),
    openFindings: sql.prepare(`SELECT findings.*,repositories.full_name FROM findings LEFT JOIN repositories ON repositories.id=findings.repo_id
      WHERE findings.installation_id=? AND findings.status='open' ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END,last_seen_at DESC`),
    scannerFindingsByRepo: sql.prepare(`SELECT fingerprint FROM findings WHERE repo_id=? AND status='open' AND source LIKE 'scheduled-%'`),
    recentEvents: sql.prepare('SELECT * FROM events WHERE installation_id=? ORDER BY received_at DESC LIMIT ?'),
    addEvent: sql.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)'),
    event: sql.prepare('SELECT delivery_id FROM events WHERE delivery_id=?'),
    shieldIncidentByKey: sql.prepare('SELECT * FROM shield_incidents WHERE incident_key=?'),
    shieldIncidentById: sql.prepare('SELECT * FROM shield_incidents WHERE id=? AND installation_id=?'),
    insertShieldIncident: sql.prepare(`INSERT INTO shield_incidents
      (id,incident_key,installation_id,repo_id,severity,score,title,evidence,actor_hash,signals_json,recommended_action,status,first_seen_at,last_seen_at,acknowledged_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'open',?,?,NULL)`),
    updateShieldIncident: sql.prepare(`UPDATE shield_incidents SET severity=?,score=?,title=?,evidence=?,actor_hash=?,signals_json=?,recommended_action=?,reopened_count=reopened_count+CASE WHEN status='acknowledged' THEN 1 ELSE 0 END,status='open',last_seen_at=?,acknowledged_at=NULL WHERE incident_key=?`),
    openShieldIncidents: sql.prepare(`SELECT shield_incidents.*,repositories.full_name FROM shield_incidents
      LEFT JOIN repositories ON repositories.id=shield_incidents.repo_id
      WHERE shield_incidents.installation_id=? AND shield_incidents.status='open'
      ORDER BY score DESC,last_seen_at DESC LIMIT ?`),
    acknowledgeShieldIncident: sql.prepare(`UPDATE shield_incidents SET status='acknowledged',acknowledged_at=?,last_seen_at=? WHERE id=? AND installation_id=? AND status='open'`),
    upsertUser: sql.prepare(`INSERT INTO users VALUES(?,?,?,?,?) ON CONFLICT(github_id) DO UPDATE SET login=excluded.login,avatar_url=excluded.avatar_url,updated_at=excluded.updated_at`),
    user: sql.prepare('SELECT * FROM users WHERE github_id=?'),
    addSession: sql.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)'),
    session: sql.prepare(`SELECT sessions.*,users.login,users.avatar_url FROM sessions JOIN users ON users.github_id=sessions.user_id
      WHERE sessions.token_hash=? AND sessions.expires_at>?`),
    deleteSession: sql.prepare('DELETE FROM sessions WHERE token_hash=?'),
    pruneSessions: sql.prepare('DELETE FROM sessions WHERE expires_at<=?'),
    addState: sql.prepare('INSERT INTO oauth_states VALUES(?,?,?)'),
    consumeState: sql.prepare('SELECT * FROM oauth_states WHERE state_hash=? AND expires_at>?'),
    deleteState: sql.prepare('DELETE FROM oauth_states WHERE state_hash=?'),
    clearAccess: sql.prepare('DELETE FROM installation_access WHERE user_id=?'),
    addAccess: sql.prepare('INSERT OR REPLACE INTO installation_access VALUES(?,?,?)'),
    hasAccess: sql.prepare('SELECT 1 AS allowed FROM installation_access WHERE user_id=? AND installation_id=?'),
    addSummary: sql.prepare('INSERT INTO scan_summaries VALUES(?,?,?,?,?)'),
    latestSummary: sql.prepare('SELECT * FROM scan_summaries WHERE installation_id=? ORDER BY created_at DESC LIMIT 1'),
    publicCounts: sql.prepare(`SELECT
      (SELECT COUNT(*) FROM installations WHERE suspended=0) AS installations,
      (SELECT COUNT(*) FROM repositories) AS repositories,
      (SELECT COUNT(*) FROM findings WHERE status='open') AS open_findings,
      (SELECT COUNT(*) FROM findings WHERE status='open' AND severity IN ('critical','high')) AS urgent_findings,
      (SELECT MAX(received_at) FROM events) AS last_event_at`)
  };

  function upsertFinding({ installationId, repoId = null, fingerprint, severity, title, evidence, source }) {
    const existing = statements.findingByFingerprint.get(fingerprint);
    const stamp = now();
    if (existing) {
      statements.updateFinding.run(severity, title, evidence, source, stamp, fingerprint);
      return statements.findingByFingerprint.get(fingerprint);
    }
    const id = randomUUID();
    statements.insertFinding.run(id, installationId, repoId, fingerprint, severity, title, evidence, source, 'open', stamp, stamp);
    return statements.findingById.get(id);
  }

  return {
    close: () => sql.close(),
    transaction: (callback) => { sql.exec('BEGIN IMMEDIATE'); try { const value = callback(); sql.exec('COMMIT'); return value; } catch (error) { sql.exec('ROLLBACK'); throw error; } },
    upsertInstallation(data) { const stamp = now(); statements.upsertInstallation.run(data.id, data.accountLogin || 'unknown', data.accountType || 'Unknown', data.targetType || null, data.suspended ? 1 : 0, stamp, stamp, stamp); return statements.installation.get(data.id); },
    getInstallation: (id) => statements.installation.get(id),
    listInstallations: () => statements.installations.all(),
    dueInstallations: (limit = 5) => statements.dueInstallations.all(now(), limit),
    setInstallationSuspended(id, suspended) { statements.suspendInstallation.run(suspended ? 1 : 0, now(), id); },
    setInstallationPaused(id, paused) { statements.pauseInstallation.run(paused ? 1 : 0, now(), id); },
    setShieldLocked(id, locked) { statements.shieldLockInstallation.run(locked ? 1 : 0, now(), id); },
    scheduleInstallation(id, date = new Date()) { statements.scheduleInstallation.run(date.toISOString(), now(), id); },
    completeInstallationScan(id, nextDate) { const stamp = now(); statements.completeScan.run(stamp, nextDate.toISOString(), stamp, id); },
    upsertRepository(installationId, repo) { const owner = repo.owner?.login || String(repo.full_name || '').split('/')[0]; const name = repo.name || String(repo.full_name || '').split('/')[1]; statements.upsertRepo.run(repo.id, installationId, owner, name, repo.full_name || `${owner}/${name}`, repo.private ? 1 : 0, repo.archived ? 1 : 0, repo.default_branch || 'main', repo.visibility || (repo.private ? 'private' : 'public'), now()); return statements.repo.get(installationId, repo.full_name || `${owner}/${name}`); },
    getRepository: (installationId, fullName) => statements.repo.get(installationId, fullName),
    getRepositoryById: (installationId, id) => statements.repoById.get(id, installationId),
    listRepositories: (installationId) => statements.repos.all(installationId),
    markRepositoryScan(id, status) { statements.markRepoScan.run(status, now(), id); },
    removeRepository(installationId, id) { statements.removeRepo.run(installationId, id); },
    upsertFinding,
    resolveFinding(fingerprint) { statements.resolveFinding.run(now(), now(), fingerprint); },
    acceptFinding(id, installationId) { statements.acceptFinding.run(now(), id, installationId); },
    listOpenFindings: (installationId) => statements.openFindings.all(installationId),
    resolveStaleScannerFindings(repoId, seenFingerprints) { const seen = new Set(seenFingerprints); for (const row of statements.scannerFindingsByRepo.all(repoId)) if (!seen.has(row.fingerprint)) statements.resolveFinding.run(now(), now(), row.fingerprint); },
    hasDelivery: (deliveryId) => Boolean(statements.event.get(deliveryId)),
    addEvent(event) { statements.addEvent.run(event.deliveryId, event.installationId || null, event.repoId || null, event.event, event.action || null, event.risk, event.title, event.detail, now()); },
    recentEvents: (installationId, limit = 100) => statements.recentEvents.all(installationId, Math.min(limit, 250)),
    upsertShieldIncident(incident) {
      if (!incident.installationId) return null;
      const existing = statements.shieldIncidentByKey.get(incident.incidentKey);
      const stamp = now();
      const signalsJson = JSON.stringify((incident.signals || []).slice(0, 20));
      if (existing) {
        statements.updateShieldIncident.run(incident.severity, incident.score, incident.title, incident.evidence, incident.actorHash || null, signalsJson, incident.recommendedAction, stamp, incident.incidentKey);
        return statements.shieldIncidentByKey.get(incident.incidentKey);
      }
      const id = randomUUID();
      statements.insertShieldIncident.run(id, incident.incidentKey, incident.installationId, incident.repoId || null, incident.severity, incident.score, incident.title, incident.evidence, incident.actorHash || null, signalsJson, incident.recommendedAction, stamp, stamp);
      return statements.shieldIncidentById.get(id, incident.installationId);
    },
    listOpenShieldIncidents: (installationId, limit = 100) => statements.openShieldIncidents.all(installationId, Math.min(limit, 250)).map((row) => ({ ...row, signals: JSON.parse(row.signals_json) })),
    acknowledgeShieldIncident(id, installationId) { const stamp = now(); return statements.acknowledgeShieldIncident.run(stamp, stamp, id, installationId).changes > 0; },
    upsertUser(user) { const stamp = now(); statements.upsertUser.run(user.id, user.login, user.avatar_url || null, stamp, stamp); return statements.user.get(user.id); },
    createSession({ tokenHash, userId, githubTokenEncrypted, csrfToken, expiresAt }) { statements.addSession.run(tokenHash, userId, githubTokenEncrypted, csrfToken, expiresAt, now()); },
    getSession: (tokenHash) => statements.session.get(tokenHash, now()),
    deleteSession: (tokenHash) => statements.deleteSession.run(tokenHash),
    pruneSessions() { statements.pruneSessions.run(now()); },
    createOauthState(stateHash, expiresAt) { statements.addState.run(stateHash, expiresAt, now()); },
    consumeOauthState(stateHash) { const row = statements.consumeState.get(stateHash, now()); statements.deleteState.run(stateHash); return row; },
    replaceInstallationAccess(userId, installationIds) { return this.transaction(() => { statements.clearAccess.run(userId); for (const id of installationIds) statements.addAccess.run(userId, id, now()); }); },
    userHasAccess: (userId, installationId) => Boolean(statements.hasAccess.get(userId, installationId)),
    addSummary(installationId, summary, model = null) { const id = randomUUID(); statements.addSummary.run(id, installationId, summary, model, now()); return id; },
    latestSummary: (installationId) => statements.latestSummary.get(installationId),
    publicCounts: () => statements.publicCounts.get()
  };
}
