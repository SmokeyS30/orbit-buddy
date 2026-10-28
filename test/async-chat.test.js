import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';
import { createModelClient } from '../src/model.js';

async function fixture(extraEnv = {}, extraOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-asyncchat-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', ...extraEnv }, ...extraOptions });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function register(base,email='owner@example.com') {
  const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, displayName: 'Owner', password: 'correct horse battery staple' }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrf, userId: body.user.id };
}

const authHeaders = ({ cookie, csrf }) => ({ Cookie: cookie, 'X-Orbit-CSRF': csrf, 'Content-Type': 'application/json' });

// L3: registration seeds an Orbit welcome message in the default conversation.
// Tests asserting on conversation contents filter it out.
const isWelcome = (m) => m.role === 'assistant' && /^Welcome, /.test(m.content || '');
const chatOnly = (msgs) => msgs.filter((m) => !isWelcome(m));

async function waitFor(fn, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test('high-confidence abusive AI output is filtered before storage and delivery',async(t)=>{
  const model=createModelClient({NODE_ENV:'test'});
  let release;
  const unsafeReply='A walk can help. '.repeat(80)+'I will kill you. More text follows. [SUGGEST_MEMORY: unsafe memory] [FOLLOWUP: unsafe task on 2026-12-01]';
  model.respond=async({onTurn,onToken})=>{
    onTurn?.(0);
    onToken?.('A walk can help. '.repeat(80));
    onToken?.('I will kill');
    onToken?.(' you.');
    onToken?.(' More text follows.');
    await new Promise(resolve=>{release=resolve;});
    return{text:unsafeReply,toolCalls:[]};
  };
  const{app,base}=await fixture({}, {modelClient:model});t.after(()=>app.close());
  const auth=await register(base);
  const response=await fetch(`${base}/api/chat`,{method:'POST',headers:authHeaders(auth),body:JSON.stringify({message:'Help me plan a walk.'})});
  assert.equal(response.status,202);
  const sent=await response.json();
  assert.ok(await waitFor(()=>!!release));
  const streaming=await(await fetch(`${base}/api/chat/stream-state?conversationId=${sent.conversationId}`,{headers:{Cookie:auth.cookie}})).json();
  assert.match(streaming.text,/Orbit hid this response/);
  release();
  assert.ok(await waitFor(()=>app.db.listConversationMessages(auth.userId,sent.conversationId,10)
    .some((message)=>message.role==='assistant'&&message.content.includes('Orbit hid this response'))));
  const messages=app.db.listConversationMessages(auth.userId,sent.conversationId,10);
  assert.equal(messages.filter((message)=>message.role==='assistant'&&message.content.includes('I will kill you.')).length,0);
  const snapshot=await(await fetch(`${base}/api/snapshot?conversation=${sent.conversationId}`,{headers:{Cookie:auth.cookie}})).json();
  assert.equal(snapshot.messages.filter((message)=>message.role==='assistant'&&message.content.includes('I will kill you.')).length,0);
  assert.equal(app.db.listMemorySuggestions(auth.userId).some((row)=>row.content==='unsafe memory'),false);
  assert.equal(app.db.listFollowUps(auth.userId).some((row)=>row.description==='unsafe task'),false);
});

test('POST /api/chat returns 202 instantly and the reply lands in the background', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ message: 'hello there' }) });
  assert.equal(response.status, 202);
  const sent = await response.json();
  assert.ok(sent.id, '202 carries the user message id');
  assert.ok(sent.conversationId, '202 carries the conversation id');
  const landed = await waitFor(() => {
    const convo = app.db.ensureDefaultConversation(auth.userId);
    return app.db.listConversationMessages(auth.userId, convo.id, 10).some((m) => m.role === 'assistant' && m.content.includes('hello there'));
  });
  assert.ok(landed, 'assistant reply arrived in the background');
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const roles = chatOnly(app.db.listConversationMessages(auth.userId, convo.id, 10)).map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant']);
});

