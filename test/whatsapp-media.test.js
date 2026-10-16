// D5: WhatsApp outbound media — FIXTURES/MOCKS ONLY. No real Twilio message
// is ever sent: fetch is stubbed and bytes stay in-process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';
import { readEncryptionKey } from '../src/security.js';
import { sendWhatsAppMedia } from '../src/whatsapp.js';
import {
  stageWhatsAppMedia,
  peekWhatsAppMedia,
  deriveMediaSigningKey,
  signWhatsAppMediaToken,
  verifyWhatsAppMediaToken,
  buildWhatsAppMediaUrl,
  WHATSAPP_MEDIA_TTL_MS,
  MAX_WHATSAPP_MEDIA_BYTES,
  MAX_STAGED_WHATSAPP_MEDIA,
} from '../src/whatsapp-media.js';

const FIXTURE_SECRET = Buffer.alloc(32, 7);
const FIXTURE_KEY_STR = FIXTURE_SECRET.toString('base64'); // 32 raw bytes -> used as-is

async function withFetchStub(stub, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

async function fixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-d5-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', ...extraEnv } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

// --- sendWhatsAppMedia: exact form Twilio expects (mocked fetch) ---

test('sendWhatsAppMedia posts MediaUrl + From/To with Basic auth', async () => {
  const calls = [];
  const sid = await withFetchStub(async (url, opts) => {
    calls.push({ url: String(url), opts });
    return { ok: true, status: 201, json: async () => ({ sid: 'SMmedia123' }), text: async () => '' };
  }, () => sendWhatsAppMedia({
    accountSid: 'ACx', authToken: 'tok', fromNumber: '+14155238886', toPhone: '+15085551234',
    mediaUrl: 'https://orbitbuddy.app/api/whatsapp/media/abc.123.sig', body: 'here is the chart',
  }));
  assert.equal(sid, 'SMmedia123');
  assert.equal(calls[0].url, 'https://api.twilio.com/2010-04-01/Accounts/ACx/Messages.json');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.Authorization, `Basic ${Buffer.from('ACx:tok', 'utf8').toString('base64')}`);
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(calls[0].opts.body);
  assert.equal(form.get('From'), 'whatsapp:+14155238886');
  assert.equal(form.get('To'), 'whatsapp:+15085551234');
  assert.equal(form.get('MediaUrl'), 'https://orbitbuddy.app/api/whatsapp/media/abc.123.sig');
  assert.equal(form.get('Body'), 'here is the chart');
});

test('sendWhatsAppMedia works without a caption body and rejects a missing URL', async () => {
  const calls = [];
  await withFetchStub(async (url, opts) => {
    calls.push(opts);
    return { ok: true, status: 201, json: async () => ({ sid: 'SMx' }), text: async () => '' };
  }, () => sendWhatsAppMedia({ accountSid: 'ACx', authToken: 'tok', fromNumber: '+1', toPhone: '+2', mediaUrl: 'https://x/y' }));
  assert.equal(new URLSearchParams(calls[0].body).get('Body'), null);
  await assert.rejects(
    sendWhatsAppMedia({ accountSid: 'ACx', authToken: 'tok', fromNumber: '+1', toPhone: '+2', mediaUrl: '' }),
    /media URL is required/
  );
});

test('sendWhatsAppMedia throws on Twilio errors', async () => {
  await assert.rejects(
    withFetchStub(async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => 'bad media' }),
      () => sendWhatsAppMedia({ accountSid: 'ACx', authToken: 'tok', fromNumber: '+1', toPhone: '+2', mediaUrl: 'https://x/y' })),
    /Twilio media send failed \(400\)/
  );
});

// --- staging validation ---

test('stageWhatsAppMedia accepts the allowlisted types', () => {
  for (const mimeType of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) {
    const id = stageWhatsAppMedia('u1', { bytes: Buffer.from([1, 2, 3]), mimeType });
    assert.match(id, /^[0-9a-f-]{36}$/i);
    const entry = peekWhatsAppMedia(id);
    assert.equal(entry.mimeType, mimeType); // normalized, lowercased, params stripped
    assert.deepEqual([...entry.bytes], [1, 2, 3]);
  }
  const mixed = stageWhatsAppMedia('u1', { bytes: Buffer.from([9]), mimeType: 'image/png; charset=binary' });
  assert.equal(peekWhatsAppMedia(mixed).mimeType, 'image/png');
});

test('stageWhatsAppMedia rejects wrong types, empty, and oversize payloads', async () => {
  await assert.rejects(async () => stageWhatsAppMedia('u1', { bytes: Buffer.from([1]), mimeType: 'text/plain' }), /Unsupported media type/);
  await assert.rejects(async () => stageWhatsAppMedia('u1', { bytes: Buffer.alloc(0), mimeType: 'image/png' }), /Empty media/);
  const big = stageWhatsAppMedia; // sanity: cap constant is 10MB
  assert.equal(MAX_WHATSAPP_MEDIA_BYTES, 10 * 1024 * 1024);
  await assert.rejects(
    async () => big('u1', { bytes: Buffer.alloc(MAX_WHATSAPP_MEDIA_BYTES + 1), mimeType: 'image/png' }),
    /too large/
  );
});

