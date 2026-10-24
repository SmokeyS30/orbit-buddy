import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/database.js';
import { createSyncPgAdapter } from '../src/db/sync-pg-wrapper.mjs';
import { REPLY_INTERRUPTED_TEXT } from '../src/reply-jobs.js';
import { createOrbitServer } from '../server.js';
import { createModelClient } from '../src/model.js';
import { hashToken } from '../src/security.js';
import pg from 'pg';

function seed(db){
  const user=db.createUser({email:`reply-${randomUUID()}@example.com`,displayName:'Job test',passwordHash:'test',passwordSalt:'test',role:'member'});
  return{user,conversation:db.createConversation(user.id,'Job test')};
}

async function ensurePostgresSchema(url){
  const pool=new pg.Pool({connectionString:url,ssl:false});
  try{
    const schema=fs.readFileSync(new URL('../src/db/postgres-schema.sql',import.meta.url),'utf8');
    for(const sql of schema.split(';').map((x)=>x.trim()).filter(Boolean))await pool.query(sql);
  }finally{await pool.end();}
}

async function waitFor(check,timeoutMs=8000){
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){if(await check())return true;await new Promise((resolve)=>setTimeout(resolve,50));}
  return false;
}

test('SQLite reply jobs survive restart, preserve order and fence expired work',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-reply-jobs-'));
  const file=path.join(dir,'orbit.sqlite');
  let db=openDatabase(file);
  try{
    const {user,conversation}=seed(db);
    const first=db.acceptReplyJob(user.id,conversation.id,'First question');
    const second=db.acceptReplyJob(user.id,conversation.id,'Second question');
    assert.equal(db.getReplyJob(first.job.id).status,'queued');
    assert.equal(db.getMessage(user.id,first.userMessage.id).content,'First question');
    const claimed=db.claimNextReplyJob('worker-A');
    assert.equal(claimed.id,first.job.id);
    assert.equal(db.claimNextReplyJob('worker-B'),null,'later turn waits for first lease');
    assert.equal(db.completeReplyJob(claimed.id,'wrong-token','wrong reply'),null);
    const reply=db.completeReplyJob(claimed.id,claimed.lease_token,'First answer');
    assert.equal(reply.reply_job_id,first.job.id);
    assert.equal(db.completeReplyJob(claimed.id,claimed.lease_token,'duplicate'),null);
    assert.equal(db.claimNextReplyJob('worker-B').id,second.job.id);
    db.close();
    db=openDatabase(file);
    assert.equal(db.getReplyJob(first.job.id).status,'completed');
    const recovered=db.recoverExpiredReplyJobs(Date.now()+10*60_000);
    assert.equal(recovered,1,'expired running job is interrupted once');
    assert.equal(db.getReplyJob(second.job.id).status,'interrupted');
    assert.equal(db.listConversationMessages(user.id,conversation.id,20).filter((m)=>m.reply_job_id===second.job.id).length,1);
    assert.equal(db.listConversationMessages(user.id,conversation.id,20).find((m)=>m.reply_job_id===second.job.id).content,REPLY_INTERRUPTED_TEXT);
    assert.equal(db.recoverExpiredReplyJobs(Date.now()+10*60_000),0);
    const third=db.acceptReplyJob(user.id,conversation.id,'Third question');
    db.close();
    db=openDatabase(file);
    const thirdClaim=db.claimNextReplyJob('worker-C');
    assert.equal(thirdClaim.id,third.job.id,'unstarted job recovers after restart');
    assert.ok(db.completeReplyJob(thirdClaim.id,thirdClaim.lease_token,'Third answer'));
    const ephemeral=db.acceptReplyJob(user.id,conversation.id,'[Photo]',{originInstance:'origin',requiresEphemeral:true});
    assert.equal(db.claimNextReplyJob('other'),null,'ephemeral turn stays on its origin');
    assert.equal(db.recoverExpiredReplyJobs(Date.now()+10*60_000),1);
    assert.equal(db.getReplyJob(ephemeral.job.id).status,'interrupted');
    const removed=db.acceptReplyJob(user.id,conversation.id,'Delete pending turn');
    assert.ok(db.deleteMessageTurn(user.id,removed.userMessage.id).includes(removed.userMessage.id));
    assert.equal(db.getReplyJob(removed.job.id).status,'cancelled');
    assert.equal(db.recoverExpiredReplyJobs(Date.now()+10*60_000),0);
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('PostgreSQL claims one conversation turn across replicas and migrations are idempotent',async()=>{
  const url=process.env.TEST_DATABASE_URL;
  assert.ok(url,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  await ensurePostgresSchema(url);
  const one=createSyncPgAdapter(url);
  const two=createSyncPgAdapter(url);
  let userId=null;
  try{
    const {user,conversation}=seed(one);userId=user.id;
    const first=one.acceptReplyJob(user.id,conversation.id,'First PG question');
    const second=one.acceptReplyJob(user.id,conversation.id,'Second PG question');
    const sameInstant='2026-10-24T10:00:00.000Z';
    one.retimeMessage(user.id,first.userMessage.id,sameInstant);
    one.retimeMessage(user.id,second.userMessage.id,sameInstant);
    assert.deepEqual(one.listConversationMessages(user.id,conversation.id,10).map((m)=>m.id),
      [first.userMessage.id,second.userMessage.id],'same-millisecond turns keep insertion order');
    assert.deepEqual(one.listConversationMessagesThrough(user.id,conversation.id,first.userMessage.id,10).map((m)=>m.id),
      [first.userMessage.id],'later accepted turn stays outside its predecessor context');
    const claimed=await Promise.all([one.async.claimNextReplyJob('replica-A'),two.async.claimNextReplyJob('replica-B')]);
    assert.equal(claimed.filter(Boolean).length,1);
    assert.equal(claimed.find(Boolean).id,first.job.id);
    assert.equal(two.completeReplyJob(first.job.id,'stale-token','wrong'),null);
    const reply=one.completeReplyJob(first.job.id,claimed.find(Boolean).lease_token,'First PG answer');
    assert.equal(reply.reply_job_id,first.job.id);
    const next=two.claimNextReplyJob('replica-B');
    assert.equal(next.id,second.job.id);
    assert.equal(two.recoverExpiredReplyJobs(Date.now()+10*60_000),1);
    assert.equal(one.completeReplyJob(next.id,next.lease_token,'too late'),null);
    assert.equal(one.getReplyJob(next.id).status,'interrupted');
    assert.equal(one.listConversationMessages(user.id,conversation.id,20).filter((m)=>m.reply_job_id===next.id).length,1);
    const removed=one.acceptReplyJob(user.id,conversation.id,'Delete PG pending turn');
    assert.ok(one.deleteMessageTurn(user.id,removed.userMessage.id).includes(removed.userMessage.id));
    assert.equal(one.getReplyJob(removed.job.id).status,'cancelled');
  }finally{
    try{if(userId)one.deleteUserAccount(userId);}catch{}
    one.close();two.close();
  }
});

test('PostgreSQL reply survives another replica and queued work recovers on restart',async()=>{
  const url=process.env.TEST_DATABASE_URL;
  assert.ok(url,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  await ensurePostgresSchema(url);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-reply-servers-'));
  const calls=[];
  let release,heldOnce=false;
  const makeModel=(name)=>{
    const model=createModelClient({NODE_ENV:'test'});
    model.respond=async({message})=>{
      calls.push({name,message});
      if(message==='Held cross-replica question'&&!heldOnce){heldOnce=true;await new Promise((resolve)=>{release=resolve;});}
      return{text:`Answered ${message}`,toolCalls:[]};
    };
    return model;
  };
  const env={NODE_ENV:'test',DATABASE_URL:url,OPENAI_MODEL:'gpt-6-luna'};
  const a=createOrbitServer({env,dataDir:path.join(dir,'a'),modelClient:makeModel('A')});
  const b=createOrbitServer({env,dataDir:path.join(dir,'b'),modelClient:makeModel('B')});
  let c=null,userId=null;
  try{
    await Promise.all([new Promise((resolve)=>a.server.listen(0,'127.0.0.1',resolve)),new Promise((resolve)=>b.server.listen(0,'127.0.0.1',resolve))]);
    const {user,conversation}=seed(a.db);userId=user.id;
    const token=randomUUID(),csrf=randomUUID();
    a.db.createSession({tokenHash:hashToken(token),userId,csrfToken:csrf,expiresAt:new Date(Date.now()+60_000).toISOString(),userAgent:'test'});
    const cookie=`orbit_session=${token}`;
    const baseA=`http://127.0.0.1:${a.server.address().port}`;
    const baseB=`http://127.0.0.1:${b.server.address().port}`;
    const sent=await fetch(`${baseA}/api/chat`,{method:'POST',headers:{Cookie:cookie,'X-Orbit-CSRF':csrf,'Content-Type':'application/json'},
      body:JSON.stringify({conversationId:conversation.id,message:'Held cross-replica question'})});
    assert.equal(sent.status,202);
    assert.ok(await waitFor(()=>!!release));
    const working=await(await fetch(`${baseB}/api/chat/stream-state?conversationId=${conversation.id}`,{headers:{Cookie:cookie}})).json();
    assert.deepEqual(working,{state:'streaming',turn:-1,text:''},'other replica keeps existing polling contract alive');
    const sse=await fetch(`${baseB}/api/chat/stream?conversationId=${conversation.id}`,{headers:{Cookie:cookie}});
    assert.equal(sse.status,200);
    release();
    const sseText=await sse.text();
    assert.match(sseText,/event: sync/);
    assert.match(sseText,/event: done/,'other replica completes the existing SSE contract');
    assert.ok(await waitFor(()=>a.db.getConversationReplyJobState(userId,conversation.id)?.status==='completed'));
    const finished=await(await fetch(`${baseB}/api/chat/stream-state?conversationId=${conversation.id}`,{headers:{Cookie:cookie}})).json();
    assert.equal(finished.state,'done');
    const firstReply=a.db.listConversationMessages(userId,conversation.id,10).find((m)=>m.role==='assistant');
    assert.ok(firstReply);
    assert.equal(a.db.listConversationMessages(userId,conversation.id,10).filter((m)=>m.role==='assistant').length,1);
    const queued=b.db.acceptReplyJob(userId,conversation.id,'Queued before restart');
    await a.close();await b.close();
    c=createOrbitServer({env,dataDir:path.join(dir,'c'),modelClient:makeModel('C')});
    c.startWorker();
    assert.ok(await waitFor(()=>c.db.getReplyJob(queued.job.id)?.status==='completed'),'startup recovered queued job');
    assert.equal(c.db.listConversationMessages(userId,conversation.id,10).filter((m)=>m.reply_job_id===queued.job.id).length,1);
    await new Promise((resolve)=>c.server.listen(0,'127.0.0.1',resolve));
    const regenerated=await fetch(`http://127.0.0.1:${c.server.address().port}/api/chat/messages/${firstReply.id}/regenerate`,{
      method:'POST',headers:{Cookie:cookie,'X-Orbit-CSRF':csrf,'Content-Type':'application/json'},body:'{}'});
    assert.equal(regenerated.status,202);
    assert.ok(await waitFor(()=>c.db.getConversationReplyJobState(userId,conversation.id)?.status==='completed'));
    assert.equal(c.db.getMessage(userId,firstReply.id),null,'old reply is atomically replaced by the regenerate job');
    assert.deepEqual(calls.map((x)=>x.message),['Held cross-replica question','Queued before restart','Held cross-replica question']);
  }finally{
    release?.();
    if(c){try{if(userId)c.db.deleteUserAccount(userId);}catch{}await c.close();}
    else{try{if(userId)a.db.deleteUserAccount(userId);}catch{}await a.close();await b.close();}
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('graceful shutdown waits for an active reply and leaves it completed',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-reply-drain-'));
  const model=createModelClient({NODE_ENV:'test'});
  let release,started=false;
  model.respond=async()=>{
    started=true;
    await new Promise((resolve)=>{release=resolve;});
    return{text:'Reply finished before shutdown.',toolCalls:[]};
  };
  const app=createOrbitServer({env:{NODE_ENV:'test',OPENAI_MODEL:'gpt-6-luna'},dataDir:dir,modelClient:model});
  let closed=false;
  try{
    await new Promise((resolve)=>app.server.listen(0,'127.0.0.1',resolve));
    const {user,conversation}=seed(app.db);
    const token=randomUUID(),csrf=randomUUID();
    app.db.createSession({tokenHash:hashToken(token),userId:user.id,csrfToken:csrf,expiresAt:new Date(Date.now()+60_000).toISOString(),userAgent:'test'});
    const sent=await fetch(`http://127.0.0.1:${app.server.address().port}/api/chat`,{
      method:'POST',headers:{Cookie:`orbit_session=${token}`,'X-Orbit-CSRF':csrf,'Content-Type':'application/json'},
      body:JSON.stringify({conversationId:conversation.id,message:'Please answer before shutdown.'})});
    assert.equal(sent.status,202);
    assert.ok(await waitFor(()=>started));
    const shutdown=app.close().then(()=>{closed=true;});
    await new Promise((resolve)=>setTimeout(resolve,50));
    assert.equal(closed,false,'shutdown waits for the in-flight model reply');
    release();
    await shutdown;
    const db=openDatabase(path.join(dir,'orbit.sqlite'));
    try{
      const job=db.getConversationReplyJobState(user.id,conversation.id);
      assert.equal(job.status,'completed');
      assert.equal(db.listConversationMessages(user.id,conversation.id,10).filter((m)=>m.reply_job_id===job.id).length,1);
    }finally{db.close();}
  }finally{release?.();if(!closed)await app.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('deleting a pending turn fences its running reply',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-reply-cancel-'));
  const model=createModelClient({NODE_ENV:'test'});
  let release,started=false;
  model.respond=async()=>{started=true;await new Promise((resolve)=>{release=resolve;});return{text:'Should never be stored.',toolCalls:[]};};
  const app=createOrbitServer({env:{NODE_ENV:'test',OPENAI_MODEL:'gpt-6-luna'},dataDir:dir,modelClient:model});
  try{
    await new Promise((resolve)=>app.server.listen(0,'127.0.0.1',resolve));
    const {user,conversation}=seed(app.db);
    const token=randomUUID(),csrf=randomUUID(),base=`http://127.0.0.1:${app.server.address().port}`;
    app.db.createSession({tokenHash:hashToken(token),userId:user.id,csrfToken:csrf,expiresAt:new Date(Date.now()+60_000).toISOString(),userAgent:'test'});
    const headers={Cookie:`orbit_session=${token}`,'X-Orbit-CSRF':csrf,'Content-Type':'application/json'};
    const sent=await fetch(`${base}/api/chat`,{method:'POST',headers,body:JSON.stringify({conversationId:conversation.id,message:'Please wait while I cancel.'})});
    assert.equal(sent.status,202);
    const body=await sent.json();
    assert.ok(await waitFor(()=>started));
    const removed=await fetch(`${base}/api/chat/messages/${body.id}`,{method:'DELETE',headers});
    assert.equal(removed.status,200);
    release();
    assert.ok(await waitFor(()=>app.db.getConversationReplyJobState(user.id,conversation.id)?.status==='cancelled'));
    await new Promise((resolve)=>setTimeout(resolve,50));
    assert.equal(app.db.listConversationMessages(user.id,conversation.id,20).some((m)=>m.content==='Should never be stored.'),false);
  }finally{release?.();await app.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('emergency pause holds recovered jobs until resume',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-reply-paused-'));
  const model=createModelClient({NODE_ENV:'test'});
  let calls=0;
  model.respond=async()=>{calls++;return{text:'Resumed reply.',toolCalls:[]};};
  const app=createOrbitServer({env:{NODE_ENV:'test',OPENAI_MODEL:'gpt-6-luna'},dataDir:dir,modelClient:model});
  try{
    const {user,conversation}=seed(app.db);
    const accepted=app.db.acceptReplyJob(user.id,conversation.id,'Please answer after resume.');
    app.db.setSetting('system_paused','true');
    app.runReplyJobs();
    await new Promise((resolve)=>setTimeout(resolve,30));
    assert.equal(app.db.getReplyJob(accepted.job.id).status,'queued');
    assert.equal(calls,0);
    app.db.setSetting('system_paused','false');
    app.runReplyJobs();
    assert.ok(await waitFor(()=>app.db.getReplyJob(accepted.job.id).status==='completed'));
    assert.equal(calls,1);
  }finally{await app.close();fs.rmSync(dir,{recursive:true,force:true});}
});
