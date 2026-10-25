import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';
import { toolGmailDelete } from '../src/tools.js';
import { encryptSecret, readEncryptionKey } from '../src/security.js';

async function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-gmail-delete-preview-'));
  const env={NODE_ENV:'test',DATA_ENCRYPTION_KEY:'synthetic-gmail-key-for-isolated-tests-123456'};
  const app=createOrbitServer({dataDir:directory,env});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();fs.rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const response=await fetch(`${base}/api/auth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'owner@example.test',displayName:'Owner',password:'correct horse battery staple'})});
  assert.equal(response.status,201);
  const account=await response.json();
  const cookie=response.headers.get('set-cookie').split(';')[0];
  app.db.saveConnector(account.user.id,'gmail',{accessEncrypted:encryptSecret('synthetic-gmail-token',readEncryptionKey(env.DATA_ENCRYPTION_KEY)),scopes:'https://www.googleapis.com/auth/gmail.modify',expiresAt:new Date(Date.now()+3_600_000).toISOString(),profile:{id:'synthetic-owner',email:'owner@example.test'}});
  const state={mailbox:'owner@example.test',messageId:'msg456',subject:'Verified subject',from:'Sender <sender@example.test>',date:'Sun, 25 Oct 2026 09:00:00 +0000',snippet:'Verified snippet',threadId:'thread-1',historyId:'123',trashCalls:0,profileCalls:0,metadataCalls:0};
  const originalFetch=global.fetch;
  global.fetch=async(url,options={})=>{
    const address=String(url);
    if(!address.startsWith('https://gmail.googleapis.com/'))return originalFetch(url,options);
    assert.equal(options.headers?.Authorization,'Bearer synthetic-gmail-token');
    if(address.endsWith('/profile')){state.profileCalls++;return Response.json({emailAddress:state.mailbox});}
    if(address.includes('/messages/msg456?format=metadata')){
      state.metadataCalls++;
      return Response.json({id:state.messageId,threadId:state.threadId,historyId:state.historyId,labelIds:['INBOX'],snippet:state.snippet,payload:{headers:[{name:'From',value:state.from},{name:'Subject',value:state.subject},{name:'Date',value:state.date}]}});
    }
    if(address.endsWith('/messages/msg456/trash')){state.trashCalls++;return Response.json({id:'msg456'});}
    throw new Error(`Unexpected synthetic Gmail request: ${address}`);
  };
  t.after(()=>{global.fetch=originalFetch;});
  const ctx={db:app.db,userId:account.user.id,messageId:null,gmail:{getToken:async()=> 'synthetic-gmail-token'}};
  const approve=(id,csrf=account.csrf)=>fetch(`${base}/api/approvals/${id}/approve`,{method:'POST',headers:{Cookie:cookie,'X-Orbit-CSRF':csrf,'Content-Type':'application/json'},body:'{}'});
  return{app,account,state,ctx,approve};
}

test('Gmail delete card previews verified exact-ID metadata, not model-supplied text',async t=>{
  const {app,account,state,ctx,approve}=await fixture(t);
  const staged=await toolGmailDelete({id:'msg456',subject:'Fake model subject',from:'Fake sender'},ctx);
  const row=app.db.getApproval(account.user.id,staged.id);
  assert.equal(row.kind,'gmail_delete');
  assert.match(row.title,/Verified subject/);
  assert.doesNotMatch(JSON.stringify(row),/Fake model subject|Fake sender/);
  assert.equal(row.payload.preview.mailbox,'owner@example.test');
  assert.equal(row.payload.preview.id,'msg456');
  assert.equal(row.payload.preview.threadId,'thread-1');
  assert.equal(state.trashCalls,0);
  assert.equal((await approve(staged.id,'bad-csrf')).status,403);
  assert.equal((await approve(staged.id)).status,200);
  assert.equal(state.trashCalls,1);
  assert.equal((await approve(staged.id)).status,409);
  assert.equal(state.trashCalls,1);
});

test('Gmail deletion fails closed if metadata or mailbox changed after approval staging',async t=>{
  const {app,account,state,ctx,approve}=await fixture(t);
  const changedMessage=await toolGmailDelete({id:'msg456'},ctx);
  state.subject='Different message';
  assert.equal((await approve(changedMessage.id)).status,409);
  assert.equal(state.trashCalls,0);
  assert.equal(app.db.getApproval(account.user.id,changedMessage.id).status,'failed');
  state.subject='Verified subject';
  const changedMailbox=await toolGmailDelete({id:'msg456'},ctx);
  state.mailbox='other@example.test';
  assert.equal((await approve(changedMailbox.id)).status,409);
  assert.equal(state.trashCalls,0);
});

test('Gmail deletion rejects mismatched ID and legacy unverified approval payload',async t=>{
  const {app,account,state,ctx,approve}=await fixture(t);
  state.messageId='another-message';
  await assert.rejects(()=>toolGmailDelete({id:'msg456'},ctx),/message ID|metadata/i);
  assert.equal(app.db.listApprovals(account.user.id).length,0);
  state.messageId='msg456';
  const legacy=app.db.addApproval(account.user.id,{kind:'gmail_delete',title:'Unverified old approval',summary:'From fake sender',payload:{id:'msg456',subject:'Fake'},sourceMessageId:null});
  assert.equal((await approve(legacy.id)).status,409);
  assert.equal(state.trashCalls,0);
});
