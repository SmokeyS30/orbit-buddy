// Teach Orbit (X3) — regression tests.
// Taught knowledge is EXPLICIT (user gave it); memories are OBSERVED (Orbit
// noticed). The two are stored separately, listed separately, and deletable
// independently. Explicit teaching auto-saves — no tap, no review window.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.js';
import { parseTeachCommand, extractTeachText, teachFilenameForMime, teachMetadataNote } from '../src/teach.js';
import { formatTaughtKnowledge, taughtCiteInstruction } from '../src/model.js';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-teach-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  const user = db.createUser({ email: 'owner@example.com', displayName: 'Owner', passwordHash: 'hash', passwordSalt: 'salt', role: 'owner' });
  const other = db.createUser({ email: 'b@example.com', displayName: 'B', passwordHash: 'h', passwordSalt: 's', role: 'member' });
  return { db, user, other };
}

// --- teach-in-chat command parsing ------------------------------------------

test('parseTeachCommand: matches explicit teaching forms', () => {
  assert.deepEqual(parseTeachCommand("remember that my mom's birthday is June 12"), { content: "my mom's birthday is June 12" });
  assert.deepEqual(parseTeachCommand('teach Orbit that the garage code is 4412'), { content: 'the garage code is 4412' });
  assert.deepEqual(parseTeachCommand('teach that shortcuts save time'), { content: 'shortcuts save time' });
  assert.deepEqual(parseTeachCommand('note that I prefer morning meetings'), { content: 'I prefer morning meetings' });
  assert.deepEqual(parseTeachCommand('  REMEMBER THAT extra spaces  '), { content: 'extra spaces' });
});

test('parseTeachCommand: rejects non-teaching messages', () => {
  assert.equal(parseTeachCommand('remember the milk'), null);
  assert.equal(parseTeachCommand('what do you know about me?'), null);
  assert.equal(parseTeachCommand('teach me piano'), null);
  assert.equal(parseTeachCommand('forget that embarrassing story'), null);
  assert.equal(parseTeachCommand(''), null);
  assert.equal(parseTeachCommand('remember that x'), null, 'content too short');
});

test('handleTeachCommand: explicit teaching auto-saves as taught knowledge', async () => {
  const server = await import('../server.js');
  const { db, user } = fixture();
  const reply = server.handleTeachCommand({ db, userId: user.id, message: "remember that my mom's birthday is June 12" });
  assert.ok(reply.includes("what you've taught me"), 'confirms the save conversationally');
  const taught = db.listTaughtKnowledge(user.id);
  assert.equal(taught.length, 1, 'one taught item saved immediately');
  assert.equal(taught[0].content, "my mom's birthday is June 12");
  assert.equal(taught[0].source, 'chat');
  // Nothing leaks into the observed-memory stores — no tap, no suggestion.
  assert.equal(db.listMemories(user.id).length, 0, 'not stored as a memory');
  assert.equal(db.listMemorySuggestions(user.id).length, 0, 'no suggestion created');
  assert.equal(server.handleTeachCommand({ db, userId: user.id, message: 'what time is it?' }), null);
});

test('taught knowledge: per-user isolation', () => {
  const { db, user, other } = fixture();
  db.addTaughtKnowledge(user.id, 'Owner secret fact', { source: 'chat' });
  assert.equal(db.listTaughtKnowledge(other.id).length, 0, "other user sees nothing");
  assert.equal(db.deleteTaughtKnowledge(other.id, db.listTaughtKnowledge(user.id)[0].id), false, "other user cannot delete");
  assert.equal(db.listTaughtKnowledge(user.id).length, 1, 'owner item untouched');
});

test('taught knowledge: DB round trip + relevance ranking', () => {
  const { db, user } = fixture();
  db.addTaughtKnowledge(user.id, 'The garage code is 4412.', { source: 'chat' });
  db.addTaughtKnowledge(user.id, 'Project Alpha launch notes.', { source: 'upload', title: 'alpha.txt', filename: 'alpha.txt', mimeType: 'text/plain' });
  const all = db.listTaughtKnowledge(user.id);
  assert.equal(all.length, 2);
  assert.equal(all[0].title, 'alpha.txt', 'upload metadata preserved');
  const relevant = db.listRelevantTaughtKnowledge(user.id, 'garage code');
  assert.ok(relevant.length >= 1);
  assert.ok(relevant[0].content.includes('4412'), 'best match ranks first');
  assert.ok(db.deleteTaughtKnowledge(user.id, all[0].id));
  assert.equal(db.listTaughtKnowledge(user.id).length, 1);
});

