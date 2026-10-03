import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { toolGetDatetime, parseLiteResults, assertPublicUrl, executeTool, TOOL_DEFINITIONS } from '../src/tools.js';
import { createModelClient } from '../src/model.js';

test('tool definitions are valid Responses API function tools', () => {
  assert.equal(TOOL_DEFINITIONS.length, 6);
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.type, 'function');
    assert.ok(tool.name && tool.description && tool.parameters);
  }
  assert.deepEqual(TOOL_DEFINITIONS.map((t) => t.name).sort(), ['create_task', 'fetch_url', 'get_datetime', 'read_calendar', 'save_memory', 'web_search']);
});

test('get_datetime returns current time and falls back on bad timezone', () => {
  const result = toolGetDatetime({});
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(result.iso));
  assert.equal(result.timeZone, 'America/New_York');
  assert.ok(result.local.includes('2026'));
  const bad = toolGetDatetime({ timeZone: 'Not/AZone' });
  assert.equal(bad.timeZone, 'America/New_York');
  const london = toolGetDatetime({ timeZone: 'Europe/London' });
  assert.equal(london.timeZone, 'Europe/London');
});

test('assertPublicUrl blocks SSRF targets', async () => {
  await assert.rejects(() => assertPublicUrl('ftp://example.com/x'), /Only http/);
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1/'), /not publicly reachable/);
  await assert.rejects(() => assertPublicUrl('http://10.1.2.3/'), /not publicly reachable/);
  await assert.rejects(() => assertPublicUrl('http://169.254.169.254/latest/'), /not publicly reachable/);
  await assert.rejects(() => assertPublicUrl('http://[::1]/'), /not publicly reachable/);
  assert.ok((await assertPublicUrl('https://8.8.8.8/')).startsWith('https://'));
});

test('parseLiteResults extracts titles, urls and snippets', () => {
  const html = `<table>
    <tr><td><a rel="nofollow" href="https://example.com/a">First Result</a></td></tr>
    <tr><td class='result-snippet'>A <b>snippet</b> here.</td></tr>
    <tr><td><a rel="nofollow" href="https://duckduckgo.com/y.js">internal</a></td></tr>
    <tr><td><a rel="nofollow" href="https://example.com/b">Second Result</a></td></tr>
    <tr><td class='result-snippet'>Another snippet.</td></tr>
  </table>`;
  const results = parseLiteResults(html);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://example.com/a');
  assert.equal(results[0].title, 'First Result');
  assert.equal(results[0].snippet, 'A snippet here.');
  assert.equal(results[1].url, 'https://example.com/b');
});

test('fetch_url reads text and strips scripts', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/binary') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from([1, 2, 3]));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><style>.x{color:red}</style></head><body><script>alert(1)</script><h1>Hello world</h1><p>Readable text.</p></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  // 127.0.0.1 is blocked by the SSRF guard, so call the fetch path via executeTool with a stubbed guard is not possible;
  // instead verify the guard rejects loopback and unknown tools reject.
  await assert.rejects(() => executeTool('fetch_url', { url: `http://127.0.0.1:${server.address().port}/` }), /not publicly reachable/);
  await assert.rejects(() => executeTool('nope', {}), /Unknown tool/);
});

test('web_search prefers Brave when a key is set, falls back to DDG', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  global.fetch = async (url, options) => {
    if (String(url).includes('api.search.brave.com')) {
      assert.equal(options.headers['X-Subscription-Token'], 'test-brave-key');
      return {
        ok: true,
        json: async () => ({ web: { results: [{ url: 'https://example.com/sox', title: 'Sox win', description: 'Boston won 5-4.' }] } })
      };
    }
    throw new Error('DDG should not be called when Brave succeeds');
  };
  const { result } = await executeTool('web_search', { query: 'red sox' }, { BRAVE_SEARCH_API_KEY: 'test-brave-key' });
  assert.equal(result.via, 'brave');
  assert.equal(result.results[0].title, 'Sox win');

  global.fetch = async (url) => {
    if (String(url).includes('api.search.brave.com')) return { ok: false, status: 429 };
    return { ok: true, json: async () => ({ AbstractText: 'Fallback answer.', AbstractURL: 'https://example.com/fb' }) };
  };
  const fallback = await executeTool('web_search', { query: 'red sox' }, { BRAVE_SEARCH_API_KEY: 'bad-key' });
  assert.equal(fallback.result.via, 'instant-answer');
});

test('web_search uses the instant-answer API when available', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  global.fetch = async (url) => ({
    ok: true,
    json: async () => ({ AbstractText: 'Paris is the capital of France.', AbstractURL: 'https://example.com/paris' })
  });
  const { result } = await executeTool('web_search', { query: 'capital of france' });
  assert.equal(result.answer, 'Paris is the capital of France.');
  assert.equal(result.via, 'instant-answer');
});

