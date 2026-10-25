import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';
import { createSubscriptionService } from '../src/subscriptions.js';
import { hashToken } from '../src/security.js';
import { signupAuditSubject } from '../src/signup-risk.js';

const password='correct horse battery staple';
const email='victim@example.test';

async function fixture(t,{sendEmail=true}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-email-proof-'));
  const sent=[];
  const app=createOrbitServer({dataDir:directory,env:{NODE_ENV:'test',SIGNUP_RISK_MODE:'off',SIGNUP_AUDIT_KEY:'synthetic-email-proof-key',PUBLIC_BASE_URL:'https://orbit.example.test'},
    ...(sendEmail?{sendEmail:async(_env,message)=>{sent.push(message);return true;}}:{})});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();fs.rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const register=(address,extra={})=>fetch(`${base}/api/auth/register`,{method:'POST',headers:{'Content-Type':'application/json','User-Agent':'OrbitBuddy/1.1'},body:JSON.stringify({email:address,displayName:'Synthetic user',password,...extra})});
  const owner=await register('owner@example.test');assert.equal(owner.status,201);
  app.db.setSetting('registration_open','true');
  return{app,base,register,sent};
}

test('an open registration door still requires mailbox proof before creating a member',async t=>{
  const fx=await fixture(t);
  const first=await fx.register(email);
  assert.equal(first.status,403);
  assert.equal((await first.json()).verificationRequired,true);
  assert.equal(fx.app.db.getUserByEmail(email),undefined,'unverified email cannot be reserved as an account');
  assert.equal(fx.sent.length,1);
  const link=fx.sent[0].text.match(/https:\/\/[^\s]+#signup-verify=[^\s]+/)?.[0];
  assert.ok(link);
  const verificationToken=new URL(link).hash.slice('#signup-verify='.length);
  const proved=await fx.register(email,{verificationToken});
  assert.equal(proved.status,201);
  const body=await proved.json();
  assert.ok(fx.app.db.getUserById(body.user.id).email_verified_at);
  assert.equal(fx.app.db.getSignupVerificationToken(hashToken(verificationToken),signupAuditSubject(email,'synthetic-email-proof-key')),undefined,'verification proof is consumed');
});

test('member registration fails closed if transactional email is unavailable',async t=>{
  const fx=await fixture(t,{sendEmail:false});
  const response=await fx.register('unverified@example.test');
  assert.equal(response.status,503);
  assert.equal(fx.app.db.getUserByEmail('unverified@example.test'),undefined);
});

test('an email-listed comped benefit requires verified mailbox ownership',()=>{
  const service=createSubscriptionService({COMPED_USER_EMAILS:email},{getSetting:()=>null});
  assert.equal(service.isComped('unverified',{email,email_verified_at:null,role:'member'}),false);
  assert.equal(service.isComped('verified',{email,email_verified_at:'2026-10-25T00:00:00.000Z',role:'member'}),true);
});