// --- review: "what do you know about me?" covers taught knowledge -----------

test('handleMemoryCommand: list covers taught knowledge in its own section', async () => {
  const server = await import('../server.js');
  const { db, user } = fixture();
  db.addMemory(user.id, 'Prefers morning briefings.', { kind: 'preference', source: 'user' });
  db.addTaughtKnowledge(user.id, "Mom's birthday is June 12.", { source: 'chat' });
  const list = server.handleMemoryCommand({ db, userId: user.id, message: 'what do you know about me?' });
  assert.ok(list.includes('Prefers morning briefings'), 'memories listed');
  assert.ok(list.includes("What you've taught me"), 'taught section present');
  assert.ok(list.includes("Mom's birthday is June 12"), 'taught item listed');
  assert.ok(/T1\./.test(list), 'taught items use T-numbers, not memory numbering');
});

test('handleMemoryCommand: list works when only taught knowledge exists', async () => {
  const server = await import('../server.js');
  const { db, user } = fixture();
  db.addTaughtKnowledge(user.id, 'Garage code 4412.', { source: 'chat' });
  const list = server.handleMemoryCommand({ db, userId: user.id, message: 'what do you know about me?' });
  assert.ok(list.includes('Garage code 4412'));
  assert.ok(list.includes("What you've taught me"));
});

// --- delete: independent, per-store ------------------------------------------

test('handleMemoryCommand: forget deletes taught items from the right store', async () => {
  const server = await import('../server.js');
  const { db, user } = fixture();
  db.addMemory(user.id, 'Likes hiking on Sundays.', { kind: 'fact', source: 'user' });
  db.addTaughtKnowledge(user.id, 'The hiking trail permit number is ZX-99.', { source: 'chat' });
  const ask = server.handleMemoryCommand({ db, userId: user.id, message: 'forget permit' });
  assert.ok(ask.includes('Forget this?'), 'single taught match asks for confirmation');
  assert.ok(ask.includes('from what you taught me'), 'taught origin is named');
  const done = server.handleMemoryCommand({ db, userId: user.id, message: 'yes' });
  assert.ok(done.includes('forgot'), 'confirms deletion');
  assert.equal(db.listTaughtKnowledge(user.id).length, 0, 'taught item deleted');
  assert.equal(db.listMemories(user.id).length, 1, 'memory untouched');
});

test('handleMemoryCommand: "forget everything I taught you" clears only taught', async () => {
  const server = await import('../server.js');
  const { db, user } = fixture();
  db.addMemory(user.id, 'Likes hiking.', { kind: 'fact', source: 'user' });
  db.addTaughtKnowledge(user.id, 'Garage code 4412.', { source: 'chat' });
  db.addTaughtKnowledge(user.id, 'Wifi password is hunter2.', { source: 'chat' });
  const ask = server.handleMemoryCommand({ db, userId: user.id, message: 'forget everything I taught you' });
  assert.ok(ask.includes('delete all 2 things you\'ve taught me'), 'asks to confirm taught-only delete');
  assert.ok(ask.includes('what I remember about you stays'), 'memories explicitly stay');
  const done = server.handleMemoryCommand({ db, userId: user.id, message: 'yes' });
  assert.ok(done.includes('forgot 2 things you taught me'));
  assert.equal(db.listTaughtKnowledge(user.id).length, 0);
  assert.equal(db.listMemories(user.id).length, 1, 'memory survives');
});

test('handleMemoryCommand: "forget everything" (memories) leaves taught alone', async () => {
  const server = await import('../server.js');
  const { db, user } = fixture();
  db.addMemory(user.id, 'Likes hiking.', { kind: 'fact', source: 'user' });
  db.addTaughtKnowledge(user.id, 'Garage code 4412.', { source: 'chat' });
  const ask = server.handleMemoryCommand({ db, userId: user.id, message: 'forget everything' });
  assert.ok(ask.includes('What you\'ve taught me stays'), 'taught independence is stated');
  const done = server.handleMemoryCommand({ db, userId: user.id, message: 'yes' });
  assert.ok(done.includes('forgot'));
  assert.equal(db.listMemories(user.id).length, 0, 'memories deleted');
  assert.equal(db.listTaughtKnowledge(user.id).length, 1, 'taught knowledge survives');
});

