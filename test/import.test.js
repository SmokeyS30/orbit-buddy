import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.js';
import { extractMessages, chunkMessages, parseChatGPTExport, parseGenericExport, parseMultipartFile } from '../src/import.js';

function chatgptExport() {
  return {
    conversations: [
      {
        title: 'Weekend plans',
        mapping: {
          a: { message: { author: { role: 'user' }, content: { parts: ['I live in Brewster, Massachusetts'] }, create_time: 100 } },
          b: { message: { author: { role: 'assistant' }, content: { parts: ['Nice!'] }, create_time: 101 } },
          c: { message: { author: { role: 'user' }, content: { parts: ['I am studying for my CompTIA Security+ exam'] }, create_time: 102 } },
          d: { message: null },
          e: { message: { author: { role: 'system' }, content: { parts: ['skip me'] }, create_time: 103 } },
        }
      }
    ]
  };
}

test('parseChatGPTExport extracts ordered user/assistant messages', () => {
  const msgs = parseChatGPTExport(chatgptExport());
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].role, 'user');
  assert.ok(msgs[0].content.includes('Brewster'));
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[2].role, 'user');
  assert.ok(msgs[2].content.includes('Security+'));
});

test('parseGenericExport handles simple message arrays', () => {
  const msgs = parseGenericExport({ messages: [
    { role: 'user', content: 'I prefer dark mode' },
    { role: 'assistant', content: 'Got it' },
    { role: 'weird', content: 'skip' },
    { role: 'user', content: '' },
  ]});
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].content, 'I prefer dark mode');
});

test('extractMessages tries chatgpt then generic, unwraps data wrapper', () => {
  const r1 = extractMessages(chatgptExport());
  assert.equal(r1.format, 'chatgpt');
  assert.ok(r1.messages.length > 0);
  const r2 = extractMessages({ data: { messages: [{ role: 'user', content: 'hello there friend, how are you doing today' }] } });
  assert.equal(r2.format, 'generic');
  const r3 = extractMessages({ garbage: true });
  assert.equal(r3, null);
  const r4 = extractMessages(null);
  assert.equal(r4, null);
});

test('chunkMessages skips trivial chunks', () => {
  const msgs = [
    { role: 'user', content: 'ok' },
    { role: 'assistant', content: 'sure' },
  ];
  assert.equal(chunkMessages(msgs, 20).length, 0);
  const big = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'This is a reasonably long message about my preferences and habits ' + i }));
  const chunks = chunkMessages(big, 20);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 20);
});

test('parseMultipartFile extracts file content', () => {
  const body = '--testboundary\r\nContent-Disposition: form-data; name="file"; filename="conversations.json"\r\nContent-Type: application/json\r\n\r\n{"messages":[]}\r\n--testboundary--\r\n';
  const out = parseMultipartFile(Buffer.from(body, 'utf8'), `multipart/form-data; boundary=testboundary`);
  assert.equal(out, '{"messages":[]}');
  assert.equal(parseMultipartFile(Buffer.from('nope'), 'text/plain'), null);
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-db-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'), {});
  const user = db.createUser({ email: 'owner@example.com', displayName: 'Owner', passwordHash: 'hash', passwordSalt: 'salt', role: 'owner' });
  return { db, user };
}

test('import job lifecycle: create, update, list', () => {
  const { db, user } = fixture();
  const job = db.createImportJob(user.id, 'conversations.json');
  assert.equal(job.status, 'processing');
  assert.equal(job.filename, 'conversations.json');
  const got = db.getImportJob(user.id, job.id);
  assert.equal(got.id, job.id);
  db.updateImportJob(user.id, job.id, { total_chunks: 10, done_chunks: 3, suggestions_added: 5 });
  const updated = db.getImportJob(user.id, job.id);
  assert.equal(updated.total_chunks, 10);
  assert.equal(updated.done_chunks, 3);
  assert.equal(updated.suggestions_added, 5);
  db.updateImportJob(user.id, job.id, { status: 'done' });
  assert.equal(db.getImportJob(user.id, job.id).status, 'done');
  const jobs = db.listImportJobs(user.id);
  assert.equal(jobs.length, 1);
  // Other users can't see it
  const other = db.createUser({ email: 'b@example.com', displayName: 'B', passwordHash: 'h', passwordSalt: 's', role: 'member' });
  assert.equal(db.getImportJob(other.id, job.id), null);
  assert.equal(db.listImportJobs(other.id).length, 0);
});

test('import job failure records error', () => {
  const { db, user } = fixture();
  const job = db.createImportJob(user.id, 'bad.json');
  db.updateImportJob(user.id, job.id, { status: 'failed', error: 'No conversation messages found.' });
  const got = db.getImportJob(user.id, job.id);
  assert.equal(got.status, 'failed');
  assert.ok(got.error.includes('No conversation'));
});
