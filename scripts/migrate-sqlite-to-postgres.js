#!/usr/bin/env node
// SQLite → PostgreSQL data migration script (Stage 1)
// 
// Usage:
//   DATABASE_URL=postgres://... node scripts/migrate-sqlite-to-postgres.js /path/to/orbit.db
//
// This script:
// 1. Connects to PostgreSQL via DATABASE_URL
// 2. Creates the schema (from src/db/postgres-schema.sql)
// 3. Reads all tables from the SQLite file (read-only)
// 4. Inserts data into PostgreSQL in dependency order
// 5. Verifies row counts match
//
// SAFETY:
// - Does NOT modify the SQLite file (read-only)
// - Does NOT touch production (Stage 1 only)
// - Idempotent: uses ON CONFLICT DO NOTHING, safe to re-run

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

// Tables in dependency order (parents before children for FK constraints)
const TABLES_IN_ORDER = [
  'users',
  'settings',
  'sessions',
  'recovery_codes',
  'conversations',
  'messages',
  'memories',
  'memory_suggestions',
  'follow_ups',
  'goals',
  'goal_checkins',
  'routines',
  'projects',
  'project_steps',
  'tasks',
  'events',
  'artifacts',
  'approvals',
  'push_subscriptions',
  'connectors',
  'oauth_states',
  'calendar_feeds',
  'timeline_cache',
  'proactive_state',
  'user_preferences',
  'people_mentions',
  'curiosity_gaps',
  'motivation_profile',
  'emotional_profile',
  'import_jobs',
  'conversation_summaries',
  'streak_completions',
  'door_tokens',
  'access_requests',
  'personal_dates',
];

async function main() {
  const sqlitePath = process.argv[2];
  if (!sqlitePath) {
    console.error('Usage: DATABASE_URL=postgres://... node migrate-sqlite-to-postgres.js /path/to/orbit.db');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL environment variable is required.');
    process.exit(1);
  }
  if (!fs.existsSync(sqlitePath)) {
    console.error(`SQLite file not found: ${sqlitePath}`);
    process.exit(1);
  }

  console.log('=== Orbit Buddy SQLite → PostgreSQL Migration (Stage 1) ===');
  console.log(`Source: ${sqlitePath}`);
  console.log('');

  // 1. Connect to PostgreSQL
  console.log('Connecting to PostgreSQL...');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
  });
  await pool.query('SELECT 1');
  console.log('✓ Connected');

  // 2. Create schema
  console.log('Creating schema...');
  const schemaPath = path.join(__dirname, '../src/db/postgres-schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  const statements = schema.split(';').map(s => s.trim()).filter(s => s && !s.startsWith('--'));
  for (const stmt of statements) {
    await pool.query(stmt);
  }
  console.log(`✓ Schema created (${statements.length} statements)`);

  // 3. Open SQLite (read-only)
  console.log('Opening SQLite (read-only)...');
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });

  // 4. Migrate each table
  const results = [];
  for (const table of TABLES_IN_ORDER) {
    try {
      // Check if table exists in SQLite
      const tableCheck = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      ).get(table);
      if (!tableCheck) {
        console.log(`  ⊘ ${table}: not in SQLite, skipping`);
        continue;
      }

      // Get all rows from SQLite
      const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all();
      if (rows.length === 0) {
        console.log(`  ○ ${table}: empty, skipping`);
        results.push({ table, sqlite: 0, postgres: 0, match: true });
        continue;
      }

      // Get column names from first row
      const columns = Object.keys(rows[0]);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const columnList = columns.map(c => `"${c}"`).join(', ');

      // Insert with ON CONFLICT DO NOTHING for idempotency
      // We need the primary key for the conflict target; use the first column
      // (all tables use single-column PKs in this schema)
      const pk = columns[0];
      let inserted = 0;
      
      // Batch inserts for performance
      const BATCH_SIZE = 100;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const values = [];
        const valuePlaceholders = batch.map((row, batchIdx) => {
          const rowPlaceholders = columns.map((col, colIdx) => {
            values.push(row[col]);
            return `$${batchIdx * columns.length + colIdx + 1}`;
          });
          return `(${rowPlaceholders.join(', ')})`;
        }).join(', ');

        const sql = `INSERT INTO "${table}" (${columnList}) VALUES ${valuePlaceholders} ON CONFLICT ("${pk}") DO NOTHING`;
        const result = await pool.query(sql, values);
        inserted += result.rowCount || 0;
      }

      // Verify count
      const pgCount = await pool.query(`SELECT COUNT(*) as n FROM "${table}"`);
      const pgN = parseInt(pgCount.rows[0].n, 10);
      const match = pgN >= rows.length; // >= because ON CONFLICT may skip existing

      console.log(`  ✓ ${table}: ${rows.length} rows from SQLite, ${pgN} in PostgreSQL`);
      results.push({ table, sqlite: rows.length, postgres: pgN, match });
    } catch (err) {
      console.error(`  ✗ ${table}: ${err.message}`);
      results.push({ table, error: err.message, match: false });
    }
  }

  sqlite.close();

  // 5. Summary
  console.log('');
  console.log('=== Migration Summary ===');
  const failed = results.filter(r => !r.match);
  const totalRows = results.reduce((sum, r) => sum + (r.sqlite || 0), 0);
  console.log(`Tables processed: ${results.length}`);
  console.log(`Total rows: ${totalRows}`);
  console.log(`Failed: ${failed.length}`);
  
  if (failed.length > 0) {
    console.log('');
    console.log('Failed tables:');
    for (const f of failed) {
      console.log(`  - ${f.table}: ${f.error || 'count mismatch'}`);
    }
    process.exit(1);
  }

  console.log('');
  console.log('✓ Migration complete. Verify data before Stage 2.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
