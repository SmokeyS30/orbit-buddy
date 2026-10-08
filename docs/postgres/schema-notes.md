# PostgreSQL Schema Conversion Notes

Source: `src/database.js` @ commit `a659466` (35 tables, 15 indexes)
Output: `/tmp/pg-schema.sql`
Date: 2026-10-07

## Source file issue: /tmp/schema.sql was truncated

The provided `/tmp/schema.sql` (170 lines) was truncated mid-definition at the
`streak_completions` table (line 167-170, ended with a trailing comma, no
closing paren, no PRIMARY KEY). It contained only 32 of 35 tables.

The complete definitions were recovered from the authoritative source
`src/database.js` @ `a659466` via raw.githubusercontent.com. Three tables and
ten indexes were missing from the truncated file and have been included:

| Missing item | Recovered definition |
|---|---|
| `streak_completions` | Completed: `PRIMARY KEY (user_id, item_type, item_id, date)` |
| `conversation_summaries` | `conversation_id TEXT PK → conversations(id)`, user_id, summary, message_count, updated_at |
| `access_requests` | id PK, name, email, note, created_at, handled_at |
| `door_tokens` | token_hash PK, expires_at, used_at, created_at |
| 10 indexes | idx_conversations_user, idx_tasks_due, idx_tasks_user, idx_events_user, idx_sessions_user, idx_followups_due, idx_goals_user, idx_routines_user, idx_projects_user, idx_project_steps, idx_approvals_user, idx_people_stale, idx_messages_conversation |

## Conversion decisions (SQLite → PostgreSQL)

