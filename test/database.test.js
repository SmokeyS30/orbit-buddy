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

test('tracks people mentions and finds stale ones for nudges', () => {
  const { db, user, filePath } = fixture();
  db.trackPersonMention(user.id, 'Mom');
  db.trackPersonMention(user.id, 'Sarah');
  assert.equal(db.getStalePeople(user.id, 14).length, 0, 'fresh mentions are not stale');
  const raw = new DatabaseSync(filePath);
  const ageMention = (days) => raw.prepare('UPDATE people_mentions SET last_mentioned_at=? WHERE user_id=? AND person_name=?')
    .run(new Date(Date.now() - days * 86400_000).toISOString(), user.id, 'Mom');
  ageMention(20);
  let stale = db.getStalePeople(user.id, 14);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].person_name, 'Mom');
  db.markPersonNudged(user.id, 'Mom');
  assert.equal(db.getStalePeople(user.id, 14).length, 0, 'nudged person cools down for 30 days');
  raw.prepare('UPDATE people_mentions SET last_nudged_at=? WHERE user_id=? AND person_name=?')
    .run(new Date(Date.now() - 31 * 86400_000).toISOString(), user.id, 'Mom');
  assert.equal(db.getStalePeople(user.id, 14).length, 1, 'nudge cooldown expires after 30 days');
  db.dismissPersonNudge(user.id, 'Mom');
  assert.equal(db.getStalePeople(user.id, 14).length, 0, 'dismissed person is excluded');
  db.trackPersonMention(user.id, 'Mom');
  ageMention(20);
  assert.equal(db.getStalePeople(user.id, 14).length, 1, 're-mention un-dismisses and refreshes');
  raw.close();
  db.close();
});

test('finds memories from the same date in prior years', () => {
  const { db, user, filePath } = fixture();
  const memory = db.addMemory(user.id, 'Trip to the museum');
  const now = new Date();
  const lastYear = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate(), 12));
  const raw = new DatabaseSync(filePath);
  raw.prepare('UPDATE memories SET created_at=?, updated_at=? WHERE id=?').run(lastYear.toISOString(), lastYear.toISOString(), memory.id);
  raw.close();
  const month = lastYear.getUTCMonth() + 1;
  const day = lastYear.getUTCDate();
  const found = db.listMemoriesOnDate(user.id, month, day);
  assert.equal(found.length, 1);
  assert.equal(found[0].content, 'Trip to the museum');
  assert.equal(found[0].year, String(lastYear.getUTCFullYear()));
  db.addMemory(user.id, 'Something today');
  assert.ok(!db.listMemoriesOnDate(user.id, month, day).some((m) => m.content === 'Something today'), 'current-year memories excluded');
  db.close();
});

test('lists recent completions for the weekly review', () => {
  const { db, user } = fixture();
  const task = db.addTask(user.id, { title: 'Finish report', prompt: 'Write it' });
  db.completeTask(user.id, task.id, 'done');
  const pending = db.addTask(user.id, { title: 'Later thing', prompt: 'Later' });
  const weekAgo = new Date(Date.now() - 8 * 86400_000).toISOString();
  const done = db.listTasksCompletedSince(user.id, weekAgo);
  assert.ok(done.some((t) => t.id === task.id), 'completed task included');
  assert.ok(!done.some((t) => t.id === pending.id), 'incomplete task excluded');
  db.addMemory(user.id, 'Learned something new');
  assert.ok(db.listMemoriesSince(user.id, weekAgo).some((m) => m.content === 'Learned something new'));
  const goal = db.addGoal(user.id, { title: 'Run a 5k' });
  db.updateGoal(user.id, goal.id, { progress: 50, note: 'Halfway there' });
  const checkins = db.listGoalCheckinsSince(user.id, weekAgo);
  assert.ok(checkins.some((c) => c.goal_title === 'Run a 5k' && c.progress === 50));
  db.close();
});

