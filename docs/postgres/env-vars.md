# PostgreSQL Environment Variables (Stage 2)

These are NOT set in production yet. Do not set them until Stage 2 with explicit owner approval.

## Required for PostgreSQL mode

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgres://orbit:SECRET@orbit-postgres.postgres.database.azure.com:5432/orbitbuddy?sslmode=require` |

When `DATABASE_URL` is set, the factory uses PostgreSQL. When unset, SQLite is used (current behavior).

## Azure setup (Stage 2, not yet done)

1. Create Azure Database for PostgreSQL Flexible Server
2. Configure firewall to allow Azure Container Apps
3. Create database `orbitbuddy`
4. Store connection string in Azure Key Vault or Container App secrets as `DATABASE_URL`
5. `DATA_ENCRYPTION_KEY` must be preserved — do NOT rotate during migration

## Rollback

To rollback to SQLite: remove/unset `DATABASE_URL` and restart the container.
The SQLite database file and backups are preserved during Stage 2.
