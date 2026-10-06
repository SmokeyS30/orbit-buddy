#!/bin/sh
# Orbit Buddy container entrypoint
# SQLite runs on local disk (fast, reliable locking).
# Azure Files mount at /backup is used for backup/restore only.
set -e

DATA_DIR="${DATA_DIR:-/var/data/orbit}"
BACKUP_DIR="${BACKUP_DIR:-/backup}"
DB_FILE="$DATA_DIR/orbit.sqlite"
BACKUP_FILE="$BACKUP_DIR/orbit.sqlite"
BACKUP_TMP="$BACKUP_DIR/orbit.sqlite.tmp"
LOCAL_BACKUP_TMP="$DATA_DIR/orbit.sqlite.backup.tmp"
LEGACY_BACKUP_FILE="$BACKUP_DIR/orbit/orbit.sqlite"
BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-60}"

mkdir -p "$DATA_DIR" "$BACKUP_DIR"

# Restore only a non-empty backup. The legacy path covers the original Azure
# deployment, which mounted the share directly at /var/data.
if [ ! -s "$DB_FILE" ]; then
  if [ -s "$BACKUP_FILE" ]; then
    echo "Restoring database from Azure Files backup..."
    cp "$BACKUP_FILE" "$DB_FILE"
  elif [ -s "$LEGACY_BACKUP_FILE" ]; then
    echo "Restoring database from legacy Azure Files location..."
    cp "$LEGACY_BACKUP_FILE" "$DB_FILE"
  fi
fi

backup_database() {
  [ -s "$DB_FILE" ] || return 0
  # Azure Files cannot be opened as a SQLite backup destination. First create
  # the consistent snapshot on local disk, then copy the completed file.
  node src/sqlite-file-backup.js "$DB_FILE" "$LOCAL_BACKUP_TMP" \
    && cp "$LOCAL_BACKUP_TMP" "$BACKUP_TMP" \
    && mv "$BACKUP_TMP" "$BACKUP_FILE"
}

# Use SQLite's online backup API instead of copying a live WAL database.
(
  while true; do
    sleep "$BACKUP_INTERVAL_SECONDS"
    backup_database || echo "Warning: scheduled database backup failed" >&2
  done
) &
BACKUP_PID=$!

node server.js &
APP_PID=$!

forward_shutdown() {
  trap - TERM INT
  kill -TERM "$APP_PID" 2>/dev/null || true
}

trap forward_shutdown TERM INT

APP_STATUS=0
wait "$APP_PID" || APP_STATUS=$?

kill "$BACKUP_PID" 2>/dev/null || true
wait "$BACKUP_PID" 2>/dev/null || true

echo "Saving final database backup..."
backup_database || echo "Warning: final database backup failed" >&2

exit "$APP_STATUS"
