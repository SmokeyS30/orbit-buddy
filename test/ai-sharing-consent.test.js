import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createOrbitServer } from '../server.js';
import { consentGatedModel, disclosedAiRecipientConfigured } from '../src/ai-sharing.js';
import { openPostgres } from '../src/db/postgres-adapter.js';
import { hashToken } from '../src/security.js';

function partialJson(base,route,headers,first,last){
  const url=new URL(route,base);
  const request=http.request(url,{method:'POST',headers:{...headers,'Content-Length':Buffer.byteLength(first+last)}});
  const response=new Promise((resolve,reject)=>{
    request.on('response',res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    request.on('error',reject);
  });
  request.write(first);
  return {request,response,finish:()=>request.end(last)};
}

async function fixture(t,extraEnv={}) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-ai-consent-'));
  let calls=0;
  const modelClient={configured:true,model:'synthetic',fallbackModel:null,
    diagnostics:()=>({provider:'openai',state:'ready'}),checkConnection:async()=>({provider:'openai',state:'ready'}),
    respond:async({assertActive})=>{await assertActive();calls++;return{text:'Synthetic reply',toolCalls:[]};},
    respondChitchat:async({assertActive})=>{await assertActive();calls++;return{text:'Synthetic reply',toolCalls:[]};}};
  const app=createOrbitServer({dataDir,env:{NODE_ENV:'test',SIGNUP_RISK_MODE:'off',OPENAI_API_KEY:'synthetic-unused-key',...extraEnv},modelClient});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const registration=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'owner@example.test',displayName:'Owner',password:'correct horse battery staple'})});
  assert.equal(registration.status,201);
  const body=await registration.json();
  const headers={Cookie:registration.headers.get('set-cookie').split(';')[0],'X-Orbit-CSRF':body.csrf,'Content-Type':'application/json'};
  return {app,base,headers,userId:body.user.id,calls:()=>calls,modelClient};
}

test('AI sharing starts off, requires an explicit boolean choice, and is account bound',async t=>{
  const f=await fixture(t);
  const get=()=>fetch(f.base+'/api/ai-sharing-consent',{headers:f.headers});
  const change=(value,headers=f.headers)=>fetch(f.base+'/api/ai-sharing-consent',{method:'POST',headers,body:JSON.stringify(value)});
  assert.deepEqual(await(await get()).json(),{accepted:false,recipientAvailable:true});
  assert.equal((await change({accepted:'true'})).status,400);
  assert.equal((await change({accepted:true},{...f.headers,'X-Orbit-CSRF':'invalid'})).status,403);
  assert.equal((await change({accepted:true})).status,200);
  assert.ok(f.app.db.getUserById(f.userId).ai_sharing_consent_at);
  assert.deepEqual(await(await get()).json(),{accepted:true,recipientAvailable:true});
  assert.equal((await change({accepted:false})).status,200);
  assert.equal(f.app.db.getUserById(f.userId).ai_sharing_consent_at,null);
});

test('a revoked session cannot grant AI sharing after a partial request body',async t=>{
  const f=await fixture(t);
  let authenticated;
  const sawAuthentication=new Promise(resolve=>{authenticated=resolve;});
  const original=f.app.db.getSession;
  f.app.db.getSession=(...args)=>{const session=original(...args);authenticated();return session;};
  t.after(()=>{f.app.db.getSession=original;});
  const pending=partialJson(f.base,'/api/ai-sharing-consent',f.headers,'{"accepted":','true}');
  await sawAuthentication;
  f.app.db.deleteSession(hashToken(f.headers.Cookie.slice('orbit_session='.length)));
  pending.finish();
  assert.equal(await pending.response,401);
  assert.equal(f.app.db.getUserById(f.userId).ai_sharing_consent_at,null);
});

