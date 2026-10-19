import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';

async function fixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-chatstream-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', ...extraEnv } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function register(base) {
  const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple' }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrf, userId: body.user.id };
}

// Read a text/event-stream response until the 'done' event (or timeout).
async function collectSse(base, query, headers, timeoutMs = 10000) {
  const response = await fetch(`${base}/api/chat/stream${query}`, { headers });
  assert.equal(response.status, 200, 'SSE endpoint returns 200 for an authed owner');
  assert.ok(String(response.headers.get('content-type') || '').includes('text/event-stream'), 'content-type is text/event-stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buf = '';
  const timer = setTimeout(() => { reader.cancel().catch(() => {}); }, timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (!line || line.startsWith(':')) continue; // skip blanks and heartbeats/comments
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (data) events.push({ event, data: JSON.parse(data) });
        if (event === 'done') { await reader.cancel().catch(() => {}); break; }
      }
      if (events.some((e) => e.event === 'done')) break;
    }
  } finally {
    clearTimeout(timer);
  }
  return events;
}

test('SSE endpoint emits sync then delta events as the stream grows', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const stream = { turn: 0, text: '', done: false };
  app.pendingStreams.set(convo.id, stream);
  const collected = collectSse(base, `?conversationId=${convo.id}`, { Cookie: auth.cookie });
  await new Promise((r) => setTimeout(r, 250)); // let the sync event arrive
  stream.text = 'Hello ';
  await new Promise((r) => setTimeout(r, 250));
  stream.text = 'Hello world';
  await new Promise((r) => setTimeout(r, 250));
  stream.done = true;
  const events = await collected;
  assert.ok(events.length >= 1, 'got SSE events');
  assert.equal(events[0].event, 'sync', 'first event is sync');
  assert.equal(events[0].data.turn, 0);
  const deltas = events.filter((e) => e.event === 'delta');
  assert.ok(deltas.length >= 1, 'delta events were emitted for new text');
  assert.equal(deltas.map((d) => d.data.delta).join(''), 'Hello world', 'deltas carry only the new text since last send');
  assert.equal(events[events.length - 1].event, 'done', 'final event is done');
});

test('SSE initial sync does not repeat already-generated text as a delta', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const stream = { turn: 0, text: 'Already here', done: false };
  app.pendingStreams.set(convo.id, stream);
  const collected = collectSse(base, `?conversationId=${convo.id}`, { Cookie: auth.cookie });
  await new Promise((r) => setTimeout(r, 250));
  stream.text = 'Already here and growing';
  await new Promise((r) => setTimeout(r, 250));
  stream.done = true;
  const events = await collected;
  const sync = events.find((event) => event.event === 'sync');
  const deltas = events.filter((event) => event.event === 'delta');
  assert.equal(sync.data.text, 'Already here');
  assert.equal(deltas.map((event) => event.data.delta).join(''), ' and growing');
  assert.equal(sync.data.text + deltas.map((event) => event.data.delta).join(''), 'Already here and growing');
});

test('SSE resynchronizes when marker stripping rewrites the visible prefix', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const stream = { turn: 0, text: 'Hello [SUGGEST_MEMORY: favorite', done: false };
  app.pendingStreams.set(convo.id, stream);
  const collected = collectSse(base, `?conversationId=${convo.id}`, { Cookie: auth.cookie });
  await new Promise((r) => setTimeout(r, 250));
  stream.text = 'Hello [SUGGEST_MEMORY: favorite color is blue]';
  await new Promise((r) => setTimeout(r, 250));
  stream.text = 'Hello [SUGGEST_MEMORY: favorite color is blue] world';
  await new Promise((r) => setTimeout(r, 250));
  stream.done = true;
  const events = await collected;
  const syncs = events.filter((event) => event.event === 'sync');
  assert.ok(syncs.some((event) => event.data.text === 'Hello'), 'sanitized rewrite sends a corrective sync');
  let visible = '';
  let turn = -1;
  for (const event of events) {
    if (event.event === 'sync') { turn = event.data.turn; visible = event.data.text; }
    if (event.event === 'delta') {
      if (event.data.turn !== turn) { turn = event.data.turn; visible = ''; }
      visible += event.data.delta;
    }
  }
  assert.equal(visible, 'Hello  world');
});

test('SSE endpoint closes the connection after the done event', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  app.pendingStreams.set(convo.id, { turn: 2, text: 'already finished', done: true });
  const events = await collectSse(base, `?conversationId=${convo.id}`, { Cookie: auth.cookie });
  assert.ok(events.some((e) => e.event === 'done'), 'done event arrives for a finished stream');
});

test('SSE endpoint clears its buffer when a new turn starts', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const stream = { turn: 0, text: 'first turn text', done: false };
  app.pendingStreams.set(convo.id, stream);
  const collected = collectSse(base, `?conversationId=${convo.id}`, { Cookie: auth.cookie });
  await new Promise((r) => setTimeout(r, 250));
  stream.turn = 1; stream.text = 'second turn';
  await new Promise((r) => setTimeout(r, 250));
  stream.done = true;
  const events = await collected;
  const syncs = events.filter((e) => e.event === 'sync');
  assert.ok(syncs.some((s) => s.data.turn === 1 && s.data.text === 'second turn'), 'new turn emits a fresh sync with the new turn text');
});

test('SSE endpoint rejects unauthenticated requests and unknown conversations', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const auth = await register(base);
  const convo = app.db.ensureDefaultConversation(auth.userId);
  const anon = await fetch(`${base}/api/chat/stream?conversationId=${convo.id}`);
  assert.equal(anon.status, 401, 'no session returns 401, not a stream');
  assert.ok(!String(anon.headers.get('content-type') || '').includes('text/event-stream'), '401 is not an event stream');
  const missing = await fetch(`${base}/api/chat/stream?conversationId=00000000-0000-0000-0000-000000000000`, { headers: { Cookie: auth.cookie } });
  assert.equal(missing.status, 404, 'unknown conversation returns 404, not a stream');
  assert.ok(!String(missing.headers.get('content-type') || '').includes('text/event-stream'), '404 is not an event stream');
});

test('client uses EventSource with the pollStream fallback intact', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(source.includes('new EventSource('), 'app.js opens an EventSource');
  assert.ok(source.includes('/api/chat/stream?conversationId='), 'EventSource targets /api/chat/stream');
  assert.ok(source.includes("addEventListener('delta'"), 'client listens for delta events');
  assert.ok(source.includes("addEventListener('done'"), 'client listens for done events');
  assert.match(source, /async function pollStream\(\)/, 'pollStream is still defined as the polling fallback');
  assert.ok(source.includes('pollStream()'), 'fallback path still invokes pollStream');
  assert.ok(source.includes('/api/chat/stream-state'), 'pollStream still reads /api/chat/stream-state');
});
