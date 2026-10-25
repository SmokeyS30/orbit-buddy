import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { openDatabase } from '../src/database.js';
import { openPostgres } from '../src/db/postgres-adapter.js';

const expiry = () => new Date(Date.now() + 60_000).toISOString();
const registration = (endpoint) => ({ endpoint, keys: { p256dh: 'synthetic-key', auth: 'synthetic-auth' } });
const account = (db, email, role = 'member') => db.createUser({
  email, displayName: 'Synthetic', passwordHash: 'synthetic', passwordSalt: 'synthetic', role,
});
const session = (db, userId, tokenHash) => db.createSession({
  tokenHash, userId, csrfToken: 'synthetic', expiresAt: expiry(), userAgent: 'synthetic',
});

async function waitForNoPgSessions(admin, databaseName) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const active = await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [databaseName]);
    if (active.rowCount === 0) return;
    assert.ok(Date.now() < deadline, `temporary database ${databaseName} still has open sessions`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('SQLite migrates old push tables without breaking positional writers; bindings follow the current session', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-push-ownership-'));
  const file = path.join(directory, 'orbit.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE push_subscriptions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE apns_device_tokens (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_token TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'ios',
      apns_environment TEXT NOT NULL DEFAULT 'production', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(user_id,device_token)
    );
  `);
  old.close();
  let db;
  try {
    db = openDatabase(file);
    db.close();
    db = openDatabase(file); // repeat migration
    const a = account(db, 'push-a@example.test', 'owner');
    const b = account(db, 'push-b@example.test');
    session(db, a.id, 'session-a'); session(db, b.id, 'session-b');
    const raw = new DatabaseSync(file);
    const token = 'ab'.repeat(32);
    const endpoint = 'https://push.example.test/device';
    try {
      assert.equal(raw.prepare('PRAGMA table_info(push_subscriptions)').all().length, 6);
      assert.equal(raw.prepare('PRAGMA table_info(apns_device_tokens)').all().length, 7);
      // These exact positional writes are made by the old server binary.
      raw.prepare('INSERT INTO push_subscriptions VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), a.id, 'https://push.example.test/legacy', 'key', 'auth', expiry());
      raw.prepare('INSERT INTO apns_device_tokens VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), a.id, 'cd'.repeat(32), 'ios', 'production', expiry(), expiry());
    } finally { raw.close(); }
    assert.equal(db.listPush(a.id).length, 0, 'legacy registrations have no live session binding');
    assert.equal(db.listApnsTokens(a.id).length, 0);
    assert.throws(() => db.savePush(a.id, registration(endpoint), 'missing-session'));
    assert.throws(() => db.saveApnsToken(a.id, token, 'missing-session'));
    assert.equal(db.listPush(a.id).length, 0);

    db.savePush(a.id, registration(endpoint), 'session-a');
    db.saveApnsToken(a.id, token, 'session-a');
    const oldWeb = db.listPush(a.id)[0];
    assert.equal(db.isPushRegistrationCurrent(a.id, endpoint, 'session-a'), true);
    assert.equal(db.isApnsRegistrationCurrent(a.id, token, 'session-a'), true);
    db.savePush(b.id, registration(endpoint), 'session-b');
    db.saveApnsToken(b.id, token, 'session-b');
    assert.equal(db.listPush(a.id).length, 0);
    assert.equal(db.listApnsTokens(a.id).length, 0);
    assert.equal(db.listPush(b.id).length, 1);
    assert.equal(db.listApnsTokens(b.id).length, 1);
    const mixedWriter = new DatabaseSync(file);
    try {
      mixedWriter.prepare('INSERT INTO apns_device_tokens VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), a.id, token, 'ios', 'production', expiry(), expiry());
    } finally { mixedWriter.close(); }
    assert.equal(db.listApnsTokens(b.id).length, 0, 'an old writer creating an ambiguous token fails closed');
    db.saveApnsToken(b.id, token, 'session-b');
    assert.equal(db.listApnsTokens(b.id).length, 1, 'new registration removes stale physical owners');
    db.setUserDisabled(b.id, true);
    assert.equal(db.listPush(b.id).length, 0, 'disabled account cannot receive web push');
    assert.equal(db.listApnsTokens(b.id).length, 0, 'disabled account cannot receive native push');
    assert.throws(() => db.saveApnsToken(b.id, token, 'session-b'));
    db.setUserDisabled(b.id, false);
    db.setModerationBlocked(b.id, true);
    assert.equal(db.listPush(b.id).length, 0, 'moderation block suppresses push');
    assert.equal(db.listApnsTokens(b.id).length, 0);
    db.setModerationBlocked(b.id, false);
    assert.equal(db.deletePushById(oldWeb.id, 'session-a'), false, 'old failure cannot remove B registration');
    assert.equal(db.deleteApnsToken(token, 'session-a'), false, 'old failure cannot remove B device');
    assert.equal(db.listPush(b.id).length, 1);
    assert.equal(db.listApnsTokens(b.id).length, 1);

    db.deleteSession('session-b');
    assert.equal(db.listPush(b.id).length, 0, 'logout prevents further server selection');
    assert.equal(db.listApnsTokens(b.id).length, 0);
    assert.equal(db.isPushRegistrationCurrent(b.id, endpoint, 'session-b'), false);
    assert.equal(db.isApnsRegistrationCurrent(b.id, token, 'session-b'), false);
    session(db, b.id, 'short-session');
    db.savePush(b.id, registration(endpoint), 'short-session');
    db.saveApnsToken(b.id, token, 'short-session');
    const expired = new DatabaseSync(file);
    try { expired.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?')
      .run('2000-01-01T00:00:00.000Z', 'short-session'); }
    finally { expired.close(); }
    assert.equal(db.listPush(b.id).length, 0, 'expired session is inert without pruning');
    assert.equal(db.listApnsTokens(b.id).length, 0);
  } finally { db?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('PostgreSQL migrates old schema twice and serializes concurrent device ownership', async () => {
  const baseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(baseUrl, 'TEST_DATABASE_URL must point to disposable PostgreSQL');
  const name = `orbit_push_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const targetUrl = new URL(baseUrl); targetUrl.pathname = `/${name}`;
  const ssl = targetUrl.searchParams.get('sslmode') === 'disable' ? false : true;
  const admin = new pg.Pool({ connectionString: baseUrl, ssl });
  let dbA, dbB, created = false;
  try {
    await admin.query(`CREATE DATABASE ${name}`); created = true;
    const setup = new pg.Pool({ connectionString: targetUrl.toString(), ssl });
    try {
      // Start from the pre-change schema, then exercise the production migration.
      const schema = fs.readFileSync(new URL('../src/db/postgres-schema.sql', import.meta.url), 'utf8')
        .replace(/CREATE TABLE IF NOT EXISTS (?:push_session_bindings|apns_session_bindings) \([\s\S]*?\);\s*/g, '');
      for (const statement of schema.split(';').map((part) => part.trim()).filter(Boolean)) {
        await setup.query(statement);
      }
      const oldColumns = await setup.query(`SELECT table_name,count(*)::int AS n FROM information_schema.columns
        WHERE table_schema='public' AND table_name IN ('push_subscriptions','apns_device_tokens') GROUP BY table_name`);
      assert.deepEqual(Object.fromEntries(oldColumns.rows.map((row) => [row.table_name, row.n])),
        { push_subscriptions: 6, apns_device_tokens: 7 });
    } finally { await setup.end(); }
    dbA = await openPostgres(targetUrl.toString());
    dbB = await openPostgres(targetUrl.toString()); // migration repeats on a second replica
    const a = await account(dbA, 'push-a@example.test', 'owner');
    const b = await account(dbB, 'push-b@example.test');
    await session(dbA, a.id, 'session-a'); await session(dbB, b.id, 'session-b');
    const token = 'ef'.repeat(32);
    const endpoint = 'https://push.example.test/device';
    const oldWriter = new pg.Pool({ connectionString: targetUrl.toString(), ssl });
    try {
      await oldWriter.query('INSERT INTO push_subscriptions VALUES($1,$2,$3,$4,$5,$6)',
        [randomUUID(), a.id, 'https://push.example.test/legacy', 'key', 'auth', expiry()]);
      await oldWriter.query('INSERT INTO apns_device_tokens VALUES($1,$2,$3,$4,$5,$6,$7)',
        [randomUUID(), a.id, 'cd'.repeat(32), 'ios', 'production', expiry(), expiry()]);
    } finally { await oldWriter.end(); }
    assert.equal((await dbA.listPush(a.id)).length, 0);
    assert.equal((await dbA.listApnsTokens(a.id)).length, 0);
    await assert.rejects(dbA.savePush(a.id, registration(endpoint), 'missing-session'));
    await assert.rejects(dbA.saveApnsToken(a.id, token, 'missing-session'));

    await Promise.all([
      dbA.savePush(a.id, registration(endpoint), 'session-a'),
      dbB.savePush(b.id, registration(endpoint), 'session-b'),
    ]);
    await Promise.all([
      dbA.saveApnsToken(a.id, token, 'session-a'),
      dbB.saveApnsToken(b.id, token, 'session-b'),
    ]);
    const aWeb = await dbA.listPush(a.id), bWeb = await dbB.listPush(b.id);
    const aApns = await dbA.listApnsTokens(a.id), bApns = await dbB.listApnsTokens(b.id);
    assert.equal(aWeb.length + bWeb.length, 1, 'one current web endpoint owner');
    assert.equal(aApns.length + bApns.length, 1, 'one current APNs device owner');
    const winner = aWeb.length ? a : b;
    const winnerSession = winner.id === a.id ? 'session-a' : 'session-b';
    const loserSession = winner.id === a.id ? 'session-b' : 'session-a';
    assert.equal(await dbA.deletePushById((aWeb[0] || bWeb[0]).id, loserSession), false);
    assert.equal((await dbA.listPush(winner.id)).length, 1);
    const apnsWinner = aApns.length ? a : b;
    const apnsLoserSession = apnsWinner.id === a.id ? 'session-b' : 'session-a';
    assert.equal(await dbA.deleteApnsToken(token, apnsLoserSession), false);
    assert.equal((await dbA.listApnsTokens(apnsWinner.id)).length, 1);
    const oldWriterAgain = new pg.Pool({ connectionString: targetUrl.toString(), ssl });
    try {
      await oldWriterAgain.query('INSERT INTO apns_device_tokens VALUES($1,$2,$3,$4,$5,$6,$7)',
        [randomUUID(), apnsWinner.id === a.id ? b.id : a.id, token, 'ios', 'production', expiry(), expiry()]);
    } finally { await oldWriterAgain.end(); }
    assert.equal((await dbA.listApnsTokens(apnsWinner.id)).length, 0, 'old writer ambiguity fails closed');
    await dbA.saveApnsToken(apnsWinner.id, token, apnsWinner.id === a.id ? 'session-a' : 'session-b');
    assert.equal((await dbA.listApnsTokens(apnsWinner.id)).length, 1);
    await dbA.run('UPDATE users SET disabled=1 WHERE id IN (?,?)', a.id, b.id);
    assert.equal((await dbA.listPush(winner.id)).length, 0);
    assert.equal((await dbA.listApnsTokens(apnsWinner.id)).length, 0);
    await dbA.run('UPDATE users SET disabled=0,moderation_blocked=1 WHERE id IN (?,?)', a.id, b.id);
    assert.equal((await dbA.listPush(winner.id)).length, 0);
    assert.equal((await dbA.listApnsTokens(apnsWinner.id)).length, 0);
    await dbA.run('UPDATE users SET moderation_blocked=0 WHERE id IN (?,?)', a.id, b.id);
    await dbA.deleteSession(winnerSession);
    await dbA.deleteSession(apnsWinner.id === a.id ? 'session-a' : 'session-b');
    assert.equal((await dbA.listPush(winner.id)).length, 0);
    assert.equal((await dbA.listApnsTokens(apnsWinner.id)).length, 0);
  } finally {
    await dbA?.close(); await dbB?.close();
    if (created) {
      await waitForNoPgSessions(admin, name);
      await admin.query(`DROP DATABASE ${name}`);
    }
    await admin.end();
  }
});