test('withdrawal during a partial voice body stops a later transcription request',async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(f.base+'/api/ai-sharing-consent',{method:'POST',headers:f.headers,body:'{"accepted":true}'})).status,200);
  let checked;
  const sawConsent=new Promise(resolve=>{checked=resolve;});
  const original=f.app.db.getUserById;
  f.app.db.getUserById=(...args)=>{const user=original(...args);if(args[0]===f.userId)checked();return user;};
  t.after(()=>{f.app.db.getUserById=original;});
  const audio=Buffer.from('synthetic audio').toString('base64');
  const pending=partialJson(f.base,'/api/voice/transcribe',f.headers,'{"audio":',JSON.stringify(audio)+',"mimeType":"audio/webm"}');
  await sawConsent;
  const originalFetch=globalThis.fetch;
  let outbound=0;
  globalThis.fetch=async(...args)=>{outbound++;return {ok:true,json:async()=>({text:'synthetic'})};};
  try{
    const withdrawn=await originalFetch(f.base+'/api/ai-sharing-consent',{method:'POST',headers:f.headers,body:'{"accepted":false}'});
    assert.equal(withdrawn.status,200);
    pending.finish();
    assert.equal(await pending.response,403);
    assert.equal(outbound,0);
  }finally{globalThis.fetch=originalFetch;}
});

test('a revoked session cannot send a partially uploaded voice note',async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(f.base+'/api/ai-sharing-consent',{method:'POST',headers:f.headers,body:'{"accepted":true}'})).status,200);
  let checked;
  const sawConsent=new Promise(resolve=>{checked=resolve;});
  const original=f.app.db.getUserById;
  f.app.db.getUserById=(...args)=>{const user=original(...args);if(args[0]===f.userId)checked();return user;};
  t.after(()=>{f.app.db.getUserById=original;});
  const pending=partialJson(f.base,'/api/voice/transcribe',f.headers,'{"audio":',JSON.stringify(Buffer.from('synthetic audio').toString('base64'))+'}');
  await sawConsent;
  f.app.db.deleteSession(hashToken(f.headers.Cookie.slice('orbit_session='.length)));
  const originalFetch=globalThis.fetch;
  let outbound=0;
  globalThis.fetch=async()=>{outbound++;return {ok:true,json:async()=>({text:'synthetic'})};};
  try{pending.finish();assert.equal(await pending.response,401);assert.equal(outbound,0);}
  finally{globalThis.fetch=originalFetch;}
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

test('withdrawal during a task response defers the reminder without a failure alert',async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(f.base+'/api/ai-sharing-consent',{method:'POST',headers:f.headers,body:'{"accepted":true}'})).status,200);
  const task=f.app.db.addTask(f.userId,{title:'Synthetic reminder',prompt:'Synthetic prompt'});
  f.modelClient.respond=async({assertActive})=>{
    await assertActive();
    f.app.db.setAiSharingConsent(f.userId,false);
    return {text:'Discarded synthetic reply',toolCalls:[]};
  };
  await f.app.runDueTasks();
  const after=f.app.db.getTask(f.userId,task.id);
  assert.equal(after.status,'queued');
  assert.equal(after.result,null);
  assert.equal(f.app.db.listEvents(f.userId).some(event=>event.type==='task_failed'),false);
});

test('withdrawal between provider attempts blocks the next request and missing identity fails closed',async()=>{
  let allowed=false,calls=0;
  const db={getUserById:async(id)=>id==='account'&&allowed?{ai_sharing_consent_at:'synthetic'}:{ai_sharing_consent_at:null}};
  const model=consentGatedModel({respond:async({assertActive})=>{await assertActive();calls++;allowed=false;await assertActive();calls++;}},db,true);
  await assert.rejects(()=>model.respond({message:'private'}),{code:'AI_SHARING_CONSENT_REQUIRED'});
  allowed=true;
  await assert.rejects(()=>model.respond({aiConsentUserId:'account',message:'private'}),{code:'AI_SHARING_CONSENT_REQUIRED'});
  assert.equal(calls,1,'no second provider attempt after withdrawal');
});

