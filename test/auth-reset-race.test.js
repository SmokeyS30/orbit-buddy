import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createOrbitServer } from '../server.js';
import { hashToken, verifyPassword } from '../src/security.js';
import { openPostgres } from '../src/db/postgres-adapter.js';

const oldPassword='correct horse battery staple';
const newPassword='new synthetic password 456789';

async function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-reset-race-'));
  let hold=null;
  const releases=[];
  const passwordVerifier=async(...args)=>{
    const valid=await verifyPassword(...args);
    if(hold){const gate=hold;hold=null;gate.started();await gate.wait;}
    return valid;
  };
  const app=createOrbitServer({dataDir:directory,env:{NODE_ENV:'test'},passwordVerifier});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const release of releases)release();await app.close();fs.rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const register=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'owner@example.test',displayName:'Owner',password:oldPassword})});
  assert.equal(register.status,201);
  const body=await register.json();
  const auth={cookie:register.headers.get('set-cookie').split(';')[0],csrf:body.csrf,user:body.user,codes:body.recoveryCodes};
  return{app,base,auth,
    gateNextVerification(){let started,release;const begun=new Promise(resolve=>{started=resolve;});const wait=new Promise(resolve=>{release=resolve;});releases.push(release);hold={started,wait};return{begun,release};},
    async reset(){const token=randomUUID();app.db.addPasswordResetToken(hashToken(token),auth.user.id,new Date(Date.now()+60_000).toISOString());return fetch(`${base}/api/auth/reset-password`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,newPassword})});}
  };
}
const headers=(auth)=>({Cookie:auth.cookie,'X-Orbit-CSRF':auth.csrf,'Content-Type':'application/json'});

async function pauseJsonPost(fx,pathname,payload){
  const body=JSON.stringify(payload);
  let seen;const arrived=new Promise(resolve=>{seen=resolve;});
  const onRequest=req=>{if(req.url===pathname){fx.app.server.off('request',onRequest);seen();}};
  fx.app.server.on('request',onRequest);
  let finish;
  const response=new Promise((resolve,reject)=>{
    const request=http.request(`${fx.base}${pathname}`,{method:'POST',headers:{...headers(fx.auth),'Content-Length':Buffer.byteLength(body)}},res=>{
      res.resume();res.on('end',()=>resolve(res.statusCode));
    });
    request.on('error',reject);
    request.write(body.slice(0,10));
    finish=()=>request.end(body.slice(10));
  });
  await arrived;
  // The route authenticates synchronously, then waits for the rest of JSON.
  await new Promise(resolve=>setImmediate(resolve));
  return{finish,response};
}

test('email reset fences an in-flight recovery-code rotation',{timeout:10_000},async t=>{
  const fx=await fixture(t);const gate=fx.gateNextVerification();
  const rotate=fetch(`${fx.base}/api/recovery-codes/rotate`,{method:'POST',headers:headers(fx.auth),body:JSON.stringify({password:oldPassword})});
  await gate.begun;
  assert.equal((await fx.reset()).status,200);
  gate.release();
  assert.equal((await rotate).status,401);
  const stale=await fetch(`${fx.base}/api/auth/recover`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'owner@example.test',recoveryCode:fx.auth.codes[0],newPassword:oldPassword})});
  assert.equal(stale.status,401);
});

test('email reset fences an in-flight password login',{timeout:10_000},async t=>{
  const fx=await fixture(t);const gate=fx.gateNextVerification();
  const login=fetch(`${fx.base}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'owner@example.test',password:oldPassword})});
  await gate.begun;
  assert.equal((await fx.reset()).status,200);
  gate.release();
  const stale=await login;
  assert.equal(stale.status,401);
  assert.equal(stale.headers.get('set-cookie'),null,'a stale login cannot mint a session');
  const current=await fetch(`${fx.base}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'owner@example.test',password:newPassword})});
  assert.equal(current.status,200,'new credentials continue to work');
});

test('email reset fences an in-flight account deletion',{timeout:10_000},async t=>{
  const fx=await fixture(t);const gate=fx.gateNextVerification();
  const deletion=fetch(`${fx.base}/api/account`,{method:'DELETE',headers:headers(fx.auth),body:JSON.stringify({password:oldPassword,confirm:'DELETE'})});
  await gate.begun;
  assert.equal((await fx.reset()).status,200);
  gate.release();
  assert.equal((await deletion).status,401);
  assert.ok(fx.app.db.getUserById(fx.auth.user.id),"the mailbox owner's account remains");
});

