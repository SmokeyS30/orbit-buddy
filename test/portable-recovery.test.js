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
import { PORTABLE_USER_TABLES, portableInsertSql, portableRowValues } from '../src/portable-recovery.js';
import { writeAutomatedBackup } from '../src/backups.js';
import { decryptPortable, encryptPortable, hashToken } from '../src/security.js';
import { createOrbitServer } from '../server.js';
import { createSyncPgAdapter } from '../src/db/sync-pg-wrapper.mjs';

const now='2026-10-24T12:00:00.000Z';
function sampleRow(entry,userId,prefix){
  const values={id:`${prefix}-${entry.table}`,user_id:userId,label:'Birthday',month:10,day:24,year:2026,type:'birthday',
    notes:'Call Alex',gift_nag:1,gift_done:0,item_type:'goal',item_id:'goal-1',date:'2026-10-24',record_json:'{}',version:1,
    source:'backup',memory_id:`${prefix}-memory-1`,occurrence_key:`${prefix}-occurrence`,kind:'chat',via:'chat',
    reason:'test',content_snapshot:'Memory 1',memory_created_at:now,surfaced_at:now,message_id:`${prefix}-message-1`,
    content:'Canvas text',person_name:'Alex',last_mentioned_at:now,last_nudged_at:null,dismissed:0,
    context_summary:'Friend',sentiment:'positive',last_context_update:now,question:'What next?',context:'Planning',priority:2,
    asked_at:null,style:'direct',evidence:'Synthetic',support_style:'calm',energy_notes:'Synthetic',question_id:'q1',
    correct:1,attempted_at:now,item_key:'item-1',seen_at:now,dismissed_at:null,repo:'SmokeyS30/orbit-buddy',muted_at:now,
    created_at:now,updated_at:now};
  return Object.fromEntries(entry.columns.map((column)=>[column,values[column]??null]));
}

function sqliteFixture(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-recovery-'));
  const file=path.join(directory,'fixture.sqlite');
  const db=openDatabase(file);
  const user=db.createUser({email:`${randomUUID()}@example.com`,displayName:'Synthetic',passwordHash:'fixture-hash',passwordSalt:'fixture-salt',role:'member'});
  const conversation=db.ensureDefaultConversation(user.id);
  return{directory,file,db,user,conversation};
}

