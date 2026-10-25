import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.js';
import { createOrbitServer } from '../server.js';
import {
  resolveRelativeDate, executeTool,
  toolCreateGoal, toolCreateTask, toolCreateRoutine,
  toolUpdateGoal, toolUpdateTask, toolUpdateRoutine,
  toolDeleteGoal, toolDeleteTask, toolDeleteRoutine, toolConfirmDeleteApproval
} from '../src/tools.js';

// D2: chat-as-manager — low-risk updates in chat; destructive changes use
// server-owned approval cards and a separate authenticated button press.

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-manage-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  const user = db.createUser({ email: 'owner@example.com', displayName: 'Owner', passwordHash: 'hash', passwordSalt: 'salt', role: 'owner' });
  const conversation=db.ensureDefaultConversation(user.id);
  const ctx={ db, userId: user.id, timeZone: 'America/New_York', messageId: null };
  const turn=(message)=>{
    const row=db.addMessage(user.id,conversation.id,'user',message);
    return {...ctx,messageId:row.id,conversationId:conversation.id,userMessage:message};
  };
  const reply=(message)=>db.addMessage(user.id,conversation.id,'assistant',message);
  return { db, user, ctx, turn, reply };
}

async function approvalApiFixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-delete-api-'));
  const app=createOrbitServer({dataDir:directory,env:{NODE_ENV:'test'}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();fs.rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const registered=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'delete-owner@example.test',displayName:'Owner',password:'correct horse battery staple'})});
  assert.equal(registered.status,201);
  const account=await registered.json();
  const cookie=registered.headers.get('set-cookie').split(';')[0];
  const headers={Cookie:cookie,'X-Orbit-CSRF':account.csrf,'Content-Type':'application/json'};
  const approve=(id,requestHeaders=headers)=>fetch(`${base}/api/approvals/${id}/approve`,{method:'POST',headers:requestHeaders,body:'{}'});
  const stage=(goal,description)=>{
    const conversation=app.db.ensureDefaultConversation(account.user.id);
    const source=app.db.addMessage(account.user.id,conversation.id,'user',description);
    return toolDeleteGoal({goalId:goal.id},{db:app.db,userId:account.user.id,messageId:source.id});
  };
  return{app,base,account,headers,approve,stage};
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

test('model cannot stage and confirm a deletion during one user turn', () => {
  const {db,user,ctx,turn}=fixture();
  const goal=toolCreateGoal({title:'Keep this goal'},ctx);
  const first=turn('Delete Keep this goal');
  const staged=toolDeleteGoal({title:'Keep this goal'},first);
  assert.throws(()=>toolConfirmDeleteApproval({approvalId:staged.approvalId},first),/Chat cannot execute deletions/i);
  assert.ok(db.getGoal(user.id,goal.id));
  assert.equal(db.getApproval(user.id,staged.approvalId).status,'pending');
  db.close();
});

test('delete confirmation rejects ambiguous, stale and cross-conversation replies', () => {
  const {db,user,ctx,turn,reply}=fixture();
  const goal=toolCreateGoal({title:'Keep the goal'},ctx);
  const staged=toolDeleteGoal({title:'Keep the goal'},turn('Delete Keep the goal'));
  reply(`Confirm deletion: ${staged.preview}`);
  const other=db.createConversation(user.id,'Another thread');
  const cross=db.addMessage(user.id,other.id,'user','yes');
  assert.throws(()=>toolConfirmDeleteApproval({approvalId:staged.approvalId},{...ctx,messageId:cross.id}),/Chat cannot execute deletions/i);
  const ambiguous=turn('yes, but keep the goal');
  assert.throws(()=>toolConfirmDeleteApproval({approvalId:staged.approvalId},ambiguous),/Chat cannot execute deletions/i);
  assert.throws(()=>toolConfirmDeleteApproval({approvalId:staged.approvalId},turn('yes')),/Chat cannot execute deletions/i,
    'an unrelated intervening user turn invalidates the old preview');
  assert.ok(db.getGoal(user.id,goal.id));
  db.close();
});

test('delete confirmation requires a visible preview naming the target and deletion', () => {
  const {db,user,ctx,turn,reply}=fixture();
  const goal=toolCreateGoal({title:'Keep the goal'},ctx);
  const staged=toolDeleteGoal({title:'Keep the goal'},turn('Delete Keep the goal'));
  reply('Sure, would you like help with that goal?');
  assert.throws(()=>toolConfirmDeleteApproval({approvalId:staged.approvalId},turn('yes')),/Chat cannot execute deletions/i);
  assert.ok(db.getGoal(user.id,goal.id));
  db.close();
});

