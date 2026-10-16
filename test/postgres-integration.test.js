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

    // 7b. W1 parity: messageExists / retimeMessage / deleteMessageTurn must
    // exist on the Postgres adapter (they were missing; regenerate and
    // per-message delete threw in production while working on SQLite).
    assert.equal(db.messageExists(messageId), true, 'messageExists true for a real message');
    assert.equal(db.messageExists('00000000-0000-0000-0000-000000000000'), false, 'messageExists false for unknown id');
    const reply = db.addMessage(userId, conversationId, 'assistant', 'Hello back');
    assert.ok(db.retimeMessage(userId, reply.id, new Date('2026-01-02T03:04:05.000Z').toISOString()), 'retimeMessage updates created_at');
    const refetched_reply = db.getMessage(userId, reply.id);
    assert.equal(new Date(refetched_reply.created_at).toISOString().slice(0, 10), '2026-01-02', 'retimed created_at persisted');
    // Fresh user+assistant pair in natural order for the turn-delete check.
    // Explicit distinct timestamps: same-millisecond inserts would make the
    // created_at ASC, id ASC tiebreak fall back to random UUID order and the
    // turn pairing would be nondeterministic.
    const t1 = new Date('2026-03-04T10:00:00.000Z').toISOString();
    const t2 = new Date('2026-03-04T10:00:01.000Z').toISOString();
    const u2 = db.addMessage(userId, conversationId, 'user', 'Second question');
    const a2 = db.addMessage(userId, conversationId, 'assistant', 'Second answer');
    assert.ok(db.retimeMessage(userId, u2.id, t1) && db.retimeMessage(userId, a2.id, t2), 'retimed pair into deterministic order');
    const deletedIds = db.deleteMessageTurn(userId, a2.id);
    assert.ok(Array.isArray(deletedIds) && deletedIds.includes(a2.id) && deletedIds.includes(u2.id), 'deleteMessageTurn removes the whole turn');
    assert.equal(db.messageExists(a2.id), false, 'assistant reply gone after turn delete');
    assert.equal(db.messageExists(u2.id), false, 'user message gone after turn delete');
    assert.equal(db.deleteMessageTurn(userId, '00000000-0000-0000-0000-000000000000'), null, 'deleteMessageTurn null for unknown id');

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

test('PostgreSQL: Memory v2 auto-recall parity (auto-save + contradiction guard)', async () => {
  assert.ok(DATABASE_URL, 'TEST_DATABASE_URL must be set (CI provides PostgreSQL 16 service)');
  await ensureSchema();
  const email = `pgtest-memv2-${Date.now()}@example.com`;
  let db = null;
  let userId = null;
  const memoryIds = [];
  try {
    db = createSyncPgAdapter(DATABASE_URL);
    const user = db.createUser({ email, displayName: 'PG Memv2', passwordHash: 'h', passwordSalt: 's', role: 'member' });
    userId = user.id;
    // Fresh suggestion stays pending with the real window.
    db.addMemorySuggestion(userId, 'PG fresh suggestion', { kind: 'fact' });
    assert.equal(db.autoApproveMemorySuggestions(userId, 15), 0, 'fresh suggestion not auto-saved');
    // window=0 auto-saves with source=auto-suggestion.
    assert.equal(db.autoApproveMemorySuggestions(userId, 0), 1, 'stale suggestion auto-saved');
    const saved = db.listMemories(userId);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].source, 'auto-suggestion');
    memoryIds.push(saved[0].id);
    // Contradictory suggestion is never auto-saved.
    db.addMemory(userId, 'Likes pepperoni pizza.', { kind: 'preference', source: 'user' });
    memoryIds.push(db.listMemories(userId).find((m) => m.content.includes('pepperoni') && m.source === 'user').id);
    db.addMemorySuggestion(userId, "Doesn't like pepperoni pizza.", { kind: 'preference' });
    assert.equal(db.autoApproveMemorySuggestions(userId, 0), 0, 'contradiction stays pending');
    assert.equal(db.listMemorySuggestions(userId).length, 1, 'contradictory suggestion still pending');
  } finally {
    try {
      if (db && userId) {
        for (const id of memoryIds) { try { db.deleteMemory(userId, id); } catch {} }
        try { db.deleteDemoUser(userId); } catch {}
      }
    } finally {
      if (db) { try { db.close(); } catch {} }
    }
  }
});

test('PostgreSQL: Teach Orbit taught_knowledge parity (table + CRUD + isolation)', async () => {
  assert.ok(DATABASE_URL, 'TEST_DATABASE_URL must be set (CI provides PostgreSQL 16 service)');
  await ensureSchema();
  const email = `pgtest-teach-${Date.now()}@example.com`;
  const email2 = `pgtest-teach2-${Date.now()}@example.com`;
  let db = null;
  let userId = null;
  let userId2 = null;
  try {
    db = createSyncPgAdapter(DATABASE_URL);
    const user = db.createUser({ email, displayName: 'PG Teach', passwordHash: 'h', passwordSalt: 's', role: 'member' });
    const user2 = db.createUser({ email: email2, displayName: 'PG Teach 2', passwordHash: 'h', passwordSalt: 's', role: 'member' });
    userId = user.id; userId2 = user2.id;
    // The taught_knowledge table must exist via the schema AND the adapter's
    // self-migration array (production only runs the migrations array).
    const row = db.addTaughtKnowledge(userId, 'The garage code is 4412.', { source: 'chat' });
    assert.ok(row && row.id, 'taught item saved');
    assert.equal(row.source, 'chat');
    const up = db.addTaughtKnowledge(userId, 'Launch notes.', { source: 'upload', title: 'alpha.txt', filename: 'alpha.txt', mimeType: 'text/plain' });
    assert.equal(up.title, 'alpha.txt', 'upload metadata preserved');
    assert.equal(db.listTaughtKnowledge(userId).length, 2);
    assert.equal(db.listTaughtKnowledge(userId2).length, 0, 'per-user isolation');
    const relevant = db.listRelevantTaughtKnowledge(userId, 'garage code');
    assert.ok(relevant.length >= 1 && relevant[0].content.includes('4412'), 'relevance ranking works');
    assert.ok(db.deleteTaughtKnowledge(userId, row.id), 'delete works');
    assert.equal(db.listTaughtKnowledge(userId).length, 1);
    assert.equal(db.deleteTaughtKnowledge(userId2, up.id), false, 'cross-user delete refused');
  } finally {
    try {
      if (db && userId) { for (const t of db.listTaughtKnowledge(userId)) { try { db.deleteTaughtKnowledge(userId, t.id); } catch {} } }
    } catch {}
    try { if (db && userId) { try { db.deleteDemoUser(userId); } catch {} } } catch {}
    try { if (db && userId2) { try { db.deleteDemoUser(userId2); } catch {} } } catch {}
    finally { if (db) { try { db.close(); } catch {} } }
  }
});
