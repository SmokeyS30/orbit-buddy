import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-server-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', BUDDY_ACCESS_TOKEN: 'test-token', OPENAI_MODEL: 'gpt-5.4-mini' } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  return { app, base: `http://127.0.0.1:${port}` };
}

test('health is public and API data is protected', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  const response = await fetch(`${base}/api/status`, { headers: { Authorization: 'Bearer test-token' } });
  assert.equal(response.status, 200); assert.equal((await response.json()).modelConfigured, false);
});

test('demo chat stores a safe response', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Help me plan tomorrow' })
  });
  assert.equal(response.status, 201);
  const snapshot = await fetch(`${base}/api/snapshot`, { headers: { Authorization: 'Bearer test-token' } });
  const body = await snapshot.json();
  assert.equal(body.messages.length, 2);
  assert.match(body.messages[1].content, /demo mode/i);
});