test('only disclosed provider origins can receive account content',async()=>{
  assert.equal(disclosedAiRecipientConfigured({}),true);
  assert.equal(disclosedAiRecipientConfigured({OPENAI_BASE_URL:'https://api.openai.com/v1'}),true);
  for(const host of ['https://openai.example.test/v1','https://api.openai.com.evil.test/v1','https://user:pass@api.openai.com/v1','http://api.openai.com/v1'])
    assert.equal(disclosedAiRecipientConfigured({OPENAI_BASE_URL:host}),false,host);
  const azure={AZURE_OPENAI_ENDPOINT:'https://east.openai.azure.com',AZURE_OPENAI_API_KEY:'synthetic',AZURE_OPENAI_DEPLOYMENT:'synthetic'};
  assert.equal(disclosedAiRecipientConfigured(azure),true);
  assert.equal(disclosedAiRecipientConfigured({...azure,AZURE_OPENAI_SECONDARY_ENDPOINT:'https://west.cognitiveservices.azure.com',AZURE_OPENAI_SECONDARY_KEY:'synthetic'}),true);
  assert.equal(disclosedAiRecipientConfigured({...azure,AZURE_OPENAI_SECONDARY_ENDPOINT:'https://west.openai.azure.com.evil.test',AZURE_OPENAI_SECONDARY_KEY:'synthetic'}),false);
  let calls=0;
  const model=consentGatedModel({respond:async()=>{calls++;}}, {getUserById:async()=>({ai_sharing_consent_at:'synthetic'})}, false);
  await assert.rejects(()=>model.respond({aiConsentUserId:'account',message:'private'}),{code:'AI_SHARING_RECIPIENT_UNDISCLOSED'});
  assert.equal(calls,0);
});

test('an undisclosed configured model host cannot receive an AI sharing grant',async t=>{
  const f=await fixture(t,{OPENAI_BASE_URL:'https://api.openai.com.evil.test/v1'});
  const status=await(await fetch(f.base+'/api/ai-sharing-consent',{headers:f.headers})).json();
  assert.deepEqual(status,{accepted:false,recipientAvailable:false});
  const choice=await fetch(f.base+'/api/ai-sharing-consent',{method:'POST',headers:f.headers,body:'{"accepted":true}'});
  assert.equal(choice.status,503);
  assert.equal(f.app.db.getUserById(f.userId).ai_sharing_consent_at,null);
  assert.equal(f.calls(),0);
  assert.equal((await fetch(f.base+'/healthz')).status,200,'non-AI health remains available');
});

test('PostgreSQL consent is account scoped and withdrawal survives a fresh read',async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Use a disposable local PostgreSQL test database.');
  const db=await openPostgres(process.env.TEST_DATABASE_URL);
  const account=await db.createUser({email:`ai-consent-${randomUUID()}@example.test`,displayName:'Synthetic',passwordHash:'synthetic',passwordSalt:'synthetic',role:'member'});
  try{
    assert.equal((await db.getUserById(account.id)).ai_sharing_consent_at,null);
    const tokenHash=randomUUID(),csrfToken=randomUUID();
    await db.createSession({tokenHash,userId:account.id,csrfToken,expiresAt:new Date(Date.now()+60_000).toISOString(),userAgent:'synthetic'});
    assert.equal(await db.setAiSharingConsentIfSessionCurrent(account.id,tokenHash,csrfToken,true),true);
    await db.deleteSession(tokenHash);
    assert.equal(await db.setAiSharingConsentIfSessionCurrent(account.id,tokenHash,csrfToken,false),false);
    assert.equal(await db.setAiSharingConsent(account.id,true),true);
    assert.ok((await db.getUserById(account.id)).ai_sharing_consent_at);
    const task=await db.addTask(account.id,{title:'Synthetic reminder',prompt:'Synthetic'});
    const attempt=await db.startTask(account.id,task.id);
    assert.ok(attempt);
    assert.equal(await db.deferTaskForAiConsent(account.id,task.id,attempt),true);
    assert.equal((await db.getTask(account.id,task.id)).status,'queued');
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
