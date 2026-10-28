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
  try {
    storage.setItem(CHAT_QUEUE_KEY, JSON.stringify(queue));
    return true;
  } catch (_) {
    return false;
  }
}

export function createChatQueueEntry({ id, text, conversationId = null, ownerId = null, queuedAt }) {
  return { id, text, conversationId, ownerId: ownerId || null, queuedAt };
}

// Append against a fresh read of storage. Never append to an array a
// caller loaded earlier: that array may predate a flush's removals.
export function enqueueChatMessage(storage, entry) {
  const queue = loadChatQueue(storage);
  queue.push(entry);
  return saveChatQueue(storage, queue) ? entry : null;
}

// Remove exactly one entry, by id, against a fresh read of storage.
// Entries enqueued after the caller's snapshot was taken survive.
export function removeChatQueueEntry(storage, id) {
  const queue = loadChatQueue(storage).filter((entry) => entry.id !== id);
  return saveChatQueue(storage, queue);
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

// Drain entries using the same queue rules as the app. Storage failures are
// explicit: once an accepted message cannot be removed, its id is held in the
// caller-owned blocked set so another wake-up in this app session cannot send
// it again. A reload still needs server-side idempotency to close the final
// ambiguous-delivery window; this helper deliberately does not invent that
// protocol.
export async function flushChatQueueEntries({
  storage,
  ownerId,
  send,
  canContinue = () => true,
  shouldRetry = () => false,
  blockedIds = new Set(),
  onSent = () => {},
  onDropped = () => {},
  onPersistenceFailure = () => {},
}) {
  const result = { sent: 0, dropped: 0, persistenceFailed: false, deliveryUncertain: false, blockedEntryId: null };
  if (!ownerId) return result;

  for (;;) {
    if (!canContinue()) break;
    const entry = nextSendableEntry(loadChatQueue(storage), ownerId);
    if (!entry || blockedIds.has(entry.id)) break;

    let response;
    try {
      response = await send(entry);
    } catch (error) {
      if (shouldRetry(error)) break;
      if (!removeChatQueueEntry(storage, entry.id)) {
        blockedIds.add(entry.id);
        result.persistenceFailed = true;
        result.blockedEntryId = entry.id;
        await onPersistenceFailure({ entry, error, delivered: false });
        break;
      }
      result.dropped += 1;
      await onDropped(error, entry);
      continue;
    }

    if (!removeChatQueueEntry(storage, entry.id)) {
      blockedIds.add(entry.id);
      result.persistenceFailed = true;
      result.deliveryUncertain = true;
      result.blockedEntryId = entry.id;
      await onPersistenceFailure({ entry, response, delivered: true });
      break;
    }
    result.sent += 1;
    await onSent(response, entry);
  }

  return result;
}
