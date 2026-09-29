import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  const db = new DatabaseSync(filePath);
  fs.chmodSync(filePath, 0o600);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      risk TEXT NOT NULL CHECK(risk IN ('internal', 'external')),
      schedule_at TEXT,
      recurrence TEXT NOT NULL CHECK(recurrence IN ('none', 'daily', 'weekly')),
      result TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(status, schedule_at);
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
  `);

  const statements = {
    addMessage: db.prepare('INSERT INTO messages (id, role, content, created_at) VALUES (?, ?, ?, ?)'),
    listMessages: db.prepare('SELECT * FROM messages ORDER BY created_at DESC, rowid DESC LIMIT ?'),
    addMemory: db.prepare('INSERT INTO memories (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)'),
    listMemories: db.prepare('SELECT * FROM memories ORDER BY updated_at DESC, rowid DESC LIMIT 100'),
    deleteMemory: db.prepare('DELETE FROM memories WHERE id = ?'),
    addTask: db.prepare(`INSERT INTO tasks
      (id, title, prompt, status, risk, schedule_at, recurrence, result, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`),
    listTasks: db.prepare('SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT 200'),
    getTask: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    updateTaskStatus: db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?'),
    completeTask: db.prepare('UPDATE tasks SET status = ?, result = ?, schedule_at = ?, updated_at = ? WHERE id = ?'),
    dueTasks: db.prepare(`SELECT * FROM tasks
      WHERE status IN ('queued', 'scheduled') AND (schedule_at IS NULL OR schedule_at <= ?)
      ORDER BY COALESCE(schedule_at, created_at) ASC LIMIT 5`),
    addEvent: db.prepare('INSERT INTO events (id, type, message, detail, created_at) VALUES (?, ?, ?, ?, ?)'),
    listEvents: db.prepare('SELECT * FROM events ORDER BY created_at DESC, rowid DESC LIMIT ?')
  };

  const now = () => new Date().toISOString();
  const api = {
    close: () => db.close(),
    addMessage(role, content) {
      const row = { id: randomUUID(), role, content, created_at: now() };
      statements.addMessage.run(row.id, row.role, row.content, row.created_at);
      return row;
    },
    listMessages(limit = 60) {
      return statements.listMessages.all(Math.min(Math.max(limit, 1), 200)).reverse();
    },
    addMemory(content) {
      const timestamp = now();
      const row = { id: randomUUID(), content, created_at: timestamp, updated_at: timestamp };
      statements.addMemory.run(row.id, row.content, row.created_at, row.updated_at);
      return row;
    },
    listMemories: () => statements.listMemories.all(),
    deleteMemory(id) {
      return statements.deleteMemory.run(id).changes > 0;
    },
    addTask({ title, prompt, risk = 'internal', scheduleAt = null, recurrence = 'none' }) {
      const timestamp = now();
      const status = risk === 'external' ? 'waiting_approval' : scheduleAt ? 'scheduled' : 'queued';
      const row = {
        id: randomUUID(), title, prompt, status, risk,
        schedule_at: scheduleAt, recurrence, result: null,
        created_at: timestamp, updated_at: timestamp
      };
      statements.addTask.run(row.id, row.title, row.prompt, row.status, row.risk, row.schedule_at,
        row.recurrence, row.created_at, row.updated_at);
      return row;
    },
    listTasks: () => statements.listTasks.all(),
    getTask: (id) => statements.getTask.get(id),
    setTaskStatus(id, status) {
      return statements.updateTaskStatus.run(status, now(), id).changes > 0;
    },
    completeTask(id, result, status = 'completed', scheduleAt = null) {
      return statements.completeTask.run(status, result, scheduleAt, now(), id).changes > 0;
    },
    dueTasks: () => statements.dueTasks.all(now()),
    addEvent(type, message, detail = null) {
      const row = { id: randomUUID(), type, message, detail, created_at: now() };
      statements.addEvent.run(row.id, row.type, row.message, row.detail, row.created_at);
      return row;
    },
    listEvents(limit = 80) {
      return statements.listEvents.all(Math.min(Math.max(limit, 1), 200));
    }
  };
  return api;
}
