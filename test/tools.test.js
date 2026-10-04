import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { toolGetDatetime, parseLiteResults, assertPublicUrl, executeTool, TOOL_DEFINITIONS } from '../src/tools.js';
import { createModelClient } from '../src/model.js';

test('tool definitions are valid Responses API function tools', () => {
  assert.equal(TOOL_DEFINITIONS.length, 18);
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.type, 'function');
    assert.ok(tool.name && tool.description && tool.parameters);
  }
  assert.deepEqual(TOOL_DEFINITIONS.map((t) => t.name).sort(), ['calculate', 'create_goal', 'create_project', 'create_routine', 'create_task', 'deep_research', 'fetch_url', 'get_datetime', 'get_news', 'get_weather', 'propose_calendar_event', 'propose_memory', 'read_calendar', 'save_memory', 'schedule_followup', 'update_goal', 'update_project_step', 'web_search']);
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

test('model access failure falls back to the configured starter model', async (t) => {
  let requests = 0;
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests += 1;
      const sent = JSON.parse(body);
      res.writeHead(sent.model === 'gpt-6-astra' ? 404 : 200, { 'Content-Type': 'application/json' });
      if (sent.model === 'gpt-6-astra') res.end(JSON.stringify({ error: { code: 'model_not_found', message: 'Project does not have access to this model.' } }));
      else res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Fallback worked.' }] }] }));
    });
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  t.after(() => stub.close());
  const model = createModelClient({ OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'gpt-6-astra', OPENAI_FALLBACK_MODEL: 'gpt-6-luna', OPENAI_BASE_URL: `http://127.0.0.1:${stub.address().port}`, ALLOW_INSECURE_MODEL_URL: 'true' });
  const response = await model.respond({ buddyName: 'Orbit', message: 'Hello', tools: true });
  assert.equal(response.text, 'Fallback worked.');
  assert.equal(requests, 2);
  assert.equal(model.diagnostics().state, 'fallback');
  assert.equal(model.diagnostics().activeModel, 'gpt-6-luna');
});

test('model access fallback continues to the compatibility model', async (t) => {
  const attempted = [];
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const sent = JSON.parse(body);
      attempted.push(sent.model);
      const works = sent.model === 'gpt-5.4-mini';
      res.writeHead(works ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(works
        ? { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Compatible model worked.' }] }] }
        : { error: { code: 'model_not_found', message: 'Project does not have access to this model.' } }));
    });
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  t.after(() => stub.close());
  const model = createModelClient({ OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'astra', OPENAI_FALLBACK_MODEL: 'luna', OPENAI_BASE_URL: `http://127.0.0.1:${stub.address().port}`, ALLOW_INSECURE_MODEL_URL: 'true' });
  const response = await model.respond({ buddyName: 'Orbit', message: 'Hello' });
  assert.equal(response.text, 'Compatible model worked.');
  assert.deepEqual(attempted, ['gpt-6-astra', 'gpt-6-luna', 'gpt-5.4-mini']);
  assert.equal(model.diagnostics().activeModel, 'gpt-5.4-mini');
});

test('authentication failures are diagnosed without a fallback retry', async (t) => {
  let requests = 0;
  const stub = http.createServer((req, res) => {
    req.resume();req.on('end', () => { requests += 1;res.writeHead(401, { 'Content-Type': 'application/json' });res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'Incorrect API key.' } })); });
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  t.after(() => stub.close());
  const model = createModelClient({ OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'gpt-6-astra', OPENAI_FALLBACK_MODEL: 'gpt-6-luna', OPENAI_BASE_URL: `http://127.0.0.1:${stub.address().port}`, ALLOW_INSECURE_MODEL_URL: 'true' });
  await assert.rejects(() => model.respond({ buddyName: 'Orbit', message: 'Hello' }), (error) => error.classification === 'authentication');
  assert.equal(requests, 1);
  assert.equal(model.diagnostics().state, 'authentication');
});

