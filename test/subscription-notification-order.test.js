import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Environment, Status } from '@apple/app-store-server-library';
import { openDatabase } from '../src/database.js';
import { createSyncPgAdapter } from '../src/db/sync-pg-wrapper.mjs';
import { createSubscriptionService } from '../src/subscriptions.js';

const productId='com.smokeys30.orbitbuddy.standard.monthly';
const older=Date.parse('2026-10-19T11:00:00.000Z');
const newer=Date.parse('2026-10-19T12:00:00.000Z');

function notificationService(db,{notificationId,signedDate,status,waitForStatus=async()=>{}}){
  const transaction={transactionId:'synthetic-transaction',originalTransactionId:'synthetic-original',
    productId,appAccountToken:null,expiresDate:Date.now()+86400_000,signedDate};
  return (token)=>{
    const verifier={
      async verifyAndDecodeNotification(){return{notificationUUID:notificationId,signedDate,
        data:{signedTransactionInfo:'notification-transaction'}};},
      async verifyAndDecodeTransaction(){return{...transaction,appAccountToken:token};},
    };
    const client={async getAllSubscriptionStatuses(){await waitForStatus();
      return{data:[{lastTransactions:[{status,signedTransactionInfo:'status-transaction'}]}]};}};
    return createSubscriptionService({SUBSCRIPTIONS_ENABLED:'true'},db,
      {appleRuntime:{production:{environment:Environment.PRODUCTION,verifier,client}}});
  };
}

async function checkReverseCompletion(dbOld,dbNew,userId,token){
  await dbOld.saveSubscription(userId,{productId,status:'active',appAccountToken:token,
    originalTransactionId:'synthetic-original',lastEventSignedAt:'2026-10-19T10:00:00.000Z'});
  let releaseOld,oldEntered;
  const entered=new Promise(resolve=>{oldEntered=resolve;});
  const blocked=new Promise(resolve=>{releaseOld=resolve;});
  const oldService=notificationService(dbOld,{notificationId:`old-${randomUUID()}`,
    signedDate:older,status:Status.ACTIVE,waitForStatus:async()=>{oldEntered();await blocked;}})(token);
  const newService=notificationService(dbNew,{notificationId:`new-${randomUUID()}`,
    signedDate:newer,status:Status.REVOKED})(token);
  const oldRun=oldService.handleNotification('synthetic');
  let newerError;
  try{
    await entered;
    const newResult=await newService.handleNotification('synthetic');
    assert.equal(newResult.status,'revoked');
    assert.equal((await dbNew.getSubscription(userId)).status,'revoked');
  }catch(error){newerError=error;
  }finally{releaseOld();}
  const oldResult=await oldRun.catch(error=>{if(!newerError)throw error;return null;});
  if(newerError)throw newerError;
  assert.equal(oldResult.reason,'stale notification');
  const final=await dbNew.getSubscription(userId);
  assert.equal(final.status,'revoked');
  assert.equal(final.last_event_signed_at,new Date(newer).toISOString());
  const duplicate=notificationService(dbOld,{notificationId:`duplicate-${randomUUID()}`,
    signedDate:newer,status:Status.ACTIVE})(token);
  assert.equal((await duplicate.handleNotification('synthetic')).reason,'stale notification');
  assert.equal((await dbOld.getSubscription(userId)).status,'revoked');
  assert.equal(await dbOld.applySubscriptionNotification(userId,{productId,status:'active',appAccountToken:randomUUID(),
    originalTransactionId:'synthetic-other',lastEventSignedAt:new Date(newer+60_000).toISOString()}),false,
    'a later callback cannot replace a different account binding');
  const snapshot=await dbOld.getSubscription(userId);
  const laterSignedAt=new Date(newer+120_000).toISOString();
  assert.equal(await dbNew.applySubscriptionNotification(userId,{productId,status:'active',appAccountToken:token,
    originalTransactionId:'synthetic-original',lastEventSignedAt:laterSignedAt}),true);
  const staleResult={productId,status:'revoked',appAccountToken:token,originalTransactionId:'synthetic-original',
    lastEventSignedAt:new Date(older).toISOString()};
  assert.equal(await dbOld.saveSubscriptionIfUnchanged(userId,snapshot,staleResult),false,
    'a verifier that started before a notification cannot undo it');
  assert.equal(await dbOld.saveSubscriptionIfUnchanged(userId,null,staleResult),false,
    'a first-purchase insert cannot replace an account row created meanwhile');
  const fresh=await dbOld.getSubscription(userId);
  assert.equal(await dbOld.saveSubscriptionIfUnchanged(userId,fresh,{...staleResult,status:'active'}),true);
  assert.equal((await dbOld.getSubscription(userId)).last_event_signed_at,laterSignedAt,
    'a fresh status check must not move the signed event marker backward');
}

test('SQLite older signed notification cannot overwrite a newer event after a delayed status response',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-notification-order-'));
  const file=path.join(dir,'test.sqlite');
  const oldDb=openDatabase(file),newDb=openDatabase(file);
  try{
    const user=oldDb.createUser({email:'notification-order@example.test',displayName:'Synthetic',
      passwordHash:'x',passwordSalt:'y',role:'owner'});
    await checkReverseCompletion(oldDb,newDb,user.id,randomUUID());
  }finally{oldDb.close();newDb.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('PostgreSQL older signed notification cannot overwrite a newer event across connections',async()=>{
  const url=process.env.TEST_DATABASE_URL;
  assert.ok(url,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  const oldDb=createSyncPgAdapter(url),newDb=createSyncPgAdapter(url);
  let user;
  try{
    user=await oldDb.createUser({email:`notification-${randomUUID()}@example.test`,displayName:'Synthetic',
      passwordHash:'x',passwordSalt:'y',role:'member'});
    await checkReverseCompletion(oldDb,newDb,user.id,randomUUID());
  }finally{if(user)await oldDb.deleteUserAccount(user.id);await oldDb.close();await newDb.close();}
});
