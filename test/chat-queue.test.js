import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CHAT_QUEUE_KEY,
  loadChatQueue,
  saveChatQueue,
  createChatQueueEntry,
  enqueueChatMessage,
  removeChatQueueEntry,
  isEntrySendableUnder,
  nextSendableEntry,
  legacyEntries,
  flushChatQueueEntries,
} from '../public/chat-queue.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function failingWriteStorage() {
  const storage = memoryStorage();
  let failWrites = false;
  return {
    getItem: storage.getItem,
    removeItem: storage.removeItem,
    setItem(key, value) {
      if (failWrites) throw new Error('quota exceeded');
      storage.setItem(key, value);
    },
    failWrites() { failWrites = true; },
  };
}

let seq = 0;
function entry(ownerId, text = 'hello') {
  seq += 1;
  return createChatQueueEntry({
    id: `q${seq}`,
    text: `${text} ${seq}`,
    conversationId: 'conv-1',
    ownerId,
    queuedAt: new Date(2026, 9, 28, 12, 0, seq).toISOString(),
  });
}

// Mirrors the flush loop in public/app.js using only the module's
// primitives: fresh read each round, send only the next entry bound to
// the signed-in account, remove by id only after a successful send.
// `send` may throw ({auth:true}) or ({network:true}) to simulate failures.
async function flush(storage, ownerId, send) {
  const sent = [];
  await flushChatQueueEntries({
    storage,
    ownerId,
    send,
    shouldRetry: (error) => !!(error && (error.auth || error.network)),
    onSent: (_response, queued) => { sent.push(queued); },
  });
  return sent;
}

test('entries are bound to the account that queued them', async () => {
  const storage = memoryStorage();
  enqueueChatMessage(storage, entry('account-a'));
  enqueueChatMessage(storage, entry('account-b'));
  enqueueChatMessage(storage, entry('account-a'));

  const sentByB = await flush(storage, 'account-b', async () => {});
  assert.equal(sentByB.length, 1);
  assert.equal(sentByB[0].ownerId, 'account-b');

  const remaining = loadChatQueue(storage);
  assert.equal(remaining.length, 2);
  assert.ok(remaining.every((e) => e.ownerId === 'account-a'), 'account A entries stay queued, untouched');
});

test('sign-out and re-login: queued entries wait for their own account', async () => {
  const storage = memoryStorage();
  enqueueChatMessage(storage, entry('account-a'));

  // Signed out: nothing is sendable under no account.
  assert.equal(nextSendableEntry(loadChatQueue(storage), null), null);
  // A different account signing in must not inherit the queue.
  assert.equal(await flush(storage, 'account-b', async () => {}).then((s) => s.length), 0);
  assert.equal(loadChatQueue(storage).length, 1);
  // The original account signing back in flushes normally.
  const sent = await flush(storage, 'account-a', async () => {});
  assert.equal(sent.length, 1);
  assert.equal(loadChatQueue(storage).length, 0);
});

test('legacy unbound entries are never auto-sent under any account', async () => {
  const storage = memoryStorage();
  // Shape written by pre-binding builds: no ownerId field at all.
  saveChatQueue(storage, [
    { id: 'old-1', text: 'from before the update', conversationId: 'conv-1', queuedAt: '2026-10-20T00:00:00.000Z' },
    entry('account-a'),
  ]);
  assert.equal(legacyEntries(loadChatQueue(storage)).length, 1);
  assert.equal(isEntrySendableUnder(loadChatQueue(storage)[0], 'account-a'), false);

  const sent = await flush(storage, 'account-a', async () => {});
  assert.equal(sent.length, 1, 'only the bound entry is sent');
  const remaining = loadChatQueue(storage);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, 'old-1', 'legacy entry is preserved, not sent and not deleted');

  // Not under any other account either.
  assert.equal((await flush(storage, 'account-b', async () => {})).length, 0);
  assert.equal(loadChatQueue(storage).length, 1);
});

test('an entry queued while signed out is treated as unbound', () => {
  const e = entry(null);
  assert.equal(e.ownerId, null);
  assert.equal(isEntrySendableUnder(e, 'account-a'), false);
});

test('a message enqueued mid-flush is not overwritten by the flush', async () => {
  const storage = memoryStorage();
  enqueueChatMessage(storage, entry('account-a', 'first'));

  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const flushing = flush(storage, 'account-a', async () => {
    calls += 1;
    if (calls === 1) await gate; // hold the first send open
  });

  // While the first send is in flight, the user queues another message.
  enqueueChatMessage(storage, entry('account-a', 'second'));
  releaseFirst();

  const sent = await flushing;
  assert.equal(sent.length, 2, 'both messages are sent exactly once');
  assert.equal(loadChatQueue(storage).length, 0);
});

