import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
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
const delay=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));

async function waitFor(pool,check,message){
  const end=Date.now()+10_000;
  while(Date.now()<end){if(await check())return;await delay(20);}
  assert.fail(message);
}

async function waitingQueries(pool,fragment){
  const {rows}=await pool.query(`SELECT COUNT(*) AS count FROM pg_stat_activity
    WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1`,[`%${fragment}%`]);
  return Number(rows[0].count);
}

async function pauseOnWrite(pool,table,userId,updatePassword=false){
  const suffix=randomUUID().replaceAll('-','');
  const functionName=`orbit_test_pause_${suffix}`;
  const triggerName=`orbit_test_pause_${suffix}`;
  const lockKey=BigInt(`0x${suffix.slice(0,15)}`).toString();
  const client=await pool.connect();
  let released=false;
  await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(${lockKey}::bigint); RETURN NEW; END $$`);
  try{
    const when=updatePassword
      ? `BEFORE UPDATE OF password_hash ON users FOR EACH ROW WHEN (OLD.id='${userId}' AND NEW.password_hash IS DISTINCT FROM OLD.password_hash)`
      : `BEFORE INSERT ON ${table} FOR EACH ROW WHEN (NEW.user_id='${userId}')`;
    await pool.query(`CREATE TRIGGER ${triggerName} ${when} EXECUTE FUNCTION ${functionName}()`);
    await client.query('SELECT pg_advisory_lock($1::bigint)',[lockKey]);
  }catch(error){
    await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    client.release();
    throw error;
  }
  return{
    lockKey,
    async waitForTrigger(){await waitFor(pool,async()=>{
      const {rows}=await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted
        AND classid=(($1::bigint >> 32)::oid) AND objid=(($1::bigint & 4294967295)::oid) AND objsubid=1) AS waiting`,[lockKey]);
      return rows[0].waiting;
    },'the guarded write did not reach its synchronization trigger');},
    async release(){if(!released){released=true;await client.query('SELECT pg_advisory_unlock($1::bigint)',[lockKey]);}},
    async dispose(){
      await this.release();
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON ${updatePassword?'users':table}`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      client.release();
    }
  };
}

async function assertResetClearedProofs(db,userId){
  assert.deepEqual(await db.all('SELECT token_hash FROM sessions WHERE user_id=?',userId),[]);
  assert.deepEqual(await db.all('SELECT subject FROM auth_identities WHERE user_id=?',userId),[]);
  assert.deepEqual(await db.all('SELECT code_hash FROM recovery_codes WHERE user_id=?',userId),[]);
  assert.deepEqual(await db.listPush(userId),[]);
  assert.deepEqual(await db.listApnsTokens(userId),[]);
}

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

test('PostgreSQL credential-bound mutations reject stale proofs after reset and serialize with reset',{timeout:120_000},async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  const databaseUrl=process.env.TEST_DATABASE_URL;
  const db=await openPostgres(databaseUrl);
  const pool=new pg.Pool({connectionString:databaseUrl,ssl:/sslmode=disable/.test(databaseUrl)?false:true});
  try{
    const guards=[
      {name:'password session creation',table:'sessions',run:({user,expiry})=>db.createPasswordSessionIfCurrent({
        tokenHash:`new-password-${user.id}`,userId:user.id,csrfToken:'new',expiresAt:expiry,expectedPasswordHash:'old-hash',expectedPasswordSalt:'old-salt'
      })},
      {name:'Apple session creation',table:'sessions',run:({user,expiry,appleSubject})=>db.createAppleSessionIfCurrent({
        tokenHash:`new-apple-${user.id}`,userId:user.id,csrfToken:'new',expiresAt:expiry,identitySubject:appleSubject
      })},
      {name:'Google identity linking',table:'auth_identities',run:({user,sessionHash})=>db.linkAuthIdentityIfCurrent(
        'google',`new-identity-${user.id}`,user.id,sessionHash,'old-hash','old-salt'
      )},
      {name:'recovery-code rotation',table:'recovery_codes',run:({user,sessionHash})=>db.replaceRecoveryCodesIfCurrent(
        user.id,sessionHash,'old-hash','old-salt',[`new-code-${user.id}`]
      )},
      {name:'web-push registration',table:'push_subscriptions',run:({user,sessionHash})=>db.savePushIfCurrent(user.id,{
        endpoint:`https://push.example.test/${user.id}`,keys:{p256dh:'synthetic',auth:'synthetic'}
      },sessionHash)},
      {name:'APNs registration',table:'apns_device_tokens',run:({user,sessionHash})=>db.saveApnsTokenIfCurrent(
        user.id,`${user.id.replaceAll('-','').slice(0,64)}`,sessionHash
      )}
    ];
    for(const guard of guards){
      for(const resetFirst of [true,false]){
        let user=null,pause=null,mutationPromise=null,resetPromise=null;
        try{
          user=await db.createUser({email:`reset-race-${randomUUID()}@example.test`,displayName:'Synthetic',passwordHash:'old-hash',passwordSalt:'old-salt',role:'member'});
          const expiry=new Date(Date.now()+60_000).toISOString();
          const sessionHash=`old-session-${user.id}`;
          const appleSubject=`old-apple-${user.id}`;
          await db.createSession({tokenHash:sessionHash,userId:user.id,csrfToken:'synthetic',expiresAt:expiry,userAgent:'synthetic'});
          await db.linkAuthIdentity('apple',appleSubject,user.id);
          await db.replaceRecoveryCodes(user.id,[`old-code-${user.id}`]);
          const resetHash=`reset-${user.id}`;
          await db.addPasswordResetToken(resetHash,user.id,expiry);
          const args={user,expiry,sessionHash,appleSubject};
          if(resetFirst){
            pause=await pauseOnWrite(pool,'users',user.id,true);
            resetPromise=db.finishPasswordReset(resetHash,'new-hash','new-salt');
            await pause.waitForTrigger();
            const before=await waitingQueries(pool,'FROM users WHERE id=$1 FOR UPDATE');
            mutationPromise=guard.run(args);
            await waitFor(pool,async()=>await waitingQueries(pool,'FROM users WHERE id=$1 FOR UPDATE')>before,
              `${guard.name} did not wait for the in-flight reset`);
            await pause.release();
            assert.equal(await resetPromise,true);
            assert.equal(await mutationPromise,false,`${guard.name} must reject the revoked proof`);
          }else{
            pause=await pauseOnWrite(pool,guard.table,user.id);
            mutationPromise=guard.run(args);
            await pause.waitForTrigger();
            const before=await waitingQueries(pool,'FROM users WHERE id=$1 FOR UPDATE');
            resetPromise=db.finishPasswordReset(resetHash,'new-hash','new-salt');
            await waitFor(pool,async()=>await waitingQueries(pool,'FROM users WHERE id=$1 FOR UPDATE')>before,
              `reset did not wait for ${guard.name} to commit`);
            await pause.release();
            assert.equal(await mutationPromise,true,`${guard.name} should finish before reset`);
            assert.equal(await resetPromise,true);
          }
          await assertResetClearedProofs(db,user.id);
          assert.equal((await db.getUserById(user.id)).password_hash,'new-hash');
        }finally{
          if(pause)await pause.release();
          await Promise.allSettled([mutationPromise,resetPromise].filter(Boolean));
          if(pause)await pause.dispose();
          if(user)await db.run('DELETE FROM users WHERE id=?',user.id);
        }
      }
    }
    let user=null;
    try{
      user=await db.createUser({email:`reset-race-${randomUUID()}@example.test`,displayName:'Synthetic',passwordHash:'old-hash',passwordSalt:'old-salt',role:'member'});
      const expiry=new Date(Date.now()+60_000).toISOString();
      const sessionHash=`old-session-${user.id}`;
      await db.createSession({tokenHash:sessionHash,userId:user.id,csrfToken:'synthetic',expiresAt:expiry,userAgent:'synthetic'});
      await db.addPasswordResetToken(`reset-${user.id}`,user.id,expiry);
      assert.equal(await db.finishPasswordReset(`reset-${user.id}`,'new-hash','new-salt'),true);
      assert.equal((await db.deleteUserAccount(user.id,{sessionHash,expectedPasswordHash:'old-hash',expectedPasswordSalt:'old-salt'})).staleCredentials,true);
      assert.ok(await db.getUserById(user.id));
      assert.equal(await db.createPasswordSessionIfCurrent({tokenHash:`new-session-${user.id}`,userId:user.id,csrfToken:'new',expiresAt:expiry,expectedPasswordHash:'new-hash',expectedPasswordSalt:'new-salt'}),true);
      assert.equal(await db.savePushIfCurrent(user.id,{endpoint:`https://push.example.test/current/${user.id}`,keys:{p256dh:'synthetic',auth:'synthetic'}},`new-session-${user.id}`),true);
      assert.equal(await db.saveApnsTokenIfCurrent(user.id,user.id.replaceAll('-',''),`new-session-${user.id}`),true);
    }finally{if(user)await db.run('DELETE FROM users WHERE id=?',user.id);}
  }finally{await pool.end();await db.close();}
});
