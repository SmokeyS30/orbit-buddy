import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac,randomUUID } from 'node:crypto';
import { createOrbitServer } from '../server.js';
import { openDatabase } from '../src/database.js';
import { openPostgres } from '../src/db/postgres-adapter.js';

const env={NODE_ENV:'test',TWILIO_ACCOUNT_SID:'ACsynthetic',TWILIO_AUTH_TOKEN:'synthetic-secret',TWILIO_WHATSAPP_NUMBER:'+14155238886'};
const phone='whatsapp:+15551234567';

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
  assert.equal(response.status,200);
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
