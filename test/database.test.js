import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.js';

test('persists messages, memories, tasks, and events', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-db-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  db.addMessage('user', 'Hello');
  const memory = db.addMemory('Prefer concise answers.');
  const task = db.addTask({ title: 'Plan', prompt: 'Make a plan' });
  db.addEvent('test', 'Test event');
  assert.equal(db.listMessages()[0].content, 'Hello');
  assert.equal(db.listMemories()[0].id, memory.id);
  assert.equal(db.dueTasks()[0].id, task.id);
  assert.equal(db.listEvents()[0].type, 'test');
  assert.equal(db.deleteMemory(memory.id), true);
  db.close();
});

test('external tasks wait for explicit approval', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-approval-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  const task = db.addTask({ title: 'Send message', prompt: 'Draft it', risk: 'external' });
  assert.equal(task.status, 'waiting_approval');
  assert.equal(db.dueTasks().length, 0);
  db.close();
});
