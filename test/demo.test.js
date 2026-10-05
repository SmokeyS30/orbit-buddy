import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDemoData, isDemoUser, demoCapReached, demoMessageCount, cleanupExpiredDemos, DEMO_MESSAGE_CAP } from '../src/demo.js';
import { openDatabase } from '../src/database.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-demo-test-'));
  return openDatabase(path.join(dir, 'test.db'), { encryptionKey: 'test-key-12345678901234567890123456789012' });
}

test('demo user creation and detection', () => {
  const db = tempDb();
  const user = db.createDemoUser();
  assert.ok(user.id);
  assert.equal(user.is_demo, 1);
  assert.ok(isDemoUser(user));
  assert.ok(!isDemoUser({ is_demo: 0 }));
  assert.ok(!isDemoUser(null));
  db.close();
});

test('demo data seeding creates memories, goals, tasks, and messages', () => {
  const db = tempDb();
  const user = db.createDemoUser();
  seedDemoData(db, user.id);

  const memories = db.listMemories(user.id);
  assert.ok(memories.length >= 4, `expected >=4 memories, got ${memories.length}`);

  const goals = db.listGoals(user.id);
  assert.ok(goals.length >= 2, `expected >=2 goals, got ${goals.length}`);

  const tasks = db.listTasks(user.id);
  assert.ok(tasks.length >= 2, `expected >=2 tasks, got ${tasks.length}`);

  const convo = db.ensureDefaultConversation(user.id);
  const messages = db.listConversationMessages(user.id, convo.id);
  assert.ok(messages.length >= 4, `expected >=4 starter messages, got ${messages.length}`);
  db.close();
});

test('demo message cap counts user messages excluding starters', () => {
  const db = tempDb();
  const user = db.createDemoUser();
  seedDemoData(db, user.id);

  // Starter has 2 user messages; cap should not be reached yet
  assert.equal(demoMessageCount(db, user.id), 0);
  assert.equal(demoCapReached(db, user.id), false);

  // Simulate reaching the cap
  const convo = db.ensureDefaultConversation(user.id);
  for (let i = 0; i < DEMO_MESSAGE_CAP; i++) {
    db.addMessage(user.id, convo.id, 'user', `Test message ${i}`);
  }
  assert.equal(demoMessageCount(db, user.id), DEMO_MESSAGE_CAP);
  assert.equal(demoCapReached(db, user.id), true);
  db.close();
});

test('expired demo cleanup removes old demo users', () => {
  const db = tempDb();
  const user = db.createDemoUser();
  seedDemoData(db, user.id);

  // Not expired yet (1 hour default)
  assert.equal(cleanupExpiredDemos(db), 0);
  assert.ok(db.getUserById(user.id));

  // Force expiry with 0ms max age
  const expired = db.listExpiredDemoUsers(0);
  assert.equal(expired.length, 1);
  db.deleteDemoUser(user.id);
  assert.equal(db.getUserById(user.id), undefined);
  db.close();
});

test('demo users cannot be confused with regular users', () => {
  const db = tempDb();
  const demo = db.createDemoUser();
  // Regular user creation still works and is_demo defaults to 0
  const regular = db.createUser({ email: 'real@example.com', displayName: 'Real', passwordHash: 'h', passwordSalt: 's', role: 'member' });
  assert.equal(regular.is_demo, 0);
  assert.ok(!isDemoUser(regular));
  db.close();
});
