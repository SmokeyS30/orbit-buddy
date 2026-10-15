import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.js';
import {
  resolveRelativeDate, executeTool,
  toolCreateGoal, toolCreateTask, toolCreateRoutine,
  toolUpdateGoal, toolUpdateTask, toolUpdateRoutine,
  toolDeleteGoal, toolDeleteTask, toolDeleteRoutine, toolConfirmDeleteApproval
} from '../src/tools.js';

// D2: chat-as-manager — in-chat updates (low-risk, fuzzy match) and deletion
// (always confirm-in-chat: stage → explicit yes → execute).

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-manage-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  const user = db.createUser({ email: 'owner@example.com', displayName: 'Owner', passwordHash: 'hash', passwordSalt: 'salt', role: 'owner' });
  return { db, user, ctx: { db, userId: user.id, timeZone: 'America/New_York', messageId: null } };
}

const THU = new Date('2026-10-15T12:00:00Z'); // Thursday 08:00 EDT
const FRI = new Date('2026-10-16T12:00:00Z'); // Friday 08:00 EDT

test('resolveRelativeDate resolves ISO and relative phrases in the user timezone', () => {
  const zone = 'America/New_York';
  assert.equal(resolveRelativeDate('2026-10-23', zone, THU), '2026-10-23');
  assert.equal(resolveRelativeDate('today', zone, THU), '2026-10-15');
  assert.equal(resolveRelativeDate('tomorrow', zone, THU), '2026-10-16');
  assert.equal(resolveRelativeDate('day after tomorrow', zone, THU), '2026-10-17');
  assert.equal(resolveRelativeDate('next week', zone, THU), '2026-10-22');
  assert.equal(resolveRelativeDate('Friday', zone, THU), '2026-10-16');
  assert.equal(resolveRelativeDate('friday', zone, FRI), '2026-10-16'); // bare weekday on the day = today
  assert.equal(resolveRelativeDate('next Friday', zone, THU), '2026-10-23');
  assert.equal(resolveRelativeDate('Monday', zone, THU), '2026-10-19');
});

test('resolveRelativeDate returns null for unresolvable phrases', () => {
  assert.equal(resolveRelativeDate('someday', 'America/New_York', THU), null);
  assert.equal(resolveRelativeDate('2026-13-99', 'America/New_York', THU), null);
  assert.equal(resolveRelativeDate('', 'America/New_York', THU), null);
});

test('update_goal renames, reprioritizes, and moves the deadline by fuzzy title', () => {
  const { db, user, ctx } = fixture();
  const created = toolCreateGoal({ title: 'Gym goal' }, ctx);
  const renamed = toolUpdateGoal({ title: 'gym goal', newTitle: 'Gym 5x weekly', priority: 3 }, ctx);
  assert.equal(renamed.title, 'Gym 5x weekly');
  assert.equal(renamed.priority, 3);
  assert.match(renamed.note, /renamed to “Gym 5x weekly”/);
  assert.match(renamed.note, /priority 3/);
  const moved = toolUpdateGoal({ title: 'gym 5x', targetDate: '2026-10-31' }, ctx);
  assert.equal(moved.targetDate, '2026-10-31');
  assert.match(moved.note, /target moved to 2026-10-31/);
  const relative = toolUpdateGoal({ title: 'gym 5x', targetDate: 'Friday' }, ctx);
  assert.equal(relative.targetDate, resolveRelativeDate('Friday', 'America/New_York'));
  const cleared = toolUpdateGoal({ goalId: created.id, targetDate: null }, ctx);
  assert.equal(cleared.targetDate, null);
  db.close();
});

test('update_goal still works by goalId with progress/status (backward compatible)', () => {
  const { db, user, ctx } = fixture();
  const created = toolCreateGoal({ title: 'Read more' }, ctx);
  const updated = toolUpdateGoal({ goalId: created.id, progress: 50, nextStep: 'Chapter 3' }, ctx);
  assert.equal(updated.progress, 50);
  assert.equal(updated.nextStep, 'Chapter 3');
  assert.equal(db.getGoal(user.id, created.id).progress, 50);
  db.close();
});

