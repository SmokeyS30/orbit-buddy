import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.js';
import { DatabaseSync } from 'node:sqlite';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-db-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  const user = db.createUser({ email: 'owner@example.com', displayName: 'Owner', passwordHash: 'hash', passwordSalt: 'salt', role: 'owner' });
  return { db, user };
}

test('isolates persistent data by user and saves artifacts', () => {
  const { db, user } = fixture();
  const second = db.createUser({ email: 'member@example.com', displayName: 'Member', passwordHash: 'hash', passwordSalt: 'salt', role: 'member' });
  const convo = db.ensureDefaultConversation(user.id);
  db.addMessage(user.id, convo.id, 'user', 'Hello');
  const memory = db.addMemory(user.id, 'Prefer concise answers.');
  const task = db.addTask(user.id, { title: 'Plan', prompt: 'Make a plan' });
  db.addArtifact(user.id, { taskId: task.id, name: 'plan.md', content: '# Plan' });
  db.addEvent(user.id, 'test', 'Test event');
  assert.equal(db.listConversationMessages(user.id, convo.id)[0].content, 'Hello');
  assert.equal(db.listMemories(user.id)[0].id, memory.id);
  assert.equal(db.listTasks(user.id)[0].id, task.id);
  assert.equal(db.listArtifacts(user.id)[0].name, 'plan.md');
  assert.equal(db.listEvents(user.id)[0].type, 'test');
  assert.deepEqual(db.listMessages(second.id), []);
  assert.equal(db.deleteMemory(user.id, memory.id), true);
  db.close();
});

test('external tasks wait for approval and emergency state persists', () => {
  const { db, user } = fixture();
  const task = db.addTask(user.id, { title: 'Send message', prompt: 'Draft it', risk: 'external' });
  assert.equal(task.status, 'waiting_approval');
  assert.equal(db.dueTasks().length, 0);
  db.setSetting('paused', '1');
  assert.equal(db.getSetting('paused'), '1');
  db.close();
});

test('exports and non-destructively restores a user bundle', () => {
  const { db, user } = fixture();
  const portableConvo = db.ensureDefaultConversation(user.id);
  db.addMessage(user.id, portableConvo.id, 'user', 'Portable message');
  const bundle = db.exportUser(user.id);
  db.close();

  const targetFixture = fixture();
  targetFixture.db.restoreUser(targetFixture.user.id, bundle);
  targetFixture.db.restoreUser(targetFixture.user.id, bundle);
  assert.equal(targetFixture.db.listMessages(targetFixture.user.id).length, 1);
  assert.equal(targetFixture.db.listMessages(targetFixture.user.id)[0].content, 'Portable message');
  targetFixture.db.close();
});

test('conversations isolate threads and deleting one removes its messages', () => {
  const { db, user } = fixture();
  const general = db.ensureDefaultConversation(user.id);
  assert.equal(general.title, 'General');
  assert.equal(db.ensureDefaultConversation(user.id).id, general.id);
  const side = db.createConversation(user.id, 'Side quest');
  db.addMessage(user.id, general.id, 'user', 'In general');
  db.addMessage(user.id, side.id, 'user', 'On the side');
  assert.equal(db.listConversationMessages(user.id, general.id).length, 1);
  assert.equal(db.listConversationMessages(user.id, side.id)[0].content, 'On the side');
  assert.equal(db.listConversations(user.id).length, 2);
  assert.equal(db.deleteConversation(user.id, side.id), true);
  assert.equal(db.listConversations(user.id).length, 1);
  assert.equal(db.listConversationMessages(user.id, side.id).length, 0);
  assert.equal(db.listConversationMessages(user.id, general.id).length, 1);
  assert.equal(db.deleteConversation(user.id, 'nope'), false);
  db.close();
});

test('pre-thread messages are adopted into a General conversation on open', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-db-'));
  const legacyPath = path.join(directory, 'legacy.sqlite');
  // simulate a v0.1 database: no conversations table, messages without conversation_id
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, display_name TEXT, password_hash TEXT, password_salt TEXT, role TEXT, disabled INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, user_id TEXT, role TEXT, content TEXT, created_at TEXT);`);
  const uid = 'user-1';
  legacy.exec(`INSERT INTO users VALUES ('${uid}','a@b.c','Ab','h','s','owner',0,'t','t')`);
  legacy.exec(`INSERT INTO messages VALUES ('m1','${uid}','user','old hello','t')`);
  legacy.close();
  const db = openDatabase(legacyPath);
  const convos = db.listConversations(uid);
  assert.equal(convos.length, 1);
  assert.equal(convos[0].title, 'General');
  const msgs = db.listConversationMessages(uid, convos[0].id);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].content, 'old hello');
  db.close();
});
