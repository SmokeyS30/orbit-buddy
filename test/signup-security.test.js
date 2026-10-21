import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash,generateKeyPairSync,sign } from 'node:crypto';
import cbor from 'cbor';
import {generateKeyPair,exportJWK,exportPKCS8,createLocalJWKSet,SignJWT} from 'jose';
import { createOrbitServer } from '../server.js';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/database.js';
import { hashToken } from '../src/security.js';
import { verifyAppAssertion,verifyAppAttestation } from '../src/app-attest.js';

const password='correct horse battery staple';
async function fixture(t,env={},options={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-signup-security-'));
  const app=createOrbitServer({dataDir:dir,env:{NODE_ENV:'test',SIGNUP_RISK_MODE:'observe',...env},...options});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const request=async(route,body,session)=>{
    const response=await fetch(`http://127.0.0.1:${app.server.address().port}${route}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','User-Agent':'OrbitBuddy/1.1',...(session?{Cookie:session.cookie,'X-Orbit-CSRF':session.csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const owner=await request('/api/auth/register',{email:'owner@example.com',displayName:'Owner',password});owner.csrf=owner.body.csrf;
  return {app,request,owner};
}

test('owner pause, appeals and recovery respect account boundaries',async t=>{
  const {app,request,owner}=await fixture(t);
  await request('/api/admin/registration',{open:true},owner);
  const member=await request('/api/auth/register',{email:'member@example.com',displayName:'Member',password});member.csrf=member.body.csrf;
  assert.equal((await request('/api/admin/signup-pause',{paused:true})).status,401);
  assert.equal((await request('/api/admin/signup-pause',{paused:true},member)).status,403);
  assert.equal((await request('/api/admin/signup-pause',{paused:true},{...owner,csrf:'wrong'})).status,403);
  assert.equal((await request('/api/admin/signup-pause',{paused:true},owner)).status,200);
  assert.equal((await request('/api/auth/register',{email:'new@example.com',displayName:'New',password})).status,503);
  assert.equal((await request('/api/auth/login',{email:'member@example.com',password})).status,200);
  assert.equal((await request('/api/access-claim',{email:'member@example.com',password:'attacker-password'})).status,410);
  const code=member.body.recoveryCodes[0];
  assert.equal((await request('/api/auth/recover',{email:'owner@example.com',recoveryCode:code,newPassword:password})).status,401);
  assert.equal((await request('/api/auth/recover',{email:'member@example.com',recoveryCode:code,newPassword:'short'})).status,400);
  assert.equal((await request('/api/auth/recover',{email:'member@example.com',recoveryCode:code,newPassword:password})).status,200);
  assert.equal((await request('/api/auth/recover',{email:'member@example.com',recoveryCode:code,newPassword:password})).status,401);
  assert.equal((await request('/api/auth/signup-appeal',{email:'new@example.com',note:'Please review signup'})).status,202);
  assert.equal((await request('/api/admin/signup-appeals')).status,401);
  const appeals=(await request('/api/admin/signup-appeals',undefined,owner)).body.appeals;assert.equal(appeals.length,1);
  await request('/api/admin/signup-appeals',{id:appeals[0].id,status:'reviewed'},owner);
  assert.equal(app.db.getUserByEmail('new@example.com'),undefined,'review grants no access');
  assert.equal((await request('/api/admin/signup-risk',undefined,owner)).body.paused,true);
});

test('environment pause cannot be cleared through owner controls',async t=>{
  const {request,owner}=await fixture(t,{SIGNUPS_PAUSED:'true'});
  assert.equal((await request('/api/admin/signup-pause',{paused:false},owner)).body.paused,true);
});

test('challenges are expiring, purpose-bound, account-bound and single-use; counters use compare-and-swap',async t=>{
  const {app}=await fixture(t);const db=app.db,expiry=new Date(Date.now()+60_000).toISOString();
  db.addSignupChallenge('hash','link','owner',expiry);
  assert.equal(db.consumeSignupChallenge('hash','login','owner'),false);
  assert.equal(db.consumeSignupChallenge('hash','link','other'),false);
  assert.equal(db.consumeSignupChallenge('hash','link','owner'),true);
  assert.equal(db.consumeSignupChallenge('hash','link','owner'),false);
  db.addSignupChallenge('old','link','owner','2000-01-01');assert.equal(db.consumeSignupChallenge('old','link','owner'),false);
  db.addAppAttestKey('key','public','production');assert.equal(db.advanceAppAttestCounter('key',0,1),true);
  assert.equal(db.advanceAppAttestCounter('key',0,2),false);assert.equal(db.advanceAppAttestCounter('key',1,1),false);
});

test('real local signatures exercise assertion checks, not live Apple attestation',()=>{
  const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),env={APPLE_TEAM_ID:'TEAM',APPLE_APP_BUNDLE_ID:'com.test'};
  const auth=Buffer.alloc(37);createHash('sha256').update('TEAM.com.test').digest().copy(auth);auth.writeUInt32BE(1,33);
  const payload='server-bound-challenge';const hash=createHash('sha256').update(Buffer.concat([auth,createHash('sha256').update(payload).digest()])).digest();
  const signature=sign('sha256',hash,pair.privateKey),assertion=cbor.encode({signature,authenticatorData:auth}).toString('base64');
  const key={public_key:pair.publicKey.export({type:'spki',format:'pem'}),sign_count:0};
  assert.equal(verifyAppAssertion({assertion,payload,key},env),1);
  assert.throws(()=>verifyAppAssertion({assertion,payload:'tampered',key},env));
  assert.throws(()=>verifyAppAssertion({assertion,payload,key:{...key,sign_count:1}},env));
  assert.throws(()=>verifyAppAssertion({assertion,payload,key},{...env,APPLE_TEAM_ID:'WRONG'}));
  assert.throws(()=>verifyAppAttestation({attestation:assertion,keyId:'fake',challenge:'fake'},env));
});

test('additive SQLite restart preserves identities and passwords; reset consumption and verification rollback are atomic',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-migration-')),file=path.join(dir,'db.sqlite');
  let db=openDatabase(file);const user=db.createUser({email:'old@example.com',displayName:'Existing',passwordHash:'old',passwordSalt:'salt',role:'owner'});
  db.linkAuthIdentity('apple','subject',user.id);db.close();
  const legacy=new DatabaseSync(file);legacy.exec('DROP TABLE signup_challenges; DROP TABLE app_attest_keys; DROP TABLE signup_appeals');legacy.close();
  db=openDatabase(file);t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  assert.equal(db.getUserById(user.id).password_hash,'old');assert.equal(db.getAuthIdentity('apple','subject').user_id,user.id);
  db.setSetting('registration_open','true');db.addSignupVerificationToken('token','email-hash',new Date(Date.now()+60_000).toISOString());
  assert.throws(()=>db.createSignupAccount({email:'old@example.com',displayName:'Collision',passwordHash:'new',passwordSalt:'new',verificationHash:'token',emailHash:'email-hash'}));
  assert.ok(db.getSignupVerificationToken('token','email-hash'));
  db.addPasswordResetToken(hashToken('reset'),user.id,new Date(Date.now()+60_000).toISOString());
  db.addPasswordResetToken(hashToken('sibling'),user.id,new Date(Date.now()+60_000).toISOString());
  assert.equal(db.finishPasswordReset(hashToken('reset'),'new','salt'),true);assert.equal(db.finishPasswordReset(hashToken('reset'),'attacker','salt'),false);
  assert.equal(db.getUserById(user.id).password_hash,'new');
  assert.equal(db.finishPasswordReset(hashToken('sibling'),'stale','salt'),false);
});

test('Apple HTTP flow requires authenticated explicit linking and cannot replay or link a colliding subject',async t=>{
  const rsa=await generateKeyPair('RS256'),ec=await generateKeyPair('ES256',{extractable:true});
  const keys=createLocalJWKSet({keys:[{...await exportJWK(rsa.publicKey),kid:'test'}]});
  const env={APPLE_CLIENT_ID:'com.test',APPLE_TEAM_ID:'TEAM',APPLE_KEY_ID:'test',APPLE_PRIVATE_KEY:await exportPKCS8(ec.privateKey)};
  let exchangedToken;
  const {app,request,owner}=await fixture(t,env,{appleVerification:{keys,fetchImpl:async()=>Response.json({id_token:exchangedToken})}});
  const credentials=async(nonce,sub='shared-subject')=>{
    exchangedToken=await new SignJWT({sub,nonce,email:'owner@example.com',email_verified:true}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer('https://appleid.apple.com').setAudience('com.test').setIssuedAt().setExpirationTime('5m').sign(rsa.privateKey);
    return {identityToken:exchangedToken,authorizationCode:'mock-code',nonce};
  };
  assert.equal((await request('/api/auth/apple/challenge',{purpose:'link'})).status,401);
  const unlinked=(await request('/api/auth/apple/challenge',{purpose:'login'})).body;
  assert.equal((await request('/api/auth/apple/complete',{purpose:'login',...await credentials(unlinked.nonce)})).status,409,'verified matching email never auto-links');
  const challenge=(await request('/api/auth/apple/challenge',{purpose:'link'},owner)).body;
  const input={purpose:'link',password,...await credentials(challenge.nonce)};
  assert.equal((await request('/api/auth/apple/complete',{...input,password:'wrong'},owner)).status,401);
  assert.equal((await request('/api/auth/apple/complete',input,owner)).status,200);
  assert.equal((await request('/api/auth/apple/complete',input,owner)).status,401,'consumed nonce cannot replay');
  await request('/api/admin/registration',{open:true},owner);
  const member=await request('/api/auth/register',{email:'member@example.com',displayName:'Member',password});member.csrf=member.body.csrf;
  const collision=(await request('/api/auth/apple/challenge',{purpose:'link'},member)).body;
  assert.equal((await request('/api/auth/apple/complete',{purpose:'link',password,...await credentials(collision.nonce)},member)).status,409);
  assert.equal(app.db.getAuthIdentity('apple','shared-subject').user_id,owner.body.user.id);
  const login=(await request('/api/auth/apple/challenge',{purpose:'login'})).body;
  assert.equal((await request('/api/auth/apple/complete',{purpose:'login',...await credentials(login.nonce)})).status,200);
  app.db.setUserDisabled(owner.body.user.id,true);
  const disabled=(await request('/api/auth/apple/challenge',{purpose:'login'})).body;
  assert.equal((await request('/api/auth/apple/complete',{purpose:'login',...await credentials(disabled.nonce)})).status,401);
});

test('pinned Apple attestation fixture verifies at its historical certificate date; expired and altered proofs fail',t=>{
  // Public fixture distributed under node-app-attest's MIT license. This is a
  // recorded 2024 attestation for its example app, not a live Orbit device check.
  const fixture=JSON.parse(fs.readFileSync(new URL('../node_modules/node-app-attest/test/fixtures/attestation-production.json',import.meta.url),'utf8'));
  const env={APPLE_TEAM_ID:'V8H6LQ9448',APPLE_APP_BUNDLE_ID:'io.uebelacker.AppAttestExample',NODE_ENV:'production'};
  const input={...fixture,challenge:Buffer.from(fixture.challenge,'base64')};
  assert.throws(()=>verifyAppAttestation(input,env),/Expired/);
  t.mock.timers.enable({apis:['Date'],now:new Date('2024-03-01T00:00:00Z')});
  assert.equal(verifyAppAttestation(input,env).environment,'production');
  assert.throws(()=>verifyAppAttestation({...input,challenge:'wrong'},env));
  assert.throws(()=>verifyAppAttestation({...input,keyId:Buffer.alloc(32).toString('base64')},env));
  assert.throws(()=>verifyAppAttestation(input,{...env,APPLE_TEAM_ID:'wrong'}));
  const changed=cbor.decodeAllSync(Buffer.from(input.attestation,'base64'))[0];changed.authData[0]^=1;
  assert.throws(()=>verifyAppAttestation({...input,attestation:cbor.encode(changed).toString('base64')},env));
});

test('attestation API binds assertion to signup email, rejects replay, and ignores client attested flags',async t=>{
  const env={APPLE_TEAM_ID:'TEAM',APPLE_APP_BUNDLE_ID:'com.test'};
  const {app,request,owner}=await fixture(t,env);
  await request('/api/admin/registration',{open:true},owner);
  const keyId=Buffer.alloc(32,7).toString('base64'),pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  app.db.addAppAttestKey(keyId,pair.publicKey.export({type:'spki',format:'pem'}),'production');
  const email='proof@example.com';
  const challenge=(await request('/api/auth/attest/challenge',{email,keyId,purpose:'assert'})).body;
  const auth=Buffer.alloc(37);createHash('sha256').update('TEAM.com.test').digest().copy(auth);auth.writeUInt32BE(1,33);
  const hash=createHash('sha256').update(Buffer.concat([auth,createHash('sha256').update(challenge.payload).digest()])).digest();
  const assertion=cbor.encode({signature:sign('sha256',hash,pair.privateKey),authenticatorData:auth}).toString('base64');
  const input={email,keyId,challenge:challenge.challenge,purpose:'assert',assertion};
  assert.equal((await request('/api/auth/attest/complete',{...input,email:'wrong@example.com'})).status,401);
  const complete=await request('/api/auth/attest/complete',input);assert.equal(complete.status,200);
  assert.equal((await request('/api/auth/attest/complete',input)).status,401);
  const signup=await request('/api/auth/register',{email,displayName:'Proof',password,attestationProof:complete.body.proof});assert.equal(signup.status,201);
  assert.equal(app.db.consumeSignupChallenge(hashToken(complete.body.proof),'signup-attested',hashToken(email)),false);
  assert.equal((await request('/api/auth/register',{email:'fallback@example.com',displayName:'Fallback',password,attested:true,attestationProof:'fake'})).status,201,'observe mode preserves fallback');
});