test('SQLite portable recovery includes formerly capped and omitted user content',async(t)=>{
  const source=sqliteFixture(),target=sqliteFixture();
  t.after(()=>{source.db.close();target.db.close();fs.rmSync(source.directory,{recursive:true,force:true});fs.rmSync(target.directory,{recursive:true,force:true});});
  const prefix=randomUUID();
  source.db.getPreferences(source.user.id);
  const task=source.db.addTask(source.user.id,{title:'Synthetic reminder',prompt:'Remember',deliveryChannel:'whatsapp'});
  const raw=new DatabaseSync(source.file);
  try{
    raw.exec('BEGIN IMMEDIATE');
    const message=raw.prepare('INSERT INTO messages(id,user_id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?,?)');
    for(let i=1;i<=20001;i++)message.run(`${prefix}-message-${i}`,source.user.id,source.conversation.id,'user',`Message ${i}`,now);
    const memory=raw.prepare(`INSERT INTO memories(id,user_id,content,created_at,updated_at,kind,source,status,confidence)
      VALUES(?,?,?,?,?,'fact','test',?,1)`);
    for(let i=1;i<=101;i++)memory.run(`${prefix}-memory-${i}`,source.user.id,`Memory ${i}`,now,now,i===101?'superseded':'approved');
    raw.prepare(`UPDATE memories SET last_mentioned_at=?,relevance_score=0.75,superseded_by=?,embedding='[0.1,0.2]'
      WHERE id=?`).run(now,`${prefix}-memory-101`,`${prefix}-memory-1`);
    for(const entry of PORTABLE_USER_TABLES){
      const row=sampleRow(entry,source.user.id,prefix);
      raw.prepare(portableInsertSql(entry)).run(...portableRowValues(entry,row,source.user.id));
    }
    raw.prepare(`UPDATE user_preferences SET buddy_name='Orbit',writing_voice_opt_in=1,writing_voice_profile='Concise',
      writing_voice_offered=1,intro_dismissed=1 WHERE user_id=?`).run(source.user.id);
    raw.prepare("UPDATE tasks SET status='running',lease_expires_at='2027-01-01T00:00:00.000Z' WHERE id=?").run(task.id);
    raw.exec('COMMIT');
  }catch(error){raw.exec('ROLLBACK');throw error;}finally{raw.close();}
  const bundle=source.db.exportUser(source.user.id);
  assert.equal(bundle.version,6);
  assert.equal(bundle.messages.length,20001);
  assert.equal(bundle.messages[0].content,'Message 1');
  assert.equal(bundle.messages.at(-1).content,'Message 20001');
  assert.equal(bundle.memories.length,101);
  assert.equal(bundle.memories.find((m)=>m.id===`${prefix}-memory-101`).status,'superseded');
  assert.equal(bundle.memories.find((m)=>m.id===`${prefix}-memory-1`).embedding,'[0.1,0.2]');
  assert.deepEqual(Object.keys(bundle.user).sort(),['display_name','email','id']);
  for(const entry of PORTABLE_USER_TABLES)assert.equal(bundle[entry.key].length,1,entry.key);

  const backup=await writeAutomatedBackup({db:source.db,userId:source.user.id,backupDir:path.join(source.directory,'backups'),
    passphrase:'synthetic portable passphrase'});
  assert.ok(backup.endsWith('.orbitbackup'));
  const decrypted=await decryptPortable(fs.readFileSync(backup,'utf8'),'synthetic portable passphrase');
  assert.equal(decrypted.messages.length,20001);
  assert.equal(fs.readdirSync(path.dirname(backup)).filter((name)=>name.endsWith('.tmp')).length,0);

  target.db.updatePassword(target.user.id,'target-hash','target-salt');
  target.db.restoreUser(target.user.id,decrypted);
  target.db.restoreUser(target.user.id,decrypted);
  const restored=target.db.exportUser(target.user.id);
  assert.equal(restored.messages.length,20001);
  assert.equal(restored.messages[0].content,'Message 1');
  assert.equal(restored.messages.at(-1).content,'Message 20001');
  assert.equal(restored.memories.length,101);
  assert.equal(restored.memories.find((m)=>m.id===`${prefix}-memory-1`).last_mentioned_at,now);
  assert.equal(restored.memories.find((m)=>m.id===`${prefix}-memory-1`).relevance_score,0.75);
  for(const entry of PORTABLE_USER_TABLES){
    assert.equal(restored[entry.key].length,1,entry.key);
    assert.equal(restored[entry.key][0].user_id,target.user.id,entry.key);
  }
  assert.equal(restored.preferences.buddy_name,'Orbit');
  assert.equal(restored.preferences.writing_voice_profile,'Concise');
  assert.equal(restored.preferences.intro_dismissed,1);
  assert.equal(target.db.getTask(target.user.id,task.id).delivery_channel,'whatsapp');
  assert.equal(target.db.getTask(target.user.id,task.id).lease_expires_at,null);
  assert.equal(target.db.getUserById(target.user.id).password_hash,'target-hash');
});

test('legacy version 5 portable bundles still merge without replacing account credentials',()=>{
  const source=sqliteFixture(),target=sqliteFixture();
  try{
    source.db.addMessage(source.user.id,source.conversation.id,'user','Legacy backup message');
    const legacy={...source.db.exportUser(source.user.id),version:5};
    for(const entry of PORTABLE_USER_TABLES)delete legacy[entry.key];
    target.db.updatePassword(target.user.id,'target-hash','target-salt');
    target.db.restoreUser(target.user.id,legacy);
    assert.equal(target.db.exportUser(target.user.id).messages[0].content,'Legacy backup message');
    assert.equal(target.db.getUserById(target.user.id).password_hash,'target-hash');
  }finally{
    source.db.close();target.db.close();
    fs.rmSync(source.directory,{recursive:true,force:true});fs.rmSync(target.directory,{recursive:true,force:true});
  }
});

