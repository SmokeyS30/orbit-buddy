// PostgreSQL integration test for the sync worker-thread wrapper.
// Requires TEST_DATABASE_URL to be set. In CI, a PostgreSQL 16 service
// container provides it. Exercises: startup (no Atomics deadlock), schema,
// account create/login, reads, writes, conversations/messages, and
// persistence across close/reopen.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSyncPgAdapter } from '../src/db/sync-pg-wrapper.mjs';

const DATABASE_URL = process.env.TEST_DATABASE_URL;

// Apply schema idempotently before tests. Uses a direct pg Pool (not the
// sync wrapper) so schema setup doesn't depend on the code under test.
async function ensureSchema() {
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('sslmode=disable') ? false : true,
  });
  try {
    const schema = readFileSync(new URL('../src/db/postgres-schema.sql', import.meta.url), 'utf8');
    // Split on semicolons; schema uses CREATE TABLE IF NOT EXISTS etc.
    const statements = schema.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of statements) {
      await pool.query(stmt);
    }
  } finally {
    await pool.end();
  }
}

test('PostgreSQL sync wrapper: startup, CRUD, and persistence', async () => {
  assert.ok(DATABASE_URL, 'TEST_DATABASE_URL must be set (CI provides PostgreSQL 16 service)');
  await ensureSchema();

  let db = null;
  let db2 = null;
  const email = `pgtest-${Date.now()}@example.com`;
  let userId = null;
  let memoryId = null;
  let conversationId = null;
  let messageId = null;

  try {
    // 1. Startup — must not deadlock (regression test for the Atomics.wait /
    // 'message' event deadlock that caused "PG worker failed to start").
    db = createSyncPgAdapter(DATABASE_URL);
    assert.ok(db, 'adapter created without deadlock');

    // 2. Write: create a user record.
    const user = db.createUser({
      email,
      displayName: 'PG Test User',
      passwordHash: 'test-hash',
      passwordSalt: 'test-salt',
      role: 'member',
    });
    assert.ok(user.id, 'user created with id');
    assert.equal(user.email, email);
    userId = user.id;

    // 3. Read: fetch the user back. DB returns snake_case fields.
    const fetched = db.getUserByEmail(email);
    assert.ok(fetched, 'user fetched by email');
    assert.equal(fetched.id, userId);
    assert.equal(fetched.display_name, 'PG Test User');

    // 4. Password-hash read path (used by login).
    const loginUser = db.getUserByEmail(email);
    assert.equal(loginUser.password_hash, 'test-hash', 'password hash readable for login');

    // 5. Write: store a memory for the user.
    const memory = db.addMemory(userId, 'PostgreSQL integration test note', { kind: 'note' });
    assert.ok(memory.id, 'memory created');
    memoryId = memory.id;

    // 6. Read: list memories.
    const memories = db.listMemories(userId);
    assert.ok(Array.isArray(memories), 'memories listed');
    assert.ok(memories.some(m => m.id === memoryId), 'created memory found');

    // 7. Conversation + message create/read.
    const convo = db.createConversation(userId, 'PG Test Conversation');
    assert.ok(convo.id, 'conversation created');
    conversationId = convo.id;
    const msg = db.addMessage(userId, conversationId, 'user', 'Hello PG');
    assert.ok(msg.id, 'message created');
    messageId = msg.id;
    const messages = db.listMessages(userId, 100);
    assert.ok(messages.some(m => m.id === messageId), 'message found');

    // 8. Persistence: close and reopen, data must survive.
    db.close(); db = null;
    db2 = createSyncPgAdapter(DATABASE_URL);
    const refetched = db2.getUserByEmail(email);
    assert.ok(refetched, 'user persists after close/reopen');
    assert.equal(refetched.id, userId);
    const rememories = db2.listMemories(userId);
    assert.ok(rememories.some(m => m.id === memoryId), 'memory persists after close/reopen');
    const remsgs = db2.listMessages(userId, 100);
    assert.ok(remsgs.some(m => m.id === messageId), 'message persists after close/reopen');
  } finally {
    // Reliable cleanup: a failed assertion must not leave workers running
    // or test records behind.
    try {
      const cleanupDb = db2 || db;
      if (cleanupDb && userId) {
        try { cleanupDb.deleteConversation(userId, conversationId); } catch {}
        try { cleanupDb.deleteMemory(userId, memoryId); } catch {}
        try { cleanupDb.deleteDemoUser(userId); } catch {}
      }
    } finally {
      if (db2) { try { db2.close(); } catch {} db2 = null; }
      if (db) { try { db.close(); } catch {} db = null; }
    }
  }
});

test('PostgreSQL sync wrapper: fails fast with bad connection string', async () => {
  // Must throw promptly, not hang for 30s. readyTimeoutMs=3000 in the
  // connection string makes the wrapper fail fast.
  const start = Date.now();
  assert.throws(
    () => createSyncPgAdapter('postgresql://invalid:invalid@127.0.0.1:1/nodb?readyTimeoutMs=3000'),
    /PG worker failed to start/,
    'bad connection string throws clear error (not hang)'
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 15000, `failed fast in ${elapsed}ms (< 15s)`);
});