test('rapid sends are queued and answered in order', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const headers = authHeaders(auth);
  const first = await fetch(`${base}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ message: 'first question' }) });
  const second = await fetch(`${base}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ message: 'second question' }) });
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  const landed = await waitFor(() => {
    const convo = app.db.ensureDefaultConversation(auth.userId);
    return chatOnly(app.db.listConversationMessages(auth.userId, convo.id, 10)).filter((m) => m.role === 'assistant').length === 2;
  });
  assert.ok(landed, 'both replies arrived');
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const messages = chatOnly(app.db.listConversationMessages(auth.userId, convo.id, 10));
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.ok(messages[1].content.includes('first question'), 'first reply matches first message');
  assert.ok(messages[3].content.includes('second question'), 'second reply matches second message');
});

test('slow summary does not block the next reply or hide uncovered history',async(t)=>{
  const model=createModelClient({NODE_ENV:'test'});
  model.configured=true;
  let releaseSummary,summaryStarted=false;
  let secondHistory=[];
  model.respond=async({message,history=[],taskMode})=>{
    if(taskMode){summaryStarted=true;await new Promise((resolve)=>{releaseSummary=resolve;});return{text:'Synthetic summary',toolCalls:[]};}
    if(message.includes('second question'))secondHistory=history;
    return{text:`Answered ${message}`,toolCalls:[]};
  };
  const {app,base}=await fixture({}, {modelClient:model});
  t.after(async()=>{releaseSummary?.();await app.close();});
  const auth=await register(base);
  const conversation=app.db.ensureDefaultConversation(auth.userId);
  for(let i=0;i<30;i++)app.db.addMessage(auth.userId,conversation.id,i%2?'assistant':'user',i===0?'Early context marker':'Synthetic earlier turn');
  const first=await fetch(`${base}/api/chat`,{method:'POST',headers:authHeaders(auth),body:JSON.stringify({message:'Please answer the first question in detail.'})});
  assert.equal(first.status,202);
  assert.ok(await waitFor(()=>summaryStarted),'background summary started');
  const second=await fetch(`${base}/api/chat`,{method:'POST',headers:authHeaders(auth),body:JSON.stringify({message:'Please answer the second question in detail.'})});
  assert.equal(second.status,202);
  assert.ok(await waitFor(()=>app.db.listConversationMessages(auth.userId,conversation.id,5)
    .some((m)=>m.role==='assistant'&&m.content.includes('second question'))),
    'second reply completed while summary model call remained pending');
  assert.ok(secondHistory.some((m)=>m.content==='Early context marker'),'uncovered early history reached the second reply');
  releaseSummary();
  assert.ok(await waitFor(()=>app.db.getConversationSummary(auth.userId,conversation.id)?.summary==='Synthetic summary'));
  app.db.setConversationSummary(auth.userId,conversation.id,'newer',100);
  app.db.setConversationSummary(auth.userId,conversation.id,'stale',50);
  assert.equal(app.db.getConversationSummary(auth.userId,conversation.id).summary,'newer');
});

test('queued turn history excludes later accepted user messages',async(t)=>{
  const model=createModelClient({NODE_ENV:'test'});
  let releaseFirst,started=false;
  let secondHistory=[];
  model.respond=async({message,history=[]})=>{
    if(message==='First queued question'){started=true;await new Promise((resolve)=>{releaseFirst=resolve;});}
    if(message==='Second queued question')secondHistory=history;
    return{text:`Answered ${message}`,toolCalls:[]};
  };
  const {app,base}=await fixture({}, {modelClient:model});
  t.after(async()=>{releaseFirst?.();await app.close();});
  const auth=await register(base);
  const send=(message)=>fetch(`${base}/api/chat`,{method:'POST',headers:authHeaders(auth),body:JSON.stringify({message})});
  assert.equal((await send('First queued question')).status,202);
  assert.ok(await waitFor(()=>started));
  assert.equal((await send('Second queued question')).status,202);
  assert.equal((await send('Third queued question')).status,202);
  releaseFirst();
  const conversation=app.db.ensureDefaultConversation(auth.userId);
  assert.ok(await waitFor(()=>app.db.listConversationMessages(auth.userId,conversation.id,10)
    .some((m)=>m.role==='assistant'&&m.content==='Answered Third queued question')));
  assert.ok(secondHistory.some((m)=>m.content==='First queued question'));
  assert.ok(secondHistory.every((m)=>m.content!=='Third queued question'));
});

