import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.js';
import { DatabaseSync } from 'node:sqlite';
import {
  cleanSample,
  extractWritingSamples,
  buildVoiceDistillPrompt,
  parseVoiceProfile,
  buildVoiceStyleDirective,
  learnWritingVoice,
  writingVoiceStatus,
  SENT_SAMPLE_MAX
} from '../src/writing-voice.js';
import { listSentEmails } from '../src/gmail.js';
import { executeTool, TOOL_DEFINITIONS } from '../src/tools.js';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-voice-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'), {});
  const user = db.createUser({ email: 'owner@example.com', displayName: 'Owner', passwordHash: 'hash', passwordSalt: 'salt', role: 'owner' });
  return { db, user };
}

const LONG_BODY = (n) => `Hey there — just checking in on the project timeline for next week. I wanted to confirm the deliverables are on track and see if you need anything from my side before Friday. Let me know what works for a quick call. Thanks so much! Email number ${n}.`;

function mockGmailApi(messageBodies) {
  const originalFetch = global.fetch;
  const encode = (text) => Buffer.from(text, 'utf-8').toString('base64url');
  global.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/messages?')) {
      return { ok: true, json: async () => ({ messages: messageBodies.map((_, i) => ({ id: `m${i}` })) }) };
    }
    const match = /\/messages\/(m\d+)\?format=full/.exec(urlStr);
    if (match) {
      const i = Number(match[1].slice(1));
      return {
        ok: true,
        json: async () => ({
          payload: {
            headers: [{ name: 'Subject', value: `Subject ${i}` }, { name: 'Date', value: 'Thu, 15 Oct 2026 10:00:00 -0400' }],
            mimeType: 'text/plain',
            body: { data: encode(messageBodies[i]) }
          }
        })
      };
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: 'Not mocked' } }) };
  };
  return () => { global.fetch = originalFetch; };
}

test('cleanSample strips quoted replies and rejects short/forwarded mail', () => {
  const withQuotes = `${LONG_BODY(1)}\n> On Tue someone wrote:\n> quoted text here\nOn Monday, someone wrote:\nmore of my own words after the header which keeps it long enough to pass the filter easily.`;
  const cleaned = cleanSample(withQuotes);
  assert.ok(!cleaned.includes('>'), 'quoted lines removed');
  assert.ok(!cleaned.includes('On Monday, someone wrote:'), 'reply header removed');
  assert.ok(cleaned.includes('Hey there'), 'own writing kept');
  assert.equal(cleanSample('too short'), '', 'short bodies rejected');
  assert.equal(cleanSample(`---------- Forwarded message ---------\nFrom: someone\n\n${LONG_BODY(2)}`), '', 'forwards rejected');
});

test('extractWritingSamples filters and caps at SENT_SAMPLE_MAX', () => {
  const emails = Array.from({ length: SENT_SAMPLE_MAX + 5 }, (_, i) => ({ body: LONG_BODY(i) }));
  emails.push({ body: 'short' }, { body: '' }, {});
  const samples = extractWritingSamples(emails);
  assert.equal(samples.length, SENT_SAMPLE_MAX);
  assert.ok(samples.every((s) => s.length >= 50));
});

test('buildVoiceDistillPrompt asks for a style-only profile', () => {
  const prompt = buildVoiceDistillPrompt(['Sample one text here.', 'Sample two text here.']);
  assert.ok(prompt.includes('3-6 sentences'));
  assert.ok(prompt.includes('Sample one text here.'));
  assert.ok(prompt.includes('Do not quote or paraphrase any email content'));
  assert.ok(/second person/i.test(prompt));
});

test('parseVoiceProfile trims, rejects junk, and caps length', () => {
  assert.equal(parseVoiceProfile('  hi  '), '', 'too short rejected');
  assert.equal(parseVoiceProfile('word '.repeat(400)).length <= 1200, true, 'capped at max');
  assert.equal(parseVoiceProfile('  You write warmly and directly.\n\nYou keep your sentences short.  '), 'You write warmly and directly. You keep your sentences short.');
});

