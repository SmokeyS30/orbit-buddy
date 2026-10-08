# PostgreSQL Rollback Procedure (Stage 2)

## When to rollback

- Data verification fails after migration
- Application errors spike after cutover
- PostgreSQL performance is unacceptable
- Any data integrity concern

## Prerequisites (prepare BEFORE Stage 2)

- [ ] Final SQLite snapshot verified and stored outside Azure
- [ ] `DATA_ENCRYPTION_KEY` value confirmed accessible
- [ ] Rollback tested in staging

## Rollback steps

### 1. Pause Orbit
Enable emergency pause to stop writes.

### 2. Switch database backend
Unset `DATABASE_URL` in Container App secrets/environment.
SQLite is the default when `DATABASE_URL` is absent.

### 3. Restart Container App
New revision starts with SQLite backend.

### 4. Verify
- Health check passes
- Recent data present (compare against pre-migration snapshot)
- Gmail connector decrypts correctly (validates `DATA_ENCRYPTION_KEY`)
- Calendar feeds load

### 5. Assess
Determine root cause before re-attempting migration.

## Data safety notes

- SQLite file is NEVER deleted during Stage 2
- Azure Files backups continue during PostgreSQL operation
- Migration script is idempotent (safe to re-run)
- `DATA_ENCRYPTION_KEY` must NEVER be rotated during migration or rollback —
  encrypted calendar URLs and OAuth tokens would become unreadable