test('stores briefing personality preferences with defaults', () => {
  const { db, user } = fixture();
  const defaults = db.getPreferences(user.id);
  assert.equal(defaults.briefing_tone, 'motivational');
  assert.equal(defaults.briefing_length, 'quick');
  const updated = db.setPreferences(user.id, { briefingTone: 'chill', briefingLength: 'detailed' });
  assert.equal(updated.briefing_tone, 'chill');
  assert.equal(updated.briefing_length, 'detailed');
  assert.equal(updated.time_zone, 'America/New_York', 'other prefs preserved');
  const invalid = db.setPreferences(user.id, { briefingTone: 'pirate' });
  assert.equal(invalid.briefing_tone, 'chill', 'invalid tone keeps current value');
  db.close();
});

test('streak completions count consecutive days', () => {
  const { db, user } = fixture();
  const today = new Date().toISOString().slice(0, 10);
  const dayMs = 86400_000;
  const dstr = (offset) => new Date(Date.parse(today + 'T12:00:00Z') + offset * dayMs).toISOString().slice(0, 10);
  // 3 consecutive days ending today
  db.recordStreakCompletion(user.id, 'routine', 'r1', dstr(0));
  db.recordStreakCompletion(user.id, 'routine', 'r1', dstr(-1));
  db.recordStreakCompletion(user.id, 'routine', 'r1', dstr(-2));
  assert.equal(db.getStreak(user.id, 'routine', 'r1', today), 3);
  // Gap breaks the streak (missing yesterday, has day before)
  db.recordStreakCompletion(user.id, 'routine', 'r2', dstr(0));
  db.recordStreakCompletion(user.id, 'routine', 'r2', dstr(-2));
  assert.equal(db.getStreak(user.id, 'routine', 'r2', today), 1);
  // Streak can start yesterday (today not done yet)
  db.recordStreakCompletion(user.id, 'routine', 'r3', dstr(-1));
  db.recordStreakCompletion(user.id, 'routine', 'r3', dstr(-2));
  assert.equal(db.getStreak(user.id, 'routine', 'r3', today), 2);
  // No completions = 0
  assert.equal(db.getStreak(user.id, 'routine', 'nope', today), 0);
  // Duplicate recording is idempotent
  db.recordStreakCompletion(user.id, 'routine', 'r1', dstr(0));
  assert.equal(db.getStreak(user.id, 'routine', 'r1', today), 3);
  db.close();
});

test('goal streaks read from checkin history', () => {
  const { db, user } = fixture();
  const today = new Date().toISOString().slice(0, 10);
  const goal = db.addGoal(user.id, { title: 'Exercise daily' });
  // updateGoal records a checkin with the current timestamp
  db.updateGoal(user.id, goal.id, { progress: 10, note: 'day 1' });
  assert.ok(db.getGoalStreak(user.id, goal.id, today) >= 1);
  db.close();
});

test('backfillGoalStreaks seeds from existing checkins', () => {
  const { db, user } = fixture();
  const goal = db.addGoal(user.id, { title: 'Read daily' });
  db.updateGoal(user.id, goal.id, { progress: 20, note: 'started' });
  db.updateGoal(user.id, goal.id, { progress: 40, note: 'more' });
  const seeded = db.backfillGoalStreaks(user.id);
  assert.ok(seeded >= 1);
  db.close();
});

test('curiosity gap lifecycle: add, list, mark asked', () => {
  const { db, user } = fixture();
  assert.deepEqual(db.listCuriosityGaps(user.id), []);
  const id1 = db.addCuriosityGap(user.id, { question: 'What is your favorite hobby?', context: 'to personalize suggestions', priority: 3 });
  const id2 = db.addCuriosityGap(user.id, { question: 'Do you have any pets?', priority: 1 });
  assert.ok(id1 && id2);
  // Short questions rejected
  assert.equal(db.addCuriosityGap(user.id, { question: 'Hi?' }), null);
  let gaps = db.listCuriosityGaps(user.id);
  assert.equal(gaps.length, 2);
  assert.equal(gaps[0].question, 'What is your favorite hobby?', 'higher priority first');
  assert.ok(db.markCuriosityGapAsked(user.id, id1));
  gaps = db.listCuriosityGaps(user.id);
  assert.equal(gaps.length, 1, 'asked gaps excluded');
  assert.equal(gaps[0].question, 'Do you have any pets?');
});