test('removal is by id against fresh storage, exactly once', () => {
  const storage = memoryStorage();
  const a = entry('account-a');
  const b = entry('account-a');
  enqueueChatMessage(storage, a);
  enqueueChatMessage(storage, b);

  removeChatQueueEntry(storage, a.id);
  assert.deepEqual(loadChatQueue(storage).map((e) => e.id), [b.id]);
  // Removing the same id again changes nothing.
  removeChatQueueEntry(storage, a.id);
  assert.deepEqual(loadChatQueue(storage).map((e) => e.id), [b.id]);
});

test('queue writes report success and failure instead of silently claiming persistence', () => {
  const storage = failingWriteStorage();
  const queued = entry('account-a');
  assert.equal(enqueueChatMessage(storage, queued), queued);
  storage.failWrites();

  assert.equal(enqueueChatMessage(storage, entry('account-a')), null, 'a failed append is surfaced');
  assert.equal(removeChatQueueEntry(storage, queued.id), false, 'a failed removal is surfaced');
  assert.deepEqual(loadChatQueue(storage).map((item) => item.id), [queued.id], 'failed writes do not change durable state');
});

test('an accepted message is not repeatedly sent in-session when durable removal fails', async () => {
  const storage = failingWriteStorage();
  const queued = entry('account-a');
  enqueueChatMessage(storage, queued);
  storage.failWrites();
  const blockedIds = new Set();
  let sends = 0;

  const first = await flushChatQueueEntries({
    storage,
    ownerId: 'account-a',
    blockedIds,
    send: async () => { sends += 1; return { id: 'server-message' }; },
  });
  assert.equal(sends, 1);
  assert.equal(first.persistenceFailed, true);
  assert.equal(first.deliveryUncertain, true);
  assert.equal(first.blockedEntryId, queued.id);
  assert.equal(loadChatQueue(storage).length, 1, 'the failed removal remains visible in durable storage');

  const second = await flushChatQueueEntries({
    storage,
    ownerId: 'account-a',
    blockedIds,
    send: async () => { sends += 1; },
  });
  assert.equal(sends, 1, 'a later connection wake does not resend the uncertain entry');
  assert.equal(second.sent, 0);
});

test('enqueue appends against fresh storage, not a stale snapshot', () => {
  const storage = memoryStorage();
  const stale = loadChatQueue(storage); // a caller holding an old snapshot
  const a = entry('account-a');
  enqueueChatMessage(storage, a);
  assert.equal(stale.length, 0, 'the stale snapshot is untouched and unused');
  assert.deepEqual(loadChatQueue(storage).map((e) => e.id), [a.id]);
});

test('interrupted flush: a network failure keeps entries for the retry, sent once', async () => {
  const storage = memoryStorage();
  enqueueChatMessage(storage, entry('account-a', 'one'));
  enqueueChatMessage(storage, entry('account-a', 'two'));

  let attempts = 0;
  const first = await flush(storage, 'account-a', async () => {
    attempts += 1;
    if (attempts === 2) throw { network: true }; // connection drops mid-flush
  });
  assert.equal(first.length, 1);
  assert.equal(loadChatQueue(storage).length, 1, 'the un-sent message survives the interruption');

  const second = await flush(storage, 'account-a', async () => {});
  assert.equal(second.length, 1);
  assert.equal(second[0].text.startsWith('two'), true, 'the retry sends the surviving message, not a duplicate of the first');
  assert.equal(loadChatQueue(storage).length, 0);
});

test('an auth failure halts the flush and keeps every entry', async () => {
  const storage = memoryStorage();
  enqueueChatMessage(storage, entry('account-a'));
  enqueueChatMessage(storage, entry('account-a'));
  const sent = await flush(storage, 'account-a', async () => { throw { auth: true }; });
  assert.equal(sent.length, 0);
  assert.equal(loadChatQueue(storage).length, 2);
});

test('app.js wires the queue through the binding module', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(app, /from '\.\/chat-queue\.js'/);
  assert.match(app, /ownerId:state\.user\?state\.user\.id:null/, 'queued messages record the account that wrote them');
  assert.match(app, /flushChatQueueEntries\(/, 'app uses the tested queue drain implementation');
  assert.match(app, /ownerId,\s*blockedIds:blockedChatQueueIds/, 'the tested drain receives the signed-in owner and in-session duplicate hold');
  assert.ok(!/queue=queue\.slice\(1\);saveChatQueue/.test(app), 'the overwrite-prone snapshot save is gone');
  assert.ok(sw.includes("'/chat-queue.js'"), 'service worker precaches the queue module');
});

test('corrupt or non-array storage loads as an empty queue', () => {
  const storage = memoryStorage();
  storage.setItem(CHAT_QUEUE_KEY, '{not json');
  assert.deepEqual(loadChatQueue(storage), []);
  storage.setItem(CHAT_QUEUE_KEY, '{"nope":true}');
  assert.deepEqual(loadChatQueue(storage), []);
});
