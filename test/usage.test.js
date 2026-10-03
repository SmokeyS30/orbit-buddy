import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';

async function fixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-usage-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', ...extraEnv } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function register(base) {
  const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple' }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  return body.user.id;
}

test('countToolUseSince counts tool_use events by tool name and time', async (t) => {
  const { app } = await fixture(); t.after(() => app.close());
  const userId = await register(`http://127.0.0.1:${app.server.address().port}`);
  app.db.addEvent(userId, 'tool_use', 'Used web_search ("red sox score").');
  app.db.addEvent(userId, 'tool_use', 'Used web_search ("weather").');
  app.db.addEvent(userId, 'tool_use', 'Used get_datetime.');
  app.db.addEvent(userId, 'chat', 'Orbit replied to a message.');
  assert.equal(app.db.countToolUseSince('web_search', '1970-01-01T00:00:00.000Z'), 2);
  assert.equal(app.db.countToolUseSince('get_datetime', '1970-01-01T00:00:00.000Z'), 1);
  assert.equal(app.db.countToolUseSince('web_search', '2999-01-01T00:00:00.000Z'), 0);
});

test('GET /api/public/usage is public and reports this month web searches', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const userId = await register(base);
  app.db.addEvent(userId, 'tool_use', 'Used web_search ("red sox score").');
  const response = await fetch(`${base}/api/public/usage`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.month, new Date().toISOString().slice(0, 7));
  assert.equal(body.webSearches, 1);
  assert.equal(body.braveConfigured, false);
});

test('GET /api/public/usage reports braveConfigured when the key is set', async (t) => {
  const { app, base } = await fixture({ BRAVE_SEARCH_API_KEY: 'test-key' }); t.after(() => app.close());
  const response = await fetch(`${base}/api/public/usage`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.braveConfigured, true);
  assert.equal(body.webSearches, 0);
});
