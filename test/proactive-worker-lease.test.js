import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createOrbitServer} from '../server.js';
import {createModelClient} from '../src/model.js';

test('two replicas do not run the same due follow-up concurrently',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-proactive-replicas-'));
  const dbPath=path.join(dir,'shared.sqlite');
  let release,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const first=createModelClient({NODE_ENV:'test'}),second=createModelClient({NODE_ENV:'test'});
  let secondCalls=0,held=false;
  first.respond=async()=>{if(!held){held=true;await new Promise(resolve=>{release=resolve;entered();});}return{text:'Synthetic follow-up',toolCalls:[]};};
  second.respond=async()=>{secondCalls++;return{text:'Duplicate follow-up',toolCalls:[]};};
  const a=createOrbitServer({dataDir:path.join(dir,'a'),dbPath,env:{NODE_ENV:'test'},modelClient:first});
  const b=createOrbitServer({dataDir:path.join(dir,'b'),dbPath,env:{NODE_ENV:'test'},modelClient:second});
  t.after(async()=>{release?.();await a.close();await b.close();fs.rmSync(dir,{recursive:true,force:true});});
  const user=a.db.createUser({email:'proactive-replica@example.test',displayName:'Synthetic',passwordHash:'x',passwordSalt:'y',role:'owner'});
  a.db.addFollowUp(user.id,{description:'synthetic appointment',dueDate:'2026-10-28'});
  const nowMs=Date.UTC(2026,9,28,15,0,0); // 11:00 in New York
  const runA=a.runProactiveChecks(nowMs);
  await started;
  await b.runProactiveChecks(nowMs);
  assert.equal(secondCalls,0);
  release();
  await runA;
  assert.equal(a.db.listEvents(user.id).filter(event=>event.type==='followup_sent').length,1);
});
