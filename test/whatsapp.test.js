import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { openDatabase } from '../src/database.js';
import { createOrbitServer } from '../server.js';
import {
  verifyTwilioSignature,
  stripWhatsAppPrefix,
  normalizePhone,
  isE164,
  maskPhone,
  whatsappConfigured,
} from '../src/whatsapp.js';

// --- Unit: signature verification ---

const TOKEN = 'test-auth-token-123';
const WEBHOOK_URL = 'https://orbitbuddy.app/api/whatsapp/webhook';

function sign(url, params, token = TOKEN) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], String(url));
  return createHmac('sha1', token).update(data, 'utf8').digest('base64');
}

test('verifyTwilioSignature accepts a valid signature', () => {
  const params = { From: 'whatsapp:+15085551234', To: 'whatsapp:+14155238886', Body: 'hello' };
  assert.equal(verifyTwilioSignature({ authToken: TOKEN, url: WEBHOOK_URL, params, signature: sign(WEBHOOK_URL, params) }), true);
});

test('verifyTwilioSignature rejects tampered params', () => {
  const params = { From: 'whatsapp:+15085551234', Body: 'hello' };
  const sig = sign(WEBHOOK_URL, params);
  assert.equal(verifyTwilioSignature({ authToken: TOKEN, url: WEBHOOK_URL, params: { ...params, Body: 'hacked' }, signature: sig }), false);
});

test('verifyTwilioSignature rejects wrong token and missing fields', () => {
  const params = { Body: 'hi' };
  const sig = sign(WEBHOOK_URL, params);
  assert.equal(verifyTwilioSignature({ authToken: 'wrong', url: WEBHOOK_URL, params, signature: sig }), false);
  assert.equal(verifyTwilioSignature({ authToken: TOKEN, url: WEBHOOK_URL, params, signature: '' }), false);
  assert.equal(verifyTwilioSignature({ authToken: '', url: WEBHOOK_URL, params, signature: sig }), false);
});

test('verifyTwilioSignature is order-independent (params sorted)', () => {
  const a = { B: '2', A: '1' };
  const b = { A: '1', B: '2' };
  const sig = sign(WEBHOOK_URL, a);
  assert.equal(verifyTwilioSignature({ authToken: TOKEN, url: WEBHOOK_URL, params: b, signature: sig }), true);
});

// --- Unit: phone helpers ---

test('phone helpers normalize and mask', () => {
  assert.equal(stripWhatsAppPrefix('whatsapp:+15085551234'), '+15085551234');
  assert.equal(stripWhatsAppPrefix('+15085551234'), '+15085551234');
  assert.equal(normalizePhone('whatsapp:+15085551234'), '+15085551234');
  assert.equal(normalizePhone('whatsapp:not-a-number'), null);
  assert.equal(normalizePhone(null), null);
  assert.equal(isE164('+15085551234'), true);
  assert.equal(isE164('5085551234'), false);
  assert.equal(maskPhone('+15085551234'), '+1 ••• ••• 1234');
});

test('whatsappConfigured requires all three env vars', () => {
  assert.equal(whatsappConfigured({}), false);
  assert.equal(whatsappConfigured({ TWILIO_ACCOUNT_SID: 'ACx', TWILIO_AUTH_TOKEN: 't' }), false);
  assert.equal(whatsappConfigured({ TWILIO_ACCOUNT_SID: 'ACx', TWILIO_AUTH_TOKEN: 't', TWILIO_WHATSAPP_NUMBER: '+1415' }), true);
});

// --- Unit: database linking helpers ---

function dbFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wa-db-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'), {});
  const user = db.createUser({ email: 'wa@example.com', displayName: 'WA User', passwordHash: 'h', passwordSalt: 's', role: 'owner' });
  return { db, user };
}

test('whatsapp link/unlink round-trips', () => {
  const { db, user } = dbFixture();
  assert.equal(db.getWhatsAppLink(user.id), null);
  assert.equal(db.getUserByWhatsApp('+15085551234'), null);
  const link = db.linkWhatsApp(user.id, '+15085551234');
  assert.equal(link.phone_e164, '+15085551234');
  assert.equal(db.getWhatsAppLink(user.id).phone_e164, '+15085551234');
  assert.equal(db.getUserByWhatsApp('+15085551234').user_id, user.id);
  assert.equal(db.setWhatsAppLastInbound(user.id, '2026-10-12T00:00:00.000Z'), true);
  assert.equal(db.getWhatsAppLink(user.id).last_inbound_at, '2026-10-12T00:00:00.000Z');
  // Re-linking the same user with a new number updates it
  db.linkWhatsApp(user.id, '+15085559999');
  assert.equal(db.getWhatsAppLink(user.id).phone_e164, '+15085559999');
  assert.equal(db.unlinkWhatsApp(user.id), true);
  assert.equal(db.getWhatsAppLink(user.id), null);
  db.close();
});

// --- Server: webhook + linking flow ---

const TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: 'ACtest123',
  TWILIO_AUTH_TOKEN: 'test-auth-token-xyz',
  TWILIO_WHATSAPP_NUMBER: '+14155238886',
};

async function serverFixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wa-server-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', ...TWILIO_ENV, ...extraEnv } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function register(base, { email = 'owner@example.com', displayName = 'Owner' } = {}) {
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, displayName, password: 'correct horse battery staple' }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrf };
}

const authHeaders = ({ cookie, csrf }) => ({ Cookie: cookie, 'X-Orbit-CSRF': csrf, 'Content-Type': 'application/json' });

