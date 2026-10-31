import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createModelClient,
  processImageInput,
  isImageContentType,
  classifyModelError,
  IMAGE_STORED_MESSAGE,
  MAX_IMAGE_BYTES,
} from '../src/model.js';
import {
  parseMultipartImage,
  stageAttachment,
  takeAttachment,
  peekAttachment,
  pruneAttachments,
  MAX_UPLOAD_BYTES,
} from '../src/attachments.js';
import { createOrbitServer } from '../server.js';
import { mediaBytesReserved, reserveMediaBytes, MAX_EPHEMERAL_MEDIA_BYTES } from '../src/media-memory.js';
import { allowAiSharing } from './ai-sharing-fixture.js';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

test('staged attachment bytes have a process-wide admission limit',()=>{
  const bytes=Buffer.alloc(9*1024*1024,1);
  const ids=[];
  try{
    for(let i=0;i<10;i++)ids.push([`budget-user-${i}`,stageAttachment(`budget-user-${i}`,{bytes,mimeType:'image/png'})]);
    assert.throws(()=>stageAttachment('budget-user-10',{bytes,mimeType:'image/png'}),error=>error.status===429);
  }finally{
    for(const [userId,id] of ids)takeAttachment(userId,id);
  }
});

test('a tiny multipart image does not retain a large padded request buffer',()=>{
  const boundary='retained-backing';
  const header=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="tiny.png"\r\nContent-Type: image/png\r\n\r\n`);
  const middle=Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="padding"\r\n\r\n`);
  const raw=Buffer.concat([header,PNG_1PX,middle,Buffer.alloc(2*1024*1024,0x70),Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const parsed=parseMultipartImage(raw,`multipart/form-data; boundary=${boundary}`);
  assert.equal(parsed.bytes.buffer,raw.buffer,'the parser initially returns a view of the entire request');
  const initial=mediaBytesReserved();
  const id=stageAttachment('padded-request',{bytes:parsed.bytes,mimeType:parsed.mimeType});
  try{
    const retained=peekAttachment('padded-request',id).bytes;
    assert.equal(retained.length,PNG_1PX.length);
    assert.equal(retained.buffer.byteLength,retained.length,'staging must retain only the charged image allocation');
    assert.notEqual(retained.buffer,raw.buffer);
    assert.equal(mediaBytesReserved(),initial+PNG_1PX.length);
  }finally{takeAttachment('padded-request',id);}
  assert.equal(mediaBytesReserved(),initial);
});

// --- processImageInput ---

test('processImageInput builds the Responses API input_image block', () => {
  const block = processImageInput({ bytes: PNG_1PX, mimeType: 'image/png' });
  assert.equal(block.type, 'input_image');
  assert.ok(String(block.image_url).startsWith('data:image/png;base64,'), 'data URL carries the mime type');
  const payload = Buffer.from(String(block.image_url).split(',')[1], 'base64');
  assert.deepEqual(payload, PNG_1PX, 'bytes round-trip through the data URL');
});

test('processImageInput accepts all supported types and normalizes charset suffixes', () => {
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/jpeg; charset=binary']) {
    const block = processImageInput({ bytes: PNG_1PX, mimeType: mime });
    assert.equal(block.type, 'input_image');
  }
});

test('processImageInput rejects unsupported types, oversize, and empty payloads', () => {
  assert.throws(() => processImageInput({ bytes: PNG_1PX, mimeType: 'application/pdf' }), (e) => e.status === 415);
  assert.throws(() => processImageInput({ bytes: PNG_1PX, mimeType: 'text/plain' }), (e) => e.status === 415);
  assert.throws(() => processImageInput({ bytes: Buffer.alloc(MAX_IMAGE_BYTES + 1), mimeType: 'image/png' }), (e) => e.status === 413);
  assert.throws(() => processImageInput({ bytes: Buffer.alloc(0), mimeType: 'image/png' }), (e) => e.status === 400);
  assert.throws(() => processImageInput({ bytes: PNG_1PX, mimeType: '' }), (e) => e.status === 415);
});

test('isImageContentType matches the pipeline accept list', () => {
  assert.equal(isImageContentType('image/jpeg'), true);
  assert.equal(isImageContentType('image/png'), true);
  assert.equal(isImageContentType('image/webp'), true);
  assert.equal(isImageContentType('image/gif'), true);
  assert.equal(isImageContentType('image/png; charset=binary'), true);
  assert.equal(isImageContentType('image/svg+xml'), false);
  assert.equal(isImageContentType('video/mp4'), false);
  assert.equal(isImageContentType(''), false);
});

