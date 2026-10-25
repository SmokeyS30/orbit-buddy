import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';
import { signupInbox } from './helpers/signup-inbox.js';
import { writeAutomatedBackup,cleanupDeletedUserBackups } from '../src/backups.js';

const PASSWORD='correct horse battery staple';

async function fixture(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-account-delete-'));
  const inbox=signupInbox();
  const app=createOrbitServer({dataDir:directory,env:{NODE_ENV:'test',OPENAI_MODEL:'gpt-6-luna',SIGNUP_AUDIT_KEY:'synthetic-account-delete-key'},sendEmail:inbox.sendEmail});
  await new Promise((resolve)=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  return{app,base,register:(email,displayName='Reviewer')=>register(base,email,displayName,inbox)};
}

async function register(base,email,displayName,inbox){
  const response=inbox?await inbox.register(base,{email,displayName,password:PASSWORD})
    :await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,displayName:displayName||'Reviewer',password:PASSWORD})});
  assert.equal(response.status,201);
  const body=await response.json();
  return{cookie:response.headers.get('set-cookie').split(';')[0],csrf:body.csrf,user:body.user};
}

const headers=(auth)=>({Cookie:auth.cookie,'X-Orbit-CSRF':auth.csrf,'Content-Type':'application/json'});

test('account deletion requires password and explicit DELETE confirmation',async(t)=>{
  const{app,base,register}=await fixture();t.after(()=>app.close());
  const auth=await register('delete@example.com');
  const wrong=await fetch(`${base}/api/account`,{method:'DELETE',headers:headers(auth),body:JSON.stringify({password:'wrong password',confirm:'DELETE'})});
  assert.equal(wrong.status,401);
  assert.ok(app.db.getUserById(auth.user.id));
  const missing=await fetch(`${base}/api/account`,{method:'DELETE',headers:headers(auth),body:JSON.stringify({password:PASSWORD,confirm:'delete'})});
  assert.equal(missing.status,400);
  assert.ok(app.db.getUserById(auth.user.id));
});

test('account deletion removes the account, sessions, and associated data',async(t)=>{
  const{app,base,register}=await fixture();t.after(()=>app.close());
  const auth=await register('remove@example.com');
  app.db.addMemory(auth.user.id,'Private fact',{kind:'fact',source:'test'});
  app.db.setSetting(`private_${auth.user.id}`,'present');
  const response=await fetch(`${base}/api/account`,{method:'DELETE',headers:headers(auth),body:JSON.stringify({password:PASSWORD,confirm:'DELETE'})});
  assert.equal(response.status,200);
  assert.equal((await response.json()).deleted,true);
  assert.equal(app.db.getUserById(auth.user.id),undefined);
  assert.equal(app.db.getSetting(`private_${auth.user.id}`),null);
  assert.equal((await fetch(`${base}/api/auth/me`,{headers:{Cookie:auth.cookie}})).status,401);
});

