import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createOrbitServer } from '../server.js';

async function fixture(t, modelClient) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-reliability-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test' }, ...(modelClient ? { modelClient } : {}) });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

const seed = (db) => {const user=db.createUser({ email: 'owner@example.test', displayName: 'Owner', passwordHash: 'test', passwordSalt: 'test', role: 'owner' });db.setAiSharingConsent(user.id,true);return user;};

test('malformed request target returns 400 and leaves the server healthy', async (t) => {
  const { app, base } = await fixture(t);
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(app.server.address().port, '127.0.0.1');
    socket.setTimeout(5000, () => socket.destroy(new Error('request timed out')));
    let data = '';
    socket.on('connect', () => socket.write('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  assert.match(response, /^HTTP\/1\.1 400 /);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('PDF export has valid page, stream, font and xref references for every page', async (t) => {
  const { app, base } = await fixture(t);
  const registration = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.test', displayName: 'Owner', password: 'correct horse battery staple' }) });
  assert.equal(registration.status, 201);
  const { user } = await registration.json();
  const cookie = registration.headers.get('set-cookie').split(';')[0];
  for (const count of [0, 1, 60, 120]) {
    const artifact = app.db.addArtifact(user.id, { name: 'export.md', content: Array.from({ length: count }, (_, i) => `Line ${i + 1}`).join('\n') });
    const response = await fetch(`${base}/api/artifacts/${artifact.id}?format=pdf`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    const pdf = Buffer.from(await response.arrayBuffer()).toString('latin1');
    const objects = new Map([...pdf.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)].map((match) => [Number(match[1]), match[2]]));
    const tree = [...objects.values()].find((body) => /\/Type \/Pages\b/.test(body));
    const pages = [...tree.match(/\/Kids \[([^\]]*)\]/)[1].matchAll(/(\d+) 0 R/g)].map((match) => Number(match[1]));
    assert.equal(pages.length, Number(tree.match(/\/Count (\d+)/)[1]));
    assert.equal(new Set(pages).size, pages.length);
    if (count >= 60) assert.ok(pages.length > 1);
    else assert.equal(pages.length, 1);
    let text = '';
    for (const id of pages) {
      const page = objects.get(id);
      assert.match(page, /\/Type \/Page\b/);
      const parent = objects.get(Number(page.match(/\/Parent (\d+) 0 R/)[1]));
      assert.equal(parent, tree);
      for (const font of page.matchAll(/\/F\d (\d+) 0 R/g)) assert.match(objects.get(Number(font[1])), /\/Type \/Font\b/);
      const stream = objects.get(Number(page.match(/\/Contents (\d+) 0 R/)[1]));
      const content = stream.match(/\nstream\n([\s\S]*)\nendstream/)[1];
      assert.equal(Buffer.byteLength(content, 'latin1'), Number(stream.match(/\/Length (\d+)/)[1]));
      text += content;
    }
    for (let i = 1; i <= count; i++) assert.equal(text.split(`(Line ${i}) Tj`).length - 1, 1);
    const xref = Number(pdf.match(/startxref\n(\d+)/)[1]);
    assert.equal(pdf.slice(xref, xref + 4), 'xref');
    const rows = pdf.slice(xref).split('\n');
    const size = Number(rows[1].split(' ')[1]);
    assert.equal(size, objects.size + 1);
    for (let id = 1; id < size; id++) assert.ok(pdf.slice(Number(rows[id + 2].split(' ')[0])).startsWith(`${id} 0 obj\n`));
  }
});

for (const outcome of ['success', 'failure']) {
  test(`stale task ${outcome} cannot overwrite or publish after a newer attempt`, async (t) => {
    const started = Promise.withResolvers(), result = Promise.withResolvers();
    const { app } = await fixture(t, { respond: () => { started.resolve(); return result.promise; } });
    const user = seed(app.db);
    const task = app.db.addTask(user.id, { title: 'Race', prompt: 'Compute' });
    const notify = t.mock.method(app.push, 'notify', async () => {});
    const pending = app.runDueTasks();
    await started.promise;
    const firstAttempt=app.db.getTask(user.id,task.id).attempt_count;
    assert.equal(app.db.renewTaskLease(user.id,task.id,firstAttempt,-1000),true);
    app.db.recoverStaleTasks();
    const newer = app.db.claimDueTask(user.id, task.id)?.attempt_count;
    assert.ok(newer);
    assert.equal(app.db.completeClaimedTask(user.id, task.id, newer, 'new result'), true);
    if (outcome === 'success') result.resolve({ text: 'stale result' });
    else result.reject(new Error('old worker failed'));
    await pending;
    assert.equal(app.db.getTask(user.id, task.id).status, 'completed');
    assert.equal(app.db.getTask(user.id, task.id).result, 'new result');
    assert.equal(app.db.listArtifacts(user.id).length, 0);
    assert.equal(notify.mock.callCount(), 0);
    assert.ok(!app.db.listEvents(user.id).some((event) => ['task_completed', 'task_failed'].includes(event.type)));
  });
}

test('active task heartbeat renews its lease and stops on completion', async (t) => {
  const started = Promise.withResolvers(), result = Promise.withResolvers();
  const { app } = await fixture(t, { respond: () => { started.resolve(); return result.promise; } });
  const user = seed(app.db);
  const task = app.db.addTask(user.id, { title: 'Long task', prompt: 'Compute' });
  const renew = t.mock.method(app.db, 'renewTaskLease');
  const notify = t.mock.method(app.push, 'notify', async () => {});
  t.mock.timers.enable({ apis: ['setInterval'] });
  const pending = app.runDueTasks();
  await started.promise;
  t.mock.timers.tick(30_000);
  assert.equal(renew.mock.callCount(), 1);
  assert.equal(renew.mock.calls[0].result, true);
  result.resolve({ text: 'completed result' });
  await pending;
  t.mock.timers.tick(30_000);
  assert.equal(renew.mock.callCount(), 1);
  assert.equal(app.db.getTask(user.id, task.id).result, 'completed result');
  assert.equal(app.db.listArtifacts(user.id).length, 1);
  assert.equal(notify.mock.callCount(), 1);
});

for (const renewal of ['lost lease', 'database error']) {
  test(`task heartbeat fails closed on ${renewal}`, async (t) => {
    const started = Promise.withResolvers(), result = Promise.withResolvers();
    const { app } = await fixture(t, { respond: () => { started.resolve(); return result.promise; } });
    const user = seed(app.db);
    const task = app.db.addTask(user.id, { title: 'Lost task', prompt: 'Compute' });
    t.mock.method(app.db, 'renewTaskLease', () => {
      if (renewal === 'database error') throw new Error('database unavailable');
      return false;
    });
    const notify = t.mock.method(app.push, 'notify', async () => {});
    t.mock.timers.enable({ apis: ['setInterval'] });
    const pending = app.runDueTasks();
    await started.promise;
    t.mock.timers.tick(30_000);
    result.resolve({ text: 'discard this result' });
    await pending;
    assert.equal(app.db.getTask(user.id, task.id).result, null);
    assert.equal(app.db.listArtifacts(user.id).length, 0);
    assert.equal(notify.mock.callCount(), 0);
  });
}

test('notification failure cannot turn a completed task into a failed task', async (t) => {
  const { app } = await fixture(t, { respond: async () => ({ text: 'valid result' }) });
  const user = seed(app.db);
  const task = app.db.addTask(user.id, { title: 'Delivery failure', prompt: 'Compute' });
  const notify = t.mock.method(app.push, 'notify', async () => { throw new Error('push unavailable'); });
  await app.runDueTasks();
  assert.equal(app.db.getTask(user.id, task.id).status, 'completed');
  assert.equal(app.db.getTask(user.id, task.id).result, 'valid result');
  assert.equal(notify.mock.callCount(), 1);
  assert.ok(!app.db.listEvents(user.id).some((event) => event.type === 'task_failed'));
});
