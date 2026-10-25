import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { openDatabase } from '../src/database.js';
import { hashToken } from '../src/security.js';
import { createOrbitServer } from '../server.js';
import {
  verifyTwilioSignature,
  stripWhatsAppPrefix,
  normalizePhone,
  isE164,
  maskPhone,
  whatsappConfigured,
  buildLinkDeepLink,
  isAudioContentType,
  parseWhatsAppLocation,
  formatLocationMessage,
  LOCATION_STORED_MESSAGE,
  WHATSAPP_IMAGE_STORED_MESSAGE,
  MAX_TWILIO_MEDIA_BYTES,
  downloadTwilioMedia,
  transcribeVoiceNote,
  WHISPER_ENDPOINT,
  isWindowOpen,
  WHATSAPP_MESSAGE_WINDOW_MS,
} from '../src/whatsapp.js';

// --- Unit: signature verification ---

const TOKEN = 'test-auth-token-123';
const WEBHOOK_URL = 'https://orbitbuddy.app/api/whatsapp/webhook';
const MEDIA_ACCOUNT_SID = `AC${'a'.repeat(32)}`;
const mediaMessageSid = (digit) => `SM${digit.repeat(32)}`;
const mediaUrl = (messageSid, digit = 'f') =>
  `https://api.twilio.com/2010-04-01/Accounts/${MEDIA_ACCOUNT_SID}/Messages/${messageSid}/Media/ME${digit.repeat(32)}`;
const UNIT_MEDIA_URL = mediaUrl(mediaMessageSid('1'));

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

test('buildLinkDeepLink produces a wa.me link with the code pre-filled', () => {
  assert.equal(buildLinkDeepLink('+15089074074', '482913'), 'https://wa.me/15089074074?text=482913');
  assert.equal(buildLinkDeepLink('whatsapp:+15089074074', '482913'), 'https://wa.me/15089074074?text=482913');
  assert.match(buildLinkDeepLink('+14155238886', '123456'), /^https:\/\/wa\.me\/14155238886\?text=123456$/);
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
  TWILIO_ACCOUNT_SID: MEDIA_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: 'test-auth-token-xyz',
  TWILIO_WHATSAPP_NUMBER: '+14155238886',
};

async function serverFixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wa-server-'));
  const env = { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', ...TWILIO_ENV, ...extraEnv };
  const app = createOrbitServer({ dataDir: directory, env });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}`, env };
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
  const { code, whatsappNumber, deepLink } = await start.json();
  assert.match(code, /^\d{6}$/);
  assert.equal(whatsappNumber, TWILIO_ENV.TWILIO_WHATSAPP_NUMBER);
  const digits = TWILIO_ENV.TWILIO_WHATSAPP_NUMBER.replace(/\D/g, '');
  assert.match(deepLink, /^https:\/\/wa\.me\/\d+\?text=\d{6}$/);
  assert.equal(deepLink, `https://wa.me/${digits}?text=${code}`);
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

test('paused WhatsApp webhook asks for redelivery without burning the SID', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  await linkOwnerDirectly(app,base,'owner-pause@example.test');
  const sent=[];const restore=stubTwilio(sent);t.after(restore);
  const params={From:WA_FROM,Body:'hello after pause',MessageSid:'SMpause-synthetic'};
  app.db.setSetting('system_paused','true');
  const paused=await webhookPost(base,params);
  assert.equal(paused.status,503);
  assert.equal(app.db.getWhatsAppInboundState(params.MessageSid),null);
  app.db.setSetting('system_paused','false');
  const accepted=await webhookPost(base,params);
  assert.equal(accepted.status,200);
  assert.equal(app.db.getWhatsAppInboundState(params.MessageSid),'accepted');
});

test('a pending link code from an already-linked phone is consumed without model egress', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const { userId } = await linkOwnerDirectly(app,base,'owner-relink@example.test');
  const sent=[];const restore=stubTwilio(sent);t.after(restore);
  const code='443322';
  app.db.issueWhatsAppLinkCode(userId,code,new Date(Date.now()+60_000).toISOString());
  const before=userMessages(app,userId).length;
  const result=await webhookPost(base,{From:WA_FROM,Body:code,MessageSid:'SMrelink'});
  assert.equal(result.status,200);
  assert.equal(app.db.getSetting(`whatsapp_link_code_${code}`),null);
  assert.equal(userMessages(app,userId).length,before,'link secret never enters chat history');
});

