import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac,randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { createOrbitServer } from '../server.js';
import { openDatabase } from '../src/database.js';
import { openPostgres } from '../src/db/postgres-adapter.js';
import { downloadTwilioMedia, validateTwilioMediaUrl } from '../src/whatsapp.js';

const env={NODE_ENV:'test',TWILIO_ACCOUNT_SID:'ACsynthetic',TWILIO_AUTH_TOKEN:'synthetic-secret',TWILIO_WHATSAPP_NUMBER:'+14155238886'};
const phone='whatsapp:+15551234567';
const accountSid=`AC${'a'.repeat(32)}`;
const messageSid=`SM${'b'.repeat(32)}`;
const mediaSid=`ME${'c'.repeat(32)}`;
const validMediaUrl=`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${messageSid}/Media/${mediaSid}`;

test('media Basic credentials are scoped to the exact Twilio account and message resource',async()=>{
  const rejected=[
    `https://example.test/2010-04-01/Accounts/${accountSid}/Messages/${messageSid}/Media/${mediaSid}`,
    validMediaUrl.replace('https:','http:'),
    validMediaUrl.replace('api.twilio.com','api.twilio.com.evil.test'),
    validMediaUrl.replace(accountSid,`AC${'d'.repeat(32)}`),
    validMediaUrl.replace(messageSid,`SM${'d'.repeat(32)}`),
    `${validMediaUrl}?url=https://example.test`,
    validMediaUrl.replace('/Media/','/%4dedia/'),
  ];
  const previousFetch=globalThis.fetch;
  const requests=[];
  globalThis.fetch=async (url,options)=>{
    requests.push({url,options});
    return new Response('redirect',{status:302,headers:{Location:'https://example.test/steal'}});
  };
  try{
    for(const url of rejected){
      assert.throws(()=>validateTwilioMediaUrl(url,accountSid,messageSid),/Invalid Twilio media URL/);
      await assert.rejects(downloadTwilioMedia({accountSid,authToken:'synthetic',url,messageSid}),/Invalid Twilio media URL/);
    }
    assert.equal(requests.length,0,'untrusted URLs never receive credentials');
    await assert.rejects(downloadTwilioMedia({accountSid,authToken:'synthetic',url:validMediaUrl,messageSid}),/redirected/);
    assert.equal(requests.length,1,'redirect is never followed');
    assert.equal(requests[0].url,validMediaUrl);
    assert.equal(requests[0].options.redirect,'manual');
    assert.match(requests[0].options.headers.Authorization,/^Basic /);
  }finally{globalThis.fetch=previousFetch;}
});

async function serverFixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-whatsapp-security-'));
  const app=createOrbitServer({dataDir:dir,env});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const ownerResponse=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'owner@example.test',displayName:'Owner',password:'correct horse battery staple'})});
  assert.equal(ownerResponse.status,201);
  const owner=await ownerResponse.json();
  const headers={'Content-Type':'application/json',Cookie:ownerResponse.headers.get('set-cookie').split(';')[0],'X-Orbit-CSRF':owner.csrf};
  const linkStart=()=>fetch(`${base}/api/whatsapp/link/start`,{method:'POST',headers,body:'{}'});
  const webhook=(params)=>{
    const url=`${base}/api/whatsapp/webhook`;
    const data=Object.keys(params).sort().reduce((out,key)=>out+key+params[key],url);
    const signature=createHmac('sha1',env.TWILIO_AUTH_TOKEN).update(data).digest('base64');
    return fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':signature},body:new URLSearchParams(params)});
  };
  return{app,base,owner,linkStart,webhook};
}

test('starting a new WhatsApp link revokes the old code',async t=>{
  const fx=await serverFixture(t);
  const first=await(await fx.linkStart()).json();
  const second=await(await fx.linkStart()).json();
  assert.equal(fx.app.db.getSetting(`whatsapp_link_code_${first.code}`),null);
  assert.ok(fx.app.db.getSetting(`whatsapp_link_code_${second.code}`));
});

test('signed WhatsApp link guesses are bounded per sender and across the service',async t=>{
  const fx=await serverFixture(t);
  await fx.linkStart();
  const initial=await fx.webhook({From:phone,Body:'000000',MessageSid:'SMsynthetic-repeat'});
  assert.equal((await initial.json()).ignored,true);
  const replay=await fx.webhook({From:phone,Body:'000000',MessageSid:'SMsynthetic-repeat'});
  assert.equal((await replay.json()).deduped,true);
  let response;
  for(let index=0;index<5;index++)response=await fx.webhook({From:phone,Body:'000000',MessageSid:`SMsynthetic-${index}`});
  assert.equal(response.status,429);
  assert.equal((await response.json()).linkRateLimited,true);
});

