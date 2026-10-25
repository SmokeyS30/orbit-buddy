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
