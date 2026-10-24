# Recovery coverage

Portable backup version 6 exports every row for a user's messages, memories
(including superseded records), suggestions, follow-ups, goals and check-ins,
routines, projects and steps, approvals, preferences, summaries, calendar feeds,
tasks, events, and artifacts. It also includes personal dates, streak history,
person context, curiosity gaps, motivation and emotional profiles, soul record
and history, memory surfacing, study attempts, canvas revisions, catch-up state,
and radar mutes. The former 20,000-message and 100-memory export caps are gone.
Each export reads from a single database snapshot so a concurrent chat turn
cannot leave related tables at different points in time. The backup writer
publishes an encrypted file only after the complete write succeeds, then
prunes older files. Versions 2 through 5 remain restorable.

PostgreSQL exports use the asynchronous worker path so the server event loop
can continue serving requests while the database snapshot is collected.
Complete bundles can use more storage and memory than the former capped ones;
the existing Azure Files quota and seven-file rotation are unchanged.

Portable backups are per-user content merges. They preserve task delivery
channels while clearing old task and routine leases during restore. They
deliberately exclude password hashes, sessions, recovery codes, signup state,
authentication identities,
subscriptions and usage enforcement, push device tokens, connector credentials,
WhatsApp links, and active reply/task leases. Restoring a bundle does not create
or replace an account. Those operational records require PostgreSQL point-in-time
recovery (PITR) or another authorized full-database backup process. The owner
restore API accepts at most 64 MiB of JSON input; larger encrypted bundles
require an approved offline recovery procedure. Encryption passphrases and keys
must stay in their existing secret stores.

Merging into an account with existing rows skips duplicate identifiers or unique
keys; the isolated rehearsal uses a fresh target to verify complete recovery.

The deployment workflow performs a read-only query of the externally managed
`orbit-buddy-pg` server's backup retention, earliest restore point, redundancy,
and state. If access is unavailable, the query error remains in the deployment
log and must be reported; it does not change retention or block a healthy
application deploy.
This query is configuration evidence, not proof that a production restore works.

The recovery tests populate synthetic SQLite and disposable PostgreSQL databases
with more than 20,000 messages, more than 100 memories, and every additional
portable table. They encrypt backups, decrypt them, restore twice into isolated
databases, and verify counts, ownership, memory metadata, preferences, and
unchanged target account credentials. They do not use production data or run a
production restore. A live PITR drill would require separately approved isolated
infrastructure and handling for sensitive production records.
