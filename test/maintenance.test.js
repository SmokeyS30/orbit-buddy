import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer, MAINT_BYPASS_TOKEN } from '../server.js';

// The maintenance middleware is OFF by default (MAINTENANCE_MODE = false).
// The UP state is exercised via the MAINTENANCE_MODE='1' env override;
// the rest of the suite runs with NODE_ENV=test which skips it entirely.
async function fixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-maint-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'production', OPENAI_MODEL: 'gpt-6-luna', ...extraEnv } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}
const UP = { MAINTENANCE_MODE: '1' };

test('maintenance mode UP: health endpoints stay 200, everything else gets the 503 page', async (t) => {
  const { app, base } = await fixture(UP); t.after(() => app.close());
  // Health endpoints are untouched (deploy verification needs these).
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, 'orbit-buddy');
  assert.equal((await fetch(`${base}/livez`)).status, 200);
  // Pages, static assets and API routes all serve the maintenance page.
  const home = await fetch(base);
  assert.equal(home.status, 503);
  assert.match(home.headers.get('cache-control') || '', /no-store/);
  const html = await home.text();
  assert.match(html, /Major update in progress/);
  assert.match(html, /http-equiv="refresh" content="300"/);
  assert.match(html, /name="viewport"/);
  assert.equal((await fetch(`${base}/app.js`)).status, 503);
  assert.equal((await fetch(`${base}/api/auth/setup-status`)).status, 503);
});

test('maintenance mode UP: whatsapp webhook returns 503 JSON so Twilio retries', async (t) => {
  const { app, base } = await fixture(UP); t.after(() => app.close());
  const response = await fetch(`${base}/api/whatsapp/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'Body=hello'
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, maintenance: true });
});

test('maintenance mode UP: bypass header or query param serves the site normally', async (t) => {
  assert.equal(MAINT_BYPASS_TOKEN.length, 32);
  const { app, base } = await fixture(UP); t.after(() => app.close());
  const byHeader = await fetch(`${base}/app.js`, { headers: { 'x-maint-bypass': MAINT_BYPASS_TOKEN } });
  assert.equal(byHeader.status, 200);
  const byQuery = await fetch(`${base}/app.js?maint_bypass=${MAINT_BYPASS_TOKEN}`);
  assert.equal(byQuery.status, 200);
  const api = await fetch(`${base}/api/auth/setup-status?maint_bypass=${MAINT_BYPASS_TOKEN}`);
  assert.equal(api.status, 200);
  // Wrong token stays on the maintenance page.
  const wrong = await fetch(`${base}/app.js`, { headers: { 'x-maint-bypass': 'nope' } });
  assert.equal(wrong.status, 503);
});

test('maintenance mode DOWN (forced via env): site serves normally, no maintenance page', async (t) => {
  const { app, base } = await fixture({ MAINTENANCE_MODE: '0' }); t.after(() => app.close());
  const home = await fetch(base);
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.doesNotMatch(html, /Major update in progress/);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});