test('person context: update and retrieve relationship depth', () => {
  const { db, user } = fixture();
  db.trackPersonMention(user.id, 'Sarah');
  assert.equal(db.getPersonContext(user.id, 'Sarah').context_summary, null);
  assert.ok(db.updatePersonContext(user.id, 'Sarah', 'Study partner at college, things going well', 'positive'));
  const ctx = db.getPersonContext(user.id, 'Sarah');
  assert.equal(ctx.context_summary, 'Study partner at college, things going well');
  assert.equal(ctx.sentiment, 'positive');
  // Invalid sentiment falls back to neutral
  db.updatePersonContext(user.id, 'Sarah', 'Just someone', 'ecstatic');
  assert.equal(db.getPersonContext(user.id, 'Sarah').sentiment, 'neutral');
  // Tracked people list includes context
  const people = db.listTrackedPeople(user.id);
  assert.equal(people.length, 1);
  assert.equal(people[0].person_name, 'Sarah');
  // Recently mentioned filter
  const recent = db.recentlyMentionedPeople(user.id, new Date(Date.now() - 86400_000).toISOString());
  assert.deepEqual(recent, ['Sarah']);
  const old = db.recentlyMentionedPeople(user.id, new Date().toISOString());
  assert.deepEqual(old, [], 'future cutoff excludes all');
});

test('motivation profile defaults to unknown and stores inferred style', () => {
  const { db, user } = fixture();
  const initial = db.getMotivationProfile(user.id);
  assert.equal(initial.style, 'unknown');
  db.setMotivationProfile(user.id, 'encouragement', 'Replied to 4/5 encouraging check-ins');
  const updated = db.getMotivationProfile(user.id);
  assert.equal(updated.style, 'encouragement');
  assert.ok(updated.evidence.includes('encouraging'));
  // Invalid style falls back to unknown
  db.setMotivationProfile(user.id, 'bogus-style', 'x');
  assert.equal(db.getMotivationProfile(user.id).style, 'unknown');
  db.close();
});

test('emotional profile defaults to unknown and stores support style', () => {
  const { db, user } = fixture();
  const initial = db.getEmotionalProfile(user.id);
  assert.equal(initial.support_style, 'unknown');
  assert.equal(initial.energy_notes, null);
  db.setEmotionalProfile(user.id, 'listening', 'Energized by building things', 'User engaged most with validation');
  const updated = db.getEmotionalProfile(user.id);
  assert.equal(updated.support_style, 'listening');
  assert.ok(updated.energy_notes.includes('building'));
  assert.ok(updated.evidence.includes('validation'));
  // Invalid style falls back to unknown
  db.setEmotionalProfile(user.id, 'bogus-style', 'x', 'y');
  assert.equal(db.getEmotionalProfile(user.id).support_style, 'unknown');
  // Energy notes and evidence survive style updates
  db.setEmotionalProfile(user.id, 'solutions', 'Drained by admin work', 'Replied to action steps');
  const again = db.getEmotionalProfile(user.id);
  assert.equal(again.support_style, 'solutions');
  assert.ok(again.energy_notes.includes('admin'));
  db.close();
});

