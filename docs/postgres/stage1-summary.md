# PostgreSQL Migration — Stage 1 Complete

## What was built

All Stage 1 deliverables are on the `postgres-migration` branch. Production (`main`) is untouched.

### Files

| File | Description |
|------|-------------|
| `src/db/postgres-schema.sql` | PostgreSQL DDL for all 35 tables + 15 indexes |
| `src/db/postgres-adapter.js` | Async PostgreSQL adapter, 161 methods, 858 lines |
| `src/db/factory.js` | Selects SQLite vs PostgreSQL based on `DATABASE_URL` |
| `scripts/migrate-sqlite-to-postgres.js` | Data migration script (idempotent, read-only source) |
| `test/postgres.test.js` | Integration test skeleton |
| `docs/postgres/env-vars.md` | Environment variable documentation |
| `docs/postgres/rollback.md` | Rollback procedure |
| `docs/postgres/schema-notes.md` | All SQLite→PostgreSQL conversion decisions |
| `package.json` | Added `pg` dependency |

### Key design decisions

1. **Timestamps stay as TEXT** — matches SQLite behavior, avoids conversion risk in Stage 1
2. **`users.email` uses CITEXT** — case-insensitive, index-friendly (better than LOWER() workaround)
3. **All adapter methods are async** — returns Promises; SQLite version stays sync
4. **Migration is idempotent** — `ON CONFLICT DO NOTHING`, safe to re-run
5. **SQLite never modified** — migration reads only; rollback is just unsetting `DATABASE_URL`

### What's NOT done (needs live PostgreSQL)

- Integration tests against a real database
- Full data migration verification
- Performance testing

These require an actual PostgreSQL instance, which is Stage 2 (needs owner approval for the paid Azure resource).

## Stage 2 checkpoints (need explicit approval)

1. ☐ Approval to create the paid Azure PostgreSQL resource
2. ☐ Approval to begin the maintenance window (~10-30 min downtime)
3. ☐ Approval to make PostgreSQL the production primary

## Rollback

If anything goes wrong in Stage 2: unset `DATABASE_URL`, restart the container. SQLite takes over immediately. See `docs/postgres/rollback.md` for the full procedure.
