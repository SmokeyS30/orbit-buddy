import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/database.js';
import { openPostgres } from '../src/db/postgres-adapter.js';

test('native and web push registrations stop at session logout and follow the current device owner',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-push-session-'));
  const databasePath=path.join(directory,'orbit.sqlite');
  const db=openDatabase(databasePath);
  try{
    const a=db.createUser({email:'a@example.test',displayName:'A',passwordHash:'synthetic',passwordSalt:'synthetic',role:'owner'});
    const b=db.createUser({email:'b@example.test',displayName:'B',passwordHash:'synthetic',passwordSalt:'synthetic',role:'member'});
    const expiry=new Date(Date.now()+60_000).toISOString();
    db.createSession({tokenHash:'session-a',userId:a.id,csrfToken:'a',expiresAt:expiry,userAgent:'synthetic'});
    db.createSession({tokenHash:'session-b',userId:b.id,csrfToken:'b',expiresAt:expiry,userAgent:'synthetic'});
    const legacy=new DatabaseSync(databasePath);
    try{
      legacy.prepare('INSERT INTO apns_device_tokens(id,user_id,device_token,platform,apns_environment,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(),a.id,'cd'.repeat(32),'ios','production',expiry,expiry);
      legacy.prepare('INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,created_at) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(),a.id,'https://push.example.test/legacy','synthetic-p256dh','synthetic-auth',expiry);
    }finally{legacy.close();}
    assert.equal(db.listApnsTokens(a.id).length,0,'legacy unbound APNs registrations must fail closed');
    assert.equal(db.listPush(a.id).length,0,'legacy unbound web push subscriptions must fail closed');
    const token='ab'.repeat(32);
    db.saveApnsToken(a.id,token,'session-a');
    assert.equal(db.listApnsTokens(a.id).length,1);
    db.saveApnsToken(b.id,token,'session-b');
    assert.equal(db.listApnsTokens(a.id).length,0,'a device registered by B must no longer receive A notifications');
    assert.equal(db.listApnsTokens(b.id).length,1);

    db.savePush(a.id,{endpoint:'https://push.example.test/device',keys:{p256dh:'synthetic-p256dh',auth:'synthetic-auth'}},'session-a');
    assert.equal(db.listPush(a.id).length,1);
    db.deleteSession('session-a');
    db.deleteSession('session-b');
    assert.equal(db.listPush(a.id).length,0,'logout must stop web push delivery');
    assert.equal(db.listApnsTokens(b.id).length,0,'logout must stop native push delivery');
  }finally{db.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('PostgreSQL push registrations use the same session and ownership rules',async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  const db=await openPostgres(process.env.TEST_DATABASE_URL);
  let a=null,b=null;
  const suffix=randomUUID();
  try{
    a=await db.createUser({email:`push-a-${suffix}@example.test`,displayName:'A',passwordHash:'synthetic',passwordSalt:'synthetic',role:'owner'});
    b=await db.createUser({email:`push-b-${suffix}@example.test`,displayName:'B',passwordHash:'synthetic',passwordSalt:'synthetic',role:'member'});
    const expiry=new Date(Date.now()+60_000).toISOString();
    await db.createSession({tokenHash:`a-${suffix}`,userId:a.id,csrfToken:'a',expiresAt:expiry,userAgent:'synthetic'});
    await db.createSession({tokenHash:`b-${suffix}`,userId:b.id,csrfToken:'b',expiresAt:expiry,userAgent:'synthetic'});
    const token='ac'.repeat(32);
    await db.saveApnsToken(a.id,token,`a-${suffix}`);
    await db.saveApnsToken(b.id,token,`b-${suffix}`);
    assert.equal((await db.listApnsTokens(a.id)).length,0);
    assert.equal((await db.listApnsTokens(b.id)).length,1);
    await db.savePush(a.id,{endpoint:`https://push.example.test/${suffix}`,keys:{p256dh:'synthetic-p256dh',auth:'synthetic-auth'}},`a-${suffix}`);
    assert.equal((await db.listPush(a.id)).length,1);
    await db.deleteSession(`a-${suffix}`);
    await db.deleteSession(`b-${suffix}`);
    assert.equal((await db.listPush(a.id)).length,0);
    assert.equal((await db.listApnsTokens(b.id)).length,0);
  }finally{
    if(a)await db.run('DELETE FROM users WHERE id=?',a.id);
    if(b)await db.run('DELETE FROM users WHERE id=?',b.id);
    await db.close();
  }
});
