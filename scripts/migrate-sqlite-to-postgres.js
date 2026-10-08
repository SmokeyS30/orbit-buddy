#!/usr/bin/env node
// SQLite → PostgreSQL data migration script (Stage 1)
// 
// Usage:
//   DATABASE_URL=postgres://... node scripts/migrate-sqlite-to-postgres.js /path/to/orbit.db
//
// This script:
// 1. Connects to PostgreSQL via DATABASE_URL
// 2. Creates the schema (from src/db/postgres-schema.sql)
// 3. Reads all tables from the SQLite file
// 4. Inserts data into PostgreSQL in dependency order
// 5. Verifies row counts match
//
// SAFETY:
// - Does NOT modify the SQLite file (read-only)
// - Does NOT touch production (Stage 1 only)
// - Can be run multiple times (uses ON CONFLICT DO NOTHING for idempotency)

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const TABLES_IN_ORDER = [
  // Independent tables first
  'users',
  'settings',
  // Then tables with foreign keys
  'sessions',
  'recovery_codes',
  'messages',
  'conversations',
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

  console.log('Stage 1 migration script skeleton — full implementation in progress.');
  console.log(`Source: ${sqlitePath}`);
  console.log(`Tables to migrate: ${TABLES_IN_ORDER.length}`);
  
  // TODO: Implement actual migration logic
  // 1. Import pg, create pool
  // 2. Run schema
  // 3. For each table: SELECT * FROM sqlite, INSERT into pg
  // 4. Verify counts
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