test('current credentials still rotate recovery codes and delete an account',async t=>{
  const fx=await fixture(t);
  const rotated=await fetch(`${fx.base}/api/recovery-codes/rotate`,{method:'POST',headers:headers(fx.auth),body:JSON.stringify({password:oldPassword})});
  assert.equal(rotated.status,200);
  const body=await rotated.json();assert.equal(body.recoveryCodes.length,10);
  const deletion=await fetch(`${fx.base}/api/account`,{method:'DELETE',headers:headers(fx.auth),body:JSON.stringify({password:oldPassword,confirm:'DELETE'})});
  assert.equal(deletion.status,200);
  assert.equal(fx.app.db.getUserById(fx.auth.user.id),undefined);
});

test('email reset prevents an already-authenticated partial push request from re-registering',{timeout:10_000},async t=>{
  const apns=await fixture(t);
  const nativeToken='a'.repeat(64);
  const pendingNative=await pauseJsonPost(apns,'/api/push/token',{token:nativeToken});
  assert.equal((await apns.reset()).status,200);
  pendingNative.finish();
  assert.equal(await pendingNative.response,401);
  assert.equal(apns.app.db.listApnsTokens(apns.auth.user.id).length,0);

  const web=await fixture(t);
  const pendingWeb=await pauseJsonPost(web,'/api/push/subscribe',{
    endpoint:'https://push.example.test/synthetic',keys:{p256dh:'synthetic',auth:'synthetic'}
  });
  assert.equal((await web.reset()).status,200);
  pendingWeb.finish();
  assert.equal(await pendingWeb.response,401);
  assert.equal(web.app.db.listPush(web.auth.user.id).length,0);
});

test('PostgreSQL credential-bound mutations reject stale proofs after reset',async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  const db=await openPostgres(process.env.TEST_DATABASE_URL);let user=null;
  try{
    user=await db.createUser({email:`reset-race-${randomUUID()}@example.test`,displayName:'Synthetic',passwordHash:'old-hash',passwordSalt:'old-salt',role:'member'});
    const expiry=new Date(Date.now()+60_000).toISOString();
    await db.createSession({tokenHash:'old-session-'+user.id,userId:user.id,csrfToken:'synthetic',expiresAt:expiry,userAgent:'synthetic'});
    await db.linkAuthIdentity('apple','old-apple-'+user.id,user.id);
    await db.addPasswordResetToken('reset-'+user.id,user.id,expiry);
    assert.equal(await db.finishPasswordReset('reset-'+user.id,'new-hash','new-salt'),true);
    assert.equal(await db.createPasswordSessionIfCurrent({tokenHash:'bad-'+user.id,userId:user.id,csrfToken:'bad',expiresAt:expiry,expectedPasswordHash:'old-hash',expectedPasswordSalt:'old-salt'}),false);
    assert.equal(await db.replaceRecoveryCodesIfCurrent(user.id,'old-session-'+user.id,'old-hash','old-salt',['old-code']),false);
    assert.equal(await db.createAppleSessionIfCurrent({tokenHash:'bad-apple-'+user.id,userId:user.id,csrfToken:'bad',expiresAt:expiry,identitySubject:'old-apple-'+user.id}),false);
    assert.equal(await db.linkAuthIdentityIfCurrent('apple','old-apple-'+user.id,user.id,'old-session-'+user.id,'old-hash','old-salt'),false);
    assert.equal(await db.savePushIfCurrent(user.id,{endpoint:'https://push.example.test/stale',keys:{p256dh:'synthetic',auth:'synthetic'}},'old-session-'+user.id),false);
    assert.equal(await db.saveApnsTokenIfCurrent(user.id,'a'.repeat(64),'old-session-'+user.id),false);
    assert.equal((await db.listPush(user.id)).length,0);
    assert.equal((await db.listApnsTokens(user.id)).length,0);
    assert.equal(await db.getAuthIdentity('apple','old-apple-'+user.id),null);
    assert.equal((await db.deleteUserAccount(user.id,{sessionHash:'old-session-'+user.id,expectedPasswordHash:'old-hash',expectedPasswordSalt:'old-salt'})).staleCredentials,true);
    assert.ok(await db.getUserById(user.id));
    assert.equal(await db.createPasswordSessionIfCurrent({tokenHash:'new-session-'+user.id,userId:user.id,csrfToken:'new',expiresAt:expiry,expectedPasswordHash:'new-hash',expectedPasswordSalt:'new-salt'}),true);
    assert.equal(await db.savePushIfCurrent(user.id,{endpoint:'https://push.example.test/current',keys:{p256dh:'synthetic',auth:'synthetic'}},'new-session-'+user.id),true);
    assert.equal(await db.saveApnsTokenIfCurrent(user.id,'b'.repeat(64),'new-session-'+user.id),true);
  }finally{if(user)await db.run('DELETE FROM users WHERE id=?',user.id);await db.close();}
});
