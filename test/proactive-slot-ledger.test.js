import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { openDatabase } from '../src/database.js';
import { openPostgres } from '../src/db/postgres-adapter.js';
import { createOrbitServer } from '../server.js';

async function checkFreshAccountOutreach(app,email){
  const user=app.db.createUser({email,displayName:'Synthetic',passwordHash:'x',passwordSalt:'y',role:'member'});
  const date='2026-10-28';
  assert.equal(app.db.getLastOutreachAt(user.id),null,'fresh account has no proactive state');
  const token=app.db.reserveProactiveSlot(user.id,date);
  assert.ok(token,'fresh account can reserve a daily slot');
  const outcome=await app.deliverProactive(user,'Synthetic check-in','test','Synthetic delivery',{date,token});
  assert.equal(outcome.recorded,true);
  assert.ok(Number.isFinite(Date.parse(app.db.getLastOutreachAt(user.id))),
    'delivery must create last_outreach_at for cross-feature cooldowns');
  const quiet='2026-10-27T15:00:00.000Z';
  app.db.setLastQuietNudgeAt(user.id,quiet);
  assert.equal(app.db.markOutreach(user.id),true);
  assert.equal(app.db.getLastQuietNudgeAt(user.id),quiet,'upsert preserves unrelated proactive fields');
  return user;
}

test('SQLite fresh-account proactive delivery records the outreach cooldown',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-fresh-outreach-sqlite-'));
  const app=createOrbitServer({dataDir:dir,env:{NODE_ENV:'test'}});
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  await checkFreshAccountOutreach(app,`fresh-${randomUUID()}@example.test`);
});

