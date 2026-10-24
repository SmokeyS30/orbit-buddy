# Durable chat replies

Orbit stores each accepted chat turn and its reply job in one database transaction. The existing `202` response and polling/SSE formats are unchanged. Jobs are claimed in conversation order across PostgreSQL replicas; each claim has a five minute lease and a 30 second renewal. The assistant message and job completion are committed together, with a unique job reference on the message.

On startup and during polling, queued text jobs can be claimed by any replica. A job whose model call already started is **not executed again** after its lease expires: Orbit stores one interruption reply instead of starting the model and its tools a second time. A stale worker cannot commit an assistant message after the lease is lost. A tool call already in flight on that stale worker may still finish, so its external side effects cannot be claimed as exactly once. Deleting a pending turn cancels its job. Emergency pause leaves queued jobs untouched until resume.

Image and shared-location bytes remain in memory only. Their queued jobs stay with the accepting replica while it is alive. If that replica disappears, an expired job receives an interruption reply asking for a resend; the private media is never written to the job table or backup. Another replica can report `streaming` with empty text and then `done` for the existing client protocol, although live token deltas are available only on the worker running the model.

WhatsApp delivery is claimed before its send to avoid duplicate outbound messages across replicas. A crash or network failure after that claim may leave a completed reply in the conversation without an outbound WhatsApp message. This is an at-most-once delivery boundary; the job ledger does not assert exactly-once external delivery. Web client retries and repeated inbound webhooks can still create a second user turn because this change does not add an inbound idempotency key. The job ledger protects execution of each accepted server message, not deduplication of separate accepted requests.

The server stops accepting connections on shutdown and gives active replies and summaries up to 25 seconds to finish. Unfinished leased work receives an interruption reply after its lease expires. Completed job metadata is retained with the database and is covered by database-level backups; portable user exports do not include the operational queue.

For content-free diagnostics, inspect job counts by status and the oldest queued timestamp. Do not log message bodies, image bytes, lease tokens, or user identifiers when reporting queue health.
