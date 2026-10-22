import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';

const PASSWORD='correct horse battery staple';

async function fixture(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-account-delete-'));
  const app=createOrbitServer({dataDir:directory,env:{NODE_ENV:'test',OPENAI_MODEL:'gpt-6-luna'}});
  await new Promise((resolve)=>app.server.listen(0,'127.0.0.1',resolve));
  return{app,base:`http://127.0.0.1:${app.server.address().port}`};
}

async function register(base,email,displayName='Reviewer'){
  const response=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,displayName,password:PASSWORD})});
  assert.equal(response.status,201);
  const body=await response.json();
  return{cookie:response.headers.get('set-cookie').split(';')[0],csrf:body.csrf,user:body.user};
}

const headers=(auth)=>({Cookie:auth.cookie,'X-Orbit-CSRF':auth.csrf,'Content-Type':'application/json'});

test('account deletion requires password and explicit DELETE confirmation',async(t)=>{
  const{app,base}=await fixture();t.after(()=>app.close());
  const auth=await register(base,'delete@example.com');
  const wrong=await fetch(`${base}/api/account`,{method:'DELETE',headers:headers(auth),body:JSON.stringify({password:'wrong password',confirm:'DELETE'})});
  assert.equal(wrong.status,401);
  assert.ok(app.db.getUserById(auth.user.id));
  const missing=await fetch(`${base}/api/account`,{method:'DELETE',headers:headers(auth),body:JSON.stringify({password:PASSWORD,confirm:'delete'})});
  assert.equal(missing.status,400);
  assert.ok(app.db.getUserById(auth.user.id));
});

test('account deletion removes the account, sessions, and associated data',async(t)=>{
  const{app,base}=await fixture();t.after(()=>app.close());
  const auth=await register(base,'remove@example.com');
  app.db.addMemory(auth.user.id,'Private fact',{kind:'fact',source:'test'});
  app.db.setSetting(`private_${auth.user.id}`,'present');
  const response=await fetch(`${base}/api/account`,{method:'DELETE',headers:headers(auth),body:JSON.stringify({password:PASSWORD,confirm:'DELETE'})});
  assert.equal(response.status,200);
  assert.equal((await response.json()).deleted,true);
  assert.equal(app.db.getUserById(auth.user.id),undefined);
  assert.equal(app.db.getSetting(`private_${auth.user.id}`),null);
  assert.equal((await fetch(`${base}/api/auth/me`,{headers:{Cookie:auth.cookie}})).status,401);
});

test('deleting the owner transfers ownership to the oldest active member',async(t)=>{
  const{app,base}=await fixture();t.after(()=>app.close());
  const owner=await register(base,'owner-delete@example.com','Owner');
  const opened=await fetch(`${base}/api/admin/registration`,{method:'POST',headers:headers(owner),body:JSON.stringify({open:true})});
  assert.equal(opened.status,200);
  const member=await register(base,'member-successor@example.com','Member');
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
