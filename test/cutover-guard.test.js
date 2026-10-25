import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';
import { cutoverHeld } from '../src/cutover-guard.js';
import { createModelClient } from '../src/model.js';
import { hashToken } from '../src/security.js';
import { createConnectorService } from '../src/connectors.js';

test('production cutover starts closed unless explicitly opened; unknown flags fail closed', () => {
  assert.equal(cutoverHeld({ NODE_ENV: 'production' }), true);
  assert.equal(cutoverHeld({ NODE_ENV: 'production', ORBIT_CUTOVER_HOLD: 'true' }), true);
  assert.equal(cutoverHeld({ NODE_ENV: 'production', ORBIT_CUTOVER_HOLD: 'false' }), false);
  assert.equal(cutoverHeld({ NODE_ENV: 'production', ORBIT_CUTOVER_HOLD: 'unknown' }), true);
  assert.equal(cutoverHeld({ NODE_ENV: 'test' }), false);
  assert.equal(cutoverHeld({ NODE_ENV: 'test', ORBIT_CUTOVER_HOLD: 'true' }), true);
});

test('held revision keeps chat and health available while task, proactive and connector mutation stay closed', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-cutover-held-'));
  const model=createModelClient({ NODE_ENV: 'test' });
  model.respond=async()=>({ text:'Synthetic response', toolCalls:[] });
  const app=createOrbitServer({ dataDir:dir, modelClient:model, env:{ NODE_ENV:'test', ORBIT_CUTOVER_HOLD:'true', OPENAI_MODEL:'gpt-6-luna',
    DATA_ENCRYPTION_KEY:'synthetic-only-32-character-key-123', GMAIL_CLIENT_ID:'synthetic-id', GMAIL_CLIENT_SECRET:'synthetic-secret' } });
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const user=app.db.createUser({ email:'synthetic-cutover@example.test', displayName:'Synthetic', passwordHash:'test', passwordSalt:'test', role:'owner' });
  const token='synthetic-cutover-session', csrf='synthetic-cutover-csrf';
  app.db.createSession({ tokenHash:hashToken(token), userId:user.id, csrfToken:csrf, expiresAt:new Date(Date.now()+60_000).toISOString(), userAgent:'synthetic' });
  const headers={ Cookie:`orbit_session=${token}`, 'X-Orbit-CSRF':csrf, 'Content-Type':'application/json' };

  for(const endpoint of ['/livez','/readyz','/healthz'])assert.equal((await fetch(base+endpoint)).status,200);
  assert.equal((await (await fetch(base+'/healthz')).json()).cutoverHold,true);
  assert.equal((await fetch(base+'/',{method:'HEAD'})).status,200);
  assert.equal((await fetch(base+'/api/snapshot',{headers})).status,200);
  assert.equal((await fetch(base+'/api/chat',{method:'POST',headers,body:JSON.stringify({message:'Synthetic hello'})})).status,202);

  const task=app.db.addTask(user.id,{title:'Synthetic task',prompt:'Synthetic task prompt'});
  app.db.addFollowUp(user.id,{description:'Synthetic follow-up',dueDate:'2000-01-01'});
  app.db.setSetting('registration_open','true');
  app.db.setSetting('registration_opened_at','2000-01-01T00:00:00.000Z');
  await app.runDueTasks();
  await app.runProactiveChecks(Date.parse('2026-10-22T15:00:00Z'));
  await app.checkDoorLeftOpen();
  assert.equal(app.db.getTask(user.id,task.id).status,'queued');
  assert.equal(app.db.listFollowUps(user.id).length,1);
  assert.equal(app.db.getSetting('registration_nudge_at'),null);

  app.db.saveConnector(user.id,'gmail',{accessEncrypted:'synthetic',refreshEncrypted:null,scopes:'gmail',profile:{}});
  assert.equal((await fetch(base+'/api/connectors/gmail/begin',{method:'POST',headers})).status,503);
  assert.equal((await fetch(base+'/api/connectors/gmail',{method:'DELETE',headers})).status,503);
  assert.equal((await fetch(base+'/api/connectors/gmail/callback?code=synthetic&state=synthetic')).status,503);
  assert.ok(app.db.getConnector(user.id,'gmail'));
  const service=createConnectorService({ GMAIL_CLIENT_ID:'synthetic-id', GMAIL_CLIENT_SECRET:'synthetic-secret' },app.db,
    'synthetic-only-32-character-key-123',{cutoverHold:true});
  await assert.rejects(service.getValidToken(user.id,'gmail'),error=>error.status===503);
  assert.equal((await fetch(base+'/api/tasks',{method:'POST',headers,body:JSON.stringify({title:'Route-triggered',prompt:'Synthetic'})})).status,201);
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(app.db.listTasks(user.id).some(row=>row.title==='Route-triggered'&&row.status==='queued'));
});

test('open composed revision serves chat, binds OAuth to the initiating session, and runs due tasks', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-cutover-open-'));
  const model=createModelClient({ NODE_ENV:'test' });
  model.respond=async()=>({text:'Synthetic response',toolCalls:[]});
  const app=createOrbitServer({dataDir:dir,modelClient:model,env:{NODE_ENV:'test',ORBIT_CUTOVER_HOLD:'false',
    OPENAI_MODEL:'gpt-6-luna',DATA_ENCRYPTION_KEY:'synthetic-only-32-character-key-123',
    GMAIL_CLIENT_ID:'synthetic-id',GMAIL_CLIENT_SECRET:'synthetic-secret'}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const user=app.db.createUser({email:'synthetic-open@example.test',displayName:'Synthetic',passwordHash:'test',passwordSalt:'test',role:'owner'});
  const token='synthetic-open-session',csrf='synthetic-open-csrf';
  app.db.createSession({tokenHash:hashToken(token),userId:user.id,csrfToken:csrf,
    expiresAt:new Date(Date.now()+60_000).toISOString(),userAgent:'synthetic'});
  const headers={Cookie:`orbit_session=${token}`,'X-Orbit-CSRF':csrf,'Content-Type':'application/json'};
  assert.equal((await (await fetch(base+'/healthz')).json()).cutoverHold,false);
  assert.equal((await fetch(base+'/api/chat',{method:'POST',headers,body:JSON.stringify({message:'Synthetic hello'})})).status,202);
  const begin=await fetch(base+'/api/connectors/gmail/begin',{method:'POST',headers});
  assert.equal(begin.status,200);
  const state=new URL((await begin.json()).url).searchParams.get('state');
  const bound=app.db.consumeOauthState(hashToken(state));
  assert.equal(bound.session_hash,hashToken(token));
  const task=app.db.addTask(user.id,{title:'Synthetic due task',prompt:'Synthetic prompt'});
  await app.runDueTasks();
  assert.equal(app.db.getTask(user.id,task.id).status,'completed');
});
