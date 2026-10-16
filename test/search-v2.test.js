import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  searchMessages,
  classifyContentType,
  parseSearchFilterParams,
  applySearchFilters,
  isValidSearchDate,
} from '../src/conversation-search.js';

// --- classifyContentType ---
test('classifyContentType: fences and code signals vs prose', () => {
  assert.equal(classifyContentType('Here is the fix:\n```js\nconst x = 1;\n```'), 'code', 'fenced block => code');
  assert.equal(classifyContentType('    const x = 1;\n    return x;'), 'code', 'indented block => code');
  assert.equal(
    classifyContentType('Use `foo()`, then `bar()`, and finally `baz()` to finish.'),
    'code',
    'inline-code heavy => code'
  );
  assert.equal(
    classifyContentType('const orbit = "fast";\nlet count = orbit.length;\nreturn count;'),
    'code',
    'declaration signals => code'
  );
  assert.equal(classifyContentType('That sounds like a lovely plan for the weekend!'), 'prose', 'plain prose');
  assert.equal(classifyContentType(''), 'prose', 'empty => prose');
  assert.equal(classifyContentType('I ran the `deploy` command once.'), 'prose', 'one inline span is not code-heavy');
  assert.equal(classifyContentType(null), 'prose', 'null => prose');
});

// --- isValidSearchDate ---
test('isValidSearchDate: strict YYYY-MM-DD', () => {
  assert.ok(isValidSearchDate('2026-10-15'));
  assert.ok(!isValidSearchDate('2026-13-01'), 'month 13 invalid');
  assert.ok(!isValidSearchDate('2026-02-30'), 'Feb 30 invalid');
  assert.ok(!isValidSearchDate('15/10/2026'), 'wrong format');
  assert.ok(!isValidSearchDate('2026-10-15T00:00'), 'datetime rejected');
  assert.ok(!isValidSearchDate('garbage'));
  assert.ok(!isValidSearchDate(''));
  assert.ok(isValidSearchDate('2024-02-29'), 'leap day valid');
  assert.ok(!isValidSearchDate('2025-02-29'), 'non-leap Feb 29 invalid');
});

// --- parseSearchFilterParams ---
test('parseSearchFilterParams: accepts valid filters, rejects garbage', () => {
  const sp = (obj) => new URLSearchParams(obj);
  assert.deepEqual(parseSearchFilterParams(sp({})), {});
  assert.deepEqual(parseSearchFilterParams(sp({ type: 'all' })), {});
  assert.deepEqual(
    parseSearchFilterParams(sp({ from: '2026-10-01', to: '2026-10-15', type: 'code', conversationId: 'c1' }), { conversationExists: (id) => id === 'c1' }),
    { from: '2026-10-01', to: '2026-10-15', conversationId: 'c1', type: 'code' }
  );
  const bad = (obj) => {
    const err = (() => { try { parseSearchFilterParams(sp(obj)); return null; } catch (e) { return e; } })();
    assert.ok(err, `expected throw for ${JSON.stringify(obj)}`);
    return err;
  };
  assert.equal(bad({ from: 'not-a-date' }).status, 400);
  assert.equal(bad({ to: '10/15/2026' }).status, 400);
  assert.equal(bad({ from: '2026-10-20', to: '2026-10-15' }).status, 400, 'from after to');
  assert.equal(bad({ type: 'images' }).status, 400);
  function bad2(obj) { try { parseSearchFilterParams(sp(obj), { conversationExists: () => false }); } catch (e) { return e; } return null; }
  assert.equal(bad2({ conversationId: 'c-other-user' }).status, 404, 'cross-user conversationId 404s');
  assert.equal(bad2({ conversationId: 'c1' }).status, 404);
  const ok = parseSearchFilterParams(sp({ conversationId: 'mine' }), { conversationExists: () => true });
  assert.equal(ok.conversationId, 'mine');
});

// --- applySearchFilters + searchMessages integration ---
const corpus = [
  { id: 'a1', conversation_id: 'c1', content: 'I love pepperoni pizza more than anything', created_at: '2026-10-01T10:00:00Z' },
  { id: 'a2', conversation_id: 'c1', content: 'pizza recipe: ```js\nconst pizza = bake();\n```', created_at: '2026-10-10T10:00:00Z' },
  { id: 'a3', conversation_id: 'c2', content: 'pizza night with friends was great', created_at: '2026-10-20T10:00:00Z' },
  { id: 'a4', conversation_id: 'c2', content: 'the weather is nice today', created_at: '2026-10-25T10:00:00Z' },
];

test('applySearchFilters: date range is inclusive', () => {
  const hits = applySearchFilters(corpus, { from: '2026-10-10', to: '2026-10-20' });
  assert.deepEqual(hits.map((m) => m.id), ['a2', 'a3']);
  assert.deepEqual(applySearchFilters(corpus, { from: '2026-10-10' }).map((m) => m.id), ['a2', 'a3', 'a4']);
  assert.deepEqual(applySearchFilters(corpus, { to: '2026-10-01' }).map((m) => m.id), ['a1']);
  assert.deepEqual(applySearchFilters(corpus, { from: '2026-12-01' }), []);
});