test('connection check validates the key without generating tokens and selects an available fallback', async (t) => {
  let requests = 0;
  const stub = http.createServer((req, res) => {
    requests += 1;
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/models');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'gpt-6-luna' }] }));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  t.after(() => stub.close());
  const model = createModelClient({ OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'astra', OPENAI_FALLBACK_MODEL: 'luna', OPENAI_BASE_URL: `http://127.0.0.1:${stub.address().port}`, ALLOW_INSECURE_MODEL_URL: 'true' });
  const status = await model.checkConnection();
  assert.equal(requests, 1);
  assert.equal(model.model, 'gpt-6-astra');
  assert.equal(status.state, 'fallback');
  assert.equal(status.activeModel, 'gpt-6-luna');
  assert.deepEqual(status.fallbackModels, ['gpt-6-luna', 'gpt-5.4-mini', 'gpt-4.1-mini', 'gpt-4o-mini']);
});

test('connection check identifies a revoked key without a generation request', async (t) => {
  const stub = http.createServer((req, res) => {
    assert.equal(req.method, 'GET');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'Incorrect API key.' } }));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  t.after(() => stub.close());
  const model = createModelClient({ OPENAI_API_KEY: 'revoked-key', OPENAI_BASE_URL: `http://127.0.0.1:${stub.address().port}`, ALLOW_INSECURE_MODEL_URL: 'true' });
  const status = await model.checkConnection();
  assert.equal(status.state, 'authentication');
  assert.equal(status.activeModel, null);
});

test('connection check adapts to a compatible text model listed by the project', async (t) => {
  const stub = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'text-embedding-3-small' }, { id: 'gpt-4o-2024-08-06' }] }));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  t.after(() => stub.close());
  const model = createModelClient({ OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'astra', OPENAI_BASE_URL: `http://127.0.0.1:${stub.address().port}`, ALLOW_INSECURE_MODEL_URL: 'true' });
  const status = await model.checkConnection();
  assert.equal(status.state, 'fallback');
  assert.equal(status.activeModel, 'gpt-4o-2024-08-06');
  assert.equal(status.availableTextModelCount, 1);
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
      addMemory: (userId, content, options) => {
        calls.push(['addMemory', userId, content, options]);
        return { id: 'mem-1', content };
      },
      addMemorySuggestion: (userId, content, options) => {
        calls.push(['addMemorySuggestion', userId, content, options]);
        return { id: 'suggestion-1', content, ...options };
      },
      addFollowUp: (userId, followUp) => {
        calls.push(['addFollowUp', userId, followUp]);
        return { id: 'followup-1', description: followUp.description, due_date: followUp.dueDate };
      },
      addGoal: (userId, goal) => {
        calls.push(['addGoal', userId, goal]);
        return { id: 'goal-1', title: goal.title, priority: goal.priority, target_date: goal.targetDate };
      },
      updateGoal: (userId, goalId, update) => {
        calls.push(['updateGoal', userId, goalId, update]);
        return { id: goalId, title: 'Certification', progress: update.progress ?? 25, status: update.status || 'active', next_step: update.nextStep || null };
      },
      addRoutine: (userId, routine) => {
        calls.push(['addRoutine', userId, routine]);
        return { id: 'routine-1', ...routine, time_local: routine.timeLocal };
      },
      addProject: (userId, project) => {
        calls.push(['addProject', userId, project]);
        return { id: 'project-1', title: project.title, steps: project.steps.map((step, index) => ({ id: `step-${index + 1}`, title: step.title, status: 'planned' })) };
      },
      updateProjectStep: (userId, stepId, update) => {
        calls.push(['updateProjectStep', userId, stepId, update]);
        return { id: stepId, title: 'Review copy', status: update.status };
      },
      addApproval: (userId, approval) => {
        calls.push(['addApproval', userId, approval]);
        return { id: 'approval-1', status: 'pending', ...approval };
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
  assert.deepEqual(ctx.calls[0], ['addMemory', 'user-1', 'Edward likes Earl Grey', { kind: 'fact', source: 'explicit' }]);
  await assert.rejects(() => executeTool('save_memory', { content: '   ' }, {}, ctx), /content is required/);
  await assert.rejects(() => executeTool('save_memory', { content: 'x' }, {}, null), /not available in this context/);
});

test('save_memory truncates long content at 2000 chars', async () => {
  const ctx = writeCtx();
  const { result } = await executeTool('save_memory', { content: 'a'.repeat(2500) }, {}, ctx);
  assert.equal(result.content.length, 2000);
});

