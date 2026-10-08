// PostgreSQL integration test for the sync worker-thread wrapper.
// Requires TEST_DATABASE_URL to be set; skips otherwise (e.g. in CI without PG).
// Exercises: startup (no Atomics deadlock), account create/login, reads,
// writes, and persistence across close/reopen.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncPgAdapter } from '../src/db/sync-pg-wrapper.mjs';

const DATABASE_URL = process.env.TEST_DATABASE_URL;

test('PostgreSQL sync wrapper: startup, CRUD, and persistence', { skip: !DATABASE_URL }, async () => {
  // 1. Startup — must not deadlock (regression test for the Atomics.wait /
  // 'message' event deadlock that caused "PG worker failed to start").
  const db = createSyncPgAdapter(DATABASE_URL);
  assert.ok(db, 'adapter created without deadlock');

  // 2. Write: create a user record.
  const email = `pgtest-${Date.now()}@example.com`;
  const user = db.createUser({
    email,
    displayName: 'PG Test User',
    passwordHash: 'test-hash',
    passwordSalt: 'test-salt',
    role: 'member',
  });
  assert.ok(user.id, 'user created with id');
  assert.equal(user.email, email);

  // 3. Read: fetch the user back.
  const fetched = db.getUserByEmail(email);
  assert.ok(fetched, 'user fetched by email');
  assert.equal(fetched.id, user.id);
  assert.equal(fetched.displayName, 'PG Test User');

  // 4. Write: store a memory/note for the user.
  const memory = db.addMemory(user.id, 'PostgreSQL integration test note', { kind: 'note' });
  assert.ok(memory.id, 'memory created');

  // 5. Read: list memories.
  const memories = db.listMemories(user.id);
  assert.ok(Array.isArray(memories), 'memories listed');
  assert.ok(memories.some(m => m.id === memory.id), 'created memory found');

  // 6. Login flow: verify password check path works.
  const loginUser = db.getUserByEmail(email);
  assert.equal(loginUser.passwordHash, 'test-hash', 'password hash readable for login');

  // 7. Persistence: close and reopen, data must survive.
  db.close();
  const db2 = createSyncPgAdapter(DATABASE_URL);
  const refetched = db2.getUserByEmail(email);
  assert.ok(refetched, 'user persists after close/reopen');
  assert.equal(refetched.id, user.id);
  const rememories = db2.listMemories(user.id);
  assert.ok(rememories.some(m => m.id === memory.id), 'memory persists after close/reopen');

  // Cleanup
  db2.deleteDemoUser(user.id);
  db2.close();
});

test('PostgreSQL sync wrapper: fails fast with bad connection string', async () => {
  assert.throws(
    () => createSyncPgAdapter('postgresql://invalid:invalid@127.0.0.1:1/nodb'),
    /PG worker failed to start/,
    'bad connection string throws clear error (not hang)'
  );
});