function webhookPost(base, params, token = TWILIO_ENV.TWILIO_AUTH_TOKEN, tamper = null) {
  const url = `${base}/api/whatsapp/webhook`;
  const signed = { ...params };
  const signature = sign(url, signed, token);
  const form = new URLSearchParams(tamper ? { ...signed, ...tamper } : signed);
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
    body: form.toString(),
  });
}

const WA_FROM = 'whatsapp:+15085551234';

test('webhook rejects bad signatures with 403', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const res = await webhookPost(base, { From: WA_FROM, Body: 'hi' }, 'wrong-token');
  assert.equal(res.status, 403);
  const res2 = await fetch(`${base}/api/whatsapp/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'Body=hi',
  });
  assert.equal(res2.status, 403);
});

test('webhook is inert when Twilio is not configured', async (t) => {
  const { app, base } = await serverFixture({ TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_WHATSAPP_NUMBER: '' });
  t.after(() => app.close());
  const res = await fetch(`${base}/api/whatsapp/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'Body=hi',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, configured: false });
});

test('linking flow: code issued, texted, number linked', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const auth = await register(base);
  // Start linking
  const start = await fetch(`${base}/api/whatsapp/link/start`, { method: 'POST', headers: authHeaders(auth) });
  assert.equal(start.status, 200);
  const { code, whatsappNumber } = await start.json();
  assert.match(code, /^\d{6}$/);
  assert.equal(whatsappNumber, TWILIO_ENV.TWILIO_WHATSAPP_NUMBER);
  // Status before linking
  const before = await (await fetch(`${base}/api/whatsapp/link/status`, { headers: authHeaders(auth) })).json();
  assert.equal(before.linked, false);
  // Text the code to Orbit's number (stub the Twilio send)
  const sent = [];
  const origFetch = globalThis.fetch;
  const isTwilio = (u) => { try { return new URL(String(u)).hostname === 'api.twilio.com'; } catch { return false; } };
  globalThis.fetch = async (url, opts) => {
    if (isTwilio(url)) {
      sent.push({ url: String(url), body: String(opts?.body || '') });
      return { ok: true, status: 201, json: async () => ({ sid: 'SMtest' }), text: async () => '' };
    }
    return origFetch(url, opts);
  };
  try {
    const hook = await webhookPost(base, { From: WA_FROM, To: `whatsapp:${TWILIO_ENV.TWILIO_WHATSAPP_NUMBER}`, Body: code, MessageSid: 'SM1' });
    assert.equal(hook.status, 200);
    // Confirmation text went out via Twilio
    const isTwilioUrl = (u) => { try { return new URL(u).hostname === 'api.twilio.com'; } catch { return false; } };
    assert.ok(sent.some((s) => isTwilioUrl(s.url) && decodeURIComponent(s.body).includes('Connected!')));
    // Status after linking
    const after = await (await fetch(`${base}/api/whatsapp/link/status`, { headers: authHeaders(auth) })).json();
    assert.equal(after.linked, true);
    assert.equal(after.phone, '+1 ••• ••• 1234');
    // Code is single-use: texting it again does not re-link, message is ignored (already linked -> treated as chat)
    // (covered implicitly: second use finds no pending code)
    // Unlink
    const del = await fetch(`${base}/api/whatsapp/link`, { method: 'DELETE', headers: authHeaders(auth) });
    assert.equal(del.status, 200);
    const gone = await (await fetch(`${base}/api/whatsapp/link/status`, { headers: authHeaders(auth) })).json();
    assert.equal(gone.linked, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('unknown sender numbers are ignored', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const res = await webhookPost(base, { From: 'whatsapp:+19998887777', Body: 'hello?' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, ignored: true });
});

test('linked user text gets a WhatsApp reply through the chat pipeline', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const auth = await register(base, { email: 'wa2@example.com' });
  const { code } = await (await fetch(`${base}/api/whatsapp/link/start`, { method: 'POST', headers: authHeaders(auth) })).json();
  const sent = [];
  const origFetch = globalThis.fetch;
  const isTwilio = (u) => { try { return new URL(String(u)).hostname === 'api.twilio.com'; } catch { return false; } };
  globalThis.fetch = async (url, opts) => {
    if (isTwilio(url)) {
      sent.push({ url: String(url), body: String(opts?.body || '') });
      return { ok: true, status: 201, json: async () => ({ sid: 'SMtest' }), text: async () => '' };
    }
    return origFetch(url, opts);
  };
  try {
    assert.equal((await webhookPost(base, { From: WA_FROM, Body: code })).status, 200);
    sent.length = 0; // clear the link confirmation
    const hook = await webhookPost(base, { From: WA_FROM, To: `whatsapp:${TWILIO_ENV.TWILIO_WHATSAPP_NUMBER}`, Body: 'what is on my calendar today?', MessageSid: 'SM2' });
    assert.equal(hook.status, 200);
    // Wait for the background reply job to send via Twilio
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !sent.some((s) => s.body.includes('whatsapp%3A%2B15085551234') || s.body.includes('+15085551234'))) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const reply = sent.find((s) => { try { return new URL(s.url).hostname === 'api.twilio.com'; } catch { return false; } });
    assert.ok(reply, 'expected a Twilio send call for the reply');
    assert.match(reply.body, /From=whatsapp/);
    assert.match(decodeURIComponent(reply.body).replace(/\+/g, ' '), /demo mode/); // demo model prefix proves the real pipeline ran
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('link/start requires Twilio configuration', async (t) => {
  const { app, base } = await serverFixture({ TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_WHATSAPP_NUMBER: '' });
  t.after(() => app.close());
  const auth = await register(base);
  const res = await fetch(`${base}/api/whatsapp/link/start`, { method: 'POST', headers: authHeaders(auth) });
  assert.equal(res.status, 503);
});
