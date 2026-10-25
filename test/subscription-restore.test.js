import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Environment, Status } from '@apple/app-store-server-library';
import { createOrbitServer } from '../server.js';
import { openPostgres } from '../src/db/postgres-adapter.js';

const PRODUCT='com.smokeys30.orbitbuddy.standard.monthly';
const password='correct horse battery staple';

async function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-subscription-restore-'));
  let token=null,appleCalls=0;
  const txn=()=>({transactionId:'synthetic-txn',originalTransactionId:'synthetic-orig',productId:PRODUCT,appAccountToken:token,
    bundleId:'com.smokeys30.orbitbuddy',expiresDate:Date.now()+30*86400_000,signedDate:Date.now(),environment:Environment.SANDBOX});
  const verifier={
    async verifyAndDecodeTransaction(input){if(!['device','server','status','notification-txn'].includes(input))throw new Error('Invalid synthetic signature');return txn();},
    async verifyAndDecodeNotification(input){if(input!=='notification')throw new Error('Invalid synthetic notification');return{notificationUUID:'synthetic-notification',signedDate:Date.now(),data:{signedTransactionInfo:'notification-txn'}};},
  };
  const client={
    async getTransactionInfo(){appleCalls++;return{signedTransactionInfo:'server'};},
    async getAllSubscriptionStatuses(){appleCalls++;return{data:[{lastTransactions:[{status:Status.ACTIVE,signedTransactionInfo:'status'}]}]};},
  };
  const sent=[];
  const app=createOrbitServer({dataDir:directory,
    env:{NODE_ENV:'test',SIGNUP_RISK_MODE:'off',SIGNUP_AUDIT_KEY:'synthetic-subscription-restore-key',SUBSCRIPTIONS_ENABLED:'true'},
    sendEmail:async(_env,message)=>{sent.push(message);return true;},
    subscriptionDependencies:{appleRuntime:{sandbox:{environment:Environment.SANDBOX,verifier,client}}}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();fs.rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const register=async(email)=>{
    const post=(input)=>fetch(`${base}/api/auth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    const input={email,displayName:'Synthetic',password};
    let response=await post(input);
    if(response.status===403&&(await response.clone().json()).verificationRequired){
      const link=sent.at(-1).text.match(/https?:\/\/\S+/)[0];
      response=await post({...input,verificationToken:new URL(link).hash.replace('#signup-verify=','')});
    }
    assert.equal(response.status,201);
    const body=await response.json();
    return{cookie:response.headers.get('set-cookie').split(';')[0],csrf:body.csrf,id:body.user.id};
  };
  const owner=await register('owner@example.test');
  const headers=(auth)=>({'Content-Type':'application/json',Cookie:auth.cookie,'X-Orbit-CSRF':auth.csrf});
  const intent=await fetch(`${base}/api/subscriptions/purchase-intent`,{method:'POST',headers:headers(owner),body:JSON.stringify({productId:PRODUCT})});
  assert.equal(intent.status,200);
  token=(await intent.json()).appAccountToken;
  return{app,base,owner,headers,register,token,get appleCalls(){return appleCalls;}};
}

test('first signed purchase can be recovered from a pending account-bound intent without the client token',async t=>{
  const fx=await fixture(t);
  const response=await fetch(`${fx.base}/api/subscriptions/verify`,{method:'POST',headers:fx.headers(fx.owner),body:JSON.stringify({signedTransaction:'device'})});
  assert.equal(response.status,200);
  assert.equal((await response.json()).status,'active');
  assert.equal(fx.app.db.getSubscription(fx.owner.id).app_account_token,fx.token);
  assert.equal(fx.app.db.getPurchaseIntent(fx.owner.id,fx.token,PRODUCT),null,'the pending intent was consumed');
  assert.equal(fx.appleCalls,2,'synthetic Apple API was checked once for the transaction and once for status');
});

test('another account cannot claim a signed purchase bound to the first account',async t=>{
  const fx=await fixture(t);
  fx.app.db.setSetting('registration_open','true');
  const other=await fx.register('other@example.test');
  const response=await fetch(`${fx.base}/api/subscriptions/verify`,{method:'POST',headers:fx.headers(other),body:JSON.stringify({signedTransaction:'device'})});
  assert.equal(response.status,403);
  assert.equal(fx.appleCalls,0,'cross-account claim is rejected before an Apple API request');
  assert.equal(fx.app.db.getSubscription(other.id),null);
});

test('verified Apple notification binds a first purchase through its pending intent',async t=>{
  const fx=await fixture(t);
  const response=await fetch(`${fx.base}/api/subscriptions/apple-notifications`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({signedPayload:'notification'})});
  assert.equal(response.status,200);
  const subscription=fx.app.db.getSubscription(fx.owner.id);
  assert.equal(subscription.app_account_token,fx.token);
  assert.equal(subscription.status,'active');
});

test('PostgreSQL finds only the owning account from an active pending purchase intent',async()=>{
  const url=process.env.TEST_DATABASE_URL;
  assert.ok(url,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  const db=await openPostgres(url);
  const suffix=Date.now()+'-'+Math.random();
  const user=await db.createUser({email:`sub-owner-${suffix}@example.test`,displayName:'Owner',passwordHash:'hash',passwordSalt:'salt',role:'member'});
  const other=await db.createUser({email:`sub-other-${suffix}@example.test`,displayName:'Other',passwordHash:'hash',passwordSalt:'salt',role:'member'});
  try{
    const token=randomUUID();
    const expiresAt=new Date(Date.now()+60_000).toISOString();
    const intent=await db.createPurchaseIntent(user.id,PRODUCT,token,expiresAt);
    assert.equal(await db.findUserByAppAccountToken(token),user.id);
    assert.equal(await db.getPurchaseIntent(other.id,token,PRODUCT),null);
    assert.equal((await db.getPurchaseIntent(user.id,token,PRODUCT)).id,intent.id);
    await db.completePurchaseIntent(intent.id,'synthetic-transaction-'+suffix);
    assert.equal(await db.findUserByAppAccountToken(token),null,'verified intent is no longer a pending notification binding');
  }finally{
    await db.deleteUserAccount(user.id);
    await db.deleteUserAccount(other.id);
    await db.close();
  }
});
