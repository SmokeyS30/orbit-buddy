// Reply jobs contain identifiers and state only. Message content stays in the
// existing messages table; image and location payloads remain ephemeral.
export const REPLY_LEASE_MS=5*60_000;
export const REPLY_INTERRUPTED_TEXT='I couldn’t finish that reply after a server interruption. Please send it again.';