test('stageWhatsAppMedia enforces the per-user cap and expires entries', () => {
  const ids = [];
  for (let i = 0; i < MAX_STAGED_WHATSAPP_MEDIA; i++) {
    ids.push(stageWhatsAppMedia('cap-user', { bytes: Buffer.from([i]), mimeType: 'image/png' }));
  }
  assert.throws(() => stageWhatsAppMedia('cap-user', { bytes: Buffer.from([9]), mimeType: 'image/png' }), /Too many staged/);
  // Other users are unaffected by one user's cap.
  assert.ok(stageWhatsAppMedia('other-user', { bytes: Buffer.from([9]), mimeType: 'image/png' }));
  // Expired entries are pruned and no longer resolve.
  const stale = stageWhatsAppMedia('stale-user', { bytes: Buffer.from([1]), mimeType: 'image/png' }, Date.now() - WHATSAPP_MEDIA_TTL_MS - 1000);
  assert.equal(peekWhatsAppMedia(stale), null);
});

// --- signing ---

test('media tokens round-trip; tampered/expired/malformed tokens fail', () => {
  const secret = deriveMediaSigningKey(FIXTURE_SECRET);
  assert.ok(secret && secret.length === 32);
  const mediaId = '12345678-1234-1234-1234-1234567890ab';
  const token = signWhatsAppMediaToken(mediaId, secret);
  const verified = verifyWhatsAppMediaToken(token, secret);
  assert.equal(verified.mediaId, mediaId);
  // Tampered signature.
  const [id, exp, sig] = token.split('.');
  const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
  assert.equal(verifyWhatsAppMediaToken(`${id}.${exp}.${flipped}`, secret), null);
  // Tampered media id or expiry.
  assert.equal(verifyWhatsAppMediaToken(`${'00000000-0000-0000-0000-000000000000'}.${exp}.${sig}`, secret), null);
  assert.equal(verifyWhatsAppMediaToken(`${id}.${Number(exp) + 60_000}.${sig}`, secret), null);
  // Expired.
  const old = signWhatsAppMediaToken(mediaId, secret, Date.now() - WHATSAPP_MEDIA_TTL_MS - 1000);
  assert.equal(verifyWhatsAppMediaToken(old, secret), null);
  // Malformed and wrong secret.
  assert.equal(verifyWhatsAppMediaToken('not-a-token', secret), null);
  assert.equal(verifyWhatsAppMediaToken(token, deriveMediaSigningKey(Buffer.alloc(32, 9))), null);
  assert.equal(verifyWhatsAppMediaToken(token, null), null);
});

test('signing requires a server secret; the derived key is domain-separated', () => {
  assert.equal(deriveMediaSigningKey(null), null);
  assert.throws(() => signWhatsAppMediaToken('12345678-1234-1234-1234-1234567890ab', null), /not configured/);
  const k1 = deriveMediaSigningKey(FIXTURE_SECRET);
  const k2 = deriveMediaSigningKey(FIXTURE_SECRET);
  assert.deepEqual(k1, k2); // stable across calls
  assert.ok(!k1.equals(FIXTURE_SECRET)); // not the raw server secret
});

test('buildWhatsAppMediaUrl needs a public HTTPS origin', () => {
  const secret = deriveMediaSigningKey(FIXTURE_SECRET);
  const mediaId = '12345678-1234-1234-1234-1234567890ab';
  const url = buildWhatsAppMediaUrl('https://orbitbuddy.app/', mediaId, secret);
  assert.match(url, /^https:\/\/orbitbuddy\.app\/api\/whatsapp\/media\/[0-9a-f-]{36}\.\d+\.[A-Za-z0-9_-]+$/);
  assert.throws(() => buildWhatsAppMediaUrl('http://orbitbuddy.app', mediaId, secret), /HTTPS/);
  assert.throws(() => buildWhatsAppMediaUrl('', mediaId, secret), /HTTPS/);
});

// --- server endpoint round-trip ---

test('GET /api/whatsapp/media/:token serves staged bytes; invalid/expired -> 404', async (t) => {
  const { app, base } = await fixture({ DATA_ENCRYPTION_KEY: FIXTURE_KEY_STR });
  t.after(() => app.close());
  // The server derives the same sub-key from env.DATA_ENCRYPTION_KEY.
  const secret = deriveMediaSigningKey(readEncryptionKey(FIXTURE_KEY_STR));
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10]); // png magic
  const mediaId = stageWhatsAppMedia('owner-user', { bytes, mimeType: 'image/png' });
  const token = signWhatsAppMediaToken(mediaId, secret);

  // Valid token: bytes served, correct content type, no-store, no auth needed.
  const res = await fetch(`${base}/api/whatsapp/media/${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);

  // Tampered signature -> 404 (never 403).
  const [id, exp, sig] = token.split('.');
  const bad = await fetch(`${base}/api/whatsapp/media/${id}.${exp}.${sig.slice(0, -1)}X`);
  assert.equal(bad.status, 404);
  // Garbage token -> 404.
  assert.equal((await fetch(`${base}/api/whatsapp/media/nope`)).status, 404);
  // Expired token -> 404.
  const expired = signWhatsAppMediaToken(mediaId, secret, Date.now() - WHATSAPP_MEDIA_TTL_MS - 1000);
  assert.equal((await fetch(`${base}/api/whatsapp/media/${expired}`)).status, 404);
  // Valid signature but nothing staged (or already expired in the store) -> 404.
  const ghostId = '12345678-1234-1234-1234-1234567890ab';
  const ghost = signWhatsAppMediaToken(ghostId, secret);
  assert.equal((await fetch(`${base}/api/whatsapp/media/${ghost}`)).status, 404);
});
