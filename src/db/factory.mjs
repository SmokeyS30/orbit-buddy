// Database factory (ES module): returns SQLite or PostgreSQL sync wrapper
// Server.js API unchanged — db.xxx() is always synchronous

import { openDatabase } from '../database.js';
import { createSyncPgAdapter } from './sync-pg-wrapper.mjs';

export function createDatabase({ dbPath, encryptionKey } = {}) {
  const databaseUrl = process.env.DATABASE_URL;
  
  if (databaseUrl) {
    console.log('[db] Using PostgreSQL (sync wrapper)');
    return createSyncPgAdapter(databaseUrl, { encryptionKey });
  } else {
    console.log('[db] Using SQLite');
    return openDatabase(dbPath, { encryptionKey });
  }
}
