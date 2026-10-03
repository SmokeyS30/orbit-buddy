import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseResponsesStream, createModelClient } from '../src/model.js';
import { createOrbitServer } from '../server.js';

function sseBody(chunks) {
  const encoder = new TextEncoder();
  const parts = chunks.map((c) => encoder.encode(c));
  return {
    getReader() {
      let i = 0;
      return {
        async read() {
          if (i >= parts.length) return { done: true, value: undefined };
          return { done: false, value: parts[i++] };
        }
      };
    }
  };
}

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

test('parseResponsesStream rebuilds text and calls onToken per delta', async () => {
  const tokens = [];
  const output = await parseResponsesStream(sseBody([
    sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } }),
    sse({ type: 'response.output_text.delta', output_index: 0, delta: 'Hello' }),
    sse({ type: 'response.output_text.delta', output_index: 0, delta: ' world' }),
    'data: [DONE]\n\n'
  ]), (delta) => tokens.push(delta));
  assert.deepEqual(tokens, ['Hello', ' world']);
  assert.equal(output.length, 1);
  assert.equal(output[0].type, 'message');
  assert.deepEqual(output[0].content, [{ type: 'output_text', text: 'Hello world' }]);
});

test('parseResponsesStream reconstructs function calls', async () => {
  const output = await parseResponsesStream(sseBody([
    sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search' } }),
    sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"query":' }),
    sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '"red sox"}' }),
    'data: [DONE]\n\n'
  ]), null);
  assert.equal(output.length, 1);
  assert.equal(output[0].type, 'function_call');
  assert.equal(output[0].name, 'web_search');
  assert.equal(output[0].call_id, 'call_1');
  assert.deepEqual(JSON.parse(output[0].arguments), { query: 'red sox' });
});

test('parseResponsesStream handles chunks split mid-event and empty streams', async () => {
  const full = sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } })
    + sse({ type: 'response.output_text.delta', output_index: 0, delta: 'abc' });
  const cut = Math.floor(full.length / 2);
  const output = await parseResponsesStream(sseBody([full.slice(0, cut), full.slice(cut), 'data: [DONE]\n\n']), null);
  assert.equal(output[0].content[0].text, 'abc');
  const empty = await parseResponsesStream(sseBody(['data: [DONE]\n\n']), null);
  assert.deepEqual(empty, []);
});

test('tool loop streams tokens and still handles function calls', async (t) => {
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const sent = JSON.parse(body);
      assert.equal(sent.stream, true);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (!sent.input.some((item) => item.type === 'function_call_output')) {
        res.end(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'get_datetime' } })
          + sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' })
          + 'data: [DONE]\n\n');
      } else {
        res.end(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1' } })
          + sse({ type: 'response.output_text.delta', output_index: 0, delta: 'It is ' })
          + sse({ type: 'response.output_text.delta', output_index: 0, delta: 'Friday.' })
          + 'data: [DONE]\n\n');
      }
    });
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  t.after(() => stub.close());
  const model = createModelClient({
    OPENAI_API_KEY: 'test-key',
    OPENAI_MODEL: 'test-model',
    OPENAI_BASE_URL: `http://127.0.0.1:${stub.address().port}`,
    ALLOW_INSECURE_MODEL_URL: 'true'
  });
  const tokens = [];
  const turns = [];
  const { text, toolCalls } = await model.respond({
    buddyName: 'Orbit', message: 'What time is it?', tools: true,
    onToken: (delta) => tokens.push(delta), onTurn: (n) => turns.push(n)
  });
  assert.equal(text, 'It is Friday.');
  assert.deepEqual(tokens, ['It is ', 'Friday.']);
  assert.deepEqual(turns, [0, 1]);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, 'get_datetime');
});

async function fixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-stream-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', ...extraEnv } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function register(base, { email = 'owner@example.com', displayName = 'Owner' } = {}) {
  const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, displayName, password: 'correct horse battery staple' }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrf, body };
}

const authHeaders = ({ cookie, csrf }) => ({ Cookie: cookie, 'X-Orbit-CSRF': csrf, 'Content-Type': 'application/json' });

test('stream-state requires auth, rejects unknown conversations, and reports idle', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  assert.equal((await fetch(`${base}/api/chat/stream-state?conversationId=x`)).status, 401);
  const auth = await register(base);
  const snapshot = await (await fetch(`${base}/api/snapshot`, { headers: authHeaders(auth) })).json();
  const convoId = snapshot.activeConversation.id;
  const idle = await fetch(`${base}/api/chat/stream-state?conversationId=${convoId}`, { headers: authHeaders(auth) });
  assert.equal(idle.status, 200);
  assert.deepEqual(await idle.json(), { state: 'idle' });
  const bad = await fetch(`${base}/api/chat/stream-state?conversationId=nope`, { headers: authHeaders(auth) });
  assert.equal(bad.status, 404);
});