test('buildVoiceStyleDirective scopes the voice to drafting', () => {
  const directive = buildVoiceStyleDirective('You write warmly.', 'Edward');
  assert.ok(directive.includes('You write warmly.'));
  assert.ok(directive.includes('Edward'));
  assert.ok(/draft/i.test(directive));
  assert.ok(/normal conversation/i.test(directive));
  const anonymous = buildVoiceStyleDirective('You write warmly.', '');
  assert.ok(anonymous.includes('the user'));
});

test('writing voice DB methods: opt-in, learn, toggle-off keeps profile, forget clears', () => {
  const { db, user } = fixture();
  const initial = db.getWritingVoice(user.id);
  assert.equal(initial.optIn, false);
  assert.equal(initial.profile, null);

  const learned = db.setWritingVoiceProfile(user.id, 'You write warmly and directly.');
  assert.equal(learned.optIn, true, 'learning opts in');
  assert.equal(learned.profile, 'You write warmly and directly.');
  assert.ok(learned.updatedAt, 'updatedAt recorded');

  const off = db.setWritingVoiceOptIn(user.id, false);
  assert.equal(off.optIn, false);
  assert.equal(off.profile, 'You write warmly and directly.', 'toggle-off keeps the profile');

  const backOn = db.setWritingVoiceOptIn(user.id, true);
  assert.equal(backOn.optIn, true);

  const cleared = db.clearWritingVoice(user.id);
  assert.equal(cleared.optIn, false);
  assert.equal(cleared.profile, null);
  assert.equal(cleared.updatedAt, null);
});

test('writingVoiceStatus never includes the profile text', () => {
  const { db, user } = fixture();
  db.setWritingVoiceProfile(user.id, 'You write warmly and directly.');
  const status = writingVoiceStatus(db, user.id);
  assert.deepEqual(Object.keys(status).sort(), ['learned', 'optIn', 'updatedAt']);
  assert.equal(status.learned, true);
  assert.equal(status.optIn, true);
  const freshUser = db.createUser({ email: 'fresh@example.com', displayName: 'Fresh', passwordHash: 'hash', passwordSalt: 'salt', role: 'member' });
  const fresh = writingVoiceStatus(db, freshUser.id);
  assert.equal(fresh.learned, false);
  assert.equal(fresh.optIn, false);
});

test('writing voice columns migrate onto a legacy user_preferences table', () => {
  // Simulate a DB created before X5: user_preferences without the voice columns.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-voice-mig-'));
  const filePath = path.join(directory, 'old.sqlite');
  const raw = new DatabaseSync(filePath);
  raw.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','member')),
    disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE user_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    time_zone TEXT NOT NULL DEFAULT 'America/New_York', quiet_start TEXT NOT NULL DEFAULT '22:00',
    quiet_end TEXT NOT NULL DEFAULT '08:00', proactive_enabled INTEGER NOT NULL DEFAULT 1,
    briefing_tone TEXT NOT NULL DEFAULT 'motivational', briefing_length TEXT NOT NULL DEFAULT 'quick',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  raw.close();
  const db = openDatabase(filePath, {});
  const user = db.createUser({ email: 'owner@example.com', displayName: 'Owner', passwordHash: 'hash', passwordSalt: 'salt', role: 'owner' });
  assert.equal(db.getWritingVoice(user.id).optIn, false, 'opt-in defaults to off after migration');
  db.setWritingVoiceProfile(user.id, 'You write warmly and directly, keeping sentences short and clear.');
  const state = db.getWritingVoice(user.id);
  assert.equal(state.optIn, true);
  assert.ok(state.profile.includes('warmly'));
});

