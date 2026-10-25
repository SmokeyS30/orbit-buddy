import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/database.js';
import { createSyncPgAdapter } from '../src/db/sync-pg-wrapper.mjs';
import { createConnectorService } from '../src/connectors.js';
import { encryptSecret, decryptSecret } from '../src/security.js';

function fixture(t,driver){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-connector-link-'));
  if(driver==='PostgreSQL')assert.ok(process.env.TEST_DATABASE_URL,'disposable PostgreSQL is required');
  const db=driver==='PostgreSQL'?createSyncPgAdapter(process.env.TEST_DATABASE_URL):openDatabase(path.join(dir,'test.sqlite'));
  const user=db.createUser({email:`${randomUUID()}@example.test`,displayName:'Synthetic owner',passwordHash:'test',passwordSalt:'test',role:'owner'});
  const sessionHash=`session-${user.id}`;
  db.createSession({tokenHash:sessionHash,userId:user.id,csrfToken:'synthetic',expiresAt:new Date(Date.now()+60_000).toISOString(),userAgent:'synthetic'});
  const service=createConnectorService({GMAIL_CLIENT_ID:'synthetic-id',GMAIL_CLIENT_SECRET:'synthetic-secret'},db,Buffer.alloc(32,9));
  t.after(async()=>{db.deleteUserAccount(user.id);await db.close();fs.rmSync(dir,{recursive:true,force:true});});
  return{db,user,sessionHash,service};
}

const stateOf=(url)=>new URL(url).searchParams.get('state');
const response=(accessToken)=>new Response(JSON.stringify({access_token:accessToken,refresh_token:'synthetic-refresh',expires_in:3600}),{status:200});

test('legacy SQLite OAuth writer remains compatible after side-table migration',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-old-oauth-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'old.sqlite');
  const old=new DatabaseSync(file);
  old.exec(`CREATE TABLE oauth_states (state_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,
    provider TEXT NOT NULL,code_verifier TEXT,redirect_uri TEXT NOT NULL,expires_at TEXT NOT NULL)`);
  old.exec("INSERT INTO oauth_states VALUES('old-state','old-user','gmail',NULL,'https://test.example', '2999-01-01T00:00:00.000Z')");
  old.close();
  for(let i=0;i<2;i++){
    const db=openDatabase(file);
    assert.equal(db.consumeOauthState('old-state'),null,'a pre-upgrade state has no session binding');
    await db.close();
  }
  const oldWriter=new DatabaseSync(file);
  assert.equal(oldWriter.prepare('PRAGMA table_info(oauth_states)').all().length,6,'old positional inserts retain six columns');
  assert.ok(oldWriter.prepare("SELECT name FROM sqlite_master WHERE name='oauth_state_bindings'").get());
  oldWriter.exec("INSERT INTO oauth_states VALUES('rollback-state','old-user','gmail',NULL,'https://test.example','2999-01-01T00:00:00.000Z')");
  oldWriter.close();
  const migrated=openDatabase(file);
  assert.equal(migrated.consumeOauthState('rollback-state'),null);
  await migrated.close();
});

