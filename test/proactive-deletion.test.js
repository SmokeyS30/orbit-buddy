import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createOrbitServer} from '../server.js';

test('proactive worker tolerates account deletion after its user snapshot',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-proactive-delete-'));
  const app=createOrbitServer({dataDir:dir,env:{NODE_ENV:'test'}});
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const user=app.db.createUser({email:'deleted-worker@example.test',displayName:'Synthetic',passwordHash:'x',passwordSalt:'y',role:'owner'});
  const original=app.db.getPreferences.bind(app.db);
  app.db.getPreferences=(userId)=>{
    app.db.deleteUserAccount(userId);
    return original(userId);
  };
  await assert.doesNotReject(app.runProactiveChecks());
  assert.equal(app.db.getUserById(user.id),undefined);
});

test('proactive delivery skips an account deleted before notification',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-proactive-gone-'));
  const app=createOrbitServer({dataDir:dir,env:{NODE_ENV:'test'}});
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const user=app.db.createUser({email:'deleted-delivery@example.test',displayName:'Synthetic',passwordHash:'x',passwordSalt:'y',role:'owner'});
  app.db.deleteUserAccount(user.id);
  assert.equal(await app.deliverProactive(user,'Synthetic private check-in','test','Synthetic test'),false);
});
