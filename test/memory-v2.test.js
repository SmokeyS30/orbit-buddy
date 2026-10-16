import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.js';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-memv2-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  const user = db.createUser({ email: 'owner@example.com', displayName: 'Owner', passwordHash: 'hash', passwordSalt: 'salt', role: 'owner' });
  return { db, user };
}

test('auto-approve: fresh suggestion stays pending, stale one auto-saves', () => {
  const { db, user } = fixture();
  const fresh = db.addMemorySuggestion(user.id, 'Prefers morning briefings', { kind: 'preference' });
  const stale = db.addMemorySuggestion(user.id, 'Studies for CompTIA Security+', { kind: 'fact' });
  // window=0 treats both as stale (past the review window) -> both auto-save.
  assert.equal(db.autoApproveMemorySuggestions(user.id, 0), 2, 'window=0 auto-saves both suggestions');
  assert.equal(db.listMemorySuggestions(user.id).length, 0);
  const memories = db.listMemories(user.id);
  assert.equal(memories.length, 2);
  assert.ok(memories.every((m) => m.source === 'auto-suggestion'), 'auto-saved memories carry the auto source');
  assert.ok(!db.listMemorySuggestions(user.id).find((s) => s.id === fresh.id));
  assert.ok(stale.id !== fresh.id);
});

test('auto-approve: suggestion within the review window stays pending', () => {
  const { db, user } = fixture();
  db.addMemorySuggestion(user.id, 'Prefers concise answers', { kind: 'preference' });
  assert.equal(db.autoApproveMemorySuggestions(user.id, 15), 0, 'fresh suggestion is not auto-saved');
  assert.equal(db.listMemorySuggestions(user.id).length, 1);
  assert.equal(db.listMemories(user.id).length, 0);
});

test('auto-approve: contradictory suggestion is never auto-saved', () => {
  const { db, user } = fixture();
  db.addMemory(user.id, 'Likes pepperoni pizza.', { kind: 'preference', source: 'user' });
  // "Doesn't like pepperoni pizza" contradicts via negation-polarity flip + token overlap
  db.addMemorySuggestion(user.id, "Doesn't like pepperoni pizza.", { kind: 'preference' });
  assert.equal(db.autoApproveMemorySuggestions(user.id, 0), 0, 'contradiction stays pending');
  assert.equal(db.listMemorySuggestions(user.id).length, 1, 'still awaiting explicit approval');
  assert.equal(db.listMemories(user.id).length, 1, 'original memory untouched');
});

test('auto-approve: per-user isolation — other users untouched', () => {
  const { db, user } = fixture();
  const other = db.createUser({ email: 'b@example.com', displayName: 'B', passwordHash: 'h', passwordSalt: 's', role: 'member' });
  db.addMemorySuggestion(other.id, 'Other user fact', { kind: 'fact' });
  db.addMemorySuggestion(user.id, 'Owner fact', { kind: 'fact' });
  assert.equal(db.autoApproveMemorySuggestions(user.id, 0), 1);
  assert.equal(db.listMemorySuggestions(other.id).length, 1, "other user's suggestion untouched");
  assert.equal(db.listMemories(other.id).length, 0);
});

test('intent matchers: list / more / confirm / cancel / forget parsing', async () => {
  const server = await import('../server.js');
  assert.ok(server.isMemoryListRequest('what do you know about me?'));
  assert.ok(server.isMemoryListRequest('What do you remember'));
  assert.ok(server.isMemoryListRequest('list my memories'));
  assert.ok(!server.isMemoryListRequest('what do you know about france?'));
  assert.ok(server.isMemoryMoreRequest('more'));
  assert.ok(!server.isMemoryMoreRequest('more cheese please'));
  assert.ok(server.isMemoryConfirm('yes'));
  assert.ok(server.isMemoryConfirm('Yeah.'));
  assert.ok(!server.isMemoryConfirm('yesterday'));
  assert.ok(server.isMemoryCancel('never mind'));
  assert.deepEqual(server.parseForgetRequest('forget my birthday'), { kind: 'single', query: 'my birthday' });
  assert.deepEqual(server.parseForgetRequest('forget everything about pizza'), { kind: 'bulk', query: 'pizza' });
  assert.deepEqual(server.parseForgetRequest('forget all about my ex'), { kind: 'bulk', query: 'my ex' });
  assert.deepEqual(server.parseForgetRequest('forget 2'), { kind: 'pick', index: 2 });
  assert.equal(server.parseForgetRequest('forget'), null);
  assert.equal(server.parseForgetRequest('remember that my mom is great'), null);
});

