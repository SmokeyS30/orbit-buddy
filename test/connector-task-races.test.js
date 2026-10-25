import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/database.js';
import { createSyncPgAdapter } from '../src/db/sync-pg-wrapper.mjs';
import { toolCompleteTask } from '../src/tools.js';
import { createConnectorService } from '../src/connectors.js';
import { encryptSecret, decryptSecret } from '../src/security.js';

function fixture(t, driver) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-races-'));
  if (driver === 'PostgreSQL') assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must point at disposable PostgreSQL');
  const db = driver === 'PostgreSQL' ? createSyncPgAdapter(process.env.TEST_DATABASE_URL) : openDatabase(path.join(dir, 'test.sqlite'));
  const user = db.createUser({ email: `${randomUUID()}@example.test`, displayName: 'Race test', passwordHash: 'test', passwordSalt: 'test', role: 'owner' });
  t.after(async () => { db.deleteUserAccount(user.id); await db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, user };
}

for (const driver of ['SQLite', 'PostgreSQL']) {
  test(`${driver}: task generations fence expired, cancelled, and completed workers`, (t) => {
    const { db, user } = fixture(t, driver);
    const task = db.addTask(user.id, { title: 'Race', prompt: 'Compute a result' });
    const first = db.startTask(user.id, task.id, -1000);
    assert.equal(first, 1);
    assert.equal(db.startTask(user.id, task.id), null);
    assert.equal(db.renewTaskLease(user.id, task.id, first), false);
    assert.equal(db.completeTask(user.id, task.id, first, 'expired'), false);
    assert.equal(db.failTask(user.id, task.id, first, 'expired failure', 'error'), false);
    db.recoverStaleTasks();
    const second = db.startTask(user.id, task.id);
    assert.equal(second, 2);
    assert.equal(db.renewTaskLease(user.id, task.id, first), false);
    assert.equal(db.completeTask(user.id, task.id, first, 'stale'), false);
    assert.equal(db.failTask(user.id, task.id, first, 'stale failure', 'error'), false);
    const oldLease = db.getTask(user.id, task.id).lease_expires_at;
    assert.equal(db.renewTaskLease(user.id, task.id, second, 300_000), true);
    assert.ok(db.getTask(user.id, task.id).lease_expires_at > oldLease);
    assert.equal(db.completeTask(user.id, task.id, second, 'fresh'), true);
    assert.equal(db.failTask(user.id, task.id, first, 'stale failure', 'error'), false);
    assert.equal(db.failTask(user.id, task.id, second, 'delivery failure', 'error'), false);
    assert.equal(db.completeTask(user.id, task.id, second, 'duplicate'), false);
    assert.equal(db.getTask(user.id, task.id).result, 'fresh');
    db.setTaskStatus(user.id, task.id, 'queued');
    const third = db.startTask(user.id, task.id);
    db.setTaskStatus(user.id, task.id, 'cancelled');
    assert.equal(db.renewTaskLease(user.id, task.id, third), false);
    assert.equal(db.completeTask(user.id, task.id, third, 'cancelled'), false);
    assert.equal(db.failTask(user.id, task.id, third, 'cancelled failure', 'error'), false);
    db.setTaskStatus(user.id, task.id, 'queued');
    const fourth = db.startTask(user.id, task.id);
    assert.equal(db.failTask(user.id, task.id, fourth, 'real failure', 'error'), true);
    assert.equal(db.getTask(user.id, task.id).status, 'failed');
    db.setTaskStatus(user.id, task.id, 'queued');
    const fifth = db.startTask(user.id, task.id);
    const next = new Date(Date.now() + 86_400_000).toISOString();
    assert.equal(db.completeTask(user.id, task.id, fifth, 'recurring result', 'scheduled', next), true);
    assert.equal(db.getTask(user.id, task.id).schedule_at, next);
    assert.equal(db.startTask(user.id, task.id), null, 'a stale due-task snapshot cannot claim the next future occurrence');
  });

  test(`${driver}: user completion stops future reminders and fences an active worker`, (t) => {
    const { db, user } = fixture(t, driver);
    for (const running of [false, true]) {
      const task = db.addTask(user.id, { title: running ? 'Running task' : 'Future task', prompt: 'Compute', scheduleAt: running ? null : new Date(Date.now() + 86_400_000).toISOString() });
      const attempt = running ? db.startTask(user.id, task.id) : null;
      toolCompleteTask({ title: task.title }, { db, userId: user.id });
      const completed = db.getTask(user.id, task.id);
      assert.equal(completed.status, 'completed');
      assert.equal(completed.schedule_at, null);
      assert.equal(completed.lease_expires_at, null);
      if (running) {
        assert.equal(db.completeTask(user.id, task.id, attempt, 'old result'), false);
        assert.equal(db.failTask(user.id, task.id, attempt, 'old failure', 'error'), false);
      }
      assert.equal(db.getTask(user.id, task.id).result, 'Completed via chat.');
    }
  });

  for (const action of ['disconnect', 'reconnect', 'parallel refresh', 'invalid grant after reconnect', 'invalid grant']) {
    test(`${driver}: OAuth refresh handles ${action}`, async (t) => {
      const { db, user } = fixture(t, driver);
      const key = Buffer.alloc(32, 9);
      const save = (token) => db.saveConnector(user.id, 'gmail', { accessEncrypted: encryptSecret(token, key), refreshEncrypted: encryptSecret('refresh', key), scopes: 'gmail', profile: { email: 'owner@example.test' }, expiresAt: new Date(0).toISOString() });
      save('old');
      const service = createConnectorService({ GMAIL_CLIENT_ID: 'test', GMAIL_CLIENT_SECRET: 'test' }, db, key);
      const response = Promise.withResolvers();
      t.mock.method(globalThis, 'fetch', async () => (await response.promise).clone());
      const pending = service.getValidToken(user.id, 'gmail');
      if (action === 'disconnect') db.deleteConnector(user.id, 'gmail');
      if (action.includes('reconnect')) save('replacement');
      const parallel = action === 'parallel refresh' ? service.getValidToken(user.id, 'gmail') : null;
      const invalid = action.startsWith('invalid grant');
      response.resolve(new Response(JSON.stringify(invalid ? { error: 'invalid_grant' } : { access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 }), { status: invalid ? 400 : 200 }));
      if (action === 'parallel refresh') {
        const results = await Promise.allSettled([pending, parallel]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
        const row = db.getConnector(user.id, 'gmail');
        assert.equal(decryptSecret(row.access_encrypted, key), 'fresh');
        assert.equal(decryptSecret(row.refresh_encrypted, key), 'rotated');
        assert.equal(row.scopes, 'gmail');
        assert.equal(JSON.parse(row.profile_json).email, 'owner@example.test');
      } else {
        await assert.rejects(pending, { status: invalid ? 401 : 409 });
        const row = db.getConnector(user.id, 'gmail');
        if (action.includes('reconnect')) assert.equal(decryptSecret(row.access_encrypted, key), 'replacement');
        else assert.ok(!row, 'a removed connector stays absent');
      }
    });
  }
}

test('PostgreSQL: only one replica can claim a task', async (t) => {
  const { db, user } = fixture(t, 'PostgreSQL');
  const other = createSyncPgAdapter(process.env.TEST_DATABASE_URL);
  t.after(() => other.close());
  const task = db.addTask(user.id, { title: 'Claim race', prompt: 'Compute' });
  const claims = await Promise.all([db.async.startTask(user.id, task.id), other.async.startTask(user.id, task.id)]);
  assert.deepEqual(claims.sort(), [1, null]);
});