test('a negated deletion mention cannot turn a generic yes into consent',()=>{
  const {db,user,ctx,turn,reply}=fixture();
  const goal=toolCreateGoal({title:'Gym'},ctx);
  const staged=toolDeleteGoal({goalId:goal.id},turn('Could you delete Gym?'));
  reply('I will not delete Gym. Would you like a reminder instead?');
  assert.throws(()=>toolConfirmDeleteApproval({approvalId:staged.approvalId},turn('yes')),/Chat cannot execute deletions/i);
  assert.ok(db.getGoal(user.id,goal.id));
  db.close();
});

test('quoting a deletion request cannot turn a generic yes into consent',()=>{
  const {db,user,ctx,turn,reply}=fixture();
  const goal=toolCreateGoal({title:'Gym'},ctx);
  const staged=toolDeleteGoal({goalId:goal.id},turn('Delete Gym'));
  reply('You said “Delete Gym,” but I have only noted that as a quote. Would you like a reminder?');
  assert.throws(()=>toolConfirmDeleteApproval({approvalId:staged.approvalId},turn('yes')),/Chat cannot execute deletions/i);
  assert.ok(db.getGoal(user.id,goal.id));
  db.close();
});

test('yes to a reminder is not permission for an unrelated staged deletion',()=>{
  const {db,user,ctx,turn,reply}=fixture();
  const goal=toolCreateGoal({title:'Gym'},ctx);
  const staged=toolDeleteGoal({goalId:goal.id},turn('Help me with Gym'));
  reply('Would you like a reminder to go to Gym instead?');
  assert.throws(()=>toolConfirmDeleteApproval({approvalId:staged.approvalId},turn('yes')),/Chat cannot execute deletions/i);
  assert.ok(db.getGoal(user.id,goal.id));
  db.close();
});

test('an overlapping name and one generic yes cannot authorize two targets',()=>{
  const {db,user,ctx,turn,reply}=fixture();
  const gym=toolCreateGoal({title:'Gym'},ctx),shoes=toolCreateGoal({title:'Gym shoes'},ctx);
  const source=turn('Delete Gym and Gym shoes');
  const gymApproval=toolDeleteGoal({goalId:gym.id},source);
  const shoesApproval=toolDeleteGoal({goalId:shoes.id},source);
  reply(`Confirm deletion: ${shoesApproval.preview}`);
  const yes=turn('yes');
  assert.throws(()=>toolConfirmDeleteApproval({approvalId:gymApproval.approvalId},yes),/Chat cannot execute deletions/i);
  assert.throws(()=>toolConfirmDeleteApproval({approvalId:shoesApproval.approvalId},yes),/Chat cannot execute deletions/i);
  assert.ok(db.getGoal(user.id,gym.id));assert.ok(db.getGoal(user.id,shoes.id));
  db.close();
});

test('a newer cancellation withdraws an earlier deletion confirmation',()=>{
  const {db,user,ctx,turn,reply}=fixture();
  const goal=toolCreateGoal({title:'Gym'},ctx);
  const staged=toolDeleteGoal({goalId:goal.id},turn('Delete Gym'));
  reply(`Confirm deletion: ${staged.preview}`);
  const yes=turn('yes');
  turn('No, cancel the deletion');
  assert.throws(()=>toolConfirmDeleteApproval({approvalId:staged.approvalId},yes),/Chat cannot execute deletions/i);
  assert.ok(db.getGoal(user.id,goal.id));
  db.close();
});

test('delete_goal stages a request that chat can never execute', () => {
  const { db, user, ctx, turn, reply } = fixture();
  const created = toolCreateGoal({ title: 'Drop me' }, ctx);
  const staged = toolDeleteGoal({ title: 'drop me' }, turn('Delete Drop me'));
  assert.ok(staged.approvalId);
  assert.match(staged.preview, /Drop me/);
  assert.match(staged.note, /NOT deleted/);
  // The server-owned approval card is the only destructive path.
  assert.ok(db.getGoal(user.id, created.id), 'goal must still exist before confirmation');
  const approval = db.getApproval(user.id, staged.approvalId);
  assert.equal(approval.kind, 'delete_goal');
  assert.equal(approval.status, 'pending');
  reply(`Confirm deletion: ${staged.preview}`);
  const confirmedTurn=turn('yes');
  assert.throws(()=>toolConfirmDeleteApproval({approvalId:staged.approvalId},{...confirmedTurn,regenerated:true}),/Chat cannot execute deletions/i);
  assert.throws(()=>toolConfirmDeleteApproval({approvalId:staged.approvalId},confirmedTurn),/Chat cannot execute deletions/i);
  assert.ok(db.getGoal(user.id, created.id));
  assert.equal(db.getApproval(user.id, staged.approvalId).status, 'pending');
  db.close();
});

