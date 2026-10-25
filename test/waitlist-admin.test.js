import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';
import { hashToken } from '../src/security.js';

test('waitlist owner routes enforce sessions and CSRF and keep settings distinct from row updates',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-waitlist-admin-'));
  const app=createOrbitServer({dataDir:dir,env:{NODE_ENV:'test',SIGNUP_RISK_MODE:'off'}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const register=async(email)=>{
    const response=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,displayName:'Synthetic',password:'correct horse battery staple'})});
    assert.equal(response.status,201);
    const body=await response.json();
    return{cookie:response.headers.get('set-cookie').split(';')[0],csrf:body.csrf};
  };
  const owner=await register('owner@example.test');
  app.db.setSetting('registration_open','true');
  // Member registration now requires mailbox proof; a synthetic existing
  // member suffices to exercise authorization on these admin routes.
  const memberUser=app.db.createUser({email:'member@example.test',displayName:'Member',passwordHash:'synthetic',passwordSalt:'synthetic',role:'member'});
  const memberToken='synthetic-waitlist-member-session';
  const member={cookie:`orbit_session=${memberToken}`,csrf:'synthetic-csrf'};
  app.db.createSession({tokenHash:hashToken(memberToken),userId:memberUser.id,csrfToken:member.csrf,expiresAt:new Date(Date.now()+60_000).toISOString(),userAgent:'synthetic-test'});
  app.db.addWaitlistEntry({id:'wl_synthetic',email:'waiting@example.test',name:'Waiting'});
  const ownerHeaders={Cookie:owner.cookie,'X-Orbit-CSRF':owner.csrf,'Content-Type':'application/json'};
  const memberHeaders={Cookie:member.cookie,'X-Orbit-CSRF':member.csrf,'Content-Type':'application/json'};
  assert.equal((await fetch(`${base}/api/admin/waitlist`)).status,401);
  assert.equal((await fetch(`${base}/api/admin/waitlist`,{headers:memberHeaders})).status,403);
  const list=await fetch(`${base}/api/admin/waitlist`,{headers:ownerHeaders});
  assert.equal(list.status,200);
  assert.equal((await list.json()).waitlist[0].id,'wl_synthetic');
  assert.equal((await fetch(`${base}/api/admin/waitlist/settings`,{headers:ownerHeaders})).status,200);
  assert.equal((await fetch(`${base}/api/admin/waitlist/settings`,{method:'POST',headers:{Cookie:owner.cookie,'Content-Type':'application/json'},body:JSON.stringify({invitesPerWeek:12})})).status,403);
  const settings=await fetch(`${base}/api/admin/waitlist/settings`,{method:'POST',headers:ownerHeaders,body:JSON.stringify({invitesPerWeek:12})});
  assert.equal(settings.status,200);
  assert.equal(app.db.getSetting('waitlist_invites_per_week'),'12');
  assert.equal((await fetch(`${base}/api/admin/waitlist/wl_synthetic`,{method:'POST',headers:memberHeaders,body:JSON.stringify({status:'approved'})})).status,403);
  assert.equal((await fetch(`${base}/api/admin/waitlist/wl_synthetic`,{method:'POST',headers:ownerHeaders,body:JSON.stringify({status:'approved'})})).status,200);
  assert.equal(app.db.listWaitlist()[0].status,'approved');
  assert.equal((await fetch(`${base}/api/admin/waitlist/wl_missing`,{method:'POST',headers:ownerHeaders,body:JSON.stringify({status:'approved'})})).status,404);
});