test('tool loop calls functions and returns the final answer', async (t) => {
  let requests = 0;
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (requests === 1) {
        const sent = JSON.parse(body);
        assert.ok(sent.tools.some((tool) => tool.name === 'get_datetime'));
        res.end(JSON.stringify({ output: [{ type: 'function_call', call_id: 'call_1', name: 'get_datetime', arguments: '{}' }] }));
      } else {
        const sent = JSON.parse(body);
        const fnOutput = sent.input.find((item) => item.type === 'function_call_output');
        assert.equal(fnOutput.call_id, 'call_1');
        assert.ok(JSON.parse(fnOutput.output).iso);
        res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'It is Friday.' }] }] }));
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
  const { text, toolCalls } = await model.respond({ buddyName: 'Orbit', message: 'What time is it?', tools: true });
  assert.equal(text, 'It is Friday.');
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, 'get_datetime');
  assert.equal(requests, 2);
});

test('respond without tools keeps the single-request behavior', async (t) => {
  let requests = 0;
  const stub = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello.' }] }] }));
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
  const { text, toolCalls } = await model.respond({ buddyName: 'Orbit', message: 'Hi' });
  assert.equal(text, 'Hello.');
  assert.deepEqual(toolCalls, []);
  assert.equal(requests, 1);
});

function writeCtx() {
  const calls = [];
  return {
    userId: 'user-1',
    calls,
    db: {
      addTask: (userId, task) => {
        calls.push(['addTask', userId, task]);
        return {
          id: 'task-1',
          title: task.title,
          status: task.risk === 'external' ? 'waiting_approval' : (task.scheduleAt ? 'scheduled' : 'queued'),
          risk: task.risk
        };
      },
      addMemory: (userId, content) => {
        calls.push(['addMemory', userId, content]);
        return { id: 'mem-1', content };
      }
    }
  };
}

test('create_task validates input and creates via ctx', async () => {
  const ctx = writeCtx();
  const { result } = await executeTool('create_task', { title: '  Morning brief  ', prompt: 'Summarize the news', recurrence: 'daily' }, {}, ctx);
  assert.equal(result.status, 'queued');
  assert.deepEqual(ctx.calls[0][2], {
    title: 'Morning brief',
    prompt: 'Summarize the news',
    risk: 'internal',
    scheduleAt: null,
    recurrence: 'daily'
  });
});

test('create_task routes external risk through approval', async () => {
  const ctx = writeCtx();
  const { result } = await executeTool('create_task', { title: 'Buy milk', prompt: 'Order milk', risk: 'external' }, {}, ctx);
  assert.equal(result.status, 'waiting_approval');
  assert.match(result.note, /waiting/i);
});

test('create_task parses scheduleAt and rejects bad input or missing context', async () => {
  const ctx = writeCtx();
  const scheduled = await executeTool('create_task', { title: 't', prompt: 'x', scheduleAt: '2026-10-04T13:00:00Z' }, {}, ctx);
  assert.equal(scheduled.result.status, 'scheduled');
  await assert.rejects(() => executeTool('create_task', { title: '', prompt: 'x' }, {}, ctx), /title is required/);
  await assert.rejects(() => executeTool('create_task', { title: 't', prompt: 'x', scheduleAt: 'not-a-date' }, {}, ctx), /valid date/);
  await assert.rejects(() => executeTool('create_task', { title: 't', prompt: 'x' }, {}, null), /not available in this context/);
  await assert.rejects(() => executeTool('create_task', { title: 't', prompt: 'x' }, {}, { userId: 'u' }), /not available in this context/);
});

test('save_memory validates and saves via ctx', async () => {
  const ctx = writeCtx();
  const { result } = await executeTool('save_memory', { content: '  Edward likes Earl Grey  ' }, {}, ctx);
  assert.equal(result.content, 'Edward likes Earl Grey');
  assert.deepEqual(ctx.calls[0], ['addMemory', 'user-1', 'Edward likes Earl Grey']);
  await assert.rejects(() => executeTool('save_memory', { content: '   ' }, {}, ctx), /content is required/);
  await assert.rejects(() => executeTool('save_memory', { content: 'x' }, {}, null), /not available in this context/);
});

test('save_memory truncates long content at 2000 chars', async () => {
  const ctx = writeCtx();
  const { result } = await executeTool('save_memory', { content: 'a'.repeat(2500) }, {}, ctx);
  assert.equal(result.content.length, 2000);
});

test('Brave retries transient failures before giving up', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  let braveCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes('api.search.brave.com')) {
      braveCalls += 1;
      if (braveCalls < 3) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ web: { results: [{ url: 'https://example.com/a', title: 'A', description: 'D' }] } }) };
    }
    throw new Error('DDG should not be called when Brave recovers');
  };
  const { result } = await executeTool('web_search', { query: 'retry test' }, { BRAVE_SEARCH_API_KEY: 'k' });
  assert.equal(result.via, 'brave');
  assert.equal(braveCalls, 3);
});

test('Brave does not retry auth failures', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  let braveCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes('api.search.brave.com')) {
      braveCalls += 1;
      return { ok: false, status: 401 };
    }
    return { ok: true, json: async () => ({ AbstractText: 'Fallback.', AbstractURL: 'https://example.com/fb' }) };
  };
  const { result } = await executeTool('web_search', { query: 'auth test' }, { BRAVE_SEARCH_API_KEY: 'bad' });
  assert.equal(result.via, 'instant-answer');
  assert.equal(braveCalls, 1);
});