test('deferred WhatsApp replies stay bound to the accepting link and enabled account', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const { userId } = await linkOwnerDirectly(app, base);
  const sent = []; const restore = stubTwilio(sent); t.after(restore);
  const conversation = app.db.ensureDefaultConversation(userId);
  const queueCompleted = (content) => {
    const link = app.db.getWhatsAppLink(userId);
    const accepted = app.db.acceptReplyJob(userId, conversation.id, content, {
      channel: 'whatsapp', deliveryToPhone: link.phone_e164, deliveryLinkVerifiedAt: link.verified_at
    });
    const claimed = app.db.claimNextReplyJob('test');
    assert.equal(claimed.id, accepted.job.id);
    assert.ok(app.db.completeReplyJob(claimed.id, claimed.lease_token, `Reply to ${content}`));
    return accepted.job.id;
  };
  const flush = async (id) => {
    await app.runReplyJobs();
    const deadline = Date.now() + 3000;
    while (!app.db.getReplyJob(id).delivery_attempted_at && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(app.db.getReplyJob(id).delivery_attempted_at);
  };
  const relinked = queueCompleted('before relink');
  app.db.linkWhatsApp(userId, '+15085559999');
  await flush(relinked);
  assert.equal(sent.length, 0, 'no reply goes to a replacement number');
  const unlinked = queueCompleted('before unlink');
  app.db.unlinkWhatsApp(userId);
  await flush(unlinked);
  assert.equal(sent.length, 0, 'no reply goes out after unlink');
  app.db.linkWhatsApp(userId, '+15085551234');
  const disabled = queueCompleted('before disable');
  app.db.setUserDisabled(userId, true);
  await flush(disabled);
  assert.equal(sent.length, 0, 'no reply goes out after account disable');
});

test('link/start requires Twilio configuration', async (t) => {
  const { app, base } = await serverFixture({ TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_WHATSAPP_NUMBER: '' });
  t.after(() => app.close());
  const auth = await register(base);
  const res = await fetch(`${base}/api/whatsapp/link/start`, { method: 'POST', headers: authHeaders(auth) });
  assert.equal(res.status, 503);
});

// Create a member user directly in the DB (registration closes after the first
// user) and insert a session row directly to simulate a logged-in member.
async function loginAsMember(app, base, suffix) {
  const email = `member-${suffix}@example.com`;
  app.db.createUser({ email, displayName: 'Member', passwordHash: 'x', passwordSalt: 'y', role: 'member' });
  const user = app.db.getUserByEmail(email);
  const token = `tok-${suffix}-${Date.now()}`;
  const csrf = `csrf-${suffix}`;
  app.db.createSession({ tokenHash: hashToken(token), userId: user.id, csrfToken: csrf, expiresAt: new Date(Date.now() + 3600_000).toISOString(), userAgent: 'test' });
  return { cookie: `orbit_session=${token}`, csrf };
}

test('WhatsApp linking is owner-only: member gets 403 on link endpoints', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  await register(base, { email: 'owner2@example.com', displayName: 'Owner' }); // first user -> owner
  const memberAuth = await loginAsMember(app, base, 't1');
  const memberHeaders = authHeaders(memberAuth);
  const start = await fetch(`${base}/api/whatsapp/link/start`, { method: 'POST', headers: memberHeaders });
  assert.equal(start.status, 403);
  const status = await fetch(`${base}/api/whatsapp/link/status`, { headers: memberHeaders });
  assert.equal(status.status, 403);
  const del = await fetch(`${base}/api/whatsapp/link`, { method: 'DELETE', headers: memberHeaders });
  assert.equal(del.status, 403);
});

