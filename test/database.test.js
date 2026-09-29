import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.js';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-db-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  const user = db.createUser({ email: 'owner@example.com', displayName: 'Owner', passwordHash: 'hash', passwordSalt: 'salt', role: 'owner' });
  return { db, user };
}

test('isolates persistent data by user and saves artifacts', () => {
  const { db, user } = fixture();
  const second = db.createUser({ email: 'member@example.com', displayName: 'Member', passwordHash: 'hash', passwordSalt: 'salt', role: 'member' });
  db.addMessage(user.id, 'user', 'Hello');
  const memory = db.addMemory(user.id, 'Prefer concise answers.');
  const task = db.addTask(user.id, { title: 'Plan', prompt: 'Make a plan' });
  db.addArtifact(user.id, { taskId: task.id, name: 'plan.md', content: '# Plan' });
  db.addEvent(user.id, 'test', 'Test event');
  assert.equal(db.listMessages(user.id)[0].content, 'Hello');
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
  db.addMessage(user.id, 'user', 'Portable message');
  const bundle = db.exportUser(user.id);
  db.close();

  const targetFixture = fixture();
  targetFixture.db.restoreUser(targetFixture.user.id, bundle);
  targetFixture.db.restoreUser(targetFixture.user.id, bundle);
  assert.equal(targetFixture.db.listMessages(targetFixture.user.id).length, 1);
  assert.equal(targetFixture.db.listMessages(targetFixture.user.id)[0].content, 'Portable message');
  targetFixture.db.close();
});
