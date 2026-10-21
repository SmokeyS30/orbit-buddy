// Additive and deliberately shared by SQLite startup and PostgreSQL upgrades.
export const signupSecuritySchema = [
  `CREATE TABLE IF NOT EXISTS apple_signup_proofs (
    token_hash TEXT PRIMARY KEY, subject TEXT NOT NULL, email_hash TEXT NOT NULL, expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS signup_challenges (
    token_hash TEXT PRIMARY KEY, purpose TEXT NOT NULL, binding TEXT NOT NULL,
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_signup_challenges_expiry ON signup_challenges(expires_at)`,
  `CREATE TABLE IF NOT EXISTS app_attest_keys (
    key_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, environment TEXT NOT NULL,
    sign_count BIGINT NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS signup_appeals (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, note TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
];
