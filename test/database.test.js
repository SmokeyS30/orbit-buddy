import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/database.js';

function database() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-sentinel-'));
  return { db: openDatabase(path.join(directory, 'test.sqlite')), directory };
}

test('isolates repositories and findings by installation', () => {
  const { db, directory } = database();
  try {
    db.upsertInstallation({ id: 1, accountLogin: 'one', accountType: 'User' });
    db.upsertInstallation({ id: 2, accountLogin: 'two', accountType: 'User' });
    const first = db.upsertRepository(1, { id: 11, full_name: 'one/repo', name: 'repo', owner: { login: 'one' } });
    db.upsertRepository(2, { id: 22, full_name: 'two/repo', name: 'repo', owner: { login: 'two' } });
    db.upsertFinding({ installationId: 1, repoId: first.id, fingerprint: 'one', severity: 'high', title: 'Test', evidence: 'Safe evidence', source: 'scheduled-posture' });
    assert.equal(db.listRepositories(1).length, 1);
    assert.equal(db.listRepositories(1)[0].full_name, 'one/repo');
    assert.equal(db.listOpenFindings(1).length, 1);
    assert.equal(db.listOpenFindings(2).length, 0);
  } finally { db.close(); fs.rmSync(directory, { recursive: true }); }
});

test('resolves scanner findings that disappear on a later scan', () => {
  const { db, directory } = database();
  try {
    db.upsertInstallation({ id: 1, accountLogin: 'one', accountType: 'User' });
    const repo = db.upsertRepository(1, { id: 11, full_name: 'one/repo', name: 'repo', owner: { login: 'one' } });
    db.upsertFinding({ installationId: 1, repoId: repo.id, fingerprint: 'scan:11:old', severity: 'medium', title: 'Old', evidence: 'Old', source: 'scheduled-posture' });
    db.resolveStaleScannerFindings(repo.id, []);
    assert.equal(db.listOpenFindings(1).length, 0);
  } finally { db.close(); fs.rmSync(directory, { recursive: true }); }
});

test('stores Shield incidents and keeps Guardian Lock independent from monitoring pause', () => {
  const { db, directory } = database();
  try {
    db.upsertInstallation({ id: 1, accountLogin: 'one', accountType: 'User' });
    const repo = db.upsertRepository(1, { id: 11, full_name: 'one/repo', name: 'repo', owner: { login: 'one' } });
    const incident = db.upsertShieldIncident({ incidentKey: 'shield:test', installationId: 1, repoId: repo.id, severity: 'high', score: 70,
      title: 'Force push detected', evidence: 'one/repo: force push metadata.', actorHash: '0123456789abcdef', signals: ['force-push'], recommendedAction: 'Review GitHub.' });
    assert.equal(db.listOpenShieldIncidents(1)[0].signals[0], 'force-push');
    db.setShieldLocked(1, true);
    assert.equal(db.getInstallation(1).shield_locked, 1);
    assert.equal(db.getInstallation(1).paused, 0);
    assert.equal(db.acknowledgeShieldIncident(incident.id, 1), true);
    assert.equal(db.listOpenShieldIncidents(1).length, 0);
  } finally { db.close(); fs.rmSync(directory, { recursive: true }); }
});

test('tracks when an acknowledged Shield incident is reopened by new signals', () => {
  const { db, directory } = database();
  try {
    db.upsertInstallation({ id: 1, accountLogin: 'one', accountType: 'User' });
    const make = (sev, score) => db.upsertShieldIncident({ incidentKey: 'shield:reopen', installationId: 1, repoId: null, severity: sev, score,
      title: 't', evidence: 'e', actorHash: null, signals: ['force-push'], recommendedAction: 'r' });
    const first = make('high', 70);
    assert.equal(first.reopened_count, 0);
    // New signals on an open incident: no reopen counted.
    const updated = make('high', 75);
    assert.equal(updated.reopened_count, 0);
    assert.equal(db.listOpenShieldIncidents(1).length, 1);
    // Acknowledge, then new signals arrive: reopened and counted.
    assert.equal(db.acknowledgeShieldIncident(first.id, 1), true);
    const reopened = make('critical', 85);
    assert.equal(reopened.status, 'open');
    assert.equal(reopened.reopened_count, 1);
    assert.equal(db.listOpenShieldIncidents(1).length, 1);
  } finally { db.close(); fs.rmSync(directory, { recursive: true }); }
});

test('migrates an existing installation table to Guardian Lock without losing data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-sentinel-migration-'));
  const file = path.join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE installations (
    id INTEGER PRIMARY KEY, account_login TEXT NOT NULL, account_type TEXT NOT NULL,
    target_type TEXT, suspended INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_scan_at TEXT, next_scan_at TEXT
  ); INSERT INTO installations (id,account_login,account_type,created_at,updated_at) VALUES (7,'legacy','User','2026-01-01','2026-01-01');`);
  legacy.close();
  const db = openDatabase(file);
  try {
    assert.equal(db.getInstallation(7).account_login, 'legacy');
    assert.equal(db.getInstallation(7).shield_locked, 0);
    db.setShieldLocked(7, true);
    assert.equal(db.getInstallation(7).shield_locked, 1);
  } finally { db.close(); fs.rmSync(directory, { recursive: true }); }
});