test('handleMemoryCommand: list, paginate, and forget flow via chat', async () => {
  const server = await import('../server.js');
  const { db, user } = fixture();
  db.addMemory(user.id, 'Prefers morning briefings.', { kind: 'preference', source: 'user' });
  db.addMemory(user.id, 'Mom\u2019s birthday is May 3rd.', { kind: 'fact', source: 'user' });
  db.addMemory(user.id, 'Studying for CompTIA Security+.', { kind: 'goal', source: 'user' });

  const list = server.handleMemoryCommand({ db, userId: user.id, message: 'what do you know about me?' });
  assert.ok(list.includes('Prefers morning briefings'), 'lists saved memories');
  assert.ok(list.includes('(3 total)'), 'reports the total count');

  const forget = server.handleMemoryCommand({ db, userId: user.id, message: 'forget briefings' });
  assert.ok(forget.includes('Forget this?'), 'single match asks for confirmation');
  const confirm = server.handleMemoryCommand({ db, userId: user.id, message: 'yes' });
  assert.ok(confirm.includes('forgot'), 'confirms deletion');
  assert.equal(db.listMemories(user.id).length, 2, 'memory actually deleted');
  assert.ok(!db.listMemories(user.id).some((m) => m.content.includes('briefings')));

  const cancel = server.handleMemoryCommand({ db, userId: user.id, message: 'forget mom' });
  assert.ok(cancel.includes('Forget this?'));
  const no = server.handleMemoryCommand({ db, userId: user.id, message: 'no' });
  assert.ok(no.includes('nothing deleted'), 'cancel keeps the memory');
  assert.equal(db.listMemories(user.id).length, 2);
});

test('handleMemoryCommand: bulk forget with confirmation', async () => {
  const server = await import('../server.js');
  const { db, user } = fixture();
  db.addMemory(user.id, 'Likes pepperoni pizza.', { kind: 'preference', source: 'user' });
  db.addMemory(user.id, 'Orders pizza every Friday.', { kind: 'fact', source: 'user' });
  const bulk = server.handleMemoryCommand({ db, userId: user.id, message: 'forget everything about pizza' });
  assert.ok(bulk.includes('found 2 memories'), 'multi-match lists count');
  const confirmAll = server.handleMemoryCommand({ db, userId: user.id, message: 'forget all' });
  assert.ok(confirmAll.includes('Delete all 2'), 'asks to confirm bulk delete');
  const yes = server.handleMemoryCommand({ db, userId: user.id, message: 'yes' });
  assert.ok(yes.includes('forgot 2'), 'bulk delete confirmed');
  assert.equal(db.listMemories(user.id).length, 0);
});

test('handleMemoryCommand: per-user isolation on delete', async () => {
  const server = await import('../server.js');
  const { db, user } = fixture();
  const other = db.createUser({ email: 'b@example.com', displayName: 'B', passwordHash: 'h', passwordSalt: 's', role: 'member' });
  db.addMemory(other.id, 'Other user secret.', { kind: 'fact', source: 'user' });
  db.addMemory(user.id, 'Owner likes hiking.', { kind: 'fact', source: 'user' });
  const list = server.handleMemoryCommand({ db, userId: user.id, message: 'what do you know about me?' });
  assert.ok(!list.includes('Other user secret'), 'never surfaces another user\u2019s memories');
  assert.ok(list.includes('Owner likes hiking'));
});
