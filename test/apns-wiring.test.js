// APNs wiring: every user-facing web push must have an iOS (APNs) twin.
// - deliverProactive (morning briefings, check-ins), task completion/failure,
//   door nudge, access requests, waitlist signups, password resets, and the
//   emergency pause all notify via push.notify (web). Each of those sites must
//   also call apns.notify with identical arguments so iPhone users get them.
// - apns.notify is a safe no-op when APNs isn't configured, so the twin is
//   always safe to add.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

// Extract every `name(` call's full argument string, balancing parens.
function extractCalls(src, name) {
  const calls = [];
  const needle = name + '(';
  let idx = 0;
  while (true) {
    const start = src.indexOf(needle, idx);
    if (start === -1) break;
    let depth = 0;
    let i = start + needle.length - 1; // at '('
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    assert.ok(depth === 0, `unbalanced parens in ${name} call at ${start}`);
    calls.push({ args: src.slice(start + needle.length, i), pos: start });
    idx = i + 1;
  }
  return calls;
}

const pushCalls = extractCalls(serverJs, 'push.notify');
const apnsCalls = extractCalls(serverJs, 'apns.notify');
const apnsArgSet = new Set(apnsCalls.map((c) => c.args));

test('every push.notify call site has a matching apns.notify twin', () => {
  assert.ok(pushCalls.length > 0, 'expected push.notify call sites in server.js');
  const missing = pushCalls.filter((c) => !apnsArgSet.has(c.args));
  assert.deepEqual(
    missing.map((c) => c.args.slice(0, 80)),
    [],
    `${missing.length} push.notify call(s) lack an identical apns.notify twin`
  );
});

test('deliverProactive notifies both web push and APNs', () => {
  const idx = serverJs.indexOf('async function deliverProactive(');
  assert.ok(idx > -1, 'deliverProactive must exist');
  const body = serverJs.slice(idx, idx + 1500); // function is short; both calls are inside
  assert.match(body, /push\.notify\(user\.id,buddyNameFor\(user\.id\),text,\{view:'today',conversationId:conversation\.id\}\)/);
  assert.match(body, /apns\.notify\(user\.id,buddyNameFor\(user\.id\),text,\{view:'today',conversationId:conversation\.id\}\)/);
});

test('door nudge notifies both web push and APNs', () => {
  assert.match(serverJs, /push\.notify\(owner\.id,'Registration still open'/);
  assert.match(serverJs, /apns\.notify\(owner\.id,'Registration still open'/);
});

test('task completion and failure notify both web push and APNs', () => {
  assert.match(serverJs, /push\.notify\(task\.user_id,.*finished a task/);
  assert.match(serverJs, /apns\.notify\(task\.user_id,.*finished a task/);
  assert.match(serverJs, /push\.notify\(task\.user_id,.*needs attention/);
  assert.match(serverJs, /apns\.notify\(task\.user_id,.*needs attention/);
});

test('access request, waitlist, password reset, and emergency pause notify APNs', () => {
  assert.match(serverJs, /apns\.notify\(owner\.id,'Access request'/);
  assert.match(serverJs, /apns\.notify\(owner\.id,'New waitlist signup'/);
  assert.match(serverJs, /apns\.notify\(owner\.id,'Password reset requested'/);
  assert.match(serverJs, /apns\.notify\(account\.id,.*paused/);
});

test('apns service is created alongside push service', () => {
  assert.match(serverJs, /const apns=createApnsService\(env,db\)/);
});
