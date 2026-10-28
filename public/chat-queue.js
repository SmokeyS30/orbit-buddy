// Offline chat queue storage and ownership rules.
//
// Two safety properties live here, separate from the DOM/network code in
// app.js, so they can be tested directly:
//
// 1. Account binding. Every entry records the account that queued it
//    (ownerId). An entry may only ever be auto-sent under that same
//    account. Entries written before owner binding existed have no
//    ownerId; they are legacy entries and are NEVER auto-sent, because
//    there is no way to prove which account wrote them. They stay in
//    storage untouched rather than being delivered under the wrong
//    account or silently deleted.
//
// 2. No lost messages during a flush. A flush can take seconds (one
//    network round-trip per message) while the user keeps typing.
//    Every mutation below re-reads the stored queue immediately before
//    writing, and removal is by entry id only — so a message enqueued
//    mid-flush is never overwritten by the flush's bookkeeping, and a
//    flushed message is removed exactly once.
export const CHAT_QUEUE_KEY = 'orbit-chat-queue';

export function loadChatQueue(storage) {
  try {
    const q = JSON.parse(storage.getItem(CHAT_QUEUE_KEY));
    return Array.isArray(q) ? q : [];
  } catch (_) {
    return [];
  }
}

export function saveChatQueue(storage, queue) {
  try { storage.setItem(CHAT_QUEUE_KEY, JSON.stringify(queue)); } catch (_) {}
}

export function createChatQueueEntry({ id, text, conversationId = null, ownerId = null, queuedAt }) {
  return { id, text, conversationId, ownerId: ownerId || null, queuedAt };
}

// Append against a fresh read of storage. Never append to an array a
// caller loaded earlier: that array may predate a flush's removals.
export function enqueueChatMessage(storage, entry) {
  const queue = loadChatQueue(storage);
  queue.push(entry);
  saveChatQueue(storage, queue);
  return entry;
}

// Remove exactly one entry, by id, against a fresh read of storage.
// Entries enqueued after the caller's snapshot was taken survive.
export function removeChatQueueEntry(storage, id) {
  const queue = loadChatQueue(storage).filter((entry) => entry.id !== id);
  saveChatQueue(storage, queue);
  return queue;
}

export function isEntrySendableUnder(entry, ownerId) {
  return !!ownerId && !!entry && entry.ownerId === ownerId;
}

// The next entry a flush under `ownerId` may send, in queue order.
// Other accounts' entries and legacy unbound entries are skipped, not
// sent and not dropped.
export function nextSendableEntry(queue, ownerId) {
  return queue.find((entry) => isEntrySendableUnder(entry, ownerId)) || null;
}

export function legacyEntries(queue) {
  return queue.filter((entry) => !entry || !entry.ownerId);
}