test('confirm_delete_approval rejects even an explicit yes and an unknown approval', () => {
  const { ctx, turn, reply } = fixture();
  const created = toolCreateGoal({ title: 'Drop me twice' }, ctx);
  const staged = toolDeleteGoal({ title: 'drop me twice' }, turn('Delete Drop me twice'));
  assert.equal(created.title, 'Drop me twice');
  reply(`Confirm deletion: ${staged.preview}`);
  const confirmedTurn=turn('yes, delete it');
  assert.throws(() => toolConfirmDeleteApproval({ approvalId: staged.approvalId }, confirmedTurn), /Chat cannot execute deletions/i);
  assert.throws(() => toolConfirmDeleteApproval({ approvalId: '00000000-0000-0000-0000-000000000000' }, confirmedTurn), /No pending deletion/);
});

test('delete_task and delete_routine also cannot execute from chat', () => {
  const { db, user, ctx, turn, reply } = fixture();
  const task = toolCreateTask({ title: 'Temp task', prompt: 'Do it' }, ctx);
  const stagedTask = toolDeleteTask({ task: 'temp' }, turn('Delete Temp task'));
  assert.ok(db.getTask(user.id, task.id), 'task must still exist before confirmation');
  reply(`Confirm deletion: ${stagedTask.preview}`);
  assert.throws(()=>toolConfirmDeleteApproval({approvalId:stagedTask.approvalId},turn('yes')),/Chat cannot execute deletions/i);
  assert.ok(db.getTask(user.id,task.id));
  const routine = toolCreateRoutine({ title: 'Temp routine', prompt: 'Run', kind: 'custom', cadence: 'daily', timeLocal: '09:00' }, ctx);
  const stagedRoutine = toolDeleteRoutine({ routine: 'temp' }, turn('Delete Temp routine'));
  assert.ok(db.getRoutine(user.id, routine.id), 'routine must still exist before confirmation');
  reply(`Confirm deletion: ${stagedRoutine.preview}`);
  assert.throws(()=>toolConfirmDeleteApproval({approvalId:stagedRoutine.approvalId},turn('confirm deletion')),/Chat cannot execute deletions/i);
  assert.ok(db.getRoutine(user.id,routine.id));
  db.close();
});

test('SQLite approval transaction deletes a task or routine once, only for its owner',()=>{
  const {db,user,ctx,turn}=fixture();
  const cases=[
    {type:'task',created:toolCreateTask({title:'Synthetic task',prompt:'Do it'},ctx),stage:()=>toolDeleteTask({task:'synthetic task'},turn('Delete Synthetic task')),read:id=>db.getTask(user.id,id)},
    {type:'routine',created:toolCreateRoutine({title:'Synthetic routine',prompt:'Run',kind:'custom',cadence:'daily',timeLocal:'09:00'},ctx),stage:()=>toolDeleteRoutine({routine:'synthetic routine'},turn('Delete Synthetic routine')),read:id=>db.getRoutine(user.id,id)}
  ];
  for(const entry of cases){
    const staged=entry.stage();
    assert.ok(entry.read(entry.created.id));
    assert.equal(db.executeDeleteApprovalIfCurrent('another-user',staged.approvalId).status,'already');
    assert.ok(entry.read(entry.created.id));
    const result=db.executeDeleteApprovalIfCurrent(user.id,staged.approvalId);
    assert.equal(result.status,'executed');
    assert.equal(result.result.deleted,`delete_${entry.type}`);
    assert.equal(entry.read(entry.created.id)==null,true);
    assert.equal(db.executeDeleteApprovalIfCurrent(user.id,staged.approvalId).status,'already');
  }
  db.close();
});

test('the authenticated approval card deletes only its exact target once',async t=>{
  const {app,base,account,headers,approve,stage}=await approvalApiFixture(t);
  const userId=account.user.id;
  const gym=app.db.addGoal(userId,{title:'Gym'}),shoes=app.db.addGoal(userId,{title:'Gym shoes'});
  const gymApproval=stage(gym,'Delete Gym');
  const shoesApproval=stage(shoes,'Delete Gym shoes');
  const snapshot=await fetch(`${base}/api/snapshot`,{headers:{Cookie:headers.Cookie}});
  assert.equal(snapshot.status,200);
  const cards=(await snapshot.json()).approvals;
  assert.ok(cards.some(card=>card.id===shoesApproval.approvalId&&card.title.includes('Gym shoes')));
  assert.equal((await approve(shoesApproval.approvalId,{Cookie:headers.Cookie,'Content-Type':'application/json'})).status,403);
  assert.equal((await approve(shoesApproval.approvalId)).status,200);
  assert.ok(app.db.getGoal(userId,gym.id));
  assert.equal(app.db.getGoal(userId,shoes.id),null);
  assert.equal(app.db.getApproval(userId,gymApproval.approvalId).status,'pending');
  assert.equal((await approve(shoesApproval.approvalId)).status,409);
});