test('classifyModelError tags image-unsupported rejections', () => {
  const rejected = (message) => classifyModelError({ status: 400, message });
  assert.equal(rejected('The model does not support image input. Use a vision-capable model.'), 'image_unsupported');
  assert.equal(rejected('Invalid content type: image input is not supported for this model'), 'image_unsupported');
  assert.equal(rejected('Unsupported parameter: input_image'), 'image_unsupported');
  assert.equal(rejected('invalid json in request body'), 'request', 'plain 400s stay generic');
  assert.equal(rejected('nope'), 'request', 'non-image 400s stay generic');
});

// --- respond() with images: input shape + sol fallback ---

function modelEnv() {
  return { OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'gpt-6-luna', OPENAI_COMPLEX_MODEL: 'gpt-6.1-sol' };
}

function stubResponses(handler) {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => handler(url, opts);
  return () => { globalThis.fetch = origFetch; };
}

const okResponse = (text) => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }),
});

const errorResponse = (status, message) => ({
  ok: false,
  status,
  headers: { get: () => 'application/json' },
  json: async () => ({ error: { message, code: 'invalid_request_error' } }),
});

test('respond attaches input_image blocks to the user message', async () => {
  const seen = [];
  const restore = stubResponses(async (url, opts) => {
    seen.push(JSON.parse(String(opts.body)));
    return okResponse('I see a tiny square.');
  });
  try {
    const client = createModelClient(modelEnv());
    const imageBlock = processImageInput({ bytes: PNG_1PX, mimeType: 'image/png' });
    const result = await client.respond({ buddyName: 'Orbit', message: 'look at this', images: [imageBlock], tools: false });
    assert.equal(result.text, 'I see a tiny square.');
    assert.equal(seen.length, 1, 'single model call — no probing');
    const userMessage = seen[0].input[seen[0].input.length - 1];
    assert.equal(userMessage.role, 'user');
    assert.ok(Array.isArray(userMessage.content), 'user content becomes a block array for image turns');
    assert.equal(userMessage.content[0].type, 'input_text');
    assert.equal(userMessage.content[0].text, 'look at this');
    assert.deepEqual(userMessage.content[1], imageBlock);
  } finally {
    restore();
  }
});

test('respond falls back to sol when the configured model rejects image input', async () => {
  const models = [];
  const bodies = [];
  const restore = stubResponses(async (url, opts) => {
    const body = JSON.parse(String(opts.body));
    models.push(body.model);
    bodies.push(body);
    if (body.model === 'gpt-6.1-sol') return okResponse('Sol sees it.');
    return errorResponse(400, 'The model does not support image input.');
  });
  try {
    const client = createModelClient(modelEnv());
    const imageBlock = processImageInput({ bytes: PNG_1PX, mimeType: 'image/jpeg' });
    const result = await client.respond({ buddyName: 'Orbit', message: '', images: [imageBlock], tools: false });
    assert.equal(result.text, 'Sol sees it.');
    assert.deepEqual(models, ['gpt-6-luna', 'gpt-6.1-sol'], 'one normal attempt, then exactly one sol retry');
    const userMessage = bodies[1].input[bodies[1].input.length - 1];
    assert.ok(userMessage.content.some((c) => c.type === 'input_image'), 'the retry carries the image too');
  } finally {
    restore();
  }
});

test('respond does not loop when sol also rejects image input', async () => {
  let calls = 0;
  const restore = stubResponses(async () => {
    calls += 1;
    return errorResponse(400, 'image input is not supported for this model');
  });
  try {
    const client = createModelClient(modelEnv());
    const imageBlock = processImageInput({ bytes: PNG_1PX, mimeType: 'image/png' });
    await assert.rejects(
      () => client.respond({ buddyName: 'Orbit', message: 'x', images: [imageBlock], tools: false }),
      (e) => (e.classification || classifyModelError(e)) === 'image_unsupported'
    );
    assert.equal(calls, 2, 'configured model once, sol once — no probing');
  } finally {
    restore();
  }
});

// --- parseMultipartImage ---