test('webhook ignores a linking code bound to a non-owner account', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  await register(base, { email: 'owner3@example.com', displayName: 'Owner' });
  await loginAsMember(app, base, 't2');
  const memberId = app.db.listUsers().find((u) => u.role === 'member').id;
  // Plant a code bound to the member's userId (as if issued before the owner gate)
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  app.db.setSetting('whatsapp_link_code_999888', `${memberId}:${expiresAt}`);
  const sent = [];
  const origFetch = globalThis.fetch;
  const isTwilio = (u) => { try { return new URL(String(u)).hostname === 'api.twilio.com'; } catch { return false; } };
  globalThis.fetch = async (url, opts) => {
    if (isTwilio(url)) { sent.push(String(url)); return { ok: true, status: 201, json: async () => ({ sid: 'SMx' }), text: async () => '' }; }
    return origFetch(url, opts);
  };
  try {
    const hook = await webhookPost(base, { From: WA_FROM, To: `whatsapp:${TWILIO_ENV.TWILIO_WHATSAPP_NUMBER}`, Body: '999888', MessageSid: 'SM9' });
    assert.equal(hook.status, 200);
    assert.equal(app.db.getWhatsAppLink(memberId), null); // not linked
    assert.ok(!sent.length, 'no confirmation text should be sent for a non-owner code');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// --- Phase 2: location shares + voice notes ---

test('parseWhatsAppLocation parses and range-checks coordinates', () => {
  assert.deepEqual(parseWhatsAppLocation({ Latitude: '41.7210', Longitude: '-70.0830' }), { lat: '41.7210', lng: '-70.0830' });
  assert.deepEqual(parseWhatsAppLocation({ Latitude: '41.72104', Longitude: '-70.08304' }), { lat: '41.7210', lng: '-70.0830' });
  assert.equal(parseWhatsAppLocation({}), null);
  assert.equal(parseWhatsAppLocation({ Latitude: 'abc', Longitude: '-70.08' }), null);
  assert.equal(parseWhatsAppLocation({ Latitude: '41.72' }), null);
  assert.equal(parseWhatsAppLocation({ Latitude: '91', Longitude: '0' }), null); // lat out of range
  assert.equal(parseWhatsAppLocation({ Latitude: '0', Longitude: '181' }), null); // lng out of range
  assert.equal(parseWhatsAppLocation(null), null);
});

test('formatLocationMessage builds the pipeline message text', () => {
  assert.equal(formatLocationMessage({ lat: '41.7210', lng: '-70.0830' }), '[Shared location: 41.7210, -70.0830]');
  assert.equal(formatLocationMessage({ lat: '41.7210', lng: '-70.0830' }, 'Home'), '[Shared location: 41.7210, -70.0830] Home');
  assert.equal(formatLocationMessage({ lat: '41.7210', lng: '-70.0830' }, '  '), '[Shared location: 41.7210, -70.0830]');
  // The stored redaction must never contain coordinates (no digits at all)
  assert.equal(LOCATION_STORED_MESSAGE, '[Shared location]');
  assert.ok(!/\d/.test(LOCATION_STORED_MESSAGE));
});

test('isAudioContentType detects voice-note media', () => {
  assert.equal(isAudioContentType('audio/ogg'), true);
  assert.equal(isAudioContentType('audio/ogg;codecs=opus'), true);
  assert.equal(isAudioContentType('image/jpeg'), false);
  assert.equal(isAudioContentType(''), false);
  assert.equal(isAudioContentType(null), false);
});

// --- downloadTwilioMedia unit tests ---

function mediaResponse(bytes, { status = 200, contentLength, contentType = 'audio/ogg' } = {}) {
  const buf = Buffer.from(bytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => {
        const n = String(name).toLowerCase();
        if (n === 'content-length') return contentLength === undefined ? String(buf.length) : contentLength;
        if (n === 'content-type') return contentType;
        return null;
      },
    },
    body: (async function* () { yield buf; })(),
    text: async () => '',
  };
}

async function withFetchStub(stub, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

test('downloadTwilioMedia sends Basic auth and returns bytes', async () => {
  const calls = [];
  const { bytes, contentType } = await withFetchStub(async (url, opts) => {
    calls.push({ url: String(url), auth: opts.headers.Authorization });
    return mediaResponse([1, 2, 3, 4]);
  }, () => downloadTwilioMedia({ accountSid: MEDIA_ACCOUNT_SID, authToken: 'tok', url: UNIT_MEDIA_URL }));
  assert.equal(bytes.length, 4);
  assert.equal(contentType, 'audio/ogg');
  assert.equal(calls[0].url, UNIT_MEDIA_URL);
  assert.equal(calls[0].auth, `Basic ${Buffer.from(`${MEDIA_ACCOUNT_SID}:tok`, 'utf8').toString('base64')}`);
});

test('downloadTwilioMedia rejects oversized media via Content-Length and streaming', async () => {
  // Declared size over the cap: rejected without reading the body
  await assert.rejects(
    withFetchStub(async () => mediaResponse([1], { contentLength: String(MAX_TWILIO_MEDIA_BYTES + 1) }),
      () => downloadTwilioMedia({ accountSid: MEDIA_ACCOUNT_SID, authToken: 'tok', url: UNIT_MEDIA_URL })),
    (e) => e.code === 'MEDIA_TOO_LARGE'
  );
  // No declared size but the stream exceeds the cap: rejected mid-read
  await assert.rejects(
    withFetchStub(async () => ({
      ...mediaResponse([1], { contentLength: null }),
      body: (async function* () { yield Buffer.alloc(MAX_TWILIO_MEDIA_BYTES + 1); })(),
    }), () => downloadTwilioMedia({ accountSid: MEDIA_ACCOUNT_SID, authToken: 'tok', url: UNIT_MEDIA_URL, maxBytes: 100 })),
    (e) => e.code === 'MEDIA_TOO_LARGE'
  );
});

test('downloadTwilioMedia throws on HTTP errors and missing URL', async () => {
  await assert.rejects(
    withFetchStub(async () => mediaResponse([], { status: 401 }), () => downloadTwilioMedia({ accountSid: MEDIA_ACCOUNT_SID, authToken: 'tok', url: UNIT_MEDIA_URL })),
    /401/
  );
  await assert.rejects(downloadTwilioMedia({ accountSid: 'ACx', authToken: 'tok', url: '' }), /No media URL/);
});

// --- transcribeVoiceNote unit tests ---

test('transcribeVoiceNote posts to Whisper and returns trimmed text', async () => {
  const calls = [];
  const text = await withFetchStub(async (url, opts) => {
    calls.push({ url: String(url), opts });
    return { ok: true, status: 200, json: async () => ({ text: '  buy oat milk  ' }), text: async () => '' };
  }, () => transcribeVoiceNote({ apiKey: 'sk-test', audioBytes: Buffer.from([10, 20, 30]), mimeType: 'audio/ogg' }));
  assert.equal(text, 'buy oat milk');
  assert.equal(calls[0].url, WHISPER_ENDPOINT);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer sk-test');
  const form = calls[0].opts.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('model'), 'whisper-1');
  const file = form.get('file');
  assert.equal(file.name, 'voice-note.ogg');
  assert.equal(file.type, 'audio/ogg');
});

test('transcribeVoiceNote rejects missing key, empty audio, and API errors', async () => {
  await assert.rejects(transcribeVoiceNote({ apiKey: '', audioBytes: Buffer.from([1]) }), /not configured/);
  await assert.rejects(transcribeVoiceNote({ apiKey: 'sk', audioBytes: Buffer.alloc(0) }), /Empty audio/);
  await assert.rejects(
    withFetchStub(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' }),
      () => transcribeVoiceNote({ apiKey: 'sk', audioBytes: Buffer.from([1]) })),
    /500/
  );
});

// --- Server: Phase 2 webhook branches ---

async function linkOwnerDirectly(app, base, email = 'owner@example.com') {
  const auth = await register(base, { email });
  const user = app.db.getUserByEmail(email);
  app.db.linkWhatsApp(user.id, '+15085551234');
  return { auth, userId: user.id };
}

function userMessages(app, userId) {
  const convo = app.db.ensureDefaultConversation(userId);
  return app.db.listConversationMessages(userId, convo.id, 24);
}

async function waitForTwilioReply(sent, isTwilio, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !sent.some((s) => isTwilio(s.url) && s.body.includes('15085551234'))) {
    await new Promise((r) => setTimeout(r, 200));
  }
  return sent.find((s) => isTwilio(s.url));
}