// --- document ingest: best-effort extraction, nothing rejected by type --------

function minimalPdf() {
  return Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n' +
    '4 0 obj\n<< /Length 46 >>\nstream\nBT /F1 24 Tf 100 700 Td (Hello PDF world) Tj ET\nendstream\nendobj\n' +
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
    'trailer\n<< /Root 1 0 R >>\n%%EOF', 'latin1');
}

function minimalDocx(xmlBody) {
  const name = Buffer.from('word/document.xml', 'utf8');
  const data = Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${xmlBody}</w:body></w:document>`, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
  local.writeUInt32LE(0, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt32LE(0, 14);
  cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(0, 42);
  const cdStart = local.length + name.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + name.length, 12); eocd.writeUInt32LE(cdStart, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([local, name, data, cd, name, eocd]);
}

test('extractTeachText: plain text passes through', () => {
  const r = extractTeachText({ bytes: Buffer.from('Meeting notes\n- buy milk', 'utf8'), filename: 'notes.txt', mimeType: 'text/plain' });
  assert.equal(r.extraction, 'text');
  assert.ok(r.text.includes('Meeting notes'));
  assert.equal(r.needsVision, false);
});

test('extractTeachText: PDF text is extracted best-effort', () => {
  const r = extractTeachText({ bytes: minimalPdf(), filename: 'doc.pdf', mimeType: 'application/pdf' });
  assert.equal(r.extraction, 'pdf');
  assert.ok(r.text.includes('Hello PDF world'), `got: ${r.text.slice(0, 80)}`);
});

test('extractTeachText: DOCX text is extracted best-effort', () => {
  const xml = '<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>DOCX</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t></w:r></w:p>';
  const r = extractTeachText({ bytes: minimalDocx(xml), filename: 'doc.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  assert.equal(r.extraction, 'docx');
  assert.ok(r.text.includes('Hello DOCX'), `got: ${r.text.slice(0, 80)}`);
  assert.ok(r.text.includes('Second line'));
});

test('extractTeachText: images flag for the vision pipeline', () => {
  const r = extractTeachText({ bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), filename: 'photo.jpg', mimeType: 'image/jpeg' });
  assert.equal(r.extraction, 'image');
  assert.equal(r.needsVision, true);
});

test('extractTeachText: unknown types are accepted, stored as an honest note', () => {
  const r = extractTeachText({ bytes: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x01]), filename: 'tool.exe', mimeType: 'application/x-msdownload' });
  assert.equal(r.extraction, 'metadata');
  assert.ok(r.text.includes('tool.exe'), 'the note names the file');
  assert.ok(r.text.includes("couldn't extract readable text"), 'the note is honest');
});

test('teachFilenameForMime: derives a usable filename for WhatsApp media', () => {
  assert.equal(teachFilenameForMime('application/pdf'), 'shared-document.pdf');
  assert.equal(teachFilenameForMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'shared-document.docx');
  assert.ok(teachFilenameForMime('').endsWith('.file'));
});

test('teachMetadataNote: names the file and stays honest', () => {
  const note = teachMetadataNote({ filename: 'x.bin', mimeType: 'application/octet-stream', bytes: Buffer.alloc(10), reason: 'no parser' });
  assert.ok(note.includes('x.bin'));
  assert.ok(note.includes('no parser'));
});

// --- citation: taught knowledge is cited when used ----------------------------

test('formatTaughtKnowledge: builds the prompt section with titles', () => {
  const section = formatTaughtKnowledge([
    { title: 'alpha.txt', content: 'Launch is in May.' },
    { title: '', content: "Mom's birthday is June 12." },
  ]);
  assert.ok(section.includes('explicitly taught you'), 'labels the source');
  assert.ok(section.includes('"alpha.txt": Launch is in May.'), 'upload title is cited');
  assert.ok(section.includes("Mom's birthday is June 12."), 'chat-taught content included');
  assert.equal(formatTaughtKnowledge([]), '', 'empty when nothing taught');
});

test('taughtCiteInstruction: asks for a brief natural cite', () => {
  const instruction = taughtCiteInstruction();
  assert.ok(instruction.includes('from what you taught me'), 'names the cite phrase');
  assert.ok(instruction.includes('briefly'), 'keeps it short');
});