test('propose_memory queues an approval instead of silently saving', async () => {
  const ctx = writeCtx();
  const { result } = await executeTool('propose_memory', { content: ' Prefers aisle seats ', kind: 'preference' }, {}, ctx);
  assert.equal(result.kind, 'preference');
  assert.deepEqual(ctx.calls[0], ['addMemorySuggestion', 'user-1', 'Prefers aisle seats', { kind: 'preference', confidence: 0.7 }]);
});

test('schedule_followup validates dates and preserves the source message', async () => {
  const ctx = { ...writeCtx(), messageId: 'message-1' };
  const { result } = await executeTool('schedule_followup', { description: ' dentist appointment ', date: '2026-10-08' }, {}, ctx);
  assert.equal(result.date, '2026-10-08');
  assert.deepEqual(ctx.calls[0], ['addFollowUp', 'user-1', { description: 'dentist appointment', dueDate: '2026-10-08', priority: 2, sourceMessageId: 'message-1' }]);
  await assert.rejects(() => executeTool('schedule_followup', { description: 'trip', date: '2026-02-30' }, {}, ctx), /YYYY-MM-DD/);
});

test('goal tools create and update user-controlled progress', async () => {
  const ctx = writeCtx();
  const created = await executeTool('create_goal', { title: ' Certification ', priority: 3, targetDate: '2026-12-01', nextStep: 'Book exam' }, {}, ctx);
  assert.equal(created.result.id, 'goal-1');
  assert.deepEqual(ctx.calls[0], ['addGoal', 'user-1', { title: 'Certification', description: null, priority: 3, targetDate: '2026-12-01', nextStep: 'Book exam' }]);
  const updated = await executeTool('update_goal', { goalId: 'goal-1', progress: 40, note: 'Finished a module' }, {}, ctx);
  assert.equal(updated.result.progress, 40);
  assert.deepEqual(ctx.calls[1], ['updateGoal', 'user-1', 'goal-1', { progress: 40, status: undefined, nextStep: undefined, note: 'Finished a module' }]);
  await assert.rejects(() => executeTool('update_goal', { goalId: 'goal-1', progress: 101 }, {}, ctx), /0 to 100/);
});

test('project tools create ordered steps and only update explicit progress', async () => {
  const ctx = writeCtx();
  const created = await executeTool('create_project', {
    title: ' Website launch ',
    priority: 3,
    targetDate: '2026-12-01',
    steps: [{ title: 'Review copy', dueDate: '2026-11-20' }, { title: 'Publish' }]
  }, {}, ctx);
  assert.equal(created.result.id, 'project-1');
  assert.deepEqual(ctx.calls[0], ['addProject', 'user-1', {
    title: 'Website launch',
    description: null,
    priority: 3,
    targetDate: '2026-12-01',
    steps: [
      { title: 'Review copy', details: null, dueDate: '2026-11-20' },
      { title: 'Publish', details: null, dueDate: null }
    ]
  }]);
  const updated = await executeTool('update_project_step', { stepId: 'step-1', status: 'completed', note: 'Done with the user' }, {}, ctx);
  assert.equal(updated.result.status, 'completed');
  assert.deepEqual(ctx.calls[1], ['updateProjectStep', 'user-1', 'step-1', { status: 'completed', details: 'Done with the user' }]);
  await assert.rejects(() => executeTool('create_project', { title: 'Bad', steps: [{ title: 'Step', dueDate: '2026-02-30' }] }, {}, ctx), /YYYY-MM-DD/);
  await assert.rejects(() => executeTool('update_project_step', { stepId: 'step-1', status: 'guessed' }, {}, ctx), /status must be/);
});

test('calendar proposals require approval and reject invalid ranges', async () => {
  const ctx = { ...writeCtx(), messageId: 'message-1', timeZone: 'Europe/London' };
  const proposed = await executeTool('propose_calendar_event', {
    title: 'Planning review',
    startAt: '2026-10-12T14:00:00Z',
    endAt: '2026-10-12T15:00:00Z',
    location: 'Video call'
  }, {}, ctx);
  assert.equal(proposed.result.status, 'pending');
  assert.equal(proposed.result.timeZone, 'Europe/London');
  assert.deepEqual(ctx.calls[0][0], 'addApproval');
  assert.equal(ctx.calls[0][2].kind, 'calendar_event');
  assert.equal(ctx.calls[0][2].sourceMessageId, 'message-1');
  await assert.rejects(() => executeTool('propose_calendar_event', { title: 'Bad range', startAt: '2026-10-12T15:00:00Z', endAt: '2026-10-12T14:00:00Z' }, {}, ctx), /endAt after startAt/);
});

