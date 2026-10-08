// Database factory: selects SQLite or PostgreSQL based on environment.
// Stage 1: PostgreSQL adapter is built and tested but NOT used in production.
// Production continues to use SQLite until Stage 2 (explicit owner approval).
//
// Environment variables:
//   DATABASE_URL — if set, use PostgreSQL (format: postgres://user:pass@host:5432/dbname)
//   Otherwise, use SQLite (existing behavior, unchanged)

import { openDatabase as openSqlite } from '../database.js';

let pgModule = null;

export async function openDatabase(filePath, options = {}) {
  const databaseUrl = process.env.DATABASE_URL;
  
  if (databaseUrl) {
    // PostgreSQL mode (Stage 2, not yet active in production)
    if (!pgModule) {
      pgModule = await import('./postgres-adapter.js');
    }
    return pgModule.openPostgres(databaseUrl, options);
  }
  
  // SQLite mode (current production, unchanged)
  return openSqlite(filePath, options);
}

export function getDatabaseType() {
  return process.env.DATABASE_URL ? 'postgres' : 'sqlite';
}
