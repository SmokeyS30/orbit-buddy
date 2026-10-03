import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.js';
import { DatabaseSync } from 'node:sqlite';

function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-db-'));
  const filePath = path.join(directory, 'test.sqlite');
  const db = openDatabase(filePath, options);
  const user = db.createUser({ email: 'owner@example.com', displayName: 'Owner', passwordHash: 'hash', passwordSalt: 'salt', role: 'owner' });
  return { db, user, filePath };
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

test('stores typed memory and ranks relevant details ahead of unrelated ones', () => {
  const { db, user } = fixture();
  db.addMemory(user.id, 'Prefers aisle seats on flights.', { kind: 'preference' });
  db.addMemory(user.id, 'The garden shed is painted blue.', { kind: 'fact' });
  const ranked = db.listRelevantMemories(user.id, 'Help plan my next flight', 2);
  assert.equal(ranked[0].kind, 'preference');
  assert.match(ranked[0].content, /aisle seats/);
  db.close();
});

test('encrypts calendar feed URLs at rest and decrypts them through the database API', () => {
  const key = Buffer.alloc(32, 7);
  const { db, user, filePath } = fixture({ encryptionKey: key });
  const secretUrl = 'https://calendar.example/private/secret-token.ics';
  db.addCalendarFeed(user.id, { label: 'Private', url: secretUrl });
  assert.equal(db.listCalendarFeeds(user.id)[0].url, secretUrl);
  db.close();
  const raw = new DatabaseSync(filePath, { readOnly: true });
  const stored = raw.prepare('SELECT url FROM calendar_feeds').get().url;
  raw.close();
  assert.match(stored, /^enc:v1:/);
  assert.ok(!stored.includes('secret-token'));
});

test('recovers a task whose worker lease expired', () => {
  const { db, user } = fixture();
  const task = db.addTask(user.id, { title: 'Recover me', prompt: 'Continue safely' });
  assert.equal(db.startTask(user.id, task.id, -1000), true);
  assert.equal(db.getTask(user.id, task.id).status, 'running');
  assert.equal(db.recoverStaleTasks(), 1);
  assert.equal(db.getTask(user.id, task.id).status, 'queued');
  assert.equal(db.dueTasks()[0].id, task.id);
  db.close();
});

test('tracks goal progress and recurring routine leases', () => {
  const { db, user } = fixture();
  const goal = db.addGoal(user.id, { title: 'Certification', priority: 3, targetDate: '2026-12-01', nextStep: 'Finish module two' });
  const updated = db.updateGoal(user.id, goal.id, { progress: 35, note: 'Finished module one' });
  assert.equal(updated.progress, 35);
  assert.equal(updated.status, 'active');
  assert.equal(db.listGoalCheckins(user.id, goal.id)[0].note, 'Finished module one');
  assert.equal(db.listActiveGoals(user.id)[0].id, goal.id);

  const routine = db.addRoutine(user.id, { title: 'Morning brief', prompt: 'Prepare my day', kind: 'briefing', cadence: 'weekdays', timeLocal: '08:00' });
  assert.equal(db.claimRoutine(user.id, routine.id, '2026-10-05'), true);
  assert.equal(db.claimRoutine(user.id, routine.id, '2026-10-05'), false);
  assert.equal(db.completeRoutine(user.id, routine.id, '2026-10-05'), true);
  assert.equal(db.getRoutine(user.id, routine.id).last_run_date, '2026-10-05');
  assert.equal(db.claimRoutine(user.id, routine.id, '2026-10-05'), false);
  db.close();
});

test('backup version 5 preserves goals, routines, projects, and approvals', () => {
  const source = fixture();
  source.db.addGoal(source.user.id, { title: 'Run a 10K', priority: 2 });
  source.db.addRoutine(source.user.id, { title: 'Evening reflection', prompt: 'Reflect', kind: 'reflection', cadence: 'daily', timeLocal: '20:00' });
  source.db.addProject(source.user.id, { title: 'Move house', steps: [{ title: 'Book movers', dueDate: '2026-11-01' }] });
  source.db.addApproval(source.user.id, { kind: 'calendar_event', title: 'Add moving day', summary: 'Calendar proposal', payload: { title: 'Moving day', startAt: '2026-11-10T14:00:00.000Z', endAt: '2026-11-10T16:00:00.000Z' } });
  const bundle = source.db.exportUser(source.user.id);
  assert.equal(bundle.version, 5);
  source.db.close();
  const target = fixture();
  target.db.restoreUser(target.user.id, bundle);
  assert.equal(target.db.listGoals(target.user.id)[0].title, 'Run a 10K');
  assert.equal(target.db.listRoutines(target.user.id)[0].kind, 'reflection');
  assert.equal(target.db.listProjects(target.user.id)[0].steps[0].title, 'Book movers');
  assert.equal(target.db.listApprovals(target.user.id)[0].payload.title, 'Moving day');
  target.db.close();
});

test('projects and approval decisions are isolated by user', () => {
  const { db, user } = fixture();
  const second = db.createUser({ email: 'member@example.com', displayName: 'Member', passwordHash: 'hash', passwordSalt: 'salt', role: 'member' });
  const project = db.addProject(user.id, {
    title: 'Launch site',
    priority: 3,
    steps: [{ title: 'Review copy' }, { title: 'Publish', dueDate: '2026-10-20' }]
  });
  assert.equal(project.steps.length, 2);
  const completed = db.updateProjectStep(user.id, project.steps[0].id, { status: 'completed' });
  assert.equal(completed.status, 'completed');
  assert.ok(completed.completed_at);
  assert.ok(db.getProject(user.id, project.id).updated_at);
  assert.equal(db.getProject(second.id, project.id), null);
  assert.equal(db.updateProjectStep(second.id, project.steps[1].id, { status: 'completed' }), null);
  assert.equal(db.deleteProject(second.id, project.id), false);

  const approval = db.addApproval(user.id, {
    kind: 'calendar_event',
    title: 'Add launch review',
    summary: 'Review proposed calendar entry',
    payload: { title: 'Launch review' }
  });
  assert.equal(approval.status, 'pending');
  assert.equal(db.getApproval(second.id, approval.id), null);
  assert.equal(db.resolveApproval(second.id, approval.id, 'rejected'), null);
  const resolved = db.resolveApproval(user.id, approval.id, 'executed', { result: { artifactId: 'artifact-1' } });
  assert.equal(resolved.status, 'executed');
  assert.equal(resolved.result.artifactId, 'artifact-1');
  assert.equal(db.resolveApproval(user.id, approval.id, 'rejected'), null);
  db.close();
});