test('update_goal asks instead of guessing on ambiguous targets', () => {
  const { db, user, ctx } = fixture();
  toolCreateGoal({ title: 'Gym morning' }, ctx);
  toolCreateGoal({ title: 'Gym evening' }, ctx);
  const result = toolUpdateGoal({ title: 'gym', priority: 1 }, ctx);
  assert.equal(result.ambiguous, true);
  assert.equal(result.candidates.length, 2);
  // Nothing changed on either goal.
  for (const goal of db.listGoals(user.id)) assert.equal(goal.priority, 2);
  db.close();
});

test('update_goal throws when nothing matches', () => {
  const { ctx } = fixture();
  assert.throws(() => toolUpdateGoal({ title: 'zzz-no-such-goal' }, ctx), /No goal found/);
});

test('update_task renames and reschedules by fuzzy title', () => {
  const { db, user, ctx } = fixture();
  const created = toolCreateTask({ title: 'Passport renewal', prompt: 'Renew the passport' }, ctx);
  const updated = toolUpdateTask({ task: 'passport', newTitle: 'Renew passport ASAP', recurrence: 'weekly' }, ctx);
  assert.equal(updated.title, 'Renew passport ASAP');
  assert.equal(updated.recurrence, 'weekly');
  assert.match(updated.note, /renamed to “Renew passport ASAP”/);
  const relative = toolUpdateTask({ task: 'passport asap', scheduleAt: 'tomorrow' }, ctx);
  const expectedDate = resolveRelativeDate('tomorrow', 'America/New_York');
  assert.ok(relative.scheduleAt.startsWith(expectedDate), `expected ${relative.scheduleAt} to start with ${expectedDate}`);
  assert.equal(db.getTask(user.id, created.id).title, 'Renew passport ASAP');
  db.close();
});

test('update_task asks instead of guessing on ambiguous targets', () => {
  const { db, user, ctx } = fixture();
  toolCreateTask({ title: 'Gym morning', prompt: 'Go' }, ctx);
  toolCreateTask({ title: 'Gym evening', prompt: 'Go' }, ctx);
  const result = toolUpdateTask({ task: 'gym', recurrence: 'daily' }, ctx);
  assert.equal(result.ambiguous, true);
  assert.equal(result.candidates.length, 2);
  for (const task of db.listTasks(user.id)) assert.equal(task.recurrence, 'none');
  db.close();
});

test('update_routine changes time and pauses by fuzzy title', () => {
  const { db, user, ctx } = fixture();
  const created = toolCreateRoutine({ title: 'Morning briefing', prompt: 'Brief me', kind: 'briefing', cadence: 'daily', timeLocal: '08:00' }, ctx);
  const updated = toolUpdateRoutine({ routine: 'morning', timeLocal: '07:30', enabled: false }, ctx);
  assert.equal(updated.timeLocal, '07:30');
  assert.equal(updated.enabled, false);
  assert.match(updated.note, /paused/);
  const row = db.getRoutine(user.id, created.id);
  assert.equal(row.time_local, '07:30');
  assert.equal(row.enabled, 0);
  assert.throws(() => toolUpdateRoutine({ routine: 'morning', timeLocal: '25:00' }, ctx), /timeLocal/);
  db.close();
});