test('automated backup selects the nonblocking PostgreSQL export path',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-async-backup-'));
  try{
    const db={
      async:{exportUser:async()=>({version:6,messages:[{content:'synthetic'}]}),getUserById:async()=>({id:'synthetic'})},
      exportUser:()=>{throw new Error('blocking export must not run');}
    };
    const file=await writeAutomatedBackup({db,userId:'synthetic',backupDir:directory,passphrase:'synthetic portable passphrase'});
    const bundle=await decryptPortable(fs.readFileSync(file,'utf8'),'synthetic portable passphrase');
    assert.equal(bundle.messages[0].content,'synthetic');
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('a late backup writer removes its archive after the account was deleted during export',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-late-backup-'));
  let release,started;
  const entered=new Promise(resolve=>{started=resolve;});
  const db={async:{
    exportUser:async()=>{started();await new Promise(resolve=>{release=resolve;});return{version:6,messages:[{content:'synthetic private data'}]};},
    getUserById:async()=>null,
  }};
  try{
    const writing=writeAutomatedBackup({db,userId:'synthetic-deleted',backupDir:directory,passphrase:'synthetic portable passphrase'});
    await entered;
    release();
    assert.equal(await writing,null);
    assert.deepEqual(fs.readdirSync(directory),[]);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('PostgreSQL portable recovery restores a full synthetic bundle into an isolated database',async(t)=>{
  const databaseUrl=process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl,'TEST_DATABASE_URL must point to disposable PostgreSQL');
  const name=`orbit_recovery_${randomUUID().replaceAll('-','').slice(0,16)}`;
  const url=new URL(databaseUrl);
  const admin=new pg.Pool({connectionString:databaseUrl,ssl:url.searchParams.get('sslmode')==='disable'?false:true});
  const backupDir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-pg-recovery-'));
  let source=null,target=null,sourceUser=null,created=false;
  try{
    await admin.query(`CREATE DATABASE ${name}`);created=true;
    source=await openPostgres(databaseUrl);
    url.pathname=`/${name}`;
    const setup=new pg.Pool({connectionString:url.toString(),ssl:url.searchParams.get('sslmode')==='disable'?false:true});
    try{
      const schema=fs.readFileSync(new URL('../src/db/postgres-schema.sql',import.meta.url),'utf8');
      for(const statement of schema.split(';').map((part)=>part.trim()).filter(Boolean))await setup.query(statement);
    }finally{await setup.end();}
    target=await openPostgres(url.toString());
    const prefix=randomUUID();
    sourceUser=await source.createUser({email:`${prefix}@example.com`,displayName:'Synthetic',passwordHash:'source-hash',passwordSalt:'salt',role:'member'});
    // Other integration suites may run server workers against the shared test
    // database. Keep this large synthetic fixture out of proactive model work.
    await source.setUserDisabled(sourceUser.id,true);
    const targetUser=await target.createUser({email:`${prefix}@example.com`,displayName:'Synthetic',passwordHash:'target-hash',passwordSalt:'salt',role:'member'});
    const conversation=await source.ensureDefaultConversation(sourceUser.id);
    await source.getPreferences(sourceUser.id);
    const task=await source.addTask(sourceUser.id,{title:'Synthetic reminder',prompt:'Remember',deliveryChannel:'whatsapp'});
    await source.run("UPDATE tasks SET status='running',lease_expires_at='2027-01-01T00:00:00.000Z' WHERE id=?",task.id);
    await source.run(`INSERT INTO messages(id,user_id,conversation_id,role,content,created_at)
      SELECT ?||'-message-'||g,?,?,'user','Message '||g,? FROM generate_series(1,20001) g`,prefix,sourceUser.id,conversation.id,now);
    await source.run(`INSERT INTO memories(id,user_id,content,kind,source,status,created_at,updated_at)
      SELECT ?||'-memory-'||g,?,'Memory '||g,'fact','test',CASE WHEN g=101 THEN 'superseded' ELSE 'approved' END,?,?
      FROM generate_series(1,101) g`,prefix,sourceUser.id,now,now);
    await source.run('UPDATE memories SET last_mentioned_at=?,relevance_score=0.75,superseded_by=?,embedding=? WHERE id=?',
      now,`${prefix}-memory-101`,'[0.1,0.2]',`${prefix}-memory-1`);
    for(const entry of PORTABLE_USER_TABLES){
      const row=sampleRow(entry,sourceUser.id,prefix);
      await source.run(portableInsertSql(entry,true),...portableRowValues(entry,row,sourceUser.id));
    }
    await source.run("UPDATE user_preferences SET buddy_name='Orbit',writing_voice_opt_in=1,writing_voice_profile='Concise' WHERE user_id=?",sourceUser.id);
    const bundle=await source.exportUser(sourceUser.id);
    assert.equal(bundle.messages.length,20001);
    assert.equal(bundle.memories.length,101);
    assert.deepEqual(Object.keys(bundle.user).sort(),['display_name','email','id']);
    const file=await writeAutomatedBackup({db:source,userId:sourceUser.id,backupDir,passphrase:'synthetic portable passphrase'});
    const encryptedBundle=await decryptPortable(fs.readFileSync(file,'utf8'),'synthetic portable passphrase');
    assert.equal(encryptedBundle.messages.length,20001);
    await target.restoreUser(targetUser.id,encryptedBundle);
    await target.restoreUser(targetUser.id,encryptedBundle);
    const restored=await target.exportUser(targetUser.id);
    assert.equal(restored.messages.length,20001);
    assert.equal(restored.memories.length,101);
    assert.equal(restored.memories.find((m)=>m.id===`${prefix}-memory-1`).embedding,'[0.1,0.2]');
    for(const entry of PORTABLE_USER_TABLES){
      assert.equal(restored[entry.key].length,1,entry.key);
      assert.equal(restored[entry.key][0].user_id,targetUser.id,entry.key);
    }
    assert.equal(restored.preferences.buddy_name,'Orbit');
    assert.equal(restored.preferences.writing_voice_profile,'Concise');
    assert.equal((await target.getTask(targetUser.id,task.id)).delivery_channel,'whatsapp');
    assert.equal((await target.getTask(targetUser.id,task.id)).lease_expires_at,null);
    assert.equal((await target.getUserById(targetUser.id)).password_hash,'target-hash');
  }catch(error){
    console.error('isolated PostgreSQL recovery failure:',error.message);
    throw error;
  }finally{
    if(source&&sourceUser)await source.deleteUserAccount(sourceUser.id);
    if(source)await source.close();
    if(target)await target.close();
    if(created){
      const active=await admin.query('SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname=$1',[name]);
      assert.equal(active.rows[0].count,0,'all application and test connections must close before dropping the temporary backup database');
      await admin.query(`DROP DATABASE ${name}`);
    }
    await admin.end();
    fs.rmSync(backupDir,{recursive:true,force:true});
  }
});

test('PostgreSQL manual API exports over 10 MiB and waits for a slow transactional restore',async()=>{
  const databaseUrl=process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl,'TEST_DATABASE_URL must point to disposable PostgreSQL');
  const name=`orbit_backup_api_${randomUUID().replaceAll('-','').slice(0,16)}`;
  const url=new URL(databaseUrl);
  const admin=new pg.Pool({connectionString:databaseUrl,ssl:url.searchParams.get('sslmode')==='disable'?false:true});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-pg-api-backup-'));
  let app=null,sql=null,adapter=null,created=false;
  try{
    await admin.query(`CREATE DATABASE ${name}`);created=true;
    url.pathname=`/${name}`;
    sql=new pg.Pool({connectionString:url.toString(),ssl:false});
    const schema=fs.readFileSync(new URL('../src/db/postgres-schema.sql',import.meta.url),'utf8');
    for(const statement of schema.split(';').map((part)=>part.trim()).filter(Boolean))await sql.query(statement);
    app=createOrbitServer({env:{NODE_ENV:'test',DATABASE_URL:url.toString()},dataDir:directory});
    await new Promise((resolve)=>app.server.listen(0,'127.0.0.1',resolve));
    const user=app.db.createUser({email:`${randomUUID()}@example.com`,displayName:'Synthetic owner',
      passwordHash:'synthetic-hash',passwordSalt:'synthetic-salt',role:'owner'});
    const conversation=app.db.createConversation(user.id,'Large synthetic backup');
    const content=`Synthetic content: ${'x'.repeat(11*1024*1024)}`;
    await sql.query(`INSERT INTO messages(id,user_id,conversation_id,role,content,created_at)
      VALUES($1,$2,$3,'user',$4,$5)`,[randomUUID(),user.id,conversation.id,content,now]);
    const token=randomUUID(),csrf=randomUUID();
    app.db.createSession({tokenHash:hashToken(token),userId:user.id,csrfToken:csrf,
      expiresAt:new Date(Date.now()+60_000).toISOString(),userAgent:'synthetic-test'});
    const base=`http://127.0.0.1:${app.server.address().port}`;
    const headers={Cookie:`orbit_session=${token}`,'X-Orbit-CSRF':csrf,'Content-Type':'application/json'};
    const exported=await fetch(`${base}/api/backups/export`,{method:'POST',headers,
      body:JSON.stringify({passphrase:'synthetic portable passphrase'})});
    assert.equal(exported.status,200,'manual API uses the asynchronous worker for large results');
    const payload=await exported.text();
    assert.ok(payload.length>10*1024*1024,'the exported bundle exceeds the old shared buffer limit');
    const bundle=await decryptPortable(payload,'synthetic portable passphrase');
    assert.equal(bundle.messages.length,1);
    assert.equal(bundle.messages[0].content,content);

    // An intentionally delayed insert stands in for a remote PostgreSQL
    // round trip. The short generic worker timeout must not report failure
    // while a transactional restore continues in the worker.
    await sql.query(`CREATE FUNCTION orbit_slow_restore() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$`);
    await sql.query(`CREATE TRIGGER orbit_slow_restore_trigger BEFORE INSERT ON messages
      FOR EACH ROW EXECUTE FUNCTION orbit_slow_restore()`);
    adapter=createSyncPgAdapter(url.toString(),{queryTimeoutMs:50});
    const restoredId=randomUUID();
    const minimal={version:6,conversations:[],messages:[{id:restoredId,conversation_id:conversation.id,
      role:'user',content:'Delayed synthetic restore',created_at:now}]};
    const began=Date.now();
    await adapter.async.restoreUser(user.id,minimal);
    assert.ok(Date.now()-began>=150,'restore waits for its SQL transaction result');
    assert.equal((await sql.query('SELECT content FROM messages WHERE id=$1',[restoredId])).rows[0].content,
      'Delayed synthetic restore');
    await adapter.close();adapter=null;
    await sql.query('DROP TRIGGER orbit_slow_restore_trigger ON messages');
    await sql.query('DROP FUNCTION orbit_slow_restore()');

    const repeat=await fetch(`${base}/api/backups/restore`,{method:'POST',headers,
      body:JSON.stringify({payload:await encryptPortable(minimal,'synthetic portable passphrase'),
        passphrase:'synthetic portable passphrase',confirm:'RESTORE'})});
    assert.equal(repeat.status,200);
    assert.equal((await repeat.json()).paused,true);
  }finally{
    if(adapter)await adapter.close();
    if(app)await app.close();
    if(sql)await sql.end();
    if(created){
      const active=await admin.query('SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname=$1',[name]);
      assert.equal(active.rows[0].count,0,'all application and test connections must close before dropping the temporary backup database');
      await admin.query(`DROP DATABASE ${name}`);
    }
    await admin.end();
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