function multipartBody(boundary, parts) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'latin1'));
    let disposition = `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename) disposition += `; filename="${part.filename}"`;
    chunks.push(Buffer.from(`${disposition}\r\n`, 'latin1'));
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`, 'latin1'));
    chunks.push(Buffer.from('\r\n', 'latin1'));
    chunks.push(part.data);
    chunks.push(Buffer.from('\r\n', 'latin1'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
  return Buffer.concat(chunks);
}

test('parseMultipartImage extracts binary-safe file bytes, filename, and mime type', () => {
  const boundary = '----d1testboundary';
  const binary = Buffer.from([0, 1, 2, 3, 137, 80, 78, 71, 255, 254, 0, 13, 10, 13, 10, 45, 45]);
  const body = multipartBody(boundary, [
    { name: 'note', data: Buffer.from('hello') },
    { name: 'image', filename: 'shot.png', contentType: 'image/png', data: binary },
  ]);
  const file = parseMultipartImage(body, `multipart/form-data; boundary=${boundary}`);
  assert.ok(file, 'found the file part');
  assert.equal(file.filename, 'shot.png');
  assert.equal(file.mimeType, 'image/png');
  assert.deepEqual(file.bytes, binary, 'binary bytes are not corrupted');
});

test('parseMultipartImage returns null when there is no file part', () => {
  const boundary = '----d1testboundary2';
  const body = multipartBody(boundary, [{ name: 'note', data: Buffer.from('hello') }]);
  assert.equal(parseMultipartImage(body, `multipart/form-data; boundary=${boundary}`), null);
  assert.equal(parseMultipartImage(Buffer.from('junk'), 'multipart/form-data; boundary=none'), null);
  assert.equal(parseMultipartImage(Buffer.from('junk'), 'application/json'), null);
});

// --- staging ---

test('stageAttachment/takeAttachment round-trips and is single-use per user', () => {
  const id = stageAttachment('user-a', { bytes: PNG_1PX, mimeType: 'image/png' });
  assert.ok(id, 'returns an attachment id');
  const taken = takeAttachment('user-a', id);
  assert.ok(taken);
  assert.deepEqual(taken.bytes, PNG_1PX);
  assert.equal(taken.mimeType, 'image/png');
  assert.equal(takeAttachment('user-a', id), null, 'consumed ids cannot be reused');
  assert.equal(takeAttachment('user-b', id), null, 'unknown ids return null');
});

test('stageAttachment validates up front and isolates users', () => {
  assert.throws(() => stageAttachment('user-a', { bytes: PNG_1PX, mimeType: 'text/plain' }), (e) => e.status === 415);
  assert.throws(() => stageAttachment('user-a', { bytes: Buffer.alloc(MAX_IMAGE_BYTES + 1), mimeType: 'image/png' }), (e) => e.status === 413);
  const id = stageAttachment('user-a', { bytes: PNG_1PX, mimeType: 'image/gif' });
  assert.equal(takeAttachment('user-b', id), null, "one user's id is unusable by another user");
  assert.ok(takeAttachment('user-a', id), 'the owning user can still consume it');
});

test('staged attachments expire after the TTL', () => {
  const id = stageAttachment('user-ttl', { bytes: PNG_1PX, mimeType: 'image/png' });
  pruneAttachments(Date.now() + 11 * 60_000);
  assert.equal(takeAttachment('user-ttl', id), null, 'expired attachments are gone');
});

// --- POST /api/chat/attachments + /api/chat with attachmentIds ---

async function serverFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-img-server-'));
  const env = { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna' }; // no API key: model stays in demo mode
  const app = createOrbitServer({ dataDir: directory, env });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function register(base, { email = 'img-owner@example.com', displayName = 'ImgOwner' } = {}) {
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, displayName, password: 'correct horse battery staple' }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  const auth={ cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrf };
  await allowAiSharing(base,auth);
  return auth;
}

function uploadRequest(base, auth, body, contentType) {
  return fetch(`${base}/api/chat/attachments`, {
    method: 'POST',
    headers: { Cookie: auth.cookie, 'X-Orbit-CSRF': auth.csrf, 'Content-Type': contentType },
    body,
  });
}

function imageUpload(boundary, bytes, { filename = 'shot.png', contentType = 'image/png' } = {}) {
  return multipartBody(boundary, [{ name: 'image', filename, contentType, data: bytes }]);
}

test('upload endpoint: auth required', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const response = await fetch(`${base}/api/chat/attachments`, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x' }, body: 'x' });
  assert.equal(response.status, 401);
});

test('upload endpoint: rejects non-image types and oversized uploads', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const auth = await register(base);
  const text = await uploadRequest(base, auth, imageUpload('b1', Buffer.from('not an image'), { filename: 'note.txt', contentType: 'text/plain' }), 'multipart/form-data; boundary=b1');
  assert.equal(text.status, 415);
  const big = await uploadRequest(base, auth, imageUpload('b2', Buffer.alloc(MAX_IMAGE_BYTES + 1), { contentType: 'image/png' }), 'multipart/form-data; boundary=b2');
  assert.equal(big.status, 413);
  const empty = await uploadRequest(base, auth, Buffer.alloc(0), 'multipart/form-data; boundary=b3');
  assert.equal(empty.status, 400);
});