test('applySearchFilters: conversation scoping and type filter', () => {
  assert.deepEqual(applySearchFilters(corpus, { conversationId: 'c1' }).map((m) => m.id), ['a1', 'a2']);
  assert.deepEqual(applySearchFilters(corpus, { type: 'code' }).map((m) => m.id), ['a2']);
  assert.deepEqual(applySearchFilters(corpus, { type: 'prose' }).map((m) => m.id), ['a1', 'a3', 'a4']);
  assert.deepEqual(
    applySearchFilters(corpus, { conversationId: 'c2', type: 'prose' }).map((m) => m.id),
    ['a3', 'a4']
  );
  assert.deepEqual(
    applySearchFilters(corpus, { from: '2026-10-05', to: '2026-10-15', type: 'code' }).map((m) => m.id),
    ['a2']
  );
});

test('searchMessages: filters apply before scoring; unfiltered behavior unchanged', () => {
  // Regression: same ranking for the same corpus when no filters are given.
  // (Compare ids/order, not exact scores — the recency boost is time-based.)
  const orderOf = (res) => res.map((r) => r.message.id);
  const before = searchMessages(corpus, 'pizza', 20);
  assert.deepEqual(orderOf(searchMessages(corpus, 'pizza', 20, null)), orderOf(before));
  assert.deepEqual(orderOf(searchMessages(corpus, 'pizza', 20, {})), orderOf(before));
  assert.deepEqual(orderOf(searchMessages(corpus, 'pizza')), orderOf(before));
  assert.ok(before.length >= 3, 'unfiltered finds all pizza messages');

  const coded = searchMessages(corpus, 'pizza', 20, { type: 'code' });
  assert.deepEqual(coded.map((r) => r.message.id), ['a2']);

  const ranged = searchMessages(corpus, 'pizza', 20, { from: '2026-10-15', to: '2026-10-25' });
  assert.deepEqual(ranged.map((r) => r.message.id), ['a3']);

  const scoped = searchMessages(corpus, 'pizza', 20, { conversationId: 'c2' });
  assert.deepEqual(scoped.map((r) => r.message.id), ['a3']);

  // Limits still apply after filtering.
  const limited = searchMessages(corpus, 'pizza', 1, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(limited.length, 1);
});

// --- Server endpoint integration ---
const { createOrbitServer } = await import('../server.js');

async function fixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-search-v2-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', ...extraEnv } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function register(base, { email = 'owner@example.com', displayName = 'Owner' } = {}) {
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, displayName, password: 'correct horse battery staple' }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrf, body };
}

const authHeaders = ({ cookie, csrf }) => ({ Cookie: cookie, 'X-Orbit-CSRF': csrf, 'Content-Type': 'application/json' });

test('GET /api/search/messages: filters end to end, ownership enforced', async (t) => {
  const { app, base } = await fixture();
  t.after(() => app.close());
  const me = await register(base);
  // Registration is owner-only; simulate the foreign user via direct DB writes.

  // Learn the owner's user id from the register response.
  const mine = me.body.user.id;
  assert.ok(mine, 'register exposes owner id');

  const c1 = app.db.createConversation(mine, 'Recipes');
  const c2 = app.db.createConversation(mine, 'Weekend');
  const foreignUser = app.db.createUser({ email: 'other@example.com', displayName: 'Other', passwordHash: 'x', passwordSalt: 'y', role: 'member' });
  const otherConvo = app.db.createConversation(foreignUser.id, 'Theirs');

  const seed = (convoId, content, createdAt) => {
    const m = app.db.addMessage(mine, convoId, 'assistant', content);
    app.db.retimeMessage(mine, m.id, createdAt);
    return m;
  };
  seed(c1.id, 'Here is the pizza recipe you asked for.', '2026-10-01T12:00:00Z');
  seed(c1.id, 'Pizza code:\n```js\nconst bake = () => 450;\n```', '2026-10-10T12:00:00Z');
  seed(c2.id, 'Pizza night was great fun.', '2026-10-20T12:00:00Z');
  const foreignMsg = app.db.addMessage(foreignUser.id, otherConvo.id, 'assistant', 'pizza pizza pizza foreign');
  void foreignMsg;

  const search = (qs, who = me) =>
    fetch(`${base}/api/search/messages${qs}`, { headers: authHeaders(who) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  // Unfiltered baseline: only the owner's 3 pizza messages, never the foreign one.
  let r = await search('?q=pizza');
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 3);

  // Date range filter.
  r = await search('?q=pizza&from=2026-10-05&to=2026-10-15');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items.map((i) => i.conversationId), [c1.id]);
  assert.equal(r.body.items.length, 1);

  // Type filter.
  r = await search('?q=pizza&type=code');
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 1);
  assert.match(r.body.items[0].excerpt, /```/);

  r = await search('?q=pizza&type=prose');
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 2);

  // Conversation scoping.
  r = await search(`?q=pizza&conversationId=${c2.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items.map((i) => i.conversationId), [c2.id]);

  // Cross-user conversationId => 404, never leaks.
  r = await search(`?q=pizza&conversationId=${otherConvo.id}`);
  assert.equal(r.status, 404);

  // Validation errors.
  r = await search('?q=pizza&from=not-a-date');
  assert.equal(r.status, 400);
  r = await search('?q=pizza&type=song');
  assert.equal(r.status, 400);
  r = await search('?q=pizza&from=2026-10-20&to=2026-10-10');
  assert.equal(r.status, 400);
});