for(const driver of ['SQLite','PostgreSQL']){
  for(const action of ['disconnect','reconnect','parallel refresh','invalid grant after reconnect','invalid grant']){
    test(`${driver}: token refresh handles ${action}`,async t=>{
      const {db,user,service}=fixture(t,driver);
      const key=Buffer.alloc(32,9);
      const save=token=>db.saveConnector(user.id,'gmail',{
        accessEncrypted:encryptSecret(token,key),refreshEncrypted:encryptSecret('refresh',key),
        scopes:'gmail',profile:{email:'owner@example.test'},expiresAt:new Date(0).toISOString()});
      save('old');
      const response=Promise.withResolvers();
      t.mock.method(globalThis,'fetch',async()=>(await response.promise).clone());
      const pending=service.getValidToken(user.id,'gmail');
      if(action==='disconnect')db.deleteConnector(user.id,'gmail');
      if(action.includes('reconnect'))save('replacement');
      const parallel=action==='parallel refresh'?service.getValidToken(user.id,'gmail'):null;
      const invalid=action.startsWith('invalid grant');
      response.resolve(new Response(JSON.stringify(invalid?{error:'invalid_grant'}:{access_token:'fresh',refresh_token:'rotated',expires_in:3600}),{status:invalid?400:200}));
      if(parallel){
        const results=await Promise.allSettled([pending,parallel]);
        assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
        assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
        const row=db.getConnector(user.id,'gmail');
        assert.equal(decryptSecret(row.access_encrypted,key),'fresh');
        assert.equal(decryptSecret(row.refresh_encrypted,key),'rotated');
        assert.equal(row.scopes,'gmail');
        assert.equal(JSON.parse(row.profile_json).email,'owner@example.test');
      }else{
        await assert.rejects(pending,{status:invalid?401:409});
        const row=db.getConnector(user.id,'gmail');
        if(action.includes('reconnect'))assert.equal(decryptSecret(row.access_encrypted,key),'replacement');
        else assert.ok(!row,'removed connector stays absent');
      }
    });
  }

  test(`${driver}: disconnect during OAuth exchange cannot restore Gmail`,async t=>{
    const {db,user,sessionHash,service}=fixture(t,driver);
    const other=driver==='PostgreSQL'?createSyncPgAdapter(process.env.TEST_DATABASE_URL):db;
    if(other!==db)t.after(()=>other.close());
    const state=stateOf(service.begin(user.id,'gmail','https://test.example',sessionHash));
    const started=Promise.withResolvers(),release=Promise.withResolvers();
    t.mock.method(globalThis,'fetch',async url=>{
      if(String(url).endsWith('/token')){started.resolve();await release.promise;return response('old-access');}
      if(String(url).endsWith('/userinfo'))return new Response(JSON.stringify({email:'owner@example.test'}));
      throw new Error('Unexpected provider URL');
    });
    const pending=service.complete('gmail','old-code',state);
    await started.promise;
    other.deleteConnector(user.id,'gmail');
    release.resolve();
    await assert.rejects(pending,{status:409});
    assert.ok(!db.getConnector(user.id,'gmail'));
  });

  test(`${driver}: revoked initiating session cannot finish OAuth link`,async t=>{
    const {db,user,sessionHash,service}=fixture(t,driver);
    const state=stateOf(service.begin(user.id,'gmail','https://test.example',sessionHash));
    const started=Promise.withResolvers(),release=Promise.withResolvers();
    t.mock.method(globalThis,'fetch',async url=>{
      if(String(url).endsWith('/token')){started.resolve();await release.promise;return response('old-access');}
      if(String(url).endsWith('/userinfo'))return new Response(JSON.stringify({email:'owner@example.test'}));
      throw new Error('Unexpected provider URL');
    });
    const pending=service.complete('gmail','old-code',state);
    await started.promise;
    db.deleteSession(sessionHash);
    release.resolve();
    await assert.rejects(pending,{status:409});
    assert.ok(!db.getConnector(user.id,'gmail'));
  });

  test(`${driver}: disabled account cannot finish an in-flight OAuth link`,async t=>{
    const {db,user,sessionHash,service}=fixture(t,driver);
    const state=stateOf(service.begin(user.id,'gmail','https://test.example',sessionHash));
    const started=Promise.withResolvers(),release=Promise.withResolvers();
    t.mock.method(globalThis,'fetch',async url=>{
      if(String(url).endsWith('/token')){started.resolve();await release.promise;return response('old-access');}
      if(String(url).endsWith('/userinfo'))return new Response(JSON.stringify({email:'owner@example.test'}));
      throw new Error('Unexpected provider URL');
    });
    const pending=service.complete('gmail','old-code',state);
    await started.promise;
    db.setUserDisabled(user.id,true);
    release.resolve();
    await assert.rejects(pending,{status:409});
    assert.ok(!db.getConnector(user.id,'gmail'));
  });

  test(`${driver}: a newer link attempt replaces an older pending callback`,async t=>{
    const {db,user,sessionHash,service}=fixture(t,driver);
    const oldState=stateOf(service.begin(user.id,'gmail','https://test.example',sessionHash));
    const started=Promise.withResolvers(),release=Promise.withResolvers();
    t.mock.method(globalThis,'fetch',async(url,options)=>{
      if(String(url).endsWith('/token')){
        const code=new URLSearchParams(options.body).get('code');
        if(code==='old-code'){started.resolve();await release.promise;}
        return response(`${code}-access`);
      }
      if(String(url).endsWith('/userinfo'))return new Response(JSON.stringify({email:'owner@example.test'}));
      throw new Error('Unexpected provider URL');
    });
    const older=service.complete('gmail','old-code',oldState);
    await started.promise;
    const newState=stateOf(service.begin(user.id,'gmail','https://test.example',sessionHash));
    await service.complete('gmail','new-code',newState);
    release.resolve();
    await assert.rejects(older,{status:409});
    assert.ok(db.getConnector(user.id,'gmail'));
  });

  test(`${driver}: a claimed OAuth callback cannot be replayed`,async t=>{
    const {db,user,sessionHash,service}=fixture(t,driver);
    const state=stateOf(service.begin(user.id,'gmail','https://test.example',sessionHash));
    t.mock.method(globalThis,'fetch',async url=>{
      if(String(url).endsWith('/token'))return response('valid-access');
      if(String(url).endsWith('/userinfo'))return new Response(JSON.stringify({email:'owner@example.test'}));
      throw new Error('Unexpected provider URL');
    });
    const first=service.complete('gmail','code',state);
    await assert.rejects(service.complete('gmail','code',state),{status:400});
    await first;
    assert.ok(db.getConnector(user.id,'gmail'));
    await assert.rejects(service.complete('gmail','code',state),{status:400});
  });
}
