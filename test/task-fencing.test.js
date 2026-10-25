import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.js';
import { createOrbitServer } from '../server.js';
import { createModelClient } from '../src/model.js';
import { hashToken } from '../src/security.js';

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-task-fence-'));
  const db=openDatabase(path.join(dir,'orbit.sqlite'));
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const user=db.createUser({email:'synthetic@example.test',displayName:'Synthetic',passwordHash:'x',passwordSalt:'y',role:'owner'});
  return {db,user};
}

test('a cancelled task cannot be resurrected by an in-flight worker result',t=>{
  const {db,user}=fixture(t);
  const task=db.addTask(user.id,{title:'Synthetic',prompt:'No external calls'});
  assert.equal(db.startTask(user.id,task.id),true);
  assert.equal(db.setTaskStatus(user.id,task.id,'cancelled'),true);
  assert.equal(db.completeTask(user.id,task.id,'stale result'),false);
  assert.equal(db.getTask(user.id,task.id).status,'cancelled');
});

test('a recovered task rejects completion and lease renewal from the previous attempt',t=>{
  const {db,user}=fixture(t);
  const task=db.addTask(user.id,{title:'Synthetic',prompt:'No external calls'});
  assert.equal(db.startTask(user.id,task.id,-1000),true);
  const staleAttempt=db.getTask(user.id,task.id).attempt_count;
  assert.equal(db.recoverStaleTasks(),1);
  assert.equal(db.startTask(user.id,task.id),true);
  const currentAttempt=db.getTask(user.id,task.id).attempt_count;
  assert.ok(currentAttempt>staleAttempt);
  assert.equal(db.renewTaskLease(user.id,task.id,staleAttempt),false);
  assert.equal(db.completeClaimedTask(user.id,task.id,staleAttempt,'stale'),false);
  assert.equal(db.completeClaimedTask(user.id,task.id,currentAttempt,'current'),true);
  assert.equal(db.getTask(user.id,task.id).result,'current');
});

test('claim returns its own attempt even if another worker reclaims before the caller continues',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-task-claim-race-'));
  const model=createModelClient({NODE_ENV:'test'});
  let modelCalls=0;
  model.respond=async()=>{modelCalls++;return{text:'stale result',toolCalls:[]};};
  const app=createOrbitServer({dataDir:dir,env:{NODE_ENV:'test'},modelClient:model});
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const user=app.db.createUser({email:'claim@example.test',displayName:'Synthetic',passwordHash:'x',passwordSalt:'y',role:'owner'});
  const task=app.db.addTask(user.id,{title:'Synthetic',prompt:'No external calls'});
  const claim=app.db.claimDueTask.bind(app.db);
  let newerAttempt;
  app.db.claimDueTask=(userId,id)=>{
    const oldClaim=claim(userId,id,-1000);
    assert.equal(app.db.recoverStaleTasks(),1);
    newerAttempt=claim(userId,id).attempt_count;
    assert.ok(newerAttempt>oldClaim.attempt_count);
    return oldClaim;
  };
  let notifications=0;app.push.notify=async()=>{notifications++;};
  await app.runDueTasks();
  assert.equal(modelCalls,0,'the old caller cannot adopt the newer claim before starting model work');
  assert.equal(notifications,0);
  assert.equal(app.db.getTask(user.id,task.id).attempt_count,newerAttempt);
  assert.equal(app.db.getTask(user.id,task.id).status,'running');
});

