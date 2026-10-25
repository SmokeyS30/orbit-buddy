import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import webpush from 'web-push';
import { openDatabase } from '../src/database.js';
import { createPushService } from '../src/push.js';
import { createOrbitServer } from '../server.js';
import { hashPassword } from '../src/security.js';

// --- W4: notification tap deep-linking ---

async function serverFixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-deeplink-server-'));
  const env = { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', ...extraEnv };
  const app = createOrbitServer({ dataDir: directory, env });
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

function stubPush(app, pushes) {
  app.push.notify = async (...args) => { pushes.push(args); return { sent: 1, failed: 0 }; };
}

test('deliverProactive push payload carries the conversation id', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const auth = await register(base);
  const user = app.db.getUserByEmail('owner@example.com');
  const pushes = []; stubPush(app, pushes);
  await app.deliverProactive(user, 'Ping — how is the studying going?', 'smart_checkin_sent', 'Sent smart check-in.');
  assert.equal(pushes.length, 1, 'proactive check-in falls back to push');
  const [userId, title, body, data] = pushes[0];
  assert.equal(userId, user.id);
  assert.equal(title, 'Orbit');
  assert.equal(body, 'Ping — how is the studying going?');
  const convo = app.db.ensureDefaultConversation(user.id);
  assert.equal(data.view, 'today');
  assert.equal(data.conversationId, convo.id, 'payload points at the conversation the check-in was written to');
  assert.ok(app.db.listConversationMessages(user.id, convo.id, 8).some((m) => m.content.includes('how is the studying going')), 'message still lands in the conversation');
});

test('web push wire payload omits private text, action tokens, and record ids', async () => {
  const keys = webpush.generateVAPIDKeys();
  const captured = [];
  const original = webpush.sendNotification;
  webpush.sendNotification = async (_sub, payload) => { captured.push(JSON.parse(payload)); };
  try {
    const db = { listPush: () => [{ id: 's1', endpoint: 'https://push.example.com/x', p256dh: 'p', auth: 'a',bound_session_hash:'synthetic-session' }], isPushRegistrationCurrent:()=>true, deletePushById: () => {} };
    const svc = createPushService({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:test@example.com' }, db);
    await svc.notify('u1', 'Private task', 'Private result', { view: 'today', conversationId: 'conv-123',taskId:'task-123',doorToken:'secret-token',doorAction:true });
    assert.deepEqual(captured[0].data, { view: 'today' });
    assert.equal(captured[0].title, 'Orbit');
    assert.equal(captured[0].body,'Open Orbit to see your update.');
    assert.ok(!JSON.stringify(captured[0]).includes('Private'));
    assert.ok(!JSON.stringify(captured[0]).includes('secret-token'));
    await svc.notify('u1', 'Orbit', 'hi', { view: 'safety' });
    assert.deepEqual(captured[1].data, { view: 'safety' });
    await svc.notify('u1','Orbit','hi',{view:'untrusted',email:'private@example.test'});
    assert.deepEqual(captured[2].data,{view:'today'});
  } finally {
    webpush.sendNotification = original;
  }
});

test('logout or account switch after listing skips web push provider send', async () => {
  const keys = webpush.generateVAPIDKeys();
  let providerCalled = false;
  const original = webpush.sendNotification;
  webpush.sendNotification = async () => { providerCalled = true; };
  try {
    const db = {
      listPush: () => [{ id: 'old', endpoint: 'https://push.example.test/device', p256dh: 'key', auth: 'auth', bound_session_hash: 'old-session' }],
      isPushRegistrationCurrent: (userId, endpoint, sessionHash) => {
        assert.deepEqual([userId, endpoint, sessionHash], ['user-1', 'https://push.example.test/device', 'old-session']);
        return false;
      },
    };
    const svc = createPushService({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey }, db);
    assert.deepEqual(await svc.notify('user-1', 'Private', 'Private'), { sent: 0, failed: 0 });
    assert.equal(providerCalled, false);
  } finally { webpush.sendNotification = original; }
});

test('web push checks task delivery eligibility before each device send',async()=>{
  const keys=webpush.generateVAPIDKeys();
  const original=webpush.sendNotification;
  let allowed=true,sends=0;
  webpush.sendNotification=async()=>{sends++;allowed=false;};
  try{
    const db={listPush:()=>[
      {id:'first',endpoint:'https://push.example.test/first',p256dh:'p',auth:'a'},
      {id:'second',endpoint:'https://push.example.test/second',p256dh:'p',auth:'a'}
    ],isPushRegistrationCurrent:()=>true,deletePushById:()=>{}};
    const service=createPushService({VAPID_PUBLIC_KEY:keys.publicKey,VAPID_PRIVATE_KEY:keys.privateKey,VAPID_SUBJECT:'mailto:test@example.com'},db);
    const result=await service.notify('synthetic-user','Task','Result',{},()=>allowed);
    assert.equal(sends,1,'the second device is not contacted after eligibility is revoked');
    assert.equal(result.sent,1);
  }finally{webpush.sendNotification=original;}
});

test('snapshot ?conversation= selects the thread; unknown ids fall back to default', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const auth = await register(base);
  const user = app.db.getUserByEmail('owner@example.com');
  const def = app.db.ensureDefaultConversation(user.id);
  const other = app.db.createConversation(user.id, 'Second thread');
  const get = async (qs) => (await fetch(`${base}/api/snapshot${qs}`, { headers: authHeaders(auth) })).json();

  const targeted = await get(`?conversation=${other.id}`);
  assert.equal(targeted.activeConversation.id, other.id, 'deep-link id becomes the active conversation');

  const fallback = await get('?conversation=does-not-exist');
  const expectedDefault = app.db.ensureDefaultConversation(user.id).id;
  assert.equal(fallback.activeConversation.id, expectedDefault, 'unknown id falls back to the default conversation (graceful Today landing)');

  // A foreign user's conversation id can never be pulled into another account.
  const pw = await hashPassword('second-user-password');
  const user2 = app.db.createUser({ email: 'second@example.com', displayName: 'Second', passwordHash: pw.hash, passwordSalt: pw.salt, role: 'member' });
  app.db.ensureDefaultConversation(user2.id);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'second@example.com', password: 'second-user-password' }),
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  const auth2 = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: loginBody.csrf };
  const res = await fetch(`${base}/api/snapshot?conversation=${other.id}`, { headers: authHeaders(auth2) });
  const crossUser = await res.json();
  assert.notEqual(crossUser.activeConversation.id, other.id, 'user-scoped lookup: no cross-user conversation leak via the param');
});
