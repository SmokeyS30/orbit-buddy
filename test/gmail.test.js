import test from 'node:test';
import assert from 'node:assert/strict';
import { sendEmail, searchEmails, readEmail } from '../src/gmail.js';
import { toolGmailDelete, toolGmailSend, toolGmailSearch, TOOL_DEFINITIONS, executeTool } from '../src/tools.js';

// Mock getToken that returns a fake token
const mockGetToken = async () => 'fake-token';

// Mock fetch for Gmail API
function mockGmailApi(responses) {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const urlStr = String(url);
    for (const [pattern, response] of responses) {
      if (urlStr.includes(pattern)) {
        return { ok: true, json: async () => response };
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: 'Not mocked' } }) };
  };
  return () => { global.fetch = originalFetch; };
}

test('gmail tools are registered in TOOL_DEFINITIONS', () => {
  assert.equal(TOOL_DEFINITIONS.length, 29);
  const names = TOOL_DEFINITIONS.map((t) => t.name).sort();
  assert.ok(names.includes('gmail_send'));
  assert.ok(names.includes('gmail_search'));
  assert.ok(names.includes('gmail_read'));
  assert.ok(names.includes('gmail_delete'));
});

test('sendEmail validates inputs', async () => {
  await assert.rejects(() => sendEmail(mockGetToken, { to: '', subject: 'Hi', body: 'Test' }), /recipient/);
  await assert.rejects(() => sendEmail(mockGetToken, { to: 'not-an-email', subject: 'Hi', body: 'Test' }), /valid email/);
  await assert.rejects(() => sendEmail(mockGetToken, { to: 'a@b.com', subject: '', body: 'Test' }), /subject/);
});

test('sendEmail encodes and sends', async () => {
  const restore = mockGmailApi([['/messages/send', { id: 'msg123' }]]);
  try {
    const result = await sendEmail(mockGetToken, { to: 'test@example.com', subject: 'Hello', body: 'World' });
    assert.equal(result.sent, true);
    assert.equal(result.messageId, 'msg123');
    assert.equal(result.to, 'test@example.com');
  } finally { restore(); }
});

test('searchEmails returns formatted results', async () => {
  const restore = mockGmailApi([
    ['/messages?q=', { messages: [{ id: 'abc123' }] }],
    ['/messages/abc123', {
      payload: { headers: [
        { name: 'From', value: 'sender@example.com' },
        { name: 'Subject', value: 'Test Subject' },
        { name: 'Date', value: 'Mon, 05 Oct 2026 10:00:00 -0400' }
      ]},
      snippet: 'Email preview text'
    }]
  ]);
  try {
    const result = await searchEmails(mockGetToken, { query: 'from:sender@example.com', max: 5 });
    assert.equal(result.count, 1);
    assert.equal(result.emails[0].from, 'sender@example.com');
    assert.equal(result.emails[0].subject, 'Test Subject');
  } finally { restore(); }
});

test('toolGmailSend throws when Gmail not connected', async () => {
  const ctx = { db: {}, userId: 'u1' }; // no gmail helper
  await assert.rejects(() => toolGmailSend({ to: 'a@b.com', subject: 'Hi', body: 'Test' }, ctx), /not connected/);
});

test('toolGmailSearch throws when Gmail not connected', async () => {
  const ctx = { db: {}, userId: 'u1' };
  await assert.rejects(() => toolGmailSearch({ query: 'test' }, ctx), /not connected/);
});

test('gmail write tools create approvals without calling Gmail', async () => {
  const approvals = [];
  const db = { addApproval: (_userId, value) => { approvals.push(value); return { id: `a${approvals.length}`, status: 'pending', ...value }; } };
  const ctx = { db, userId: 'u1', messageId: 'm1', gmail: { getToken: mockGetToken } };

  const sent = await toolGmailSend({ to: 'test@example.com', subject: 'Hi', body: 'Hello' }, ctx);
  assert.equal(sent.status, 'pending');
  assert.equal(approvals[0].kind, 'gmail_send');
  assert.equal(approvals[0].payload.to, 'test@example.com');

  const deleted = await toolGmailDelete({ id: 'msg456', subject: 'Old note', from: 'sender@example.com' }, ctx);
  assert.equal(deleted.status, 'pending');
  assert.equal(approvals[1].kind, 'gmail_delete');
  assert.equal(approvals[1].payload.id, 'msg456');
});

test('executeTool routes Gmail writes to the approval gate', async () => {
  const db = { addApproval: (_userId, value) => ({ id: 'a1', status: 'pending', ...value }) };
  const ctx = { db, userId: 'u1', gmail: { getToken: mockGetToken } };
  const { result } = await executeTool('gmail_send', { to: 'test@example.com', subject: 'Hi', body: 'Hello' }, {}, ctx);
  assert.equal(result.status, 'pending');
  assert.equal(result.kind, 'gmail_send');
});