### 1. Extensions (new, top of file)
```sql
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```
- `citext` is required for the case-insensitive email column (see #2).
- `uuid-ossp` is included per the task spec for future UUID generation. Note: the
  app currently generates UUIDs in Node.js (`randomUUID()`), so this extension is
  not strictly required yet, but harmless to have.

### 2. `COLLATE NOCASE` → `CITEXT` (users.email)
- SQLite: `email TEXT NOT NULL UNIQUE COLLATE NOCASE`
- PostgreSQL: `email CITEXT NOT NULL UNIQUE`
- CITEXT provides case-insensitive comparison and uniqueness natively.
- **Attention:** three queries in `database.js` use `COLLATE NOCASE` at the
  query level (lines 336, 401, 495 — `userByEmail`, `listRoutines` ORDER BY,
  `listCalendarFeeds` ORDER BY). With CITEXT columns these still work, but the
  explicit `COLLATE NOCASE` in queries is redundant for the email column.
  For non-CITEXT columns (routines.title, calendar_feeds.label), query-level
  `COLLATE NOCASE` is **not valid PostgreSQL syntax** — those ORDER BY clauses
  must be rewritten (e.g. `ORDER BY LOWER(title)`) in the adapter layer.
  This is a Stage 1 code change, not a schema change.

### 3. Type mappings
| SQLite | PostgreSQL | Notes |
|---|---|---|
| `TEXT PRIMARY KEY` | `TEXT PRIMARY KEY` | Unchanged (UUID strings) |
| `TEXT` | `TEXT` | Unchanged |
| `INTEGER` | `INTEGER` | Unchanged |
| `REAL` | `DOUBLE PRECISION` | Only two columns: `memories.confidence`, `memory_suggestions.confidence` |

### 4. Timestamps kept as TEXT (deliberate Stage 1 decision)
All `*_at`, `due_date`, `target_date`, `schedule_at`, `expires_at` columns remain
`TEXT` storing ISO 8601 strings, exactly as in SQLite. This avoids:
- Timezone conversion bugs during migration
- Rewriting every date comparison in the query layer for Stage 1

**Stage 2 optimization:** convert to `timestamptz`. This will require:
- A data migration casting ISO strings to timestamptz
- Rewriting date arithmetic in queries
- Verifying the backup/restore path handles the new types

### 5. Constraints preserved as-is
- All `CHECK(...)` constraints kept verbatim (role, status, risk, recurrence enums).
- All `REFERENCES ... ON DELETE CASCADE` kept verbatim.
- All `DEFAULT` values kept verbatim (`DEFAULT 0`, `DEFAULT ''`, `DEFAULT 'active'`, etc.).
- All `UNIQUE` constraints kept (including composite `UNIQUE(user_id, description, due_date)` on follow_ups and `UNIQUE(user_id, provider)` on connectors).
- All `IF NOT EXISTS` kept (supported by PostgreSQL for TABLE and INDEX).

### 6. ensureColumn() columns merged into CREATE TABLE
`database.js` adds 30 columns via `ensureColumn()` (idempotent ALTER TABLE for
existing SQLite databases). For a fresh PostgreSQL schema these are merged
directly into the CREATE TABLE definitions, eliminating the need for an
ALTER TABLE migration pass:

| Table | Merged columns |
|---|---|
| users | `is_demo INTEGER NOT NULL DEFAULT 0` |
| messages | `conversation_id TEXT` (user_id was already in DDL) |
| memories | `kind`, `source`, `status`, `confidence DOUBLE PRECISION`, `expires_at`, `last_confirmed_at` (user_id was already in DDL) |
| memory_suggestions | `kind`, `confidence DOUBLE PRECISION` |
| follow_ups | `attempt_count`, `last_error` (priority, next_attempt_at already in DDL) |
| tasks | `attempt_count`, `lease_expires_at`, `last_error` (user_id already in DDL) |
| events | `user_id` |
| proactive_state | `last_outreach_at`, `outreach_date`, `outreach_count INTEGER NOT NULL DEFAULT 0` |
| people_mentions | `context_summary`, `sentiment`, `last_context_update` |
| personal_dates | `gift_nag INTEGER NOT NULL DEFAULT 0`, `gift_done INTEGER NOT NULL DEFAULT 0` |
| user_preferences | `briefing_length`, `buddy_name` (briefing_tone already in DDL) |
| approvals | `execution_started_at` |

### 7. `DROP TABLE IF EXISTS automation_tokens` — kept
This is a cleanup statement for a removed feature. Kept as-is for idempotency;
it is a no-op on a fresh database.

### 8. Composite primary keys — kept as-is
- `timeline_cache`: `PRIMARY KEY (user_id, month_key)`
- `people_mentions`: `PRIMARY KEY (user_id, person_name)`
- `streak_completions`: `PRIMARY KEY (user_id, item_type, item_id, date)`

PostgreSQL supports composite primary keys natively. No changes needed.

## The strftime usage (database.js line 463)

**SQLite query** (birthday/anniversary matching in `listPersonalDatesForMonthDay` or similar):
```sql
... AND strftime('%m',created_at)=? AND strftime('%d',created_at)=? AND strftime('%Y',created_at)!=?
```

**Problem:** `strftime` does not exist in PostgreSQL.

**PostgreSQL equivalent** (given TEXT ISO timestamps):
```sql
... AND to_char(created_at::timestamp, 'MM')=? AND to_char(created_at::timestamp, 'DD')=? AND to_char(created_at::timestamp, 'YYYY')!=?
```

**Why `to_char` and not `EXTRACT`:** Since we're keeping timestamps as TEXT in
Stage 1, the value must first be cast to `timestamp`. `to_char(..., 'MM')`
returns a zero-padded string ('01'-'12'), matching `strftime('%m')` semantics
exactly. `EXTRACT(MONTH FROM ...)` returns an integer, which would require the
bound parameters to change type — riskier.

**Stage 2 note:** if timestamps become `timestamptz`, this simplifies to
`EXTRACT(MONTH FROM created_at) = $1::int` etc.

**Attention:** this query must be rewritten in the PostgreSQL adapter. It is the
only SQLite-specific function in the entire query layer (197 prepared statements
audited).

## CHECK constraints and defaults needing attention

1. **`users.role` CHECK**: `CHECK(role IN ('owner','member'))` — fine as-is.
   Consider PostgreSQL ENUM in Stage 2 for type safety, but not required.

2. **Status CHECK constraints** (projects, project_steps, approvals, tasks.risk,
   tasks.recurrence, messages.role) — all preserved verbatim. PostgreSQL
   enforces them identically to SQLite.

3. **`DEFAULT ''`** on `import_jobs.filename` — preserved. Empty-string defaults
   work identically.

4. **Boolean-as-INTEGER** (`disabled`, `is_demo`, `enabled`, `dismissed`,
   `gift_nag`, `gift_done`, `proactive_enabled`, `outreach_count`) — kept as
   INTEGER with DEFAULT 0/1 to match application code that reads/writes 0/1.
   **Do not** convert to PostgreSQL BOOLEAN in Stage 1; the Node.js code
   compares against integers. A BOOLEAN migration is a Stage 2+ cleanup that
   would require touching every read/write path.

5. **`UNIQUE(user_id, description, due_date)`** on follow_ups — PostgreSQL treats
   NULLs as distinct in UNIQUE constraints (same as SQLite). No behavior change.

## Indexes

All 15 indexes converted with `IF NOT EXISTS` preserved. PostgreSQL supports
`DESC` in index definitions (used in 6 indexes) natively.

One index (`idx_messages_conversation`) is created via a separate `db.exec()`
call in database.js rather than inline with the schema — it has been included
in pg-schema.sql for completeness on fresh installs.
