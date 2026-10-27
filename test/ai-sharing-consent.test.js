import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createOrbitServer } from '../server.js';
import { consentGatedModel } from '../src/ai-sharing.js';
import { openPostgres } from '../src/db/postgres-adapter.js';

async function fixture(t) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-ai-consent-'));
  let calls=0;
  const modelClient={configured:true,model:'synthetic',fallbackModel:null,
    diagnostics:()=>({provider:'openai',state:'ready'}),checkConnection:async()=>({provider:'openai',state:'ready'}),
    respond:async({assertActive})=>{await assertActive();calls++;return{text:'Synthetic reply',toolCalls:[]};},
    respondChitchat:async({assertActive})=>{await assertActive();calls++;return{text:'Synthetic reply',toolCalls:[]};}};
  const app=createOrbitServer({dataDir,env:{NODE_ENV:'test',SIGNUP_RISK_MODE:'off',OPENAI_API_KEY:'synthetic-unused-key'},modelClient});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const registration=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'owner@example.test',displayName:'Owner',password:'correct horse battery staple'})});
  assert.equal(registration.status,201);
  const body=await registration.json();
  const headers={Cookie:registration.headers.get('set-cookie').split(';')[0],'X-Orbit-CSRF':body.csrf,'Content-Type':'application/json'};
  return {app,base,headers,userId:body.user.id,calls:()=>calls};
}

test('AI sharing starts off, requires an explicit boolean choice, and is account bound',async t=>{
  const f=await fixture(t);
  const get=()=>fetch(f.base+'/api/ai-sharing-consent',{headers:f.headers});
  const change=(value,headers=f.headers)=>fetch(f.base+'/api/ai-sharing-consent',{method:'POST',headers,body:JSON.stringify(value)});
  assert.deepEqual(await(await get()).json(),{accepted:false});
  assert.equal((await change({accepted:'true'})).status,400);
  assert.equal((await change({accepted:true},{...f.headers,'X-Orbit-CSRF':'invalid'})).status,403);
  assert.equal((await change({accepted:true})).status,200);
  assert.ok(f.app.db.getUserById(f.userId).ai_sharing_consent_at);
  assert.deepEqual(await(await get()).json(),{accepted:true});
  assert.equal((await change({accepted:false})).status,200);
  assert.equal(f.app.db.getUserById(f.userId).ai_sharing_consent_at,null);
});

test('chat and voice transcription refuse unconsented input before provider access',async t=>{
  const f=await fixture(t);
  const chat=()=>fetch(f.base+'/api/chat',{method:'POST',headers:f.headers,body:JSON.stringify({message:'private synthetic chat'})});
  const voice=()=>fetch(f.base+'/api/voice/transcribe',{method:'POST',headers:f.headers,body:JSON.stringify({audio:Buffer.from('synthetic audio').toString('base64'),mimeType:'audio/webm'})});
  assert.equal((await chat()).status,403);
  assert.equal((await voice()).status,403);
  assert.equal(f.calls(),0);
  assert.equal((await fetch(f.base+'/api/ai-sharing-consent',{method:'POST',headers:f.headers,body:'{"accepted":true}'})).status,200);
  assert.equal((await chat()).status,202);
  const until=Date.now()+3000;
  while(!f.calls()&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(f.calls(),1);
  assert.equal((await fetch(f.base+'/api/ai-sharing-consent',{method:'POST',headers:f.headers,body:'{"accepted":false}'})).status,200);
  assert.equal((await chat()).status,403);
  assert.equal((await voice()).status,403);
  assert.equal(f.calls(),1);
});

test('unconsented imports and writing-voice learning are refused; due tasks remain queued',async t=>{
  const f=await fixture(t);
  const imported=await fetch(f.base+'/api/import/conversations',{method:'POST',headers:f.headers,body:JSON.stringify({messages:[{role:'user',content:'synthetic'}]})});
  assert.equal(imported.status,403);
  assert.deepEqual(f.app.db.listImportJobs(f.userId),[]);
  const writing=await fetch(f.base+'/api/writing-voice/learn',{method:'POST',headers:f.headers,body:'{}'});
  assert.equal(writing.status,403);
  const added=await fetch(f.base+'/api/tasks',{method:'POST',headers:f.headers,body:JSON.stringify({title:'Synthetic reminder',prompt:'Remember the test'})});
  assert.equal(added.status,201);
  const task=await added.json();
  await f.app.runDueTasks();
  assert.equal(f.app.db.getTask(f.userId,task.id).status,'queued');
  assert.equal(f.calls(),0);
});

test('unconsented due tasks do not occupy the whole worker batch',async t=>{
  const f=await fixture(t);
  for(let i=0;i<10;i++){
    const user=f.app.db.createUser({email:`unconsented-${i}@example.test`,displayName:'Synthetic',passwordHash:'synthetic',passwordSalt:'synthetic',role:'member'});
    f.app.db.addTask(user.id,{title:`Old task ${i}`,prompt:'Synthetic',scheduleAt:'2000-01-01T00:00:00.000Z'});
  }
  await fetch(f.base+'/api/ai-sharing-consent',{method:'POST',headers:f.headers,body:'{"accepted":true}'});
  const allowed=f.app.db.addTask(f.userId,{title:'Allowed task',prompt:'Synthetic'});
  assert.ok(f.app.db.dueTasks().some(task=>task.id===allowed.id));
});

test('withdrawal between provider attempts blocks the next request and missing identity fails closed',async()=>{
  let allowed=false,calls=0;
  const db={getUserById:async(id)=>id==='account'&&allowed?{ai_sharing_consent_at:'synthetic'}:{ai_sharing_consent_at:null}};
  const model=consentGatedModel({respond:async({assertActive})=>{await assertActive();calls++;allowed=false;await assertActive();calls++;}},db);
  await assert.rejects(()=>model.respond({message:'private'}),{code:'AI_SHARING_CONSENT_REQUIRED'});
  allowed=true;
  await assert.rejects(()=>model.respond({aiConsentUserId:'account',message:'private'}),{code:'AI_SHARING_CONSENT_REQUIRED'});
  assert.equal(calls,1,'no second provider attempt after withdrawal');
});

test('PostgreSQL consent is account scoped and withdrawal survives a fresh read',async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Use a disposable local PostgreSQL test database.');
  const db=await openPostgres(process.env.TEST_DATABASE_URL);
  const account=await db.createUser({email:`ai-consent-${randomUUID()}@example.test`,displayName:'Synthetic',passwordHash:'synthetic',passwordSalt:'synthetic',role:'member'});
  try{
    assert.equal((await db.getUserById(account.id)).ai_sharing_consent_at,null);
    assert.equal(await db.setAiSharingConsent(account.id,true),true);
    assert.ok((await db.getUserById(account.id)).ai_sharing_consent_at);
    assert.equal(await db.setAiSharingConsent(account.id,false),true);
    assert.equal((await db.getUserById(account.id)).ai_sharing_consent_at,null);
  }finally{await db.run('DELETE FROM users WHERE id=?',account.id);await db.close();}
});

test('all current model call sites identify the account for the server guard',()=>{
  for(const file of ['server.js','src/proactive-memory.js','src/memory-connections.js','src/writing-voice.js']){
    const source=fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
    for(const match of source.matchAll(/model\.respond(?:Chitchat)?\(\{/g)){
      assert.match(source.slice(match.index,match.index+100),/aiConsentUserId\s*:/,`${file} has an unbound model call`);
    }
  }
});