test('account deletion removes its encrypted server archives and retains unrelated archives',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-delete-archive-'));
  const backupDir=path.join(directory,'backups');
  const app=createOrbitServer({dataDir:directory,env:{NODE_ENV:'test',BACKUP_DIR:backupDir}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();fs.rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const auth=await register(base,'archive-delete@example.test');
  const ownArchive=await writeAutomatedBackup({db:app.db,userId:auth.user.id,dataDir:directory,backupDir,passphrase:'synthetic backup passphrase'});
  assert.ok(fs.existsSync(ownArchive));
  const unrelated=path.join(backupDir,'orbit-unrelated-2026-10-25.orbitbackup');
  fs.writeFileSync(unrelated,'synthetic unrelated archive');
  const response=await fetch(`${base}/api/account`,{method:'DELETE',headers:headers(auth),body:JSON.stringify({password:PASSWORD,confirm:'DELETE'})});
  assert.equal(response.status,200);
  assert.equal((await response.json()).backupCleanupPending,false);
  assert.equal(fs.existsSync(ownArchive),false);
  assert.equal(fs.existsSync(unrelated),true);
  assert.equal(app.db.listPendingBackupDeletions()[0]?.account_ref,auth.user.id,
    'the deletion tombstone remains for late writers');
});

test('unavailable backup mount leaves a durable deletion retry instead of reporting cleanup complete',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-delete-retry-'));
  const backupDir=path.join(directory,'unavailable-backups');
  const app=createOrbitServer({dataDir:directory,env:{NODE_ENV:'test',BACKUP_DIR:backupDir}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();fs.rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const auth=await register(base,'retry-delete@example.test');
  const response=await fetch(`${base}/api/account`,{method:'DELETE',headers:headers(auth),body:JSON.stringify({password:PASSWORD,confirm:'DELETE'})});
  assert.equal(response.status,200);
  assert.equal((await response.json()).backupCleanupPending,true);
  assert.equal(app.db.listPendingBackupDeletions().length,1);
  fs.mkdirSync(backupDir);
  const archive=path.join(backupDir,`orbit-${auth.user.id}-synthetic.orbitbackup`);
  fs.writeFileSync(archive,'synthetic encrypted archive');
  assert.deepEqual(await cleanupDeletedUserBackups({db:app.db,dataDir:directory,backupDir}),{cleaned:1,failed:0});
  assert.equal(fs.existsSync(archive),false);
  assert.equal(app.db.listPendingBackupDeletions()[0]?.account_ref,auth.user.id,
    'a successful scan retains the deletion tombstone');
});

test('late final and temporary archives are removed after a backup writer stops',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-delete-late-'));
  const backupDir=path.join(directory,'backups');fs.mkdirSync(backupDir);
  const app=createOrbitServer({dataDir:directory,env:{NODE_ENV:'test',BACKUP_DIR:backupDir}});
  t.after(async()=>{await app.close();fs.rmSync(directory,{recursive:true,force:true});});
  const user=app.db.createUser({email:'late-delete@example.test',displayName:'Synthetic',passwordHash:'x',passwordSalt:'y',role:'member'});
  assert.equal(app.db.deleteUserAccount(user.id).deleted,true);
  assert.deepEqual(await cleanupDeletedUserBackups({db:app.db,dataDir:directory,backupDir}),{cleaned:1,failed:0});
  assert.equal(app.db.listPendingBackupDeletions()[0]?.account_ref,user.id);

  const interrupted={async:{
    exportUser:async()=>({version:6,messages:[{content:'synthetic private data'}]}),
    getUserById:async()=>{throw new Error('synthetic process stopped after rename');},
  }};
  await assert.rejects(writeAutomatedBackup({db:interrupted,userId:user.id,backupDir,passphrase:'synthetic backup passphrase'}),/synthetic process stopped/);
  assert.equal(fs.readdirSync(backupDir).filter(name=>name.endsWith('.orbitbackup')).length,1);
  const ownTemp=path.join(backupDir,`orbit-${user.id}-synthetic.orbitbackup.12345678-1234-1234-1234-123456789abc.tmp`);
  const unrelated=path.join(backupDir,'orbit-unrelated-synthetic.orbitbackup.12345678-1234-1234-1234-123456789abc.tmp');
  fs.writeFileSync(ownTemp,'synthetic partial archive');fs.writeFileSync(unrelated,'unrelated fixture');
  assert.deepEqual(await cleanupDeletedUserBackups({db:app.db,dataDir:directory,backupDir}),{cleaned:1,failed:0});
  assert.deepEqual(fs.readdirSync(backupDir),[path.basename(unrelated)]);
  assert.equal(app.db.listPendingBackupDeletions()[0]?.account_ref,user.id);
  assert.deepEqual(await cleanupDeletedUserBackups({db:app.db,dataDir:directory,backupDir}),{cleaned:1,failed:0});
});

test('deleting the owner transfers ownership to the oldest active member',async(t)=>{
  const{app,base,register}=await fixture();t.after(()=>app.close());
  const owner=await register('owner-delete@example.com','Owner');
  const opened=await fetch(`${base}/api/admin/registration`,{method:'POST',headers:headers(owner),body:JSON.stringify({open:true})});
  assert.equal(opened.status,200);
  const member=await register('member-successor@example.com','Member');
  const deleted=await fetch(`${base}/api/account`,{method:'DELETE',headers:headers(owner),body:JSON.stringify({password:PASSWORD,confirm:'DELETE'})});
  assert.equal(deleted.status,200);
  assert.equal(app.db.getUserById(member.user.id).role,'owner');
});

test('public support page explains subscriptions and account deletion',async(t)=>{
  const{app,base}=await fixture();t.after(()=>app.close());
  const response=await fetch(`${base}/support.html`);
  assert.equal(response.status,200);
  const html=await response.text();
  assert.match(html,/Apple subscription settings/);
  assert.match(html,/Safety → Delete account/);
  assert.match(html,/viewport-fit=cover/);
  assert.match(html,/id="support-back"[^>]*href="\/#safety"[^>]*data-support-back/);
  assert.match(html,/support-navigation\.js/);
  assert.match(html,/Back to Orbit Buddy/);
});