test('delete_goal stages a request but deletes nothing until confirmed', () => {
  const { db, user, ctx } = fixture();
  const created = toolCreateGoal({ title: 'Drop me' }, ctx);
  const staged = toolDeleteGoal({ title: 'drop me' }, ctx);
  assert.ok(staged.approvalId);
  assert.match(staged.preview, /Drop me/);
  assert.match(staged.note, /NOT deleted/);
  // The confirm-in-chat gate: staging alone must not delete.
  assert.ok(db.getGoal(user.id, created.id), 'goal must still exist before confirmation');
  const approval = db.getApproval(user.id, staged.approvalId);
  assert.equal(approval.kind, 'delete_goal');
  assert.equal(approval.status, 'pending');
  const done = toolConfirmDeleteApproval({ approvalId: staged.approvalId }, ctx);
  assert.equal(done.deleted, true);
  assert.equal(done.title, 'Drop me');
  assert.equal(db.getGoal(user.id, created.id), null);
  assert.equal(db.getApproval(user.id, staged.approvalId).status, 'executed');
  db.close();
});

test('confirm_delete_approval rejects double-confirm and unknown approvals', () => {
  const { ctx } = fixture();
  const created = toolCreateGoal({ title: 'Drop me twice' }, ctx);
  const staged = toolDeleteGoal({ title: 'drop me twice' }, ctx);
  assert.equal(created.title, 'Drop me twice');
  toolConfirmDeleteApproval({ approvalId: staged.approvalId }, ctx);
  assert.throws(() => toolConfirmDeleteApproval({ approvalId: staged.approvalId }, ctx), /already reviewed/);
  assert.throws(() => toolConfirmDeleteApproval({ approvalId: '00000000-0000-0000-0000-000000000000' }, ctx), /No pending deletion/);
});

test('delete_task and delete_routine follow the same confirm gate', () => {
  const { db, user, ctx } = fixture();
  const task = toolCreateTask({ title: 'Temp task', prompt: 'Do it' }, ctx);
  const stagedTask = toolDeleteTask({ task: 'temp' }, ctx);
  assert.ok(db.getTask(user.id, task.id), 'task must still exist before confirmation');
  toolConfirmDeleteApproval({ approvalId: stagedTask.approvalId }, ctx);
  assert.equal(db.getTask(user.id, task.id), undefined);
  const routine = toolCreateRoutine({ title: 'Temp routine', prompt: 'Run', kind: 'custom', cadence: 'daily', timeLocal: '09:00' }, ctx);
  const stagedRoutine = toolDeleteRoutine({ routine: 'temp' }, ctx);
  assert.ok(db.getRoutine(user.id, routine.id), 'routine must still exist before confirmation');
  toolConfirmDeleteApproval({ approvalId: stagedRoutine.approvalId }, ctx);
  assert.equal(db.getRoutine(user.id, routine.id), null);
  db.close();
});

test('delete tools ask on ambiguity and stage nothing', () => {
  const { db, user, ctx } = fixture();
  toolCreateRoutine({ title: 'Gym stretch', prompt: 'Stretch', kind: 'custom', cadence: 'daily', timeLocal: '09:00' }, ctx);
  toolCreateRoutine({ title: 'Gym weights', prompt: 'Lift', kind: 'custom', cadence: 'daily', timeLocal: '18:00' }, ctx);
  const before = db.listApprovals(user.id).filter((a) => a.status === 'pending').length;
  const result = toolDeleteRoutine({ routine: 'gym' }, ctx);
  assert.equal(result.ambiguous, true);
  assert.equal(result.candidates.length, 2);
  assert.ok(!result.approvalId);
  const after = db.listApprovals(user.id).filter((a) => a.status === 'pending').length;
  assert.equal(after, before, 'ambiguous delete must not stage an approval');
  db.close();
});

test('update/delete tools are reachable through executeTool dispatch', async () => {
  const { db, user, ctx } = fixture();
  toolCreateTask({ title: 'Dispatch check', prompt: 'Go' }, ctx);
  const { result } = await executeTool('update_task', { task: 'dispatch', newTitle: 'Dispatch checked' }, process.env, ctx);
  assert.equal(result.title, 'Dispatch checked');
  const { result: staged } = await executeTool('delete_task', { task: 'dispatch checked' }, process.env, ctx);
  assert.ok(staged.approvalId);
  assert.ok(db.getTask(user.id, staged.id), 'still present until confirmed');
  db.close();
});
