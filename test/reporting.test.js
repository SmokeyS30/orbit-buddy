import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createOrbitServer } from '../server.js';

async function fixture(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-reporting-'));
  const app=createOrbitServer({dataDir:directory,env:{NODE_ENV:'test',SIGNUP_RISK_MODE:'off'}});
  await new Promise((resolve)=>app.server.listen(0,'127.0.0.1',resolve));
  return{app,base:`http://127.0.0.1:${app.server.address().port}`};
}
async function register(base,email){
  const response=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,displayName:email.split('@')[0],password:'correct horse battery staple'})});
  assert.equal(response.status,201);
  const body=await response.json();
  return{cookie:response.headers.get('set-cookie').split(';')[0],csrf:body.csrf,userId:body.user.id};
}
const headers=(account)=>({'Content-Type':'application/json',Cookie:account.cookie,'X-Orbit-CSRF':account.csrf});
const submit=(base,account,body)=>fetch(`${base}/api/reports`,{method:'POST',headers:headers(account),body:JSON.stringify(body)});
const responseBody=(messageId,extra={})=>({submissionId:randomUUID(),kind:'response',reason:'incorrect',description:'This answer was wrong.',messageId,includeMessage:false,consent:true,...extra});

test('reports require consent, protect ownership and CSRF, and retain only chosen content',async(t)=>{
  const{app,base}=await fixture();t.after(()=>app.close());
  const owner=await register(base,'owner@example.com');
  assert.equal((await fetch(`${base}/api/admin/registration`,{method:'POST',headers:headers(owner),body:JSON.stringify({open:true})})).status,200);
  const member=await register(base,'member@example.com');
  const convo=app.db.ensureDefaultConversation(member.userId);
  const userMessage=app.db.addMessage(member.userId,convo.id,'user','Private history and secret token: abc123');
  const reply=app.db.addMessage(member.userId,convo.id,'assistant','An answer with private data: secret-456');
  const ownerReply=app.db.addMessage(owner.userId,app.db.ensureDefaultConversation(owner.userId).id,'assistant','Owner only');

  assert.equal((await fetch(`${base}/api/reports`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(responseBody(reply.id))})).status,401);
  assert.equal((await fetch(`${base}/api/reports`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:member.cookie},body:JSON.stringify(responseBody(reply.id))})).status,403);
  assert.equal((await submit(base,member,responseBody(reply.id,{consent:false}))).status,400);
  assert.equal((await submit(base,member,responseBody(ownerReply.id))).status,404);
  assert.equal((await submit(base,member,responseBody(userMessage.id))).status,400);
  assert.equal((await submit(base,member,responseBody(reply.id,{includeMessage:true,messageExcerpt:''}))).status,400);

  const first=await submit(base,member,responseBody(reply.id));
  assert.equal(first.status,201);
  const firstId=(await first.json()).id;
  const redacted='An answer with [removed]';
  assert.equal((await submit(base,member,responseBody(reply.id,{includeMessage:true,messageExcerpt:redacted}))).status,201);
  const problem={submissionId:randomUUID(),kind:'problem',reason:'bug',description:'Typing froze.',consent:true};
  assert.equal((await submit(base,member,problem)).status,201);

  assert.equal((await fetch(`${base}/api/admin/reports`,{headers:{Cookie:member.cookie}})).status,403);
  const ownerList=await fetch(`${base}/api/admin/reports`,{headers:{Cookie:owner.cookie}});
  assert.equal(ownerList.status,200);
  assert.equal(ownerList.headers.get('cache-control'),'no-store');
  const reports=(await ownerList.json()).reports;
  assert.equal(reports.length,3);
  const noExcerpt=reports.find((r)=>r.id===firstId);
  assert.equal(noExcerpt.message_excerpt,null);
  assert.equal(noExcerpt.message_id,null);
  assert.equal(noExcerpt.reporter_name,'member');
  assert.equal(reports.find((r)=>r.message_excerpt===redacted).message_id,reply.id);
  assert.equal(reports.find((r)=>r.kind==='problem').message_excerpt,null);
  assert.doesNotMatch(JSON.stringify(reports),/Private history|secret-456|abc123/);
});