test('owner latency diagnostics aggregate queued turns without exposing conversation data', async (t) => {
  const model=createModelClient({NODE_ENV:'test'});
  let releaseFirst,firstStarted=false,calls=0;
  model.respond=async({onTurn,onToken})=>{
    calls++;
    onTurn?.(0);
    if(calls===1){firstStarted=true;await new Promise((resolve)=>{releaseFirst=resolve;});}
    onToken?.('A safe reply.');
    return {text:'A safe reply.',toolCalls:[]};
  };
  const {app,base}=await fixture({}, {modelClient:model});t.after(()=>app.close());
  const auth=await register(base);
  assert.equal((await fetch(`${base}/api/admin/chat-latency`)).status,401);
  const opened=await fetch(`${base}/api/admin/registration`,{method:'POST',headers:authHeaders(auth),body:JSON.stringify({open:true})});
  assert.equal(opened.status,200);
  const member=await register(base,'member@example.com');
  assert.equal((await fetch(`${base}/api/admin/chat-latency`,{headers:{Cookie:member.cookie}})).status,403);
  const first=await fetch(`${base}/api/chat`,{method:'POST',headers:authHeaders(auth),body:JSON.stringify({message:'Please explain the first turn in detail.'})});
  assert.equal(first.status,202);
  assert.ok(await waitFor(()=>firstStarted));
  const second=await fetch(`${base}/api/chat`,{method:'POST',headers:authHeaders(auth),body:JSON.stringify({message:'Please explain the second turn in detail.'})});
  assert.equal(second.status,202);
  await new Promise((resolve)=>setTimeout(resolve,50));
  releaseFirst();
  assert.ok(await waitFor(()=>app.chatMetrics.snapshot().count===2));
  const response=await fetch(`${base}/api/admin/chat-latency`,{headers:{Cookie:auth.cookie}});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const diagnostics=await response.json();
  assert.equal(diagnostics.count,2);
  assert.ok(diagnostics.timings.queueMs.p95>=40);
  assert.equal(diagnostics.timings.modelFirstTokenMs.count,2);
  assert.equal(diagnostics.timings.databaseMs.count,2);
  assert.ok(!JSON.stringify(diagnostics).includes('Please explain'));
  const health=await(await fetch(`${base}/healthz`)).json();
  assert.deepEqual(health.chatPerformance,{state:'insufficient',windowMinutes:60});
});

test('a failing model call saves a graceful reply instead of a 500', async (t) => {
  const { app, base } = await fixture({ OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'http://127.0.0.1:1/v1', ALLOW_INSECURE_MODEL_URL: 'true' });
  t.after(() => app.close());
  const auth = await register(base);
  const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ message: 'will this break?' }) });
  assert.equal(response.status, 202, 'send itself still accepted');
  const landed = await waitFor(() => {
    const convo = app.db.ensureDefaultConversation(auth.userId);
    return chatOnly(app.db.listConversationMessages(auth.userId, convo.id, 10)).some((m) => m.role === 'assistant' && m.content.includes('connection needs attention'));
  }, 30000); // model calls now retry transient failures with backoff before failing
  assert.ok(landed, 'a reply was saved even though the model failed');
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const reply = chatOnly(app.db.listConversationMessages(auth.userId, convo.id, 10)).find((m) => m.role === 'assistant');
  assert.ok(reply.content.includes('connection needs attention'), 'targeted connection guidance saved');
  const events = app.db.listEvents(auth.userId, 10);
  assert.ok(events.some((e) => e.type === 'chat_failed'), 'chat_failed event logged');
  const status = await (await fetch(`${base}/api/status`, { headers: { Cookie: auth.cookie } })).json();
  assert.equal(status.modelStatus.state, 'network');
  assert.equal(status.modelStatus.activeModel, null);
});