test('webhook: location share runs the pipeline with coordinates redacted in storage', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const { userId } = await linkOwnerDirectly(app, base);
  const sent = [];
  const origFetch = globalThis.fetch;
  const isTwilio = (u) => { try { return new URL(String(u)).hostname === 'api.twilio.com'; } catch { return false; } };
  globalThis.fetch = async (url, opts) => {
    if (isTwilio(url)) { sent.push({ url: String(url), body: String(opts?.body || '') }); return { ok: true, status: 201, json: async () => ({ sid: 'SMx' }), text: async () => '' }; }
    return origFetch(url, opts);
  };
  try {
    const hook = await webhookPost(base, {
      From: WA_FROM, To: `whatsapp:${TWILIO_ENV.TWILIO_WHATSAPP_NUMBER}`,
      Latitude: '41.7210', Longitude: '-70.0830', Body: '', MessageSid: 'SMloc',
    });
    assert.equal(hook.status, 200);
    assert.deepEqual(await hook.json(), { ok: true, location: true });
    // Stored history row is redacted: no raw coordinates anywhere
    const msgs = userMessages(app, userId).filter((m) => m.role === 'user');
    assert.ok(msgs.length >= 1);
    const stored = String(msgs[msgs.length - 1].content);
    assert.equal(stored, LOCATION_STORED_MESSAGE);
    assert.ok(!stored.includes('41.7210') && !stored.includes('-70.0830'), 'coordinates must not be stored');
    // The pipeline ran and replied
    const reply = await waitForTwilioReply(sent, isTwilio);
    assert.ok(reply, 'expected a Twilio reply for the location share');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('webhook: invalid location fields fall through to the text path', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  await linkOwnerDirectly(app, base, 'owner-loc2@example.com');
  const hook = await webhookPost(base, {
    From: WA_FROM, To: `whatsapp:${TWILIO_ENV.TWILIO_WHATSAPP_NUMBER}`,
    Latitude: 'not-a-number', Longitude: '0', Body: '', MessageSid: 'SMloc2',
  });
  assert.equal(hook.status, 200);
  assert.deepEqual(await hook.json(), { ok: true }); // empty body, no media: nothing to do
});

test('webhook: voice note is downloaded, transcribed, and fed to the pipeline', async (t) => {
  const { app, base, env } = await serverFixture(); t.after(() => app.close());
  env.OPENAI_API_KEY = 'test-whisper-key'; // read live by the handler; model client stays in demo mode
  const { userId } = await linkOwnerDirectly(app, base, 'owner-voice@example.com');
  const sent = [];
  let whisperCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = (() => { try { return new URL(String(url)); } catch { return null; } })();
    if (u?.hostname === 'api.twilio.com' && u.pathname.includes('/Media/')) return mediaResponse([5, 6, 7, 8]);
    if (u?.hostname === 'api.twilio.com') { sent.push({ url: String(url), body: String(opts?.body || '') }); return { ok: true, status: 201, json: async () => ({ sid: 'SMx' }), text: async () => '' }; }
    if (u?.hostname === 'api.openai.com') { whisperCalls++; return { ok: true, status: 200, json: async () => ({ text: 'buy oat milk' }), text: async () => '' }; }
    return origFetch(url, opts);
  };
  try {
    const hook = await webhookPost(base, {
      From: WA_FROM, To: `whatsapp:${TWILIO_ENV.TWILIO_WHATSAPP_NUMBER}`,
      NumMedia: '1', MediaContentType0: 'audio/ogg',
      MediaUrl0: mediaUrl(mediaMessageSid('2'),'a'),
      Body: '', MessageSid: mediaMessageSid('2'),
    });
    assert.equal(hook.status, 200);
    assert.deepEqual(await hook.json(), { ok: true, voiceNote: true });
    assert.equal(whisperCalls, 1);
    // Transcript is stored with the required prefix, feeding the normal pipeline
    const msgs = userMessages(app, userId).filter((m) => m.role === 'user');
    assert.ok(msgs.length >= 1);
    assert.equal(String(msgs[msgs.length - 1].content), '[Voice note transcript]: "buy oat milk"');
    const reply = await waitForTwilioReply(sent, (u) => { try { return new URL(String(u)).hostname === 'api.twilio.com'; } catch { return false; } });
    assert.ok(reply, 'expected a Twilio reply for the voice note');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('webhook: oversized voice note gets the "bit long" reply and is not transcribed', async (t) => {
  const { app, base, env } = await serverFixture(); t.after(() => app.close());
  env.OPENAI_API_KEY = 'test-whisper-key';
  await linkOwnerDirectly(app, base, 'owner-voice2@example.com');
  const sent = [];
  let whisperCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = (() => { try { return new URL(String(url)); } catch { return null; } })();
    if (u?.hostname === 'api.twilio.com' && u.pathname.includes('/Media/')) return mediaResponse([1], { contentLength: String(MAX_TWILIO_MEDIA_BYTES + 1) });
    if (u?.hostname === 'api.twilio.com') { sent.push({ url: String(url), body: String(opts?.body || '') }); return { ok: true, status: 201, json: async () => ({ sid: 'SMx' }), text: async () => '' }; }
    if (u?.hostname === 'api.openai.com') { whisperCalls++; return { ok: true, status: 200, json: async () => ({ text: 'x' }), text: async () => '' }; }
    return origFetch(url, opts);
  };
  try {
    const hook = await webhookPost(base, {
      From: WA_FROM, To: `whatsapp:${TWILIO_ENV.TWILIO_WHATSAPP_NUMBER}`,
      NumMedia: '1', MediaContentType0: 'audio/ogg',
      MediaUrl0: mediaUrl(mediaMessageSid('3'),'b'),
      Body: '', MessageSid: mediaMessageSid('3'),
    });
    assert.equal(hook.status, 200);
    assert.deepEqual(await hook.json(), { ok: true, voiceNote: false });
    assert.equal(whisperCalls, 0, 'transcription must not be attempted for oversized audio');
    assert.ok(sent.some((s) => decodeURIComponent(s.body).replace(/\+/g, ' ').includes('a bit long')), 'expected the polite too-long reply');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('webhook: inbound image is downloaded and fed through the vision pipeline', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const { userId } = await linkOwnerDirectly(app, base, 'owner-img@example.com');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const sent = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = (() => { try { return new URL(String(url)); } catch { return null; } })();
    if (u?.hostname === 'api.twilio.com' && u.pathname.includes('/Media/')) return mediaResponse(png, { contentType: 'image/png' });
    if (u?.hostname === 'api.twilio.com') { sent.push({ url: String(url), body: String(opts?.body || '') }); return { ok: true, status: 201, json: async () => ({ sid: 'SMx' }), text: async () => '' }; }
    return origFetch(url, opts);
  };
  try {
    const hook = await webhookPost(base, {
      From: WA_FROM, To: `whatsapp:${TWILIO_ENV.TWILIO_WHATSAPP_NUMBER}`,
      NumMedia: '1', MediaContentType0: 'image/jpeg',
      MediaUrl0: mediaUrl(mediaMessageSid('4'),'c'),
      Body: 'look at this', MessageSid: mediaMessageSid('4'),
    });
    assert.equal(hook.status, 200);
    assert.deepEqual(await hook.json(), { ok: true, image: true });
    // Stored history keeps the text placeholder — bytes are never persisted
    const msgs = userMessages(app, userId).filter((m) => m.role === 'user');
    assert.equal(String(msgs[msgs.length - 1].content), WHATSAPP_IMAGE_STORED_MESSAGE);
    // The queued reply job runs the model pipeline (demo mode here) and replies via Twilio
    const reply = await waitForTwilioReply(sent, (u) => { try { return new URL(String(u)).hostname === 'api.twilio.com'; } catch { return false; } });
    assert.ok(reply, 'expected a Twilio reply for the image');
    assert.ok(decodeForm(reply.body).includes('demo mode'), 'demo-mode pipeline answered the image turn');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('webhook: transient image download failure permits a retry when provider HTTP retries are configured', async (t) => {
  const { app, base } = await serverFixture({TWILIO_WEBHOOK_RETRIES_HTTP_ERRORS:'1'}); t.after(() => app.close());
  const { userId } = await linkOwnerDirectly(app, base, 'owner-img2@example.com');
  const sent = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  let mediaCalls=0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = (() => { try { return new URL(String(url)); } catch { return null; } })();
    if (u?.hostname === 'api.twilio.com' && u.pathname.includes('/Media/')) {
      mediaCalls++;
      return mediaCalls===1
        ?{ ok: false, status: 500, headers: { get: () => null }, text: async () => 'boom' }
        :mediaResponse(png,{contentType:'image/png'});
    }
    if (u?.hostname === 'api.twilio.com') { sent.push(String(opts?.body || '')); return { ok: true, status: 201, json: async () => ({ sid: 'SMx' }), text: async () => '' }; }
    return origFetch(url, opts);
  };
  try {
    const params = {
      From: WA_FROM, To: `whatsapp:${TWILIO_ENV.TWILIO_WHATSAPP_NUMBER}`,
      NumMedia: '1', MediaContentType0: 'image/png',
      MediaUrl0: mediaUrl(mediaMessageSid('5'),'d'),
      Body: '', MessageSid: mediaMessageSid('5'),
    };
    const hook = await webhookPost(base, params);
    assert.equal(hook.status, 503);
    assert.deepEqual(await hook.json(), { ok: false, retry: true });
    assert.equal(sent.length,0,'transient failure does not send duplicate failure replies');
    const msgs = userMessages(app, userId).filter((m) => m.role === 'user');
    assert.ok(!msgs.some((m) => m.content === WHATSAPP_IMAGE_STORED_MESSAGE), 'no image message stored on download failure');
    const retry=await webhookPost(base,params);
    assert.equal(retry.status,200);
    assert.deepEqual(await retry.json(),{ok:true,image:true});
    const duplicate=await webhookPost(base,params);
    assert.deepEqual(await duplicate.json(),{ok:true,deduped:true});
    assert.equal(mediaCalls,2,'accepted image is not downloaded again');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('default media failure gives a resend reply because Twilio HTTP retries are unverified', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  await linkOwnerDirectly(app,base,'owner-media-default@example.com');
  const sent=[];
  const origFetch=globalThis.fetch;
  globalThis.fetch=async (url,opts)=>{
    const parsed=(()=>{try{return new URL(String(url));}catch{return null;}})();
    if(parsed?.hostname==='api.twilio.com'&&parsed.pathname.includes('/Media/'))
      return {ok:false,status:500,headers:{get:()=>null},text:async()=>''};
    if(parsed?.hostname==='api.twilio.com'){
      sent.push(String(opts?.body||''));
      return {ok:true,status:201,json:async()=>({sid:'SMsynthetic'}),text:async()=>''};
    }
    return origFetch(url,opts);
  };
  try{
    const sid=mediaMessageSid('7');
    const params={From:WA_FROM,Body:'',NumMedia:'1',MediaContentType0:'image/png',
      MediaUrl0:mediaUrl(sid,'7'),MessageSid:sid};
    const response=await webhookPost(base,params);
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{ok:true,image:false});
    assert.ok(sent.some(body=>decodeForm(body).includes('mind sending it again')));
    assert.equal(app.db.getWhatsAppInboundState(sid),'failed');
    const replay=await webhookPost(base,params);
    assert.deepEqual(await replay.json(),{ok:true,deduped:true});
  }finally{globalThis.fetch=origFetch;}
});

test('webhook: non-image media gets the unsupported-type reply', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  await linkOwnerDirectly(app, base, 'owner-vid@example.com');
  const sent = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    try { if (new URL(String(url)).hostname === 'api.twilio.com') { sent.push(String(opts?.body || '')); return { ok: true, status: 201, json: async () => ({ sid: 'SMx' }), text: async () => '' }; } } catch {}
    return origFetch(url, opts);
  };
  try {
    const hook = await webhookPost(base, {
      From: WA_FROM, To: `whatsapp:${TWILIO_ENV.TWILIO_WHATSAPP_NUMBER}`,
      NumMedia: '1', MediaContentType0: 'video/mp4',
      MediaUrl0: mediaUrl(mediaMessageSid('6'),'e'),
      Body: '', MessageSid: mediaMessageSid('6'),
    });
    assert.equal(hook.status, 200);
    assert.deepEqual(await hook.json(), { ok: true });
    assert.ok(sent.some((b) => decodeForm(b).includes('aren’t supported yet')), 'expected the unsupported-type reply');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// --- Feature 4 + 5: proactive delivery via WhatsApp ---

test('isWindowOpen honors the 24h messaging window', () => {
  const now = new Date('2026-10-12T20:00:00.000Z').valueOf();
  const ago = (ms) => new Date(now - ms).toISOString();
  assert.equal(WHATSAPP_MESSAGE_WINDOW_MS, 24 * 3600_000);
  assert.equal(isWindowOpen(ago(23 * 3600_000), now), true);
  assert.equal(isWindowOpen(ago(1 * 60_000), now), true);
  assert.equal(isWindowOpen(ago(25 * 3600_000), now), false);
  assert.equal(isWindowOpen(ago(48 * 3600_000), now), false);
  assert.equal(isWindowOpen(new Date(now + 3600_000).toISOString(), now), false, 'future timestamps are not open');
  assert.equal(isWindowOpen(null, now), false);
  assert.equal(isWindowOpen(undefined, now), false);
  assert.equal(isWindowOpen('not-a-date', now), false);
  assert.equal(isWindowOpen('', now), false);
});

function stubTwilio(sent) {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    try { if (new URL(String(url)).hostname === 'api.twilio.com') { sent.push({ url: String(url), body: String(opts?.body || '') }); return { ok: true, status: 201, json: async () => ({ sid: 'SMx' }), text: async () => '' }; } } catch {}
    return origFetch(url, opts);
  };
  return () => { globalThis.fetch = origFetch; };
}

function stubPush(app, pushes) {
  app.push.notify = async (...args) => { pushes.push(args); return { sent: 1, failed: 0 }; };
}

const decodeForm = (body) => decodeURIComponent(String(body || '')).replace(/\+/g, ' ');

test('deliverProactive: window open sends via WhatsApp INSTEAD of push', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const { userId } = await linkOwnerDirectly(app, base);
  app.db.setWhatsAppLastInbound(userId, new Date(Date.now() - 3600_000).toISOString()); // 1h ago: window open
  const sent = []; const restore = stubTwilio(sent);
  const pushes = []; stubPush(app, pushes);
  try {
    await app.deliverProactive(app.db.getUserById(userId), 'Quick check-in: how is the studying going?', 'smart_checkin_sent', 'Sent smart check-in.');
    // Note: check the raw (still-encoded) body for the To number — decodeForm turns %2B into a space.
    assert.ok(sent.some((s) => s.body.includes('whatsapp%3A%2B15085551234') && decodeForm(s.body).includes('how is the studying going')), 'check-in went out via Twilio/WhatsApp');
    assert.equal(pushes.length, 0, 'push is NOT sent when WhatsApp delivers');
    const convo = app.db.ensureDefaultConversation(userId);
    assert.ok(app.db.listConversationMessages(userId, convo.id, 8).some((m) => m.content.includes('how is the studying going')), 'still written to the conversation');
    assert.ok(app.db.listEvents(userId).some((e) => e.type === 'whatsapp_proactive_sent'), 'event recorded');
  } finally { restore(); }
});

test('deliverProactive: window closed skips WhatsApp, push still fires', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const { userId } = await linkOwnerDirectly(app, base);
  app.db.setWhatsAppLastInbound(userId, new Date(Date.now() - 25 * 3600_000).toISOString()); // 25h ago: window closed
  const sent = []; const restore = stubTwilio(sent);
  const pushes = []; stubPush(app, pushes);
  try {
    await app.deliverProactive(app.db.getUserById(userId), 'Quiet nudge', 'quiet_nudge_sent', 'Sent a quiet check-in nudge.');
    assert.equal(sent.length, 0, 'no WhatsApp send outside the window');
    assert.equal(pushes.length, 1, 'push still fires so nothing is lost');
    assert.equal(pushes[0][1], 'Orbit');
    assert.equal(pushes[0][2], 'Quiet nudge');
  } finally { restore(); }
});

test('deliverProactive: no WhatsApp link and non-owner fall back to push', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const { userId } = await linkOwnerDirectly(app, base);
  const pushes = []; stubPush(app, pushes);
  const sent = []; const restore = stubTwilio(sent);
  try {
    // Unlinked owner: push
    app.db.unlinkWhatsApp(userId);
    await app.deliverProactive(app.db.getUserById(userId), 'Hello owner', 'routine_sent', 'Ran routine.');
    assert.equal(sent.length, 0);
    assert.equal(pushes.length, 1);
    // Linked non-owner: push (owner-only gating preserved)
    const member = app.db.createUser({ email: 'member@example.com', displayName: 'Member', passwordHash: 'h', passwordSalt: 's', role: 'member' });
    app.db.linkWhatsApp(member.id, '+15085557777');
    app.db.setWhatsAppLastInbound(member.id, new Date().toISOString());
    await app.deliverProactive(member, 'Hello member', 'routine_sent', 'Ran routine.');
    assert.equal(sent.length, 0, 'no WhatsApp send for a non-owner');
    assert.equal(pushes.length, 2, 'member falls back to push');
  } finally { restore(); }
});

function dueTask(app, userId, overrides = {}) {
  return app.db.addTask(userId, {
    title: 'Take out the trash',
    prompt: 'Remind me to take out the trash.',
    scheduleAt: new Date(Date.now() - 60_000).toISOString(), // due now
    deliveryChannel: 'whatsapp',
    ...overrides,
  });
}

test('runDueTasks: whatsapp-channel task delivered via WhatsApp when window open', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const { userId } = await linkOwnerDirectly(app, base);
  app.db.setWhatsAppLastInbound(userId, new Date(Date.now() - 2 * 3600_000).toISOString());
  const task = dueTask(app, userId);
  assert.equal(task.delivery_channel, 'whatsapp');
  const sent = []; const restore = stubTwilio(sent);
  const pushes = []; stubPush(app, pushes);
  try {
    await app.runDueTasks();
    assert.ok(sent.some((s) => s.body.includes('whatsapp%3A%2B15085551234')), 'reminder went out via WhatsApp');
    assert.equal(pushes.length, 0, 'no duplicate push');
    assert.equal(app.db.getTask(userId, task.id).status, 'completed');
    const convo = app.db.ensureDefaultConversation(userId);
    const messages = app.db.listConversationMessages(userId, convo.id, 8);
    assert.ok(messages.some((m) => m.role === 'assistant' && app.db.getTask(userId, task.id).result && m.content.includes(app.db.getTask(userId, task.id).result.slice(0, 20))), 'result written to the conversation');
    assert.ok(app.db.listEvents(userId).some((e) => e.type === 'task_delivered_whatsapp'), 'delivery event recorded');
  } finally { restore(); }
});

test('runDueTasks: whatsapp-channel task falls back to push when window closed', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const { userId } = await linkOwnerDirectly(app, base);
  app.db.setWhatsAppLastInbound(userId, new Date(Date.now() - 30 * 3600_000).toISOString()); // 30h: closed
  const task = dueTask(app, userId);
  const sent = []; const restore = stubTwilio(sent);
  const pushes = []; stubPush(app, pushes);
  try {
    await app.runDueTasks();
    assert.equal(sent.length, 0, 'no WhatsApp send outside the window');
    assert.equal(pushes.length, 1, 'push fallback fires — reminder never dropped');
    assert.equal(app.db.getTask(userId, task.id).status, 'completed');
  } finally { restore(); }
});

test('runDueTasks: default-channel task still uses push', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const { userId } = await linkOwnerDirectly(app, base);
  app.db.setWhatsAppLastInbound(userId, new Date().toISOString()); // window open, but channel is push
  const task = dueTask(app, userId, { deliveryChannel: 'push' });
  assert.equal(task.delivery_channel, 'push');
  const sent = []; const restore = stubTwilio(sent);
  const pushes = []; stubPush(app, pushes);
  try {
    await app.runDueTasks();
    assert.equal(sent.length, 0, 'no WhatsApp for push-channel tasks');
    assert.equal(pushes.length, 1, 'push used');
    assert.equal(app.db.getTask(userId, task.id).status, 'completed');
  } finally { restore(); }
});