test('PostgreSQL fresh-account proactive delivery records the outreach cooldown',async t=>{
  const url=process.env.TEST_DATABASE_URL;
  assert.ok(url,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  const setup=new pg.Client({connectionString:url,ssl:url.includes('sslmode=disable')?false:true});
  await setup.connect();
  try{await setup.query(fs.readFileSync(new URL('../src/db/postgres-schema.sql',import.meta.url),'utf8'));}
  finally{await setup.end();}
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-fresh-outreach-pg-'));
  const app=createOrbitServer({dataDir:dir,env:{NODE_ENV:'test',DATABASE_URL:url}});
  let user;
  try{user=await checkFreshAccountOutreach(app,`fresh-${randomUUID()}@example.test`);}
  finally{if(user)app.db.deleteUserAccount(user.id);await app.close();fs.rmSync(dir,{recursive:true,force:true});}
});

async function checkDateAndRelease(db,userId){
  const newDate='2026-10-26',oldDate='2026-10-25';
  const newer=[];
  for(let i=0;i<3;i++)newer.push(await db.reserveProactiveSlot(userId,newDate,3));
  assert.ok(newer.every(Boolean));
  assert.equal(await db.claimProactiveSlot(userId,newDate,3),false);
  assert.equal(await db.commitProactiveSlot(userId,newDate,newer[1]),true);
  assert.equal(await db.releaseProactiveSlot(userId,newDate,newer[1]),false,
    'a committed outbound message cannot be refunded');
  const older=await db.reserveProactiveSlot(userId,oldDate,3);
  assert.ok(older,'an old date is independent of the newer date');
  assert.equal(await db.claimProactiveSlot(userId,newDate,3),false,
    'a late old-date claim cannot reset the newer daily count');
  assert.equal(await db.releaseProactiveSlot(userId,newDate,newer[0]),true);
  assert.equal(await db.releaseProactiveSlot(userId,newDate,newer[0]),false,
    'a reservation can be refunded only once');
  assert.equal(await db.releaseProactiveSlot(userId,newDate,older),false,
    'a token from another date cannot refund this date');
  assert.ok(await db.claimProactiveSlot(userId,newDate,3),'one refund makes one slot available');
  assert.equal(await db.claimProactiveSlot(userId,newDate,3),false);
}

test('SQLite daily proactive reservations are date and token isolated',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-proactive-slots-'));
  const db=openDatabase(path.join(dir,'test.sqlite'));
  try{
    const user=db.createUser({email:'slots@example.test',displayName:'Synthetic',passwordHash:'x',passwordSalt:'y',role:'owner'});
    await checkDateAndRelease(db,user.id);
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('SQLite opening the pre-ledger state preserves its daily cap exactly once',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-proactive-migrate-'));
  const file=path.join(dir,'test.sqlite');
  let db=openDatabase(file);
  try{
    const user=db.createUser({email:'migrate@example.test',displayName:'Synthetic',passwordHash:'x',passwordSalt:'y',role:'owner'});
    db.close();
    const raw=new DatabaseSync(file);
    raw.exec('DROP TABLE proactive_slot_reservations; DROP TABLE proactive_slot_days');
    raw.prepare('INSERT INTO proactive_state(user_id,outreach_date,outreach_count) VALUES(?,?,?)').run(user.id,'2026-10-26',2);
    raw.close();
    db=openDatabase(file);
    assert.equal(db.claimProactiveSlot(user.id,'2026-10-26',3),true);
    db.close();db=openDatabase(file);
    assert.equal(db.claimProactiveSlot(user.id,'2026-10-26',3),false,'repeat migration does not reset the day');
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('PostgreSQL daily proactive reservations are date and token isolated across connections',async()=>{
  const url=process.env.TEST_DATABASE_URL;
  assert.ok(url,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  const setup=new pg.Client({connectionString:url,ssl:url.includes('sslmode=disable')?false:true});
  await setup.connect();
  try{await setup.query(fs.readFileSync(new URL('../src/db/postgres-schema.sql',import.meta.url),'utf8'));}
  finally{await setup.end();}
  const a=await openPostgres(url),b=await openPostgres(url);
  let user;
  try{
    user=await a.createUser({email:`slots-${randomUUID()}@example.test`,displayName:'Synthetic',passwordHash:'x',passwordSalt:'y',role:'member'});
    await checkDateAndRelease(a,user.id);
    const today='2026-10-27';
    const claimed=await Promise.all(Array.from({length:16},(_,index)=>(index%2?a:b).reserveProactiveSlot(user.id,today,3)));
    assert.equal(claimed.filter(Boolean).length,3);
    assert.equal(new Set(claimed.filter(Boolean)).size,3,'each reservation has a unique claim token');
  }finally{if(user)await a.deleteUserAccount(user.id);await a.close();await b.close();}
});

test('PostgreSQL pre-ledger cap migration repeats without resetting the day',async()=>{
  const url=process.env.TEST_DATABASE_URL;
  assert.ok(url,'TEST_DATABASE_URL must point at disposable PostgreSQL');
  let db=await openPostgres(url);
  const user=await db.createUser({email:`migration-${randomUUID()}@example.test`,displayName:'Synthetic',passwordHash:'x',passwordSalt:'y',role:'member'});
  await db.close();
  const raw=new pg.Client({connectionString:url,ssl:url.includes('sslmode=disable')?false:true});
  await raw.connect();
  try{
    await raw.query('DELETE FROM proactive_slot_reservations WHERE user_id=$1',[user.id]);
    await raw.query('DELETE FROM proactive_slot_days WHERE user_id=$1',[user.id]);
    await raw.query('INSERT INTO proactive_state(user_id,outreach_date,outreach_count) VALUES($1,$2,2) ON CONFLICT(user_id) DO UPDATE SET outreach_date=excluded.outreach_date,outreach_count=2',[user.id,'2026-10-26']);
  }finally{await raw.end();}
  db=await openPostgres(url);
  try{
    assert.equal(await db.claimProactiveSlot(user.id,'2026-10-26',3),true);
    await db.close();db=await openPostgres(url);
    assert.equal(await db.claimProactiveSlot(user.id,'2026-10-26',3),false);
  }finally{await db.deleteUserAccount(user.id);await db.close();}
});