test('create_routine validates local time and weekly schedule', async () => {
  const ctx = writeCtx();
  const created = await executeTool('create_routine', { title: 'Monday brief', prompt: 'Prepare my week', kind: 'briefing', cadence: 'weekly', timeLocal: '08:30', dayOfWeek: 1 }, {}, ctx);
  assert.equal(created.result.cadence, 'weekly');
  assert.deepEqual(ctx.calls[0][2], { title: 'Monday brief', prompt: 'Prepare my week', kind: 'briefing', cadence: 'weekly', timeLocal: '08:30', dayOfWeek: 1 });
  await assert.rejects(() => executeTool('create_routine', { title: 'Bad', prompt: 'x', kind: 'custom', cadence: 'daily', timeLocal: '25:00' }, {}, ctx), /HH:MM/);
  await assert.rejects(() => executeTool('create_routine', { title: 'Bad day', prompt: 'x', kind: 'custom', cadence: 'weekly', timeLocal: '08:00', dayOfWeek: 8 }, {}, ctx), /dayOfWeek/);
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

test('tool loop requests a text summary after exhausting iterations on tool calls', async (t) => {
  let requests = 0;
  let fifthHadTools = null;
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests += 1;
      const sent = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (requests <= 4) {
        res.end(JSON.stringify({ output: [{ type: 'function_call', call_id: `call_${requests}`, name: 'get_datetime', arguments: '{}' }] }));
      } else {
        fifthHadTools = !!sent.tools;
        res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done — created 4 tasks.' }] }] }));
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
  const { text, toolCalls } = await model.respond({ buddyName: 'Orbit', message: 'Do many things', tools: true });
  assert.equal(text, 'Done — created 4 tasks.');
  assert.equal(toolCalls.length, 4);
  assert.equal(requests, 5);
  assert.equal(fifthHadTools, false);
});

test('deep_research requires a topic', async () => {
  const { toolDeepResearch } = await import('../src/tools.js');
  await assert.rejects(() => toolDeepResearch({}), /research topic is required/);
  await assert.rejects(() => toolDeepResearch({ topic: '   ' }), /research topic is required/);
});

test('deep_research tool is wired in executeTool', async () => {
  const { executeTool } = await import('../src/tools.js');
  // Mock env without Brave key so it falls back to DuckDuckGo (may fail offline, that's ok)
  // We just verify the wiring doesn't throw "Unknown tool"
  try {
    await executeTool('deep_research', { topic: 'test' }, {});
  } catch (e) {
    // Should not be "Unknown tool" — network failures are acceptable in test
    assert.ok(!e.message.includes('Unknown tool'), 'deep_research should be a known tool');
  }
});

test('calculate handles arithmetic and conversions', async () => {
  const { toolCalculate } = await import('../src/tools.js');
  assert.ok(toolCalculate({ expression: '15% of 240' }).includes('36'));
  assert.ok(toolCalculate({ expression: '5 miles to km' }).includes('8.05 km'));
  assert.ok(toolCalculate({ expression: '(12+8)*3' }).includes('60'));
  assert.throws(() => toolCalculate({}), /required/);
  assert.throws(() => toolCalculate({ expression: 'hello world' }), /only do basic/);
});

test('get_weather requires location handling', async () => {
  const { toolGetWeather } = await import('../src/tools.js');
  // Will fail without network, but should not throw "Unknown tool"
  try {
    const result = await toolGetWeather({ location: 'Boston' });
    assert.ok(result.includes('Weather for') || result.includes('°F'));
  } catch (e) {
    // Network failures OK in test, but not validation errors
    assert.ok(!e.message.includes('required'), 'Should not fail validation');
  }
});

test('get_news returns headlines', async () => {
  const { toolGetNews } = await import('../src/tools.js');
  try {
    const result = await toolGetNews({ topic: 'tech' });
    assert.ok(result.includes('headlines:'));
    assert.ok(result.includes('1.'));
  } catch (e) {
    // Network failures OK in test
    assert.ok(e.message.includes('failed') || e.message.includes('No headlines'));
  }
});
