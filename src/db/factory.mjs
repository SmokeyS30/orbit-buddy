// Database factory (ES module): returns SQLite or PostgreSQL sync wrapper
// Server.js API unchanged — db.xxx() is always synchronous
//
// The factory accepts databaseUrl explicitly (from createOrbitServer's env)
// rather than reading only process.env, so tests can supply an explicit
// environment object. Falls back to process.env.DATABASE_URL if not provided.
// The returned adapter carries a `driver` identifier ('postgres' | 'sqlite')
// for observability (e.g. /healthz).

import { openDatabase } from '../database.js';
import { createSyncPgAdapter } from './sync-pg-wrapper.mjs';

export function createDatabase({ dbPath, encryptionKey, databaseUrl } = {}) {
  // Explicit argument takes precedence; fall back to process.env for
  // backward compatibility with direct callers.
  const url = databaseUrl || process.env.DATABASE_URL;

  if (url) {
    console.log('[db] Using PostgreSQL (sync wrapper)');
    const adapter = createSyncPgAdapter(url, { encryptionKey });
    adapter.driver = 'postgres';
    return adapter;
  } else {
    console.log('[db] Using SQLite');
    const adapter = openDatabase(dbPath, { encryptionKey });
    adapter.driver = 'sqlite';
    return adapter;
  }
}