test('submission IDs make repeated clicks and lost-response retries idempotent; owner alone tracks status',async(t)=>{
  const{app,base}=await fixture();t.after(()=>app.close());
  const owner=await register(base,'owner@example.com');
  assert.equal((await fetch(`${base}/api/admin/registration`,{method:'POST',headers:headers(owner),body:JSON.stringify({open:true})})).status,200);
  const member=await register(base,'member@example.com');
  const convo=app.db.ensureDefaultConversation(member.userId);
  const reply=app.db.addMessage(member.userId,convo.id,'assistant','Report me');
  const body=responseBody(reply.id);
  const [a,b]=await Promise.all([submit(base,member,body),submit(base,member,body)]);
  assert.deepEqual([a.status,b.status].sort(),[200,201]);
  const ids=[(await a.json()).id,(await b.json()).id];
  assert.equal(ids[0],ids[1]);
  const retry=await submit(base,member,{...body,description:'Changed after first send'});
  assert.equal(retry.status,200);
  assert.equal((await retry.json()).id,ids[0]);
  assert.equal(app.db.listReports().length,1);
  assert.equal(app.db.listReports()[0].description,'This answer was wrong.');

  const mineBefore=await fetch(`${base}/api/reports/mine`,{headers:{Cookie:member.cookie}});
  assert.equal(mineBefore.status,200);
  assert.equal(mineBefore.headers.get('cache-control'),'no-store');
  assert.deepEqual((await mineBefore.json()).reports.map((report)=>report.id),[ids[0]]);
  assert.deepEqual((await (await fetch(`${base}/api/reports/mine`,{headers:{Cookie:owner.cookie}})).json()).reports,[]);
  assert.equal((await fetch(`${base}/api/reports/mine`)).status,401);
  const queue=await fetch(`${base}/api/admin/reports`,{headers:{Cookie:owner.cookie}});
  assert.equal((await queue.json()).summary.find((row)=>row.status==='new').count,1);

  const route=`${base}/api/admin/reports/${ids[0]}`;
  assert.equal((await fetch(route,{method:'PATCH',headers:headers(member),body:JSON.stringify({status:'resolved'})})).status,403);
  assert.equal((await fetch(route,{method:'PATCH',headers:{'Content-Type':'application/json',Cookie:owner.cookie},body:JSON.stringify({status:'resolved'})})).status,403);
  assert.equal((await fetch(route,{method:'PATCH',headers:headers(owner),body:JSON.stringify({status:'invalid'})})).status,400);
  assert.equal((await fetch(route,{method:'PATCH',headers:headers(owner),body:JSON.stringify({status:'reviewing',ownerNote:'x'.repeat(501)})})).status,400);
  const updated=await fetch(route,{method:'PATCH',headers:headers(owner),body:JSON.stringify({status:'reviewing',ownerNote:'We are reviewing this.'})});
  assert.equal(updated.status,200);
  assert.equal((await updated.json()).status,'reviewing');
  assert.equal(app.db.listReports()[0].status,'reviewing');
  assert.ok(app.db.listReports()[0].reviewed_at);
  const mineAfter=(await (await fetch(`${base}/api/reports/mine`,{headers:{Cookie:member.cookie}})).json()).reports;
  assert.equal(mineAfter[0].owner_note,'We are reviewing this.');
  assert.equal(mineAfter[0].status,'reviewing');
  assert.equal(mineAfter[0].description,undefined,'the receipt does not return private details');
  assert.equal((await fetch(`${base}/api/admin/reports/${randomUUID()}`,{method:'PATCH',headers:headers(owner),body:JSON.stringify({status:'resolved'})})).status,404);
});

test('report input limits and rate limits reject excess without persisting payloads',async(t)=>{
  const{app,base}=await fixture();t.after(()=>app.close());
  const owner=await register(base,'owner@example.com');
  const convo=app.db.ensureDefaultConversation(owner.userId);
  const reply=app.db.addMessage(owner.userId,convo.id,'assistant','Safe text');
  assert.equal((await submit(base,owner,responseBody(reply.id,{description:'x'.repeat(1001)}))).status,400);
  assert.equal((await submit(base,owner,responseBody(reply.id,{includeMessage:true,messageExcerpt:'x'.repeat(2001)}))).status,400);
  assert.equal((await submit(base,owner,responseBody(reply.id,{reason:'invalid'}))).status,400);
  assert.equal((await fetch(`${base}/api/reports`,{method:'POST',headers:headers(owner),body:'null'})).status,400);
  assert.equal((await submit(base,owner,{submissionId:randomUUID(),kind:'problem',reason:'bug',description:'Issue',messageId:reply.id,consent:true})).status,400);
  assert.equal((await submit(base,owner,{submissionId:randomUUID(),kind:'problem',reason:'bug',consent:true})).status,201,'description is optional');
  for(let i=0;i<4;i++)assert.equal((await submit(base,owner,responseBody(reply.id))).status,201);
  assert.equal((await submit(base,owner,responseBody(reply.id))).status,429);
  assert.equal(app.db.listReports().length,5);
});
