import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';

async function fixture(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-moderation-'));
  const app=createOrbitServer({dataDir:directory,env:{NODE_ENV:'test',SIGNUP_RISK_MODE:'off'}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  return{app,base:`http://127.0.0.1:${app.server.address().port}`};
}
async function register(base,email){
  const response=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,displayName:email.split('@')[0],password:'correct horse battery staple'})});
  assert.equal(response.status,201);
  const body=await response.json();
  return{cookie:response.headers.get('set-cookie').split(';')[0],csrf:body.csrf,id:body.user.id};
}
const headers=(account)=>({Cookie:account.cookie,'X-Orbit-CSRF':account.csrf,'Content-Type':'application/json'});
const login=(base,email)=>fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'correct horse battery staple'})});

test('owner can block and restore a member account; blocked sessions and password sign-in fail',async(t)=>{
  const{app,base}=await fixture();t.after(()=>app.close());
  const owner=await register(base,'owner@example.com');
  assert.equal((await fetch(base+'/api/admin/registration',{method:'POST',headers:headers(owner),body:JSON.stringify({open:true})})).status,200);
  const member=await register(base,'member@example.com');
  const route=`${base}/api/admin/users/${member.id}/moderation-block`;
  assert.equal((await fetch(route,{method:'POST',headers:headers(member),body:JSON.stringify({blocked:true})})).status,403);
  assert.equal((await fetch(route,{method:'POST',headers:{Cookie:owner.cookie,'Content-Type':'application/json'},body:JSON.stringify({blocked:true})})).status,403);
  assert.equal((await fetch(`${base}/api/admin/users/${owner.id}/moderation-block`,{method:'POST',headers:headers(owner),body:JSON.stringify({blocked:true})})).status,403);
  assert.equal((await fetch(route,{method:'POST',headers:headers(owner),body:JSON.stringify({blocked:'yes'})})).status,400);
  assert.equal((await fetch(route,{method:'POST',headers:headers(owner),body:JSON.stringify({blocked:true})})).status,200);
  assert.equal(app.db.getUserById(member.id).moderation_blocked,1);
  assert.equal(app.db.setUserDisabled(member.id,false),false,'generic access approval cannot clear the moderation block');
  assert.equal(app.db.getUserById(member.id).disabled,1);
  assert.equal((await fetch(base+'/api/auth/me',{headers:{Cookie:member.cookie}})).status,401);
  assert.equal((await login(base,'member@example.com')).status,401);
  const request=app.db.addAccessRequest({name:'member',email:'member@example.com'});
  assert.equal((await fetch(`${base}/api/admin/access-requests/${request.id}/approve`,{method:'POST',headers:headers(owner),body:'{}'})).status,409,'access request must not bypass a moderation block');
  const users=(await(await fetch(base+'/api/admin/users',{headers:{Cookie:owner.cookie}})).json()).users;
  assert.equal(users.find(user=>user.id===member.id).moderationBlocked,true);
  assert.equal((await fetch(route,{method:'POST',headers:headers(owner),body:JSON.stringify({blocked:false})})).status,200);
  assert.equal(app.db.getUserById(member.id).moderation_blocked,0);
  assert.equal((await login(base,'member@example.com')).status,200,'password remains valid after restoration');
});

test('moderation action cannot overwrite an account disabled for another reason',async(t)=>{
  const{app,base}=await fixture();t.after(()=>app.close());
  const owner=await register(base,'owner@example.com');
  assert.equal((await fetch(base+'/api/admin/registration',{method:'POST',headers:headers(owner),body:JSON.stringify({open:true})})).status,200);
  const member=await register(base,'member@example.com');
  app.db.setUserDisabled(member.id,true);
  const response=await fetch(`${base}/api/admin/users/${member.id}/moderation-block`,{method:'POST',headers:headers(owner),body:JSON.stringify({blocked:true})});
  assert.equal(response.status,409);
  assert.equal(app.db.getUserById(member.id).moderation_blocked,0);
});