test('listMemoriesBySource filters auto-emotion and auto-energy', () => {
  const { db, user } = fixture();
  db.addMemory(user.id, 'Emotional tone this week: steady.', { source: 'auto-emotion', confidence: 0.7 });
  db.addMemory(user.id, 'Energizers: building things. Drainers: admin work.', { source: 'auto-energy', confidence: 0.55 });
  const emos = db.listMemoriesBySource(user.id, 'auto-emotion', 10);
  assert.equal(emos.length, 1);
  assert.ok(emos[0].content.includes('steady'));
  const energies = db.listMemoriesBySource(user.id, 'auto-energy', 10);
  assert.equal(energies.length, 1);
  assert.ok(energies[0].content.includes('Drainers'));
  db.close();
});

test('listMemoriesBySource filters auto-predict and auto-contradiction', () => {
  const { db, user } = fixture();
  db.addMemory(user.id, 'User likes coffee', { source: 'user' });
  db.addMemory(user.id, 'Tends to slow down Thursdays', { source: 'auto-predict', confidence: 0.6 });
  db.addMemory(user.id, 'Says not a morning person but active early', { source: 'auto-contradiction', confidence: 0.6 });
  const preds = db.listMemoriesBySource(user.id, 'auto-predict', 10);
  assert.equal(preds.length, 1);
  assert.ok(preds[0].content.includes('Thursdays'));
  const contras = db.listMemoriesBySource(user.id, 'auto-contradiction', 10);
  assert.equal(contras.length, 1);
  db.close();
});

test('personal dates CRUD with validation', () => {
  const { db, user } = fixture();
  const bday = db.addPersonalDate(user.id, { label: "Mom's birthday", month: 6, day: 12, type: 'birthday' });
  assert.equal(bday.label, "Mom's birthday");
  assert.equal(bday.month, 6);
  assert.equal(bday.day, 12);
  assert.equal(bday.type, 'birthday');
  assert.equal(bday.year, null);
  const anniv = db.addPersonalDate(user.id, { label: 'Our anniversary', month: 9, day: 3, year: 2018, type: 'anniversary', notes: 'Nice dinner' });
  assert.equal(anniv.year, 2018);
  const other = db.addPersonalDate(user.id, { label: 'Dad memorial', month: 11, day: 20, type: 'other' });
  assert.equal(other.type, 'other');
  // Invalid type falls back to other
  const weird = db.addPersonalDate(user.id, { label: 'Weird', month: 1, day: 1, type: 'party' });
  assert.equal(weird.type, 'other');
  const all = db.listPersonalDates(user.id);
  assert.equal(all.length, 4);
  // Ordered by month, day
  assert.equal(all[0].label, 'Weird');
  assert.equal(all[1].label, "Mom's birthday");
  // Update
  const updated = db.updatePersonalDate(user.id, bday.id, { notes: 'Likes gardening' });
  assert.ok(updated.notes.includes('gardening'));
  // Validation
  assert.throws(() => db.addPersonalDate(user.id, { label: 'x', month: 13, day: 1 }), /month must be 1-12/);
  assert.throws(() => db.addPersonalDate(user.id, { label: 'x', month: 2, day: 30 }), /day must be/);
  assert.throws(() => db.addPersonalDate(user.id, { label: '   ', month: 1, day: 1 }), /label is required/);
  assert.throws(() => db.addPersonalDate(user.id, { label: 'x', month: 4, day: 31 }), /day must be/);
  // Feb 29 allowed
  const leap = db.addPersonalDate(user.id, { label: 'Leap day', month: 2, day: 29, type: 'birthday' });
  assert.equal(leap.day, 29);
  // Delete
  assert.equal(db.deletePersonalDate(user.id, bday.id), true);
  assert.equal(db.getPersonalDate(user.id, bday.id), null);
  assert.equal(db.deletePersonalDate(user.id, 'nonexistent'), false);
  // Isolation
  const second = db.createUser({ email: 'pd2@example.com', displayName: 'Two', passwordHash: 'h', passwordSalt: 's', role: 'member' });
  assert.deepEqual(db.listPersonalDates(second.id), []);
  db.close();
});
