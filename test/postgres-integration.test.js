// PostgreSQL integration test for the sync worker-thread wrapper.
// Requires TEST_DATABASE_URL to be set. In CI, a PostgreSQL 16 service
// container provides it. Exercises: startup (no Atomics deadlock), schema,
// account create/login, reads, writes, conversations/messages, and
// persistence across close/reopen.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSyncPgAdapter } from '../src/db/sync-pg-wrapper.mjs';
import { toolDeleteGoal,toolConfirmDeleteApproval } from '../src/tools.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL;

test('PostgreSQL deletion tool requires a later explicit user turn and visible preview',async()=>{
  assert.ok(DATABASE_URL,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  await ensureSchema();
  const db=createSyncPgAdapter(DATABASE_URL);
  let userId=null;
  try{
    const user=db.createUser({email:`delete-gate-${Date.now()}-${Math.random()}@example.com`,displayName:'Delete gate',passwordHash:'test',passwordSalt:'test',role:'member'});
    userId=user.id;
    const conversation=db.createConversation(userId,'Delete gate');
    const goal=db.addGoal(userId,{title:'Private goal'});
    const first=db.addMessage(userId,conversation.id,'user','Delete Private goal');
    const context={db,userId,messageId:first.id};
    const staged=toolDeleteGoal({title:'Private goal'},context);
    assert.throws(()=>toolConfirmDeleteApproval({approvalId:staged.approvalId},context),/fresh explicit confirmation/i);
    db.addMessage(userId,conversation.id,'assistant',`Confirm deletion: ${staged.preview}`);
    const next=db.addMessage(userId,conversation.id,'user','yes, delete it');
    assert.equal(toolConfirmDeleteApproval({approvalId:staged.approvalId},{...context,messageId:next.id}).deleted,true);
    assert.equal(db.getGoal(userId,goal.id),null);
  }finally{
    if(userId)db.deleteUserAccount(userId);
    db.close();
  }
});

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
    assert.equal(db.hasAuthIdentityForUser('apple',userId),false);
    db.linkAuthIdentity('apple',`pgtest-${Date.now()}`,userId);
    assert.equal(db.hasAuthIdentityForUser('apple',userId),true);
    assert.equal(db.hasAuthIdentityForUser('other',userId),false);

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

    // 7a. Production chat hot-path batches preserve the same data contract
    // while crossing the synchronous worker only once per context stage.
    db.setSetting(`buddy_name_asked_${userId}`, '123');
    db.setWritingVoiceProfile(userId, 'Short, friendly sentences.');
    const batchedReply = db.getChatReplyContext(userId, conversationId, 24);
    assert.equal(batchedReply.conversation.id, conversationId);
    assert.equal(batchedReply.history.at(-1).id, messageId);
    assert.equal(batchedReply.messageCount,1);
    const laterMessage=db.addMessage(userId,conversationId,'user','Later PG turn');
    db.retimeMessage(userId,laterMessage.id,new Date(Date.now()+1000).toISOString());
    assert.deepEqual(db.listConversationMessagesThrough(userId,conversationId,messageId,24).map((m)=>m.id),[messageId]);
    assert.equal(db.listConversationMessages(userId,conversationId,24).length,2);
    db.setConversationSummary(userId,conversationId,'newer',100);
    db.setConversationSummary(userId,conversationId,'stale',50);
    assert.equal(db.getConversationSummary(userId,conversationId).summary,'newer');
    assert.equal(batchedReply.settings[`buddy_name_asked_${userId}`], '123');
    assert.equal(batchedReply.writingVoice.optIn, true);
    assert.equal(batchedReply.writingVoice.profile, 'Short, friendly sentences.');
    db.addFollowUp(userId, { description: 'Review the PostgreSQL plan', dueDate: '2026-12-01' });
    db.addGoal(userId, { title: 'Finish PostgreSQL validation', priority: 3 });
    db.addProject(userId, { title: 'Database speed', steps: [{ title: 'Measure context loading' }] });
    db.addPersonalDate(userId, { label: 'Database anniversary', month: 6, day: 15, type: 'anniversary' });
    const batchedModel = db.getChatModelContext(userId, 'PostgreSQL integration test note', { includePlanning: true });
    assert.equal(batchedModel.memories[0].id, memoryId);
    assert.equal(batchedModel.followUps[0].description, 'Review the PostgreSQL plan');
    assert.equal(batchedModel.goals[0].title, 'Finish PostgreSQL validation');
    assert.equal(batchedModel.projects[0].steps[0].title, 'Measure context loading');
    assert.ok(db.getMemory(userId, memoryId).last_mentioned_at, 'batched recall preserves episodic stamp');
    assert.equal(db.getChatProactiveContext(userId).personalDates[0].label, 'Database anniversary');
    // Async context reads use a separate worker response channel. Interleave
    // one with a legacy synchronous call to catch shared-buffer corruption.
    const asyncModelPending = db.async.getChatModelContext(userId, 'PostgreSQL integration test note', { includePlanning: true });
    assert.equal(db.getSetting(`buddy_name_asked_${userId}`), '123');
    const asyncModel = await asyncModelPending;
    assert.equal(asyncModel.memories[0].id, memoryId);
    assert.equal(asyncModel.projects[0].steps[0].title, 'Measure context loading');
    assert.equal((await db.async.getChatProactiveContext(userId)).personalDates[0].label, 'Database anniversary');
    await assert.rejects(db.async.methodThatDoesNotExist(), /not a function/);

    // Privacy report parity: additive schema, idempotent submission, review
    // status, and persistence across worker restart.
    const submissionId=`report-${userId}`;
    const reportInput={submissionId,kind:'response',reason:'incorrect',description:'Edited note',messageId:null,messageExcerpt:null};
    const reported=db.addReport(userId,reportInput);
    assert.equal(reported.created,true);
    assert.equal(db.addReport(userId,reportInput).created,false);
    assert.equal(db.countRecentReports(userId,new Date(Date.now()-60_000).toISOString()),1);
    assert.equal(db.getReportSubmission(userId,submissionId).id,reported.report.id);
    assert.equal(db.listReports().find((r)=>r.id===reported.report.id).reporter_name,'PG Test User');
    assert.equal(db.reportQueueSummary().find((r)=>r.status==='new').count>=1,true);
    assert.deepEqual(db.listOwnReports(userId).map((r)=>r.id),[reported.report.id]);
    assert.equal(db.updateReportStatus(reported.report.id,'reviewing','Looking into this.').status,'reviewing');
    assert.equal(db.listOwnReports(userId)[0].owner_note,'Looking into this.');
    assert.equal(db.setModerationBlocked(userId,true),true,'member moderation block works on PostgreSQL');
    assert.equal(db.getUserById(userId).disabled,1);
    assert.equal(db.getUserById(userId).moderation_blocked,1);
    assert.equal(db.setUserDisabled(userId,false),false,'generic access approval cannot clear PostgreSQL moderation block');
    assert.equal(db.getUserById(userId).disabled,1);
    assert.equal(db.setModerationBlocked(userId,false),true);
    assert.equal(db.getUserById(userId).disabled,0,'restoration keeps the password account usable');

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

    // 7c. StoreKit subscription parity: binding uniqueness, purchase intents,
    // atomic quota consumption, and retry-safe notification claims all run
    // through the same sync worker used in production.
    const appAccountToken = userId;
    const originalTransactionId = `orig-${userId}`;
    db.saveSubscription(userId, {
      productId: 'com.smokeys30.orbitbuddy.standard.monthly', status: 'active',
      expiresAt: new Date(Date.now() + 86400_000).toISOString(), appAccountToken,
      environment: 'sandbox', originalTransactionId, lastEventSignedAt: new Date().toISOString(),
    });
    assert.equal(db.getSubscription(userId).app_account_token, appAccountToken, 'subscription binding persisted');
    const intent = db.createPurchaseIntent(userId, 'com.smokeys30.orbitbuddy.pro.monthly', appAccountToken, new Date(Date.now() + 3600_000).toISOString());
    assert.equal(db.getPurchaseIntent(userId, appAccountToken, 'com.smokeys30.orbitbuddy.pro.monthly').id, intent.id, 'pending purchase intent fetched');
    assert.equal(db.completePurchaseIntent(intent.id, `txn-${userId}`), true, 'purchase intent consumed once');
    assert.equal(db.completePurchaseIntent(intent.id, `txn-duplicate-${userId}`), false, 'purchase intent cannot be replayed');
    for (let i = 1; i <= 25; i++) assert.deepEqual(db.consumeDailyUsage(userId, '2026-10-19', 25), { allowed: true, count: i });
    assert.deepEqual(db.consumeDailyUsage(userId, '2026-10-19', 25), { allowed: false, count: 25 }, 'message 26 is atomically blocked');
    const notificationId = `notification-${userId}`;
    assert.equal(db.claimNotification(notificationId), true, 'notification claimed');
    assert.equal(db.claimNotification(notificationId), false, 'concurrent duplicate rejected');
    assert.equal(db.releaseNotification(notificationId), true, 'failed claim released for retry');
    assert.equal(db.claimNotification(notificationId), true, 'released notification can retry');
    assert.equal(db.completeNotification(notificationId), true, 'successful notification completed');
    assert.equal(db.claimNotification(notificationId), false, 'completed notification remains deduped');

    // 8. Persistence: close and reopen, data must survive.
    const pendingOnClose=db.async.getSetting(`buddy_name_asked_${userId}`);
    db.close(); db = null;
    await assert.rejects(pendingOnClose,/PG worker closed/,'closing the worker rejects pending async reads');
    db2 = createSyncPgAdapter(DATABASE_URL);
    const refetched = db2.getUserByEmail(email);
    assert.ok(refetched, 'user persists after close/reopen');
    assert.equal(refetched.id, userId);
    const rememories = db2.listMemories(userId);
    assert.ok(rememories.some(m => m.id === memoryId), 'memory persists after close/reopen');
    const remsgs = db2.listMessages(userId, 100);
    assert.ok(remsgs.some(m => m.id === messageId), 'message persists after close/reopen');
    assert.equal(db2.getReportSubmission(userId,submissionId).status,'reviewing','report persists after close/reopen');
    assert.equal(db2.listOwnReports(userId)[0].owner_note,'Looking into this.','review response persists after close/reopen');
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

test('PostgreSQL: Soul core parity (migrations + versioned record + history)', async () => {
  assert.ok(DATABASE_URL, 'TEST_DATABASE_URL must be set (CI provides PostgreSQL 16 service)');
  await ensureSchema();
  const email = `pgtest-soul-${Date.now()}@example.com`;
  let db = null;
  let userId = null;
  try {
    db = createSyncPgAdapter(DATABASE_URL);
    const user = db.createUser({ email, displayName: 'PG Soul', passwordHash: 'h', passwordSalt: 's', role: 'member' });
    userId = user.id;
    // Tables must exist via the PROD migrations path (not just postgres-schema.sql).
    assert.equal(db.getSoulRecord(userId), null, 'no soul record initially');
    const saved = db.saveSoulRecord(userId, { name: 'Orbit', warmth: 3, directness: 4, playfulness: 2, formality: 1 }, 'tune:directness+1');
    assert.equal(saved.version, 1);
    assert.equal(saved.directness, 4);
    const saved2 = db.saveSoulRecord(userId, { ...saved, playfulness: 3 }, 'tune:playfulness+1');
    assert.equal(saved2.version, 2);
    const current = db.getSoulRecord(userId);
    assert.equal(current.version, 2);
    assert.equal(current.playfulness, 3);
    const history = db.listSoulHistory(userId, 10);
    assert.equal(history.length, 2, 'append-only history has both versions');
    assert.equal(history[0].version, 2, 'newest first');
    const v1 = db.getSoulHistoryVersion(userId, 1);
    assert.ok(v1, 'specific version retrievable');
    assert.equal(JSON.parse(v1.record_json).directness, 4);
  } finally {
    try {
      if (db && userId) {
        try { db.deleteDemoUser(userId); } catch {}
      }
    } finally {
      if (db) { try { db.close(); } catch {} }
    }
  }
});

test('PostgreSQL: proactive memory surfacing parity (migrations + dedup)', async () => {
  assert.ok(DATABASE_URL, 'TEST_DATABASE_URL must be set (CI provides PostgreSQL 16 service)');
  await ensureSchema();
  const email = `pgtest-pmem-${Date.now()}@example.com`;
  let db = null;
  let userId = null;
  try {
    db = createSyncPgAdapter(DATABASE_URL);
    const user = db.createUser({ email, displayName: 'PG Proactive Memory', passwordHash: 'h', passwordSalt: 's', role: 'member' });
    userId = user.id;
    // Table must exist via the PROD migrations path (not just postgres-schema.sql).
    assert.equal(db.getMemorySurfacing(userId, 'date:m1:2026-10-23'), null, 'no surfacing initially');
    assert.equal(db.getLastMemorySurfacing(userId), null);
    const row = {
      memoryId: 'm1', occurrenceKey: 'date:m1:2026-10-23', kind: 'date', via: 'proactive',
      reason: 'birthday is in 7 days (October 23)', contentSnapshot: "Mom's birthday is October 23",
      memoryCreatedAt: '2026-10-01T12:00:00.000Z',
    };
    assert.equal(db.recordMemorySurfacing(userId, row), true, 'first record stored');
    assert.equal(db.recordMemorySurfacing(userId, row), false, 'duplicate occurrence ignored');
    const got = db.getMemorySurfacing(userId, 'date:m1:2026-10-23');
    assert.ok(got, 'surfacing retrievable');
    assert.equal(got.kind, 'date');
    assert.equal(got.via, 'proactive');
    assert.equal(got.content_snapshot, "Mom's birthday is October 23");
    assert.equal(got.memory_created_at, '2026-10-01T12:00:00.000Z');
    assert.equal(db.listMemorySurfacings(userId, 10).length, 1);
    assert.equal(db.getLastMemorySurfacing(userId).occurrence_key, 'date:m1:2026-10-23');
    // Per-user isolation: another user sees nothing.
    const user2 = db.createUser({ email: `pgtest-pmem2-${Date.now()}@example.com`, displayName: 'PG PM 2', passwordHash: 'h', passwordSalt: 's', role: 'member' });
    assert.equal(db.getLastMemorySurfacing(user2.id), null, 'surfacings are per-user');
    try { db.deleteDemoUser(user2.id); } catch {}
  } finally {
    try {
      if (db && userId) {
        try { db.deleteDemoUser(userId); } catch {}
      }
    } finally {
      if (db) { try { db.close(); } catch {} }
    }
  }
});

test('PostgreSQL: account deletion removes user-scoped rows', async () => {
  assert.ok(DATABASE_URL, 'TEST_DATABASE_URL must be set (CI provides PostgreSQL 16 service)');
  await ensureSchema();
  let db = null;
  let userId = null;
  try {
    db = createSyncPgAdapter(DATABASE_URL);
    const user = db.createUser({
      email: `pgtest-delete-${Date.now()}@example.com`, displayName: 'PG Delete',
      passwordHash: 'h', passwordSalt: 's', role: 'member',
    });
    userId = user.id;
    db.addMemory(userId, 'Delete this private memory', { kind: 'fact', source: 'test' });
    db.setSetting(`delete_test_${userId}`, 'private');
    const result = db.deleteUserAccount(userId);
    assert.deepEqual(result, { deleted: true, successorId: null });
    assert.equal(db.getUserById(userId), null);
    assert.equal(db.listMemories(userId).length, 0);
    assert.equal(db.getSetting(`delete_test_${userId}`), null);
    userId = null;
  } finally {
    try { if (db && userId) db.deleteDemoUser(userId); } catch {}
    if (db) { try { db.close(); } catch {} }
  }
});

test('signup security PostgreSQL upgrades, concurrent claims and rollback preserve accounts', async () => {
  assert.ok(DATABASE_URL,'TEST_DATABASE_URL must be set');
  await ensureSchema();
  const { openPostgres } = await import('../src/db/postgres-adapter.js');
  const db=await openPostgres(DATABASE_URL);
  const suffix=Date.now()+'-'+Math.random();
  try {
    const user=await db.createUser({email:`security-${suffix}@example.com`,displayName:'Existing',passwordHash:'old',passwordSalt:'salt',role:'member'});
    const other=await db.createUser({email:`other-${suffix}@example.com`,displayName:'Other',passwordHash:'old',passwordSalt:'salt',role:'member'});
    const expiry=new Date(Date.now()+60_000).toISOString();
    await db.addSignupChallenge(suffix,'link',user.id,expiry);
    assert.equal(await db.consumeSignupChallenge(suffix,'link',other.id),false);
    assert.deepEqual((await Promise.all([db.consumeSignupChallenge(suffix,'link',user.id),db.consumeSignupChallenge(suffix,'link',user.id)])).sort(),[false,true]);
    const links=await Promise.allSettled([db.linkAuthIdentity('apple',suffix,user.id),db.linkAuthIdentity('apple',suffix,other.id)]);
    assert.equal(links.filter(r=>r.status==='fulfilled').length,1);
    const linkedUserId=(await db.getAuthIdentity('apple',suffix)).user_id;
    assert.equal(await db.hasAuthIdentityForUser('apple',user.id),linkedUserId===user.id);
    assert.equal(await db.hasAuthIdentityForUser('apple',other.id),linkedUserId===other.id);
    await db.addAppAttestKey(suffix,'public','production');
    assert.deepEqual((await Promise.all([db.advanceAppAttestCounter(suffix,0,1),db.advanceAppAttestCounter(suffix,0,2)])).sort(),[false,true]);
    await db.addSignupVerificationToken(suffix,suffix,expiry);
    await assert.rejects(db.createSignupAccount({email:user.email,displayName:'Collision',passwordHash:'new',passwordSalt:'salt',verificationHash:suffix,emailHash:suffix,automatic:true}));
    assert.ok(await db.getSignupVerificationToken(suffix,suffix),'failed insert rolls back consumption');
    await db.addPasswordResetToken(suffix,user.id,expiry);
    assert.deepEqual((await Promise.all([db.finishPasswordReset(suffix,'first','salt'),db.finishPasswordReset(suffix,'second','salt')])).sort(),[false,true]);
    assert.ok(['first','second'].includes((await db.getUserById(user.id)).password_hash));
    assert.equal((await db.getUserById(other.id)).password_hash,'old');
    await db.addAppleSignupProof('apple-'+suffix,'apple-'+suffix,'email-'+suffix,expiry);
    const appleUser=await db.createSignupAccount({email:`apple-${suffix}@example.com`,displayName:'Apple',passwordHash:'unusable-random',passwordSalt:'salt',appleProofHash:'apple-'+suffix,appleEmailHash:'email-'+suffix,automatic:true});
    assert.equal((await db.getAuthIdentity('apple','apple-'+suffix)).user_id,appleUser.id);
    assert.ok(appleUser.email_verified_at);
    await db.addAppleSignupProof('collision-'+suffix,'apple-'+suffix,'email2-'+suffix,expiry);
    await assert.rejects(db.createSignupAccount({email:`apple-collision-${suffix}@example.com`,displayName:'Collision',passwordHash:'random',passwordSalt:'salt',appleProofHash:'collision-'+suffix,appleEmailHash:'email2-'+suffix,automatic:true}));
    assert.ok(await db.getAppleSignupProof('collision-'+suffix,'email2-'+suffix),'identity collision rolls back proof consumption');
    assert.equal(await db.getUserByEmail(`apple-collision-${suffix}@example.com`),null,'identity collision rolls back account creation');
    await db.setSignupPause(true);
    await assert.rejects(db.createSignupAccount({email:`paused-${suffix}@example.com`,displayName:'Paused',passwordHash:'random',passwordSalt:'salt',automatic:true}));
    await db.setSignupPause(false);
    await db.deleteUserAccount(appleUser.id);
    await db.deleteUserAccount(user.id);await db.deleteUserAccount(other.id);
  } finally { await db.close(); }
});