test('listSentEmails reads sent mail bodies via the Gmail API', async () => {
  const restore = mockGmailApi([LONG_BODY(1), LONG_BODY(2)]);
  try {
    const { count, emails } = await listSentEmails(async () => 'fake-token', { max: 30 });
    assert.equal(count, 2);
    assert.ok(emails[0].body.includes('Hey there'));
    assert.equal(emails[0].subject, 'Subject 0');
  } finally { restore(); }
});

test('learnWritingVoice distills and stores a profile from sent mail', async () => {
  const { db, user } = fixture();
  const restore = mockGmailApi([LONG_BODY(1), LONG_BODY(2), LONG_BODY(3)]);
  let capturedPrompt = '';
  const model = { respond: async ({ message }) => { capturedPrompt = message; return { text: 'You write in a warm, direct tone. Your sentences are short and punchy. You open with a quick greeting and close with thanks. You rarely use emoji.' }; } };
  try {
    const result = await learnWritingVoice({ db, userId: user.id, getToken: async () => 'fake-token', model });
    assert.equal(result.learned, true);
    assert.equal(result.sampleCount, 3);
    assert.ok(capturedPrompt.includes('Hey there'), 'samples reach the distillation prompt');
    const state = db.getWritingVoice(user.id);
    assert.equal(state.optIn, true, 'learning opts in');
    assert.ok(state.profile.includes('warm, direct tone'));
  } finally { restore(); }
});

test('learnWritingVoice refuses when there are too few usable samples', async () => {
  const { db, user } = fixture();
  const restore = mockGmailApi(['short']);
  const model = { respond: async () => { throw new Error('model should not be called'); } };
  try {
    await assert.rejects(
      () => learnWritingVoice({ db, userId: user.id, getToken: async () => 'fake-token', model }),
      /usable sent email/
    );
    assert.equal(db.getWritingVoice(user.id).optIn, false, 'no partial opt-in on failure');
  } finally { restore(); }
});

test('learn_writing_voice tool requires gmail and stores the profile', async () => {
  const { db, user } = fixture();
  const restore = mockGmailApi([LONG_BODY(1), LONG_BODY(2), LONG_BODY(3)]);
  const model = { respond: async () => ({ text: 'You write warmly. Your sentences stay short. You open casually and sign off with thanks. You skip heavy formatting.' }) };
  try {
    const ctx = { db, userId: user.id, gmail: { getToken: async () => 'fake-token' }, model };
    const { result } = await executeTool('learn_writing_voice', {}, process.env, ctx);
    assert.equal(result.learned, true);
    assert.equal(result.sampleCount, 3);
    assert.equal(db.getWritingVoice(user.id).optIn, true);
  } finally { restore(); }
});

test('learn_writing_voice tool fails without a gmail connection', async () => {
  const { db, user } = fixture();
  const model = { respond: async () => ({ text: 'x' }) };
  await assert.rejects(
    () => executeTool('learn_writing_voice', {}, process.env, { db, userId: user.id, model }),
    /not connected/i
  );
});

test('forget_writing_voice tool deletes profile and opt-in immediately', async () => {
  const { db, user } = fixture();
  db.setWritingVoiceProfile(user.id, 'You write warmly.');
  const { result } = await executeTool('forget_writing_voice', {}, process.env, { db, userId: user.id });
  assert.equal(result.forgotten, true);
  const state = db.getWritingVoice(user.id);
  assert.equal(state.optIn, false);
  assert.equal(state.profile, null);
});

test('writing voice tools are registered with opt-in gating in their descriptions', () => {
  const defs = Object.fromEntries(TOOL_DEFINITIONS.map((t) => [t.name, t]));
  assert.ok(defs.learn_writing_voice, 'learn tool registered');
  assert.ok(defs.forget_writing_voice, 'forget tool registered');
  assert.match(defs.learn_writing_voice.description, /ONLY when the user explicitly asks/i);
  assert.match(defs.learn_writing_voice.description, /Never call unprompted/i);
  assert.match(defs.forget_writing_voice.description, /"forget how I write"/i);
});