test('upload endpoint: happy path returns an id consumed by /api/chat', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const budgetBefore=mediaBytesReserved();
  const auth = await register(base);
  const headers = { Cookie: auth.cookie, 'X-Orbit-CSRF': auth.csrf, 'Content-Type': 'application/json' };
  const upload = await uploadRequest(base, auth, imageUpload('b4', PNG_1PX), 'multipart/form-data; boundary=b4');
  assert.equal(upload.status, 201);
  const stagedBody = await upload.json();
  assert.ok(stagedBody.id, 'returns an attachment id');
  assert.equal(stagedBody.mimeType, 'image/png');
  assert.equal(stagedBody.size, PNG_1PX.length);
  assert.equal(mediaBytesReserved(),budgetBefore+PNG_1PX.length);
  assert.ok(!JSON.stringify(stagedBody).includes('base64'), 'response carries no image bytes');

  // Image-only turn: no text message required
  const chat = await fetch(`${base}/api/chat`, {
    method: 'POST', headers,
    body: JSON.stringify({ message: '', attachmentIds: [stagedBody.id] }),
  });
  assert.equal(chat.status, 202);
  const sentBody = await chat.json();

  // Unknown ids are rejected with 410
  const bad = await fetch(`${base}/api/chat`, {
    method: 'POST', headers,
    body: JSON.stringify({ message: 'x', attachmentIds: ['00000000-0000-0000-0000-000000000000'] }),
  });
  assert.equal(bad.status, 410);

  // Stored history keeps the text placeholder; the queued reply job runs the
  // model pipeline in demo mode and answers without a paid call.
  const user = app.db.getUserByEmail('img-owner@example.com');
  const convo = app.db.getConversation(user.id, sentBody.conversationId);
  assert.ok(convo, 'conversation exists');
  let assistantReply = null;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const messages = app.db.listConversationMessages(user.id, convo.id, 24);
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    assert.ok(lastUser, 'user message stored');
    assert.equal(lastUser.content, IMAGE_STORED_MESSAGE, 'bytes never land in history');
    assistantReply = [...messages].reverse().find((m) => m.role === 'assistant');
    if (assistantReply) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(assistantReply, 'assistant reply was generated for the image turn');
  assert.ok(String(assistantReply.content).includes('demo mode'), 'demo-mode pipeline answered');
  const budgetDeadline=Date.now()+2000;
  while(mediaBytesReserved()!==budgetBefore&&Date.now()<budgetDeadline)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(mediaBytesReserved(),budgetBefore,'reply completion releases the queued image reservation');
});

test('account deletion releases that account’s staged image bytes',async t=>{
  const {app,base}=await serverFixture();t.after(()=>app.close());
  const initial=mediaBytesReserved(),auth=await register(base,{email:'delete-image-owner@example.test'});
  const upload=await uploadRequest(base,auth,imageUpload('account-delete',PNG_1PX),'multipart/form-data; boundary=account-delete');
  assert.equal(upload.status,201);
  assert.equal(mediaBytesReserved(),initial+PNG_1PX.length);
  const removed=await fetch(`${base}/api/account`,{method:'DELETE',headers:{Cookie:auth.cookie,'X-Orbit-CSRF':auth.csrf,'Content-Type':'application/json'},body:JSON.stringify({confirm:'DELETE',password:'correct horse battery staple'})});
  assert.equal(removed.status,200);
  assert.equal(mediaBytesReserved(),initial);
});

test('full queued-image budget refuses a chat turn without consuming its staged attachment',async t=>{
  const {app,base}=await serverFixture();t.after(()=>app.close());
  const auth=await register(base,{email:'budget-image-owner@example.test'});
  const upload=await uploadRequest(base,auth,imageUpload('budget-chat',PNG_1PX),'multipart/form-data; boundary=budget-chat');
  assert.equal(upload.status,201);
  const {id}=await upload.json();
  const filler=reserveMediaBytes(MAX_EPHEMERAL_MEDIA_BYTES-mediaBytesReserved()-128);
  const headers={Cookie:auth.cookie,'X-Orbit-CSRF':auth.csrf,'Content-Type':'application/json'};
  const send=()=>fetch(`${base}/api/chat`,{method:'POST',headers,body:JSON.stringify({message:'Look',attachmentIds:[id]})});
  try{
    assert.equal((await send()).status,429);
    const user=app.db.getUserByEmail('budget-image-owner@example.test');
    assert.ok(peekAttachment(user.id,id),'capacity refusal keeps the upload available to retry');
  }finally{filler();}
  assert.equal((await send()).status,202);
});

test('/api/chat without attachments still requires a message', async (t) => {
  const { app, base } = await serverFixture(); t.after(() => app.close());
  const auth = await register(base);
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { Cookie: auth.cookie, 'X-Orbit-CSRF': auth.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '' }),
  });
  assert.equal(response.status, 400);
});

test('MAX_UPLOAD_BYTES covers the image cap plus multipart framing', () => {
  assert.ok(MAX_UPLOAD_BYTES >= MAX_IMAGE_BYTES, 'framing headroom');
  assert.ok(MAX_UPLOAD_BYTES < MAX_IMAGE_BYTES * 1.1, 'not a loophole around the 10MB image cap');
});
