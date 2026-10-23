import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.js';
import { rankMemories } from '../src/intelligence.js';
import { executeTool } from '../src/tools.js';
import { findDateCandidates } from '../src/proactive-memory.js';
import { detectMemoryPatterns } from '../src/memory-connections.js';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-memory-privacy-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  const user = db.createUser({ email: 'owner@example.com', displayName: 'Owner', passwordHash: 'hash', passwordSalt: 'salt', role: 'owner' });
  return { db, user };
}

test('memory can be edited and made manual-only without losing it', async () => {
  const { db, user } = fixture();
  const memory = db.addMemory(user.id, 'Megan likes tea.', { kind: 'relationship', source: 'explicit' });
  const { result } = await executeTool('update_memory', {
    query: 'Megan likes tea',
    content: 'Megan prefers Earl Grey tea.',
    proactiveAllowed: false,
  }, {}, { db, userId: user.id });
  assert.equal(result.content, 'Megan prefers Earl Grey tea.');
  assert.equal(result.proactiveAllowed, false);
  const stored = db.getMemory(user.id, memory.id);
  assert.equal(stored.proactive_allowed, 0);
  assert.equal(stored.kind, 'relationship');
});

test('manual-only memory needs a direct topical match and never surfaces proactively', () => {
  const { db, user } = fixture();
  const memory = db.addMemory(user.id, 'Mom birthday is October 25.', { kind: 'relationship', source: 'explicit', proactiveAllowed: false });
  assert.equal(rankMemories(db.listMemories(user.id), 'What should I make for dinner?', 8).some((row) => row.id === memory.id), false);
  assert.equal(rankMemories(db.listMemories(user.id), 'What is Mom birthday?', 8).some((row) => row.id === memory.id), true);
  assert.equal(findDateCandidates({ memories: db.listMemories(user.id), nowMs: Date.parse('2026-10-23T12:00:00Z'), timeZone: 'America/New_York' }).length, 0);
  assert.equal(detectMemoryPatterns({ memories: [memory, { ...memory, id: 'two', content: 'Mom birthday plans are ready.' }] }).length, 0);
});

test('memory writes reject secrets at API-tool and database boundaries', async () => {
  const { db, user } = fixture();
  await assert.rejects(() => executeTool('save_memory', { content: 'My password is orbit-secret-123' }, {}, { db, userId: user.id }), /will not store password/);
  assert.throws(() => db.addMemory(user.id, 'Verification code is 123456'), /will not store verification code/);
  assert.throws(() => db.addMemorySuggestion(user.id, 'Use ghp_abcdefghijklmnopqrstuvwxyz123456'), /will not store API key/);
  assert.equal(db.listMemories(user.id).length, 0);
});

test('update_memory never crosses user boundaries and reports ambiguity', async () => {
  const { db, user } = fixture();
  const other = db.createUser({ email: 'other@example.com', displayName: 'Other', passwordHash: 'h', passwordSalt: 's', role: 'member' });
  db.addMemory(other.id, 'Megan likes coffee.', { kind: 'relationship' });
  await assert.rejects(() => executeTool('update_memory', { query: 'Megan', content: 'Changed.' }, {}, { db, userId: user.id }), /couldn't find/);
  db.addMemory(user.id, 'Megan likes tea.', { kind: 'relationship' });
  db.addMemory(user.id, 'Megan likes hiking.', { kind: 'relationship' });
  const { result } = await executeTool('update_memory', { query: 'Megan', proactiveAllowed: false }, {}, { db, userId: user.id });
  assert.equal(result.ambiguous, true);
  assert.equal(result.candidates.length, 2);
});