test('a newer cancellation invalidates the server-owned deletion card',async t=>{
  const {app,account,approve,stage}=await approvalApiFixture(t);
  const userId=account.user.id,goal=app.db.addGoal(userId,{title:'Gym'});
  const staged=stage(goal,'Delete Gym');
  const source=app.db.getMessage(userId,app.db.getApproval(userId,staged.approvalId).source_message_id);
  app.db.addMessage(userId,source.conversation_id,'user','yes');
  app.db.addMessage(userId,source.conversation_id,'user','No, cancel the deletion');
  assert.equal((await approve(staged.approvalId)).status,409);
  assert.ok(app.db.getGoal(userId,goal.id));
  assert.equal(app.db.getApproval(userId,staged.approvalId).status,'rejected');
});

test('a backdated newer chat turn invalidates the SQLite deletion card',async t=>{
  const {app,account,approve,stage}=await approvalApiFixture(t);
  const userId=account.user.id,goal=app.db.addGoal(userId,{title:'Gym'});
  const staged=stage(goal,'Delete Gym');
  const source=app.db.getMessage(userId,app.db.getApproval(userId,staged.approvalId).source_message_id);
  const cancellation=app.db.addMessage(userId,source.conversation_id,'user','No, cancel the deletion');
  assert.equal(app.db.retimeMessage(userId,cancellation.id,new Date(Date.parse(source.created_at)-60_000).toISOString()),true);
  assert.equal((await approve(staged.approvalId)).status,409);
  assert.ok(app.db.getGoal(userId,goal.id));
  assert.equal(app.db.getApproval(userId,staged.approvalId).status,'rejected');
});

test('any newer chat turn invalidates a staged deletion card',async t=>{
  const {app,account,approve,stage}=await approvalApiFixture(t);
  const userId=account.user.id,goal=app.db.addGoal(userId,{title:'Gym'});
  const staged=stage(goal,'Delete Gym');
  const source=app.db.getMessage(userId,app.db.getApproval(userId,staged.approvalId).source_message_id);
  app.db.addMessage(userId,source.conversation_id,'user','Thanks, and what is next?');
  assert.equal((await approve(staged.approvalId)).status,409);
  assert.ok(app.db.getGoal(userId,goal.id));
  assert.equal(app.db.getApproval(userId,staged.approvalId).status,'rejected');
});

test('a cancellation in another conversation invalidates the deletion card',async t=>{
  const {app,account,approve,stage}=await approvalApiFixture(t);
  const userId=account.user.id,goal=app.db.addGoal(userId,{title:'Gym'});
  const staged=stage(goal,'Delete Gym');
  const other=app.db.createConversation(userId,'Different thread');
  app.db.addMessage(userId,other.id,'user','Cancel the Gym deletion');
  assert.equal((await approve(staged.approvalId)).status,409);
  assert.ok(app.db.getGoal(userId,goal.id));
  assert.equal(app.db.getApproval(userId,staged.approvalId).status,'rejected');
});

test('a renamed target cannot be deleted through its old approval card',async t=>{
  const {app,account,approve,stage}=await approvalApiFixture(t);
  const userId=account.user.id,goal=app.db.addGoal(userId,{title:'Gym'});
  const staged=stage(goal,'Delete Gym');
  app.db.updateGoal(userId,goal.id,{title:'Gym shoes'});
  assert.equal((await approve(staged.approvalId)).status,409);
  assert.ok(app.db.getGoal(userId,goal.id));
});

test('a changed target with the same title invalidates its old deletion preview',async t=>{
  const {app,account,approve,stage}=await approvalApiFixture(t);
  const userId=account.user.id,goal=app.db.addGoal(userId,{title:'Gym'});
  const staged=stage(goal,'Delete Gym');
  app.db.updateGoal(userId,goal.id,{progress:50});
  assert.equal((await approve(staged.approvalId)).status,409);
  assert.ok(app.db.getGoal(userId,goal.id));
  assert.equal(app.db.getApproval(userId,staged.approvalId).status,'rejected');
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
