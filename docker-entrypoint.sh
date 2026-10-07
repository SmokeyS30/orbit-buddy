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
SNAPSHOT_DIR="$BACKUP_DIR/snapshots"
SNAPSHOT_MARKER="$SNAPSHOT_DIR/.last-snapshot"
BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-15}"
BACKUP_SNAPSHOT_INTERVAL_SECONDS="${BACKUP_SNAPSHOT_INTERVAL_SECONDS:-3600}"
BACKUP_SNAPSHOT_RETENTION="${BACKUP_SNAPSHOT_RETENTION:-168}"

mkdir -p "$DATA_DIR" "$BACKUP_DIR" "$SNAPSHOT_DIR"

# Restore only a non-empty backup. The legacy path covers the original Azure
# deployment, which mounted the share directly at /var/data.
if [ ! -s "$DB_FILE" ]; then
  if [ -s "$BACKUP_FILE" ]; then
    echo "Restoring database from Azure Files backup..."
    cp "$BACKUP_FILE" "$DB_FILE"
  elif [ -s "$LEGACY_BACKUP_FILE" ]; then
    echo "Restoring database from legacy Azure Files location..."
    cp "$LEGACY_BACKUP_FILE" "$DB_FILE"
  else
    LATEST_SNAPSHOT="$(ls -1t "$SNAPSHOT_DIR"/orbit-*.sqlite 2>/dev/null | head -n 1 || true)"
    if [ -n "$LATEST_SNAPSHOT" ] && [ -s "$LATEST_SNAPSHOT" ]; then
      echo "Restoring database from latest versioned snapshot..."
      cp "$LATEST_SNAPSHOT" "$DB_FILE"
    fi
  fi
fi

backup_database() {
  FORCE_SNAPSHOT="${1:-0}"
  [ -s "$DB_FILE" ] || return 0
  # Azure Files cannot be opened as a SQLite backup destination. First create
  # the consistent snapshot on local disk, then copy the completed file.
  node src/sqlite-file-backup.js "$DB_FILE" "$LOCAL_BACKUP_TMP" \
    && cp "$LOCAL_BACKUP_TMP" "$BACKUP_TMP" \
    && mv "$BACKUP_TMP" "$BACKUP_FILE" \
    || return 1

  NOW_EPOCH="$(date +%s)"
  LAST_SNAPSHOT_EPOCH="$(cat "$SNAPSHOT_MARKER" 2>/dev/null || true)"
  case "$LAST_SNAPSHOT_EPOCH" in ''|*[!0-9]*) LAST_SNAPSHOT_EPOCH=0 ;; esac
  if [ "$FORCE_SNAPSHOT" = "1" ] || [ $((NOW_EPOCH - LAST_SNAPSHOT_EPOCH)) -ge "$BACKUP_SNAPSHOT_INTERVAL_SECONDS" ]; then
    SNAPSHOT_TIME="$(date -u +%Y%m%dT%H%M%SZ)"
    SNAPSHOT_FILE="$SNAPSHOT_DIR/orbit-$SNAPSHOT_TIME-$$.sqlite"
    SNAPSHOT_TMP="$SNAPSHOT_FILE.tmp"
    cp "$LOCAL_BACKUP_TMP" "$SNAPSHOT_TMP" \
      && mv "$SNAPSHOT_TMP" "$SNAPSHOT_FILE" \
      && printf '%s\n' "$NOW_EPOCH" > "$SNAPSHOT_MARKER.tmp" \
      && mv "$SNAPSHOT_MARKER.tmp" "$SNAPSHOT_MARKER"

    FIRST_STALE=$((BACKUP_SNAPSHOT_RETENTION + 1))
    ls -1t "$SNAPSHOT_DIR"/orbit-*.sqlite 2>/dev/null \
      | sed -n "${FIRST_STALE},\$p" \
      | while IFS= read -r STALE_SNAPSHOT; do
          case "$STALE_SNAPSHOT" in "$SNAPSHOT_DIR"/orbit-*.sqlite) rm -f -- "$STALE_SNAPSHOT" ;; esac
        done
  fi
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
backup_database 1 || echo "Warning: final database backup failed" >&2

exit "$APP_STATUS"
