import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';
import { hashToken } from '../src/security.js';

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-owner-connectors-'));
  const app = createOrbitServer({
    dataDir: directory,
    env: {
      NODE_ENV: 'test',
      OPENAI_MODEL: 'gpt-6-luna',
      DATA_ENCRYPTION_KEY: 'test-encryption-key-with-32-chars',
      GMAIL_CLIENT_ID: 'test-client',
      GMAIL_CLIENT_SECRET: 'test-secret',
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_AUTH_TOKEN: 'test-token',
      TWILIO_WHATSAPP_NUMBER: '+14155238886'
    }
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function registerOwner(base) {
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple' })
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrf };
}

function memberSession(app) {
  const member = app.db.createUser({ email: 'member@example.com', displayName: 'Member', passwordHash: 'x', passwordSalt: 'y', role: 'member' });
  const token = 'member-owner-connector-token';
  const csrf = 'member-owner-connector-csrf';
  app.db.createSession({ tokenHash: hashToken(token), userId: member.id, csrfToken: csrf, expiresAt: new Date(Date.now() + 3600_000).toISOString(), userAgent: 'test' });
  return { cookie: `orbit_session=${token}`, csrf };
}

const headers = (auth) => ({ Cookie: auth.cookie, 'X-Orbit-CSRF': auth.csrf, 'Content-Type': 'application/json' });

test('Gmail and WhatsApp stay owner-only in status and API routes', async (t) => {
  const { app, base } = await fixture();
  t.after(() => app.close());
  const owner = await registerOwner(base);
  const member = memberSession(app);

  const ownerStatus = await (await fetch(`${base}/api/status`, { headers: headers(owner) })).json();
  assert.ok(ownerStatus.connectors.some((connector) => connector.id === 'gmail'));
  const memberStatus = await (await fetch(`${base}/api/status`, { headers: headers(member) })).json();
  assert.ok(!memberStatus.connectors.some((connector) => connector.id === 'gmail'));

  assert.equal((await fetch(`${base}/api/connectors/gmail/begin`, { method: 'POST', headers: headers(member) })).status, 403);
  assert.equal((await fetch(`${base}/api/connectors/gmail/preview`, { headers: headers(member) })).status, 403);
  assert.equal((await fetch(`${base}/api/connectors/gmail`, { method: 'DELETE', headers: headers(member) })).status, 403);
  assert.equal((await fetch(`${base}/api/writing-voice`, { headers: headers(member) })).status, 403);
  assert.equal((await fetch(`${base}/api/whatsapp/link/status`, { headers: headers(member) })).status, 403);

  const ownerBegin = await fetch(`${base}/api/connectors/gmail/begin`, { method: 'POST', headers: headers(owner) });
  assert.equal(ownerBegin.status, 200);
  assert.match((await ownerBegin.json()).url, /^https:\/\/accounts\.google\.com\//);
});

test('non-owner UI hides Gmail, WhatsApp, and Gmail-derived writing voice controls', () => {
  const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(appJs, /provider\.id==='gmail'&&!isOwner/);
  assert.match(appJs, /if\(isOwner\)renderWhatsAppCard/);
  assert.match(appJs, /writing-voice-panel.*toggle\('hidden',!isOwner\)/);
  assert.match(html, /id="writing-voice-panel"/);
});
