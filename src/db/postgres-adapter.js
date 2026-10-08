// PostgreSQL adapter for orbit-buddy (Stage 1)
// 
// Implements the same method interface as src/database.js (SQLite version)
// but using async PostgreSQL queries via the `pg` library.
//
// KEY DIFFERENCES from SQLite version:
// - All methods are async (return Promises)
// - Query parameters use $1, $2, ... instead of ?
// - `strftime` → `to_char` / `EXTRACT`
// - `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`
// - Connection pooling via pg.Pool
//
// Stage 1: This adapter is built and tested but NOT used in production.
// Production continues on SQLite until Stage 2 (explicit owner approval).

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret } from './security.js';

const { Pool } = pg;
const timestamp = () => new Date().toISOString();

// Convert ? placeholders to $1, $2, ... for PostgreSQL
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export async function openPostgres(databaseUrl, { encryptionKey = null } = {}) {
  const pool = new Pool({
    connectionString: databaseUrl,
    // Azure Database for PostgreSQL requires SSL
    ssl: databaseUrl.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
    max: 10, // connection pool size
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  // Test connection
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }

  // Helper to run queries
  const query = async (sql, params = []) => {
    const pgSql = toPgPlaceholders(sql);
    const result = await pool.query(pgSql, params);
    return result;
  };

  const get = async (sql, ...params) => {
    const result = await query(sql, params);
    return result.rows[0] || null;
  };

  const all = async (sql, ...params) => {
    const result = await query(sql, params);
    return result.rows;
  };

  const run = async (sql, ...params) => {
    const result = await query(sql, params);
    return { changes: result.rowCount || 0 };
  };

  // Encryption helpers (same as SQLite version)
  const protectSecret = (value) => {
    const text = String(value || '');
    if (!text || text.startsWith('enc:v1:') || !encryptionKey) return text;
    return `enc:v1:${encryptSecret(text, encryptionKey)}`;
  };

  const revealSecret = (value) => {
    const text = String(value || '');
    if (!text.startsWith('enc:v1:')) return text;
    if (!encryptionKey) throw new Error('Data encryption key is required to read protected data.');
    return decryptSecret(text.slice('enc:v1:'.length), encryptionKey);
  };

  // TODO: Implement all database methods matching src/database.js interface
  // This is a large API surface (~80+ methods). Each method from the SQLite
  // version needs an async PostgreSQL equivalent.
  //
  // Migration pattern for each method:
  //   SQLite:  userById: (id) => s.userById.get(id)
  //   PG:      userById: async (id) => get('SELECT * FROM users WHERE id = ?', id)
  //
  // SQLite-specific conversions:
  //   - `strftime('%m', created_at)` → `to_char(created_at::timestamp, 'MM')`
  //   - `INSERT OR IGNORE` → `INSERT ... ON CONFLICT DO NOTHING`
  //   - `substr(x, 1, 10)` → `substring(x from 1 for 10)` (or keep substr, PG supports it)

  return {
    // Connection management
    close: () => pool.end(),
    query, get, all, run,
    
    // TODO: Add all methods from database.js here
    // See docs for the full method list
    
    _pool: pool, // exposed for testing
  };
}
