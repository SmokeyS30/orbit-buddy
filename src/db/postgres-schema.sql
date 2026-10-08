-- PostgreSQL schema for orbit-buddy (converted from SQLite)
-- Source: src/database.js @ a659466
-- Stage 1: timestamps kept as TEXT (ISO strings) to match SQLite behavior.
-- Stage 2 optimization: consider timestamptz for created_at/updated_at/schedule_at etc.
-- All ensureColumn() migration columns have been merged into the CREATE TABLE
-- definitions below, so a fresh PostgreSQL database needs no ALTER TABLE pass.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email CITEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','member')),
  disabled INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  conversation_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  content TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',
  source TEXT NOT NULL DEFAULT 'legacy',
  status TEXT NOT NULL DEFAULT 'approved',
  confidence DOUBLE PRECISION NOT NULL DEFAULT 1,
  expires_at TEXT,
  last_confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_suggestions (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  content TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'processing',
  total_chunks INTEGER NOT NULL DEFAULT 0,
  done_chunks INTEGER NOT NULL DEFAULT 0,
  suggestions_added INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS follow_ups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  priority INTEGER NOT NULL DEFAULT 2,
  source_message_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(user_id, description, due_date)
);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  priority INTEGER NOT NULL DEFAULT 2,
  progress INTEGER NOT NULL DEFAULT 0,
  target_date TEXT,
  next_step TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS goal_checkins (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  progress INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'custom',
  cadence TEXT NOT NULL DEFAULT 'daily',
  time_local TEXT NOT NULL DEFAULT '09:00',
  day_of_week INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_date TEXT,
  last_run_at TEXT,
  lease_date TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','paused','completed')),
  priority INTEGER NOT NULL DEFAULT 2,
  target_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS project_steps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK(status IN ('planned','in_progress','blocked','completed')),
  position INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','executed','rejected','failed')),
  source_message_id TEXT,
  result_json TEXT,
  last_error TEXT,
  execution_started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  risk TEXT NOT NULL CHECK(risk IN ('internal','external')),
  schedule_at TEXT,
  recurrence TEXT NOT NULL CHECK(recurrence IN ('none','daily','weekly')),
  result TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  content TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  access_encrypted TEXT NOT NULL,
  refresh_encrypted TEXT,
  scopes TEXT NOT NULL,
  expires_at TEXT,
  profile_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, provider)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  code_verifier TEXT,
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_feeds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS timeline_cache (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month_key TEXT NOT NULL,
  narrative TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, month_key)
);

DROP TABLE IF EXISTS automation_tokens;

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proactive_state (
  user_id TEXT PRIMARY KEY,
  last_quiet_nudge_at TEXT,
  last_outreach_at TEXT,
  outreach_date TEXT,
  outreach_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  time_zone TEXT NOT NULL DEFAULT 'America/New_York',
  quiet_start TEXT NOT NULL DEFAULT '22:00',
  quiet_end TEXT NOT NULL DEFAULT '08:00',
  proactive_enabled INTEGER NOT NULL DEFAULT 1,
  briefing_tone TEXT NOT NULL DEFAULT 'motivational',
  briefing_length TEXT NOT NULL DEFAULT 'quick',
  buddy_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS people_mentions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_name TEXT NOT NULL,
  last_mentioned_at TEXT NOT NULL,
  last_nudged_at TEXT,
  dismissed INTEGER NOT NULL DEFAULT 0,
  context_summary TEXT,
  sentiment TEXT,
  last_context_update TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, person_name)
);

CREATE TABLE IF NOT EXISTS curiosity_gaps (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  context TEXT,
  priority INTEGER NOT NULL DEFAULT 2,
  asked_at TEXT,
  dismissed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS motivation_profile (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  style TEXT NOT NULL DEFAULT 'unknown',
  evidence TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emotional_profile (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  support_style TEXT NOT NULL DEFAULT 'unknown',
  energy_notes TEXT,
  evidence TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personal_dates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  year INTEGER,
  type TEXT NOT NULL DEFAULT 'other',
  notes TEXT,
  gift_nag INTEGER NOT NULL DEFAULT 0,
  gift_done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS streak_completions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, item_type, item_id, date)
);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  handled_at TEXT
);

CREATE TABLE IF NOT EXISTS door_tokens (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_personal_dates_user ON personal_dates(user_id);
CREATE INDEX IF NOT EXISTS idx_curiosity_user ON curiosity_gaps(user_id, dismissed, asked_at);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(status, schedule_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_followups_due ON follow_ups(user_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id, status, priority DESC, target_date);
CREATE INDEX IF NOT EXISTS idx_routines_user ON routines(user_id, enabled, time_local);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, status, priority DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_steps ON project_steps(user_id, project_id, position, created_at);
CREATE INDEX IF NOT EXISTS idx_approvals_user ON approvals(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_people_stale ON people_mentions(user_id, dismissed, last_mentioned_at);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(user_id, conversation_id, created_at DESC);
