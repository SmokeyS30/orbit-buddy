import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { openDatabase } from '../src/database.js';
import { openPostgres } from '../src/db/postgres-adapter.js';
import { hashToken } from '../src/security.js';
import { nyDayKey } from '../src/subscriptions.js';
import { createOrbitServer } from '../server.js';

async function fixture(extraEnv={},modelClient=null){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-ai-admission-'));
  let modelCalls=0;
  const modelReply=async()=>{modelCalls++;return{text:'[]',toolCalls:[]};};
  const app=createOrbitServer({dataDir:directory,env:{NODE_ENV:'test',...extraEnv},modelClient:modelClient||{respond:modelReply,respondChitchat:modelReply}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  return{app,directory,base:`http://127.0.0.1:${app.server.address().port}`,modelCalls:()=>modelCalls,
    async close(){await app.close();fs.rmSync(directory,{recursive:true,force:true});}};
}
const upload={messages:Array.from({length:20},(_,i)=>({role:'user',content:`I consistently enjoy morning walks and reading history books. Note ${i}`}))};
const headers=({cookie,csrf})=>({Cookie:cookie,'X-Orbit-CSRF':csrf,'Content-Type':'application/json'});
async function auth(base,endpoint,payload){
  const response=await fetch(`${base}${endpoint}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  assert.ok([200,201].includes(response.status));
  const body=await response.json();
  return{cookie:response.headers.get('set-cookie').split(';')[0],csrf:body.csrf,user:body.user};
}
const importRequest=(base,credentials)=>fetch(`${base}/api/import/conversations`,{
  method:'POST',headers:headers(credentials),body:JSON.stringify(upload)});

test('demo and paused accounts cannot start model-backed imports',async t=>{
  const fx=await fixture();t.after(()=>fx.close());
  const owner=await auth(fx.base,'/api/auth/register',{email:'owner@example.test',displayName:'Owner',password:'correct horse battery staple'});
  const demo=await auth(fx.base,'/api/demo/start',{});
  const me=await (await fetch(`${fx.base}/api/auth/me`,{headers:headers(demo)})).json();
  assert.equal(me.user.isDemo,true,'reconnected demo sessions must retain their demo status');
  const denied=await importRequest(fx.base,demo);
  assert.equal(denied.status,403);
  const demoTimeline=await fetch(`${fx.base}/api/timeline?months=1`,{headers:headers(demo)});
  assert.equal(demoTimeline.status,200);
  assert.equal(fx.modelCalls(),0);
  fx.app.db.setSetting('system_paused','true');
  const paused=await importRequest(fx.base,owner);
  assert.equal(paused.status,423);
  assert.equal(fx.modelCalls(),0);
  assert.deepEqual(fx.app.db.listImportJobs(owner.user.id),[]);
});

test('import job admission is atomic per user and bounds daily starts',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-import-limit-'));
  const db=openDatabase(path.join(directory,'orbit.sqlite'));
  try{
    const user=db.createUser({email:'owner@example.test',displayName:'Owner',passwordHash:'synthetic',passwordSalt:'synthetic',role:'owner'});
    const first=db.createImportJob(user.id,'first.json');
    assert.ok(first);
    assert.equal(db.createImportJob(user.id,'parallel.json'),null,'a processing job blocks a second import');
    db.updateImportJob(user.id,first.id,{status:'done'});
    const second=db.createImportJob(user.id,'second.json');assert.ok(second);
    db.updateImportJob(user.id,second.id,{status:'done'});
    const third=db.createImportJob(user.id,'third.json');assert.ok(third);
    db.updateImportJob(user.id,third.id,{status:'done'});
    assert.equal(db.createImportJob(user.id,'fourth.json'),null,'at most three starts in a rolling day');
  }finally{db.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('PostgreSQL import admission serializes simultaneous starts',async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  const db=await openPostgres(process.env.TEST_DATABASE_URL);
  let user=null;
  try{
    user=await db.createUser({email:`import-${randomUUID()}@example.test`,displayName:'Synthetic',passwordHash:'synthetic',passwordSalt:'synthetic',role:'member'});
    const starts=await Promise.all([db.createImportJob(user.id,'one.json'),db.createImportJob(user.id,'two.json')]);
    assert.equal(starts.filter(Boolean).length,1,'only one concurrent import starts');
    await db.updateImportJob(user.id,starts.find(Boolean).id,{status:'done'});
    for(let i=0;i<2;i++){
      const next=await db.createImportJob(user.id,`next-${i}.json`);assert.ok(next);
      await db.updateImportJob(user.id,next.id,{status:'done'});
    }
    assert.equal(await db.createImportJob(user.id,'fourth.json'),null);
  }finally{
    if(user)await db.run('DELETE FROM users WHERE id=?',user.id);
    await db.close();
  }
});

test('PostgreSQL authenticated demo sessions retain their demo flag',async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  const db=await openPostgres(process.env.TEST_DATABASE_URL);
  let demo=null;
  try{
    demo=await db.createDemoUser();
    const tokenHash=`demo-${randomUUID()}`;
    await db.createSession({tokenHash,userId:demo.id,csrfToken:'synthetic',expiresAt:new Date(Date.now()+60_000).toISOString(),userAgent:'synthetic'});
    assert.equal((await db.getSession(tokenHash)).is_demo,1);
  }finally{
    if(demo)await db.deleteDemoUser(demo.id);
    await db.close();
  }
});

test('timeline reuses a fresh current-month narrative and does no model work while paused',async t=>{
  const fx=await fixture();t.after(()=>fx.close());
  const owner=await auth(fx.base,'/api/auth/register',{email:'owner@example.test',displayName:'Owner',password:'correct horse battery staple'});
  fx.app.db.addMemory(owner.user.id,'I enjoy reading history books on my daily morning walk.',{source:'user'});
  const first=await fetch(`${fx.base}/api/timeline?months=1`,{headers:headers(owner)});
  const second=await fetch(`${fx.base}/api/timeline?months=1`,{headers:headers(owner)});
  assert.equal(first.status,200);assert.equal(second.status,200);
  assert.equal(fx.modelCalls(),1,'repeated reads must use the current-month cache');
  fx.app.db.setSetting('system_paused','true');
  const paused=await fetch(`${fx.base}/api/timeline?months=1`,{headers:headers(owner)});
  assert.equal(paused.status,200);
  assert.equal(fx.modelCalls(),1,'pause must prevent timeline model calls');
});

test('timeline does not save or return an in-flight model result after pause or account removal',async t=>{
  for(const revoke of ['pause','disable','delete']){
    let started,release;
    let abortedCode=null;
    const entered=new Promise(resolve=>{started=resolve;});
    const gate=new Promise(resolve=>{release=resolve;});
    const fx=await fixture({}, {respond:async({assertActive})=>{
      started();await gate;
      try{await assertActive();}catch(error){abortedCode=error.code;throw error;}
      return{text:'Private generated narrative',toolCalls:[]};
    }});
    t.after(async()=>{release();await fx.close();});
    const owner=await auth(fx.base,'/api/auth/register',{email:'owner@example.test',displayName:'Owner',password:'correct horse battery staple'});
    fx.app.db.addMemory(owner.user.id,'A synthetic private memory.',{source:'user'});
    const pending=fetch(`${fx.base}/api/timeline?months=1`,{headers:headers(owner)});
    await entered;
    if(revoke==='pause')fx.app.db.setSetting('system_paused','true');
    else if(revoke==='disable')fx.app.db.setUserDisabled(owner.user.id,true);
    else fx.app.db.deleteUserAccount(owner.user.id);
    release();
    const response=await pending;
    const body=await response.text();
    assert.doesNotMatch(body,/Private generated narrative/,`${revoke} must suppress the in-flight result`);
    assert.equal(abortedCode,'REPLY_LEASE_LOST',`${revoke} must stop model retries and fallbacks`);
    assert.equal(fx.app.db.getTimelineNarrativeRecord(owner.user.id,new Date().toISOString().slice(0,7)),null);
  }
});

test('simultaneous cold timeline reads admit only one model call per account',async t=>{
  let started,release,calls=0;
  const entered=new Promise(resolve=>{started=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const fx=await fixture({}, {respond:async()=>{calls++;started();await gate;return{text:'A generated chapter',toolCalls:[]};}});
  t.after(async()=>{release();await fx.close();});
  const owner=await auth(fx.base,'/api/auth/register',{email:'owner@example.test',displayName:'Owner',password:'correct horse battery staple'});
  fx.app.db.addMemory(owner.user.id,'A synthetic memory.',{source:'user'});
  const requests=Array.from({length:3},()=>fetch(`${fx.base}/api/timeline?months=1`,{headers:headers(owner)}));
  await entered;
  await new Promise(resolve=>setTimeout(resolve,50));
  try{assert.equal(calls,1,'cold requests must share a per-user generation admission');}
  finally{release();await Promise.allSettled(requests);}
});

test('PostgreSQL timeline admission serializes replicas and fences stale results',async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  const first=await openPostgres(process.env.TEST_DATABASE_URL);
  const second=await openPostgres(process.env.TEST_DATABASE_URL);
  let user=null;
  try{
    user=await first.createUser({email:`timeline-${randomUUID()}@example.test`,displayName:'Synthetic',passwordHash:'synthetic',passwordSalt:'synthetic',role:'member'});
    await first.setSetting('system_paused','false');
    const month=new Date().toISOString().slice(0,7);
    const claims=await Promise.all([first.claimTimelineNarrative(user.id,month),second.claimTimelineNarrative(user.id,month)]);
    assert.equal(claims.filter(Boolean).length,1,'replicas share one per-user claim');
    const winner=claims[0]?first:second,loser=claims[0]?second:first,token=claims.find(Boolean);
    assert.equal(await loser.completeTimelineNarrative(user.id,month,'wrong-token','wrong'),false);
    assert.equal(await winner.completeTimelineNarrative(user.id,month,token,'Synthetic chapter'),true);
    assert.equal(await loser.claimTimelineNarrative(user.id,month),null,'a stale read cannot regenerate an existing month');
    const next=await loser.claimTimelineNarrative(user.id,month,new Date(Date.now()+1000).toISOString());
    assert.ok(next,'an expired cache can be regenerated');
    await first.run('UPDATE timeline_generation_leases SET expires_at=? WHERE user_id=?','2000-01-01T00:00:00.000Z',user.id);
    const replacement=await winner.claimTimelineNarrative(user.id,month,new Date(Date.now()+1000).toISOString());
    assert.ok(replacement,'an expired lease can be reclaimed');
    assert.equal(await loser.completeTimelineNarrative(user.id,month,next,'stale worker result'),false);
    await first.setUserDisabled(user.id,true);
    assert.equal(await winner.completeTimelineNarrative(user.id,month,replacement,'must not save'),false);
    assert.equal((await first.getTimelineNarrativeRecord(user.id,month)).narrative,'Synthetic chapter');
    await loser.releaseTimelineNarrative(user.id,next);
    await winner.releaseTimelineNarrative(user.id,replacement);
  }finally{
    if(user)await first.run('DELETE FROM users WHERE id=?',user.id);
    await second.close();await first.close();
  }
});

test('pausing during an import stops later model chunks',async t=>{
  let beginFirst,releaseFirst,calls=0,abortedCode=null;
  const firstStarted=new Promise(resolve=>{beginFirst=resolve;});
  const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
  const fx=await fixture({}, {respond:async({assertActive})=>{
    calls++;if(calls===1){beginFirst();await firstGate;}
    try{await assertActive();}catch(error){abortedCode=error.code;throw error;}
    return{text:'[{"content":"I enjoy a synthetic morning reading habit every day.","kind":"preference","confidence":0.9}]',toolCalls:[]};
  }});
  t.after(async()=>{releaseFirst();await fx.close();});
  const owner=await auth(fx.base,'/api/auth/register',{email:'owner@example.test',displayName:'Owner',password:'correct horse battery staple'});
  const many={messages:Array.from({length:45},(_,i)=>({role:'user',content:`I enjoy the same substantial morning reading habit every day, message ${i}.`}))};
  const response=await fetch(`${fx.base}/api/import/conversations`,{method:'POST',headers:headers(owner),body:JSON.stringify(many)});
  assert.equal(response.status,202);
  const {job}=await response.json();
  let startTimeout;
  try{await Promise.race([firstStarted,new Promise((_,reject)=>{startTimeout=setTimeout(()=>reject(new Error('import did not start')),5000);})]);}
  finally{clearTimeout(startTimeout);}
  fx.app.db.setSetting('system_paused','true');
  releaseFirst();
  let status=null;
  for(let i=0;i<50;i++){
    status=fx.app.db.getImportJob(owner.user.id,job.id)?.status;
    if(status==='failed')break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(status,'failed');
  assert.equal(calls,1,'a pause prevents the second chunk from starting');
  assert.equal(abortedCode,'REPLY_LEASE_LOST','a pause must stop model retries and fallbacks');
  assert.equal(fx.app.db.listMemorySuggestions(owner.user.id).length,0,'the in-flight result is not persisted after pause');
});

test('an expired import worker cannot save after a replacement job starts',async t=>{
  let started,release;
  const entered=new Promise(resolve=>{started=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const fx=await fixture({}, {respond:async()=>{started();await gate;return{text:'[{"content":"I read synthetic books every morning.","kind":"preference","confidence":0.9}]',toolCalls:[]};}});
  t.after(async()=>{release();await fx.close();});
  const owner=await auth(fx.base,'/api/auth/register',{email:'owner@example.test',displayName:'Owner',password:'correct horse battery staple'});
  const response=await importRequest(fx.base,owner);
  assert.equal(response.status,202);
  const {job}=await response.json();
  await entered;
  const raw=new DatabaseSync(path.join(fx.directory,'orbit.sqlite'));
  try{raw.prepare('UPDATE import_jobs SET updated_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',job.id);}
  finally{raw.close();}
  const replacement=fx.app.db.createImportJob(owner.user.id,'synthetic-replacement.json');
  assert.ok(replacement);
  assert.equal(fx.app.db.getImportJob(owner.user.id,job.id).status,'failed');
  release();
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(fx.app.db.listMemorySuggestions(owner.user.id).length,0);
  assert.equal(fx.app.db.getImportJob(owner.user.id,job.id).status,'failed');
  assert.equal(fx.app.db.getImportJob(owner.user.id,replacement.id).status,'processing');
});

test('an import paused between acceptance and worker start fails instead of blocking the queue',async t=>{
  const fx=await fixture();t.after(()=>fx.close());
  const owner=await auth(fx.base,'/api/auth/register',{email:'owner@example.test',displayName:'Owner',password:'correct horse battery staple'});
  const original=fx.app.db.createImportJob.bind(fx.app.db);
  fx.app.db.createImportJob=(...args)=>{
    const job=original(...args);
    fx.app.db.setSetting('system_paused','true');
    return job;
  };
  const response=await importRequest(fx.base,owner);
  assert.equal(response.status,202);
  const {job}=await response.json();
  for(let i=0;i<50&&fx.app.db.getImportJob(owner.user.id,job.id)?.status==='processing';i++)
    await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(fx.app.db.getImportJob(owner.user.id,job.id)?.status,'failed');
  assert.equal(fx.modelCalls(),0);
});

test('disabled and deleted accounts cannot persist an in-flight import result',async t=>{
  for(const revoke of ['disable','delete']){
    let started,release;
    const entered=new Promise(resolve=>{started=resolve;});
    const gate=new Promise(resolve=>{release=resolve;});
    const fx=await fixture({}, {respond:async()=>{started();await gate;return{text:'[{"content":"I read synthetic books every morning.","kind":"preference","confidence":0.9}]',toolCalls:[]};}});
    t.after(async()=>{release();await fx.close();});
    const owner=await auth(fx.base,'/api/auth/register',{email:'owner@example.test',displayName:'Owner',password:'correct horse battery staple'});
    const response=await importRequest(fx.base,owner);
    assert.equal(response.status,202);
    const {job}=await response.json();
    await entered;
    if(revoke==='disable')fx.app.db.setUserDisabled(owner.user.id,true);
    else fx.app.db.deleteUserAccount(owner.user.id);
    release();
    for(let i=0;i<50&&fx.app.db.getImportJob(owner.user.id,job.id)?.status==='processing';i++)
      await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(fx.app.db.listMemorySuggestions(owner.user.id).length,0);
    assert.notEqual(fx.app.db.getImportJob(owner.user.id,job.id)?.status,'done');
  }
});

test('PostgreSQL replacement import fences an expired worker across connections',async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  const first=await openPostgres(process.env.TEST_DATABASE_URL);
  const second=await openPostgres(process.env.TEST_DATABASE_URL);
  let user=null;
  try{
    user=await first.createUser({email:`import-fence-${randomUUID()}@example.test`,displayName:'Synthetic',passwordHash:'synthetic',passwordSalt:'synthetic',role:'member'});
    const old=await first.createImportJob(user.id,'old.json');
    await first.run('UPDATE import_jobs SET updated_at=? WHERE id=?','2000-01-01T00:00:00.000Z',old.id);
    const replacement=await second.createImportJob(user.id,'replacement.json');
    assert.ok(replacement);
    assert.equal(await first.addImportSuggestionIfCurrent(user.id,old.id,'I read synthetic books every morning.'),null);
    assert.equal(await first.updateImportJobIfCurrent(user.id,old.id,{status:'done'}),null);
    assert.equal((await second.getImportJob(user.id,replacement.id)).status,'processing');
    assert.equal((await first.listMemorySuggestions(user.id)).length,0);
  }finally{
    if(user)await first.run('DELETE FROM import_jobs WHERE user_id=?',user.id);
    if(user)await first.run('DELETE FROM users WHERE id=?',user.id);
    await second.close();await first.close();
  }
});

test('regeneration consumes the same enforced daily AI allowance as chat',async t=>{
  const key=generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({type:'pkcs8',format:'pem'});
  const fx=await fixture({SUBSCRIPTIONS_ENABLED:'true',APPSTORE_SANDBOX:'true',APPSTORE_ISSUER_ID:'synthetic',APPSTORE_KEY_ID:'synthetic',APPSTORE_PRIVATE_KEY_P8:key});
  t.after(()=>fx.close());
  const member=fx.app.db.createUser({email:'member@example.test',displayName:'Member',passwordHash:'synthetic',passwordSalt:'synthetic',role:'member'});
  const token='synthetic-member-session',csrf='synthetic-csrf';
  fx.app.db.createSession({tokenHash:hashToken(token),userId:member.id,csrfToken:csrf,expiresAt:new Date(Date.now()+60_000).toISOString(),userAgent:'synthetic'});
  const conversation=fx.app.db.ensureDefaultConversation(member.id);
  fx.app.db.addMessage(member.id,conversation.id,'user','Please explain this synthetic test prompt in detail.');
  const assistant=fx.app.db.addMessage(member.id,conversation.id,'assistant','Synthetic previous answer.');
  assert.equal(fx.app.db.getDailyUsageCount(member.id,nyDayKey()),0);
  const response=await fetch(`${fx.base}/api/chat/messages/${assistant.id}/regenerate`,{method:'POST',headers:headers({cookie:`orbit_session=${token}`,csrf})});
  assert.equal(response.status,202);
  assert.equal(fx.app.db.getDailyUsageCount(member.id,nyDayKey()),1);
});

test('rejected regeneration keeps the reply and does not spend a daily allowance in SQLite',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-regen-admission-'));
  const db=openDatabase(path.join(directory,'orbit.sqlite'));
  try{
    const user=db.createUser({email:'member@example.test',displayName:'Member',passwordHash:'synthetic',passwordSalt:'synthetic',role:'member'});
    const conversation=db.ensureDefaultConversation(user.id);
    const prompt=db.addMessage(user.id,conversation.id,'user','Synthetic question.');
    const reply=db.addMessage(user.id,conversation.id,'assistant','Synthetic reply.');
    const policy={enforced:true,day:nyDayKey(),limit:1,plan:'included'};
    assert.ok(db.acceptRegenerateReplyJob(user.id,conversation.id,prompt.id,reply.id,null,policy)?.job);
    assert.equal(db.acceptRegenerateReplyJob(user.id,conversation.id,prompt.id,reply.id,null,policy),null);
    assert.equal(db.getDailyUsageCount(user.id,policy.day),1,'duplicate acceptance does not spend twice');
    const another=db.addMessage(user.id,conversation.id,'assistant','Another synthetic reply.');
    assert.equal(db.acceptRegenerateReplyJob(user.id,conversation.id,prompt.id,another.id,null,policy)?.quotaDenied?.allowed,false);
    assert.ok(db.getMessage(user.id,another.id),'quota denial leaves the target intact');
    assert.equal(db.getDailyUsageCount(user.id,policy.day),1);
  }finally{db.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('PostgreSQL simultaneous regeneration accepts and charges once',async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  const first=await openPostgres(process.env.TEST_DATABASE_URL);
  const second=await openPostgres(process.env.TEST_DATABASE_URL);
  let user=null;
  try{
    user=await first.createUser({email:`regen-${randomUUID()}@example.test`,displayName:'Synthetic',passwordHash:'synthetic',passwordSalt:'synthetic',role:'member'});
    const conversation=await first.ensureDefaultConversation(user.id);
    const prompt=await first.addMessage(user.id,conversation.id,'user','Synthetic question.');
    const reply=await first.addMessage(user.id,conversation.id,'assistant','Synthetic reply.');
    const policy={enforced:true,day:nyDayKey(),limit:1,plan:'included'};
    const results=await Promise.all([first.acceptRegenerateReplyJob(user.id,conversation.id,prompt.id,reply.id,null,policy),second.acceptRegenerateReplyJob(user.id,conversation.id,prompt.id,reply.id,null,policy)]);
    assert.equal(results.filter(result=>result?.job).length,1);
    assert.equal(await first.getDailyUsageCount(user.id,policy.day),1);
    const another=await first.addMessage(user.id,conversation.id,'assistant','Another synthetic reply.');
    assert.equal((await second.acceptRegenerateReplyJob(user.id,conversation.id,prompt.id,another.id,null,policy))?.quotaDenied?.allowed,false);
    assert.ok(await first.getMessage(user.id,another.id));
    assert.equal(await first.getDailyUsageCount(user.id,policy.day),1);
  }finally{
    if(user)await first.run('DELETE FROM users WHERE id=?',user.id);
    await second.close();await first.close();
  }
});