test('SQLite link codes consume once and inbound message SIDs deduplicate',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-whatsapp-security-db-'));
  const db=openDatabase(path.join(dir,'test.sqlite'));
  try{
    const user=db.createUser({email:'owner@example.test',displayName:'Owner',passwordHash:'hash',passwordSalt:'salt',role:'owner'});
    db.issueWhatsAppLinkCode(user.id,'123456',new Date(Date.now()+60_000).toISOString());
    assert.equal(db.consumeWhatsAppLinkCode('123456'),user.id);
    assert.equal(db.consumeWhatsAppLinkCode('123456'),null);
    assert.equal(db.claimWhatsAppInboundSid('SMsynthetic-unique'),true);
    assert.equal(db.claimWhatsAppInboundSid('SMsynthetic-unique'),false);
    db.issueWhatsAppLinkCode(user.id,'654321',new Date(Date.now()+60_000).toISOString());
    assert.equal(db.revokeWhatsAppLinkCodes(user.id),1);
    assert.equal(db.consumeWhatsAppLinkCode('654321'),null);
    for(let index=0;index<30;index++)assert.equal(db.allowWhatsAppLinkAttempt(`+1555000${String(index).padStart(4,'0')}`),true);
    assert.equal(db.allowWhatsAppLinkAttempt('+15559999999'),false,'service-wide guesses stop even when each sender is new');
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('SQLite link consumption and phone binding roll back together on phone conflict',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-whatsapp-link-'));
  const db=openDatabase(path.join(dir,'test.sqlite'));
  try{
    const a=db.createUser({email:'owner-a@example.test',displayName:'A',passwordHash:'hash',passwordSalt:'salt',role:'owner'});
    const b=db.createUser({email:'owner-b@example.test',displayName:'B',passwordHash:'hash',passwordSalt:'salt',role:'owner'});
    const expiry=new Date(Date.now()+60_000).toISOString();
    db.issueWhatsAppLinkCode(a.id,'111111',expiry);
    assert.equal(db.consumeAndLinkWhatsApp('111111','+15551234567','SMsuccessful-link'),a.id);
    assert.equal(db.claimWhatsAppInboundSid('SMsuccessful-link'),false,'link and SID commit together');
    db.issueWhatsAppLinkCode(b.id,'222222',expiry);
    assert.throws(()=>db.consumeAndLinkWhatsApp('222222','+15551234567','SMfailed-link'),/UNIQUE/);
    assert.ok(db.getSetting('whatsapp_link_code_222222'),'failed bind preserves code');
    assert.equal(db.claimWhatsAppInboundSid('SMfailed-link'),true,'failed bind also rolls back SID claim');
    assert.equal(db.consumeAndLinkWhatsApp('222222','+15551234568'),b.id);
    db.issueWhatsAppLinkCode(b.id,'333333',expiry);
    assert.equal(db.unlinkWhatsAppAndRevoke(b.id),true);
    assert.equal(db.getWhatsAppLink(b.id),null);
    assert.equal(db.consumeAndLinkWhatsApp('333333','+15551234568'),null);
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('SQLite inbound SID is committed only with its accepted reply job',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-whatsapp-inbound-'));
  const db=openDatabase(path.join(dir,'test.sqlite'));
  try{
    const user=db.createUser({email:'inbound@example.test',displayName:'Owner',passwordHash:'hash',passwordSalt:'salt',role:'owner'});
    const conversation=db.ensureDefaultConversation(user.id);
    db.linkWhatsApp(user.id,'+15551234567');
    const link=db.getWhatsAppLink(user.id);
    const options={channel:'whatsapp',deliveryToPhone:link.phone_e164,deliveryLinkVerifiedAt:link.verified_at,inboundSid:'SMaccepted'};
    assert.throws(()=>db.acceptReplyJob(user.id,conversation.id,'hello',
      {...options,inboundSid:'SMrollback',requiresEphemeral:true}),/Ephemeral/);
    assert.equal(db.claimWhatsAppInboundSid('SMrollback'),true,'failure rolled back SID claim');
    const accepted=db.acceptReplyJob(user.id,conversation.id,'hello',options);
    assert.ok(accepted.job.id);
    assert.equal(db.acceptReplyJob(user.id,conversation.id,'hello again',options),null);
    assert.equal(db.listMessages(user.id,100).filter(row=>row.content==='hello').length,1);
    db.unlinkWhatsAppAndRevoke(user.id);
    assert.equal(db.acceptReplyJob(user.id,conversation.id,'stale',
      {...options,inboundSid:'SMstale'}),null,'unlink invalidates a stale callback snapshot');
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('SQLite media lease fences stale retries and commits with its reply job',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-whatsapp-media-lease-'));
  const db=openDatabase(path.join(dir,'test.sqlite'));
  try{
    const user=db.createUser({email:'media-lease@example.test',displayName:'Owner',passwordHash:'hash',passwordSalt:'salt',role:'owner'});
    const conversation=db.ensureDefaultConversation(user.id);
    const link=db.linkWhatsApp(user.id,'+15551234567');
    const sid='SMsynthetic-lease';
    const first=db.claimWhatsAppInboundMedia(sid);
    assert.equal(first.state,'claimed');
    assert.equal(db.claimWhatsAppInboundMedia(sid).state,'busy');
    assert.equal(db.finishWhatsAppInboundMedia(sid,first.token,true),'retryable');
    const second=db.claimWhatsAppInboundMedia(sid);
    assert.equal(second.state,'claimed');
    const options={channel:'whatsapp',deliveryToPhone:link.phone_e164,deliveryLinkVerifiedAt:link.verified_at,
      inboundSid:sid};
    assert.equal(db.acceptReplyJob(user.id,conversation.id,'stale',
      {...options,inboundLeaseToken:first.token}),null);
    const accepted=db.acceptReplyJob(user.id,conversation.id,'current',
      {...options,inboundLeaseToken:second.token});
    assert.ok(accepted.job.id);
    assert.equal(db.claimWhatsAppInboundMedia(sid).state,'accepted');
    assert.equal(db.finishWhatsAppInboundMedia(sid,second.token,true),null);
    assert.equal(db.acceptReplyJob(user.id,conversation.id,'duplicate',
      {...options,inboundLeaseToken:second.token}),null);
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('SQLite old inbound SID ledger upgrades additively and preserves deduplication',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-whatsapp-migration-'));
  const file=path.join(dir,'old.sqlite');
  const old=new DatabaseSync(file);
  old.exec("CREATE TABLE whatsapp_inbound_messages(sid TEXT PRIMARY KEY,created_at TEXT NOT NULL); INSERT INTO whatsapp_inbound_messages VALUES('SMlegacy','2026-01-01T00:00:00.000Z')");
  old.close();
  try{
    const db=openDatabase(file);
    assert.equal(db.claimWhatsAppInboundMedia('SMlegacy').state,'accepted');
    db.close();
    const again=openDatabase(file);
    assert.equal(again.claimWhatsAppInboundMedia('SMlegacy').state,'accepted');
    again.close();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('PostgreSQL link consume and inbound SID claim are atomic across connections',async()=>{
  const url=process.env.TEST_DATABASE_URL;
  assert.ok(url,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  const a=await openPostgres(url),b=await openPostgres(url);
  const suffix=randomUUID();
  const user=await a.createUser({email:`wa-${suffix}@example.test`,displayName:'Owner',passwordHash:'hash',passwordSalt:'salt',role:'member'});
  const code=String(Math.floor(100000+Math.random()*900000));
  const sid=`SM${suffix.replaceAll('-','')}`;
  try{
    await a.issueWhatsAppLinkCode(user.id,code,new Date(Date.now()+60_000).toISOString());
    assert.deepEqual((await Promise.all([a.consumeWhatsAppLinkCode(code),b.consumeWhatsAppLinkCode(code)])).sort(),[null,user.id].sort());
    assert.deepEqual((await Promise.all([a.claimWhatsAppInboundSid(sid),b.claimWhatsAppInboundSid(sid)])).sort(),[false,true]);
    assert.equal(await a.allowWhatsAppLinkAttempt(`+1555${suffix.replaceAll('-','').slice(0,8)}`),true);
    await a.issueWhatsAppLinkCode(user.id,code,new Date(Date.now()+60_000).toISOString());
    assert.equal(await b.revokeWhatsAppLinkCodes(user.id),1);
    assert.equal(await a.consumeWhatsAppLinkCode(code),null);
  }finally{await a.deleteUserAccount(user.id);await a.close();await b.close();}
});

test('PostgreSQL inbound SID and reply job commit together across connections',async()=>{
  const url=process.env.TEST_DATABASE_URL;
  assert.ok(url,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  const a=await openPostgres(url),b=await openPostgres(url);
  const suffix=randomUUID(),sid=`SM${suffix.replaceAll('-','')}`;
  const user=await a.createUser({email:`wa-inbound-${suffix}@example.test`,displayName:'Owner',passwordHash:'hash',passwordSalt:'salt',role:'owner'});
  try{
    const conversation=await a.ensureDefaultConversation(user.id);
    const link=await a.linkWhatsApp(user.id,'+1555'+suffix.replaceAll('-','').slice(0,8));
    const options={channel:'whatsapp',deliveryToPhone:link.phone_e164,deliveryLinkVerifiedAt:link.verified_at,inboundSid:sid};
    await assert.rejects(a.acceptReplyJob(user.id,conversation.id,'failure',
      {...options,inboundSid:`${sid}-rollback`,requiresEphemeral:true}),/Ephemeral/);
    assert.equal(await b.claimWhatsAppInboundSid(`${sid}-rollback`),true);
    const accepted=await Promise.all([
      a.acceptReplyJob(user.id,conversation.id,'one',options),
      b.acceptReplyJob(user.id,conversation.id,'one',options),
    ]);
    assert.equal(accepted.filter(Boolean).length,1,'only one durable reply job accepted');
    await b.unlinkWhatsAppAndRevoke(user.id);
    assert.equal(await a.acceptReplyJob(user.id,conversation.id,'stale',
      {...options,inboundSid:`${sid}-stale`}),null);
  }finally{await a.deleteUserAccount(user.id);await a.close();await b.close();}
});

test('PostgreSQL media claim and retry lease are fenced across connections',async()=>{
  const url=process.env.TEST_DATABASE_URL;
  assert.ok(url,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  const a=await openPostgres(url),b=await openPostgres(url);
  const suffix=randomUUID(),sid=`SMmedia${suffix.replaceAll('-','')}`;
  const user=await a.createUser({email:`wa-lease-${suffix}@example.test`,displayName:'Owner',passwordHash:'hash',passwordSalt:'salt',role:'owner'});
  try{
    const conversation=await a.ensureDefaultConversation(user.id);
    const link=await a.linkWhatsApp(user.id,'+1555'+suffix.replaceAll('-','').slice(0,8));
    const [first,second]=await Promise.all([a.claimWhatsAppInboundMedia(sid),b.claimWhatsAppInboundMedia(sid)]);
    assert.deepEqual([first.state,second.state].sort(),['busy','claimed']);
    const owned=first.state==='claimed'?first:second;
    assert.equal(await a.finishWhatsAppInboundMedia(sid,owned.token,true),'retryable');
    const retry=await b.claimWhatsAppInboundMedia(sid);
    assert.equal(retry.state,'claimed');
    const options={channel:'whatsapp',deliveryToPhone:link.phone_e164,deliveryLinkVerifiedAt:link.verified_at,inboundSid:sid};
    assert.equal(await a.acceptReplyJob(user.id,conversation.id,'stale',
      {...options,inboundLeaseToken:owned.token}),null);
    assert.ok((await b.acceptReplyJob(user.id,conversation.id,'current',
      {...options,inboundLeaseToken:retry.token})).job.id);
    assert.equal((await a.claimWhatsAppInboundMedia(sid)).state,'accepted');
  }finally{await a.deleteUserAccount(user.id);await a.close();await b.close();}
});

test('PostgreSQL concurrent code collision cannot overwrite another owner, and revoked code cannot bind late',async()=>{
  const testUrl=process.env.TEST_DATABASE_URL;
  assert.ok(testUrl,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  const database=`wa_security_${randomUUID().replaceAll('-','')}`;
  const adminUrl=new URL(testUrl);adminUrl.pathname='/postgres';
  const isolatedUrl=new URL(testUrl);isolatedUrl.pathname=`/${database}`;
  const admin=new pg.Client({connectionString:adminUrl.href,ssl:false});
  let a,b,blocker;
  await admin.connect();
  try{
    await admin.query(`CREATE DATABASE ${database}`);
    blocker=new pg.Client({connectionString:isolatedUrl.href,ssl:false});
    await blocker.connect();
    const currentSchema=fs.readFileSync(new URL('../src/db/postgres-schema.sql',import.meta.url),'utf8');
    const oldInboundTable=`CREATE TABLE IF NOT EXISTS whatsapp_inbound_messages (\n  sid TEXT PRIMARY KEY, created_at TEXT NOT NULL\n);`;
    const priorSchema=currentSchema.replace(/CREATE TABLE IF NOT EXISTS whatsapp_inbound_messages \(\n[^;]+\);/,oldInboundTable);
    assert.notEqual(priorSchema,currentSchema,'exercise migration from the old two-column inbound table');
    await blocker.query(priorSchema);
    await blocker.query("INSERT INTO whatsapp_inbound_messages(sid,created_at) VALUES('SMlegacy','2026-01-01T00:00:00.000Z')");
    a=await openPostgres(isolatedUrl.href);b=await openPostgres(isolatedUrl.href);
    assert.equal((await a.claimWhatsAppInboundMedia('SMlegacy')).state,'accepted','old SIDs remain deduplicated after migration');
    const first=await a.createUser({email:'first@example.test',displayName:'First',passwordHash:'hash',passwordSalt:'salt',role:'owner'});
    const second=await b.createUser({email:'second@example.test',displayName:'Second',passwordHash:'hash',passwordSalt:'salt',role:'owner'});
    const expiry=new Date(Date.now()+60_000).toISOString();
    await a.issueWhatsAppLinkCode(first.id,'111111',expiry);
    await b.issueWhatsAppLinkCode(second.id,'222222',expiry);
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE settings IN SHARE MODE');
    const results=Promise.allSettled([
      a.issueWhatsAppLinkCode(first.id,'333333',expiry),
      b.issueWhatsAppLinkCode(second.id,'333333',expiry),
    ]);
    const waitFor=async (sql,count)=>{
      const deadline=Date.now()+10_000;
      while(Date.now()<deadline){
        const row=(await blocker.query(sql)).rows[0];
        if(Number(row.n)>=count)return;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      throw new Error(`Timed out waiting for ${count} PostgreSQL lock waiters.`);
    };
    try{
      await waitFor("SELECT count(*) AS n FROM pg_locks WHERE relation='settings'::regclass AND NOT granted",2);
    }finally{await blocker.query('COMMIT');}
    const outcome=await results;
    assert.equal(outcome.filter(row=>row.status==='fulfilled').length,1);
    assert.equal(outcome.filter(row=>row.status==='rejected'&&row.reason.message==='Link code collision').length,1);
    const winner=String((await blocker.query("SELECT value FROM settings WHERE key='whatsapp_link_code_333333'")).rows[0].value).split(':')[0];
    const loser=winner===first.id?second.id:first.id;
    const loserOld=loser===first.id?'111111':'222222';
    assert.equal((await blocker.query('SELECT value FROM settings WHERE key=$1',[`whatsapp_link_code_${loserOld}`])).rows[0].value.split(':')[0],loser);
    await blocker.query("INSERT INTO settings(key,value,updated_at) VALUES('whatsapp_link_code_555555',$1,$2)",
      [`${first.id}:2020-01-01T00:00:00.000Z`,'2020-01-01T00:00:00.000Z']);
    await b.issueWhatsAppLinkCode(second.id,'555555',expiry);
    assert.equal((await blocker.query("SELECT value FROM settings WHERE key='whatsapp_link_code_555555'")).rows[0].value.split(':')[0],second.id,
      'expired collision key may be safely reused');

    await a.issueWhatsAppLinkCode(first.id,'444444',expiry);
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[first.id]);
    const lateBind=b.consumeAndLinkWhatsApp('444444','+15551234567');
    try{
      await waitFor("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()",1);
      await blocker.query("DELETE FROM settings WHERE key LIKE 'whatsapp_link_code_%' AND value LIKE $1",[`${first.id}:%`]);
      await blocker.query('DELETE FROM whatsapp_links WHERE user_id=$1',[first.id]);
    }finally{await blocker.query('COMMIT');}
    assert.equal(await lateBind,null);
    assert.equal(await a.getWhatsAppLink(first.id),null);
  }finally{
    await a?.close();await b?.close();await blocker?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  }
});