test('a due-task batch skips work rescheduled while an earlier task runs',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-task-stale-batch-'));
  const model=createModelClient({NODE_ENV:'test'});
  let releaseFirst,entered;
  const firstStarted=new Promise(resolve=>{entered=resolve;});
  const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
  const messages=[];
  model.respond=async({message})=>{
    messages.push(message);
    if(messages.length===1){entered();await firstGate;}
    return{text:'Synthetic result',toolCalls:[]};
  };
  const app=createOrbitServer({dataDir:dir,env:{NODE_ENV:'test'},modelClient:model});
  t.after(async()=>{releaseFirst();await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const user=app.db.createUser({email:'stale-batch@example.test',displayName:'Synthetic',passwordHash:'x',passwordSalt:'y',role:'owner'});
  app.db.addTask(user.id,{title:'First',prompt:'First prompt'});
  const second=app.db.addTask(user.id,{title:'Second',prompt:'Old second prompt'});
  app.push.notify=async()=>({sent:0,failed:0});
  const run=app.runDueTasks();
  await firstStarted;
  const future=new Date(Date.now()+60_000).toISOString();
  app.db.updateTask(user.id,second.id,{prompt:'Future second prompt',scheduleAt:future});
  releaseFirst();await run;
  assert.deepEqual(messages,['First prompt'],'a stale batch must not start the newly future task');
  const current=app.db.getTask(user.id,second.id);
  assert.equal(current.schedule_at,future);
  assert.equal(current.result,null);
  assert.notEqual(current.status,'running');
});

test('a due-task batch executes the freshly edited row rather than its old prompt and recurrence',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-task-fresh-row-'));
  const model=createModelClient({NODE_ENV:'test'});
  let releaseFirst,entered;
  const firstStarted=new Promise(resolve=>{entered=resolve;});
  const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
  const messages=[];
  model.respond=async({message})=>{
    messages.push(message);
    if(messages.length===1){entered();await firstGate;}
    return{text:'Synthetic result',toolCalls:[]};
  };
  const app=createOrbitServer({dataDir:dir,env:{NODE_ENV:'test'},modelClient:model});
  t.after(async()=>{releaseFirst();await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const user=app.db.createUser({email:'fresh-row@example.test',displayName:'Synthetic',passwordHash:'x',passwordSalt:'y',role:'owner'});
  app.db.addTask(user.id,{title:'First',prompt:'First prompt'});
  const second=app.db.addTask(user.id,{title:'Second',prompt:'Old second prompt'});
  app.push.notify=async()=>({sent:0,failed:0});
  const run=app.runDueTasks();
  await firstStarted;
  app.db.updateTask(user.id,second.id,{title:'Edited second',prompt:'Current second prompt',
    scheduleAt:new Date(Date.now()-1000).toISOString(),recurrence:'daily'});
  releaseFirst();await run;
  assert.deepEqual(messages,['First prompt','Current second prompt']);
  const current=app.db.getTask(user.id,second.id);
  assert.equal(current.status,'scheduled','current daily recurrence controls the next run');
  assert.ok(new Date(current.schedule_at).valueOf()>Date.now());
});

test('editing a running task invalidates its prompt and schedule snapshot',t=>{
  const {db,user}=fixture(t);
  const task=db.addTask(user.id,{title:'Original',prompt:'Original prompt'});
  const first=db.claimTask(user.id,task.id);
  const edited=db.updateTask(user.id,task.id,{prompt:'Revised prompt',scheduleAt:new Date(Date.now()-1000).toISOString()});
  assert.equal(edited.status,'queued');
  assert.equal(db.activeTaskClaim(user.id,task.id,first),false);
  const second=db.claimTask(user.id,task.id);
  assert.ok(second>first);
  assert.equal(db.completeClaimedTask(user.id,task.id,first,'stale result'),false);
  assert.equal(db.completeClaimedTask(user.id,task.id,second,'revised result'),true);
  assert.equal(db.getTask(user.id,task.id).result,'revised result');
});

test('disabled accounts cannot claim, renew, complete, or receive a task result',t=>{
  const {db,user}=fixture(t);
  const task=db.addTask(user.id,{title:'Synthetic',prompt:'No external calls'});
  const attempt=db.claimTask(user.id,task.id);
  assert.equal(db.setUserDisabled(user.id,true),true);
  assert.equal(db.activeTaskClaim(user.id,task.id,attempt),false);
  assert.equal(db.renewTaskLease(user.id,task.id,attempt),false);
  assert.equal(db.completeClaimedTask(user.id,task.id,attempt,'stale'),false);
  assert.equal(db.deliverableTask(user.id,task.id,attempt),false);
  assert.equal(db.recoverStaleTasks(),0);
  db.setTaskStatus(user.id,task.id,'queued');
  assert.equal(db.claimTask(user.id,task.id),null);
});

test('ten earlier blocked due tasks cannot hide a later eligible task in SQLite',t=>{
  const {db}=fixture(t);
  const oldDue=new Date(Date.now()-120_000).toISOString();
  const laterDue=new Date(Date.now()-60_000).toISOString();
  for(let i=0;i<10;i++){
    const blocked=db.createUser({email:`blocked-${i}@example.test`,displayName:'Synthetic',passwordHash:'x',passwordSalt:'y',role:'member'});
    db.addTask(blocked.id,{title:`Blocked ${i}`,prompt:'Do not run',scheduleAt:oldDue});
    assert.equal(i%2?db.setModerationBlocked(blocked.id,true):db.setUserDisabled(blocked.id,true),true);
  }
  const eligible=db.createUser({email:'eligible@example.test',displayName:'Synthetic',passwordHash:'x',passwordSalt:'y',role:'member'});
  const task=db.addTask(eligible.id,{title:'Eligible',prompt:'Run',scheduleAt:laterDue});
  const due=db.dueTasks();
  assert.deepEqual(due.map(row=>row.id),[task.id]);
  assert.equal(db.claimDueTask(eligible.id,task.id)?.id,task.id);
});

test('cancelling while model work is in flight discards its result and notifications',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-task-interleave-'));
  const model=createModelClient({NODE_ENV:'test'});
  let release,started;
  const entered=new Promise(resolve=>{started=resolve;});
  model.respond=async()=>{await new Promise(resolve=>{release=resolve;started();});return{text:'Cancelled work result',toolCalls:[]};};
  const app=createOrbitServer({dataDir:dir,env:{NODE_ENV:'test'},modelClient:model});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const user=app.db.createUser({email:'cancel@example.test',displayName:'Synthetic',passwordHash:'x',passwordSalt:'y',role:'owner'});
  const task=app.db.addTask(user.id,{title:'Synthetic',prompt:'No external calls'});
  const token='synthetic-task-session',csrf='synthetic-csrf';
  app.db.createSession({tokenHash:hashToken(token),userId:user.id,csrfToken:csrf,expiresAt:new Date(Date.now()+60_000).toISOString(),userAgent:'synthetic-test'});
  let notifications=0;
  app.push.notify=async()=>{notifications++;};
  const run=app.runDueTasks();
  await entered;
  const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/tasks/${task.id}/cancel`,{
    method:'POST',headers:{Cookie:`orbit_session=${token}`,'X-Orbit-CSRF':csrf,'Content-Type':'application/json'},body:'{}',
  });
  assert.equal(response.status,200);
  release();
  await run;
  assert.equal(app.db.getTask(user.id,task.id).status,'cancelled');
  assert.equal(app.db.listArtifacts(user.id).length,0);
  assert.equal(app.db.listEvents(user.id).filter(event=>event.type==='task_completed').length,0);
  assert.equal(notifications,0);
});

test('account disable during model work blocks another model attempt and delivery',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-task-disabled-'));
  const model=createModelClient({NODE_ENV:'test'});
  let release,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  model.respond=async({assertActive})=>{
    assert.equal(typeof assertActive,'function');
    assertActive();
    await new Promise(resolve=>{release=resolve;entered();});
    assert.throws(()=>assertActive(),/no longer active/,'a fallback request must fail its active-claim check');
    return{text:'disabled result',toolCalls:[]};
  };
  const app=createOrbitServer({dataDir:dir,env:{NODE_ENV:'test'},modelClient:model});
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const user=app.db.createUser({email:'disabled@example.test',displayName:'Synthetic',passwordHash:'x',passwordSalt:'y',role:'owner'});
  const task=app.db.addTask(user.id,{title:'Synthetic',prompt:'No external calls'});
  let notifications=0;app.push.notify=async()=>{notifications++;};
  const run=app.runDueTasks();
  await started;
  app.db.setUserDisabled(user.id,true);
  release();await run;
  assert.equal(app.db.getTask(user.id,task.id).result,null);
  assert.equal(app.db.listArtifacts(user.id).length,0);
  assert.equal(notifications,0);
});

test('cancellation after completion blocks the next external notification',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-task-delivery-race-'));
  const model=createModelClient({NODE_ENV:'test'});
  model.respond=async()=>({text:'Synthetic result',toolCalls:[]});
  const app=createOrbitServer({dataDir:dir,env:{NODE_ENV:'test'},modelClient:model});
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const user=app.db.createUser({email:'delivery@example.test',displayName:'Synthetic',passwordHash:'x',passwordSalt:'y',role:'owner'});
  const task=app.db.addTask(user.id,{title:'Synthetic',prompt:'No external calls'});
  let webSends=0,nativeSends=0;
  app.push.notify=async(_userId,_title,_body,_data,canDeliver)=>{
    assert.equal(canDeliver(),true);
    webSends++;app.db.setTaskStatus(user.id,task.id,'cancelled');
    assert.equal(canDeliver(),false,'the per-device guard observes cancellation');
    return{sent:1,failed:0};
  };
  app.apns.notify=async()=>{nativeSends++;return{sent:1,failed:0};};
  await app.runDueTasks();
  assert.equal(webSends,1,'the first already-started provider send cannot be retracted');
  assert.equal(nativeSends,0,'the next provider send sees cancellation');
  assert.equal(app.db.getTask(user.id,task.id).status,'cancelled');
});

test('shutdown waits for task work and requeues its in-flight result without delivery',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-task-shutdown-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const model=createModelClient({NODE_ENV:'test'});
  let entered,release;
  const started=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  model.respond=async({assertActive})=>{
    entered();await gate;
    assert.throws(()=>assertActive(),/no longer active/);
    return{text:'stale shutdown result',toolCalls:[]};
  };
  const app=createOrbitServer({dataDir:dir,env:{NODE_ENV:'test'},modelClient:model});
  const user=app.db.createUser({email:'shutdown@example.test',displayName:'Synthetic',passwordHash:'x',passwordSalt:'y',role:'owner'});
  const task=app.db.addTask(user.id,{title:'Synthetic',prompt:'No external calls'});
  let notifications=0;app.push.notify=async()=>{notifications++;};
  const run=app.runDueTasks();
  await started;
  let closed=false;
  const close=app.close().then(()=>{closed=true;});
  await new Promise(resolve=>setImmediate(resolve));
  const closedBeforeWorker=closed;
  release();
  const outcomes=await Promise.allSettled([run,close]);
  assert.equal(closedBeforeWorker,false,'shutdown must join the in-flight task worker');
  assert.deepEqual(outcomes.map(outcome=>outcome.status),['fulfilled','fulfilled']);
  const reopened=openDatabase(path.join(dir,'orbit.sqlite'));
  try{
    assert.equal(reopened.getTask(user.id,task.id).status,'queued');
    assert.equal(reopened.listArtifacts(user.id).length,0);
  }finally{await reopened.close();}
  assert.equal(notifications,0);
});

test('shutdown during device delivery prevents the next unstarted task send',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-task-send-shutdown-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const model=createModelClient({NODE_ENV:'test'});
  model.respond=async()=>({text:'Synthetic result',toolCalls:[]});
  const app=createOrbitServer({dataDir:dir,env:{NODE_ENV:'test'},modelClient:model});
  const user=app.db.createUser({email:'send-shutdown@example.test',displayName:'Synthetic',passwordHash:'x',passwordSalt:'y',role:'owner'});
  app.db.addTask(user.id,{title:'Synthetic',prompt:'No external calls'});
  let entered,release;
  const started=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  let first=0,second=0,native=0;
  app.push.notify=async(_userId,_title,_body,_data,canDeliver)=>{
    if(canDeliver()){entered();await gate;first++;}
    if(canDeliver())second++;
    return{sent:first+second,failed:0};
  };
  app.apns.notify=async()=>{native++;return{sent:1,failed:0};};
  const run=app.runDueTasks();
  await started;
  const close=app.close();
  release();
  const outcomes=await Promise.allSettled([run,close]);
  assert.deepEqual(outcomes.map(outcome=>outcome.status),['fulfilled','fulfilled']);
  assert.equal(first,1,'an already-started send cannot be recalled');
  assert.equal(second,0,'a new device send must see shutdown');
  assert.equal(native,0,'a new channel send must see shutdown');
});
