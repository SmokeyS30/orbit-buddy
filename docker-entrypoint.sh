#!/bin/sh
# Orbit Buddy container entrypoint
# SQLite runs on local disk (fast, reliable locking).
# Azure Files mount at /backup is used for backup/restore only.
set -e

DATA_DIR="${DATA_DIR:-/var/data/orbit}"
BACKUP_DIR="/backup"
DB_FILE="$DATA_DIR/orbit.db"
BACKUP_FILE="$BACKUP_DIR/orbit.db"

mkdir -p "$DATA_DIR"

# Restore from backup if local DB is missing and a backup exists
if [ ! -f "$DB_FILE" ] && [ -f "$BACKUP_FILE" ]; then
  echo "Restoring database from backup..."
  cp "$BACKUP_FILE" "$DB_FILE"
fi

# Background backup loop: copy DB to Azure Files every 5 minutes
(
  while true; do
    sleep 300
    if [ -f "$DB_FILE" ]; then
      cp "$DB_FILE" "$BACKUP_FILE.tmp" 2>/dev/null && mv "$BACKUP_FILE.tmp" "$BACKUP_FILE" 2>/dev/null || true
    fi
  done
) &

# Final backup on shutdown
trap 'echo "Backing up database..."; cp "$DB_FILE" "$BACKUP_FILE" 2>/dev/null || true; exit 0' TERM INT

exec node server.js
