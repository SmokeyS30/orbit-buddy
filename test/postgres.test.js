// PostgreSQL integration tests (Stage 1)
// 
// These tests require a running PostgreSQL database.
// Set DATABASE_URL before running:
//   DATABASE_URL=postgres://user:pass@localhost:5432/orbitbuddy_test node --test test/postgres.test.js
//
// The tests:
// 1. Create the schema from src/db/postgres-schema.sql
// 2. Run CRUD operations through the adapter
// 3. Verify data integrity
// 4. Clean up

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL;

describe('PostgreSQL adapter', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let db;

  before(async () => {
    const { openPostgres } = await import('../src/db/postgres-adapter.js');
    db = await openPostgres(DATABASE_URL, {});

    // Create schema
    const schema = fs.readFileSync(
      path.join(__dirname, '../src/db/postgres-schema.sql'),
      'utf-8'
    );
    // Split by semicolon and run each statement
    // (simple approach; production migration uses a proper runner)
    const statements = schema
      .split(';')
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('--'));
    
    for (const stmt of statements) {
      await db.query(stmt);
    }
  });

  after(async () => {
    if (db) await db.close();
  });

  it('creates and retrieves a user', async () => {
    // TODO: Implement when adapter methods are complete
    // const user = await db.createUser({ email: 'test@example.com', ... });
    // assert.ok(user.id);
  });

  it('handles encrypted connector data', async () => {
    // TODO: Verify DATA_ENCRYPTION_KEY compatibility
  });

  it('converts strftime birthday query correctly', async () => {
    // TODO: Test listMemoriesOnDate with to_char conversion
  });
});
