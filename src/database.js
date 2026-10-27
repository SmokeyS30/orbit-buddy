import { signupSecuritySchema } from './signup-security-schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { decryptSecret, encryptSecret } from './security.js';
import { calculateRelevance, detectContradiction, normalizeMemoryKind, normalizePreferences, normalizePriority, rankGoals, rankMemories, validDateString, validTimeString } from './intelligence.js';
import { assertMemorySafe } from './relational-intelligence.js';
import { PORTABLE_USER_TABLES, portableInsertSql, portableRowValues } from './portable-recovery.js';
import { REPLY_INTERRUPTED_TEXT, REPLY_LEASE_MS } from './reply-jobs.js';
import { currentDeleteApproval, decodeApprovalRow } from './delete-approval.js';

const timestamp = () => new Date().toISOString();

function ensureColumn(db, table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

// Count consecutive calendar days ending today (or yesterday if today has no entry).
// dates: YYYY-MM-DD strings, most recent first. todayStr: YYYY-MM-DD.
function countConsecutiveDays(dates, todayStr) {
  if (!dates.length || !todayStr) return 0;
  const set = new Set(dates);
  const dayMs = 86400_000;
  const parse = (d) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd); };
  let cursor = parse(todayStr);
  // Allow the streak to start yesterday (today's completion may not have happened yet)
  if (!set.has(todayStr)) cursor -= dayMs;
  let streak = 0;
  while (true) {
    const key = new Date(cursor).toISOString().slice(0, 10);
    if (!set.has(key)) break;
    streak++;
    cursor -= dayMs;
  }
  return streak;
}

function adoptOrphanMessages(db, userId) {
  let convo = db.prepare('SELECT * FROM conversations WHERE user_id=? ORDER BY updated_at DESC LIMIT 1').get(userId);
  if (!convo) {
    const now = timestamp(); const id = randomUUID();
    db.prepare('INSERT INTO conversations(id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, userId, 'General', now, now);
    convo = { id };
  }
  db.prepare('UPDATE messages SET conversation_id=? WHERE user_id=? AND conversation_id IS NULL').run(convo.id, userId);
  return convo.id;
}

export function openDatabase(filePath, { encryptionKey = null } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  // chmod is best-effort: network filesystems (e.g. Azure Files) don't support it
  try { fs.chmodSync(path.dirname(filePath), 0o700); } catch (_) {}
  const db = new DatabaseSync(filePath);
  try { fs.chmodSync(filePath, 0o600); } catch (_) {}
  // WAL mode doesn't work on network filesystems (e.g. Azure Files) — fall back to DELETE
  try {
    db.exec('PRAGMA journal_mode = WAL;');
  } catch (_) {
    db.exec('PRAGMA journal_mode = DELETE;');
  }
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const withImmediate=(fn)=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};
  const insertReplyJob=({userId,conversationId,userMessageId,kind='chat',channel='web',originInstance=null,requiresEphemeral=false,insertCreatedAt=null,deliveryToPhone=null,deliveryLinkVerifiedAt=null})=>{
    if(requiresEphemeral&&!originInstance)throw new Error('Ephemeral reply jobs require an origin instance.');
    const id=randomUUID(),queuedAt=timestamp();
    db.prepare(`INSERT INTO reply_jobs(id,user_id,conversation_id,user_message_id,kind,channel,origin_instance,requires_ephemeral,queued_at,lease_expires_at,insert_created_at,delivery_to_phone,delivery_link_verified_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,userId,conversationId,userMessageId,kind,channel,originInstance,requiresEphemeral?1:0,queuedAt,
      requiresEphemeral?new Date(Date.now()+REPLY_LEASE_MS).toISOString():null,insertCreatedAt,deliveryToPhone,deliveryLinkVerifiedAt);
    return db.prepare('SELECT * FROM reply_jobs WHERE id=?').get(id);
  };
  for (const sql of signupSecuritySchema) db.exec(sql);
  const protectSecret = (value) => {
    const text = String(value || '');
    if (!text || text.startsWith('enc:v1:') || !encryptionKey) return text;
    return `enc:v1:${encryptSecret(text, encryptionKey)}`;
  };
  const revealSecret = (value) => {
    const text = String(value || '');
    if (!text.startsWith('enc:v1:')) return text;
    if (!encryptionKey) throw new Error('Data encryption key is required to read protected calendar feeds.');
    return decryptSecret(text.slice('enc:v1:'.length), encryptionKey);
  };
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','member')),
      disabled INTEGER NOT NULL DEFAULT 0, moderation_blocked INTEGER NOT NULL DEFAULT 0, email_verified_at TEXT, ai_sharing_consent_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, user_agent TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_identities (
      provider TEXT NOT NULL, subject TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(provider, subject), UNIQUE(provider, user_id)
    );
    CREATE TABLE IF NOT EXISTS recovery_codes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL UNIQUE, used_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, user_id TEXT, role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      submission_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('response','problem')),
      reason TEXT NOT NULL CHECK(reason IN ('unsafe','incorrect','bug','other')),
      description TEXT NOT NULL DEFAULT '',
      message_id TEXT,
      message_excerpt TEXT,
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewing','resolved','dismissed')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reviewed_at TEXT,
      owner_note TEXT NOT NULL DEFAULT '',
      UNIQUE(reporter_user_id,submission_id)
    );
    CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reports_reporter_created ON reports(reporter_user_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, user_id TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_suggestions (
      id TEXT PRIMARY KEY, user_id TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS import_jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      filename TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'processing',
      total_chunks INTEGER NOT NULL DEFAULT 0, done_chunks INTEGER NOT NULL DEFAULT 0,
      suggestions_added INTEGER NOT NULL DEFAULT 0, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS follow_ups (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      description TEXT NOT NULL, due_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled',
      priority INTEGER NOT NULL DEFAULT 2, source_message_id TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT, last_error TEXT, created_at TEXT NOT NULL, completed_at TEXT,
      UNIQUE(user_id, description, due_date)
    );
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'active',
      priority INTEGER NOT NULL DEFAULT 2, progress INTEGER NOT NULL DEFAULT 0,
      target_date TEXT, next_step TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS goal_checkins (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      progress INTEGER NOT NULL, note TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, prompt TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'custom',
      cadence TEXT NOT NULL DEFAULT 'daily', time_local TEXT NOT NULL DEFAULT '09:00',
      day_of_week INTEGER, enabled INTEGER NOT NULL DEFAULT 1, last_run_date TEXT, last_run_at TEXT,
      lease_date TEXT, lease_expires_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','paused','completed')),
      priority INTEGER NOT NULL DEFAULT 2, target_date TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS project_steps (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, details TEXT, status TEXT NOT NULL DEFAULT 'planned'
        CHECK(status IN ('planned','in_progress','blocked','completed')),
      position INTEGER NOT NULL DEFAULT 0, due_date TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','executed','rejected','failed')),
      source_message_id TEXT, result_json TEXT, last_error TEXT, execution_started_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reviewed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, user_id TEXT, title TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL,
      risk TEXT NOT NULL CHECK(risk IN ('internal','external')), schedule_at TEXT,
      recurrence TEXT NOT NULL CHECK(recurrence IN ('none','daily','weekly')), result TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, user_id TEXT, type TEXT NOT NULL, message TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, task_id TEXT,
      name TEXT NOT NULL, mime_type TEXT NOT NULL, content TEXT NOT NULL, size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS apns_device_tokens (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_token TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'ios',
      apns_environment TEXT NOT NULL DEFAULT 'production',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(user_id, device_token)
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      expires_at TEXT, app_account_token TEXT, environment TEXT NOT NULL DEFAULT 'production',
      original_transaction_id TEXT, last_event_signed_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subscription_purchase_intents (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL, app_account_token TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', transaction_id TEXT,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS daily_usage (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day_ny TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, day_ny)
    );
    CREATE TABLE IF NOT EXISTS processed_notifications (
      notification_id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'processing', completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS connectors (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, access_encrypted TEXT NOT NULL, refresh_encrypted TEXT,
      scopes TEXT NOT NULL, expires_at TEXT, profile_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(user_id, provider)
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, code_verifier TEXT, redirect_uri TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS calendar_feeds (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS timeline_cache (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      month_key TEXT NOT NULL,
      narrative TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, month_key)
    );
    CREATE TABLE IF NOT EXISTS timeline_generation_leases (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      month_key TEXT NOT NULL,
      token TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    DROP TABLE IF EXISTS automation_tokens;
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reply_jobs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_message_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('chat','regenerate')),
      channel TEXT NOT NULL CHECK(channel IN ('web','whatsapp')),
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','interrupted','cancelled')),
      origin_instance TEXT,
      requires_ephemeral INTEGER NOT NULL DEFAULT 0,
      queued_at TEXT NOT NULL,
      claimed_at TEXT,
      lease_expires_at TEXT,
      lease_token TEXT,
      completed_at TEXT,
      reply_message_id TEXT,
      insert_created_at TEXT,
      delivery_attempted_at TEXT,
      delivery_to_phone TEXT,
      delivery_link_verified_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reply_jobs_claim ON reply_jobs(status,seq);
    CREATE INDEX IF NOT EXISTS idx_reply_jobs_conversation ON reply_jobs(conversation_id,seq);
    CREATE INDEX IF NOT EXISTS idx_reply_jobs_lease ON reply_jobs(status,lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_reply_jobs_delivery ON reply_jobs(channel,status,delivery_attempted_at,seq);
    CREATE INDEX IF NOT EXISTS idx_reply_jobs_origin ON reply_jobs(origin_instance,status,requires_ephemeral);
    CREATE TABLE IF NOT EXISTS proactive_state (
      user_id TEXT PRIMARY KEY, last_quiet_nudge_at TEXT
    );
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      time_zone TEXT NOT NULL DEFAULT 'America/New_York', quiet_start TEXT NOT NULL DEFAULT '22:00',
      quiet_end TEXT NOT NULL DEFAULT '08:00', proactive_enabled INTEGER NOT NULL DEFAULT 1,
      briefing_tone TEXT NOT NULL DEFAULT 'motivational', briefing_length TEXT NOT NULL DEFAULT 'quick',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS people_mentions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      person_name TEXT NOT NULL, last_mentioned_at TEXT NOT NULL, last_nudged_at TEXT,
      dismissed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, person_name)
    );
    CREATE TABLE IF NOT EXISTS curiosity_gaps (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      question TEXT NOT NULL, context TEXT, priority INTEGER NOT NULL DEFAULT 2,
      asked_at TEXT, dismissed INTEGER NOT NULL DEFAULT 0,
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
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL, month INTEGER NOT NULL, day INTEGER NOT NULL, year INTEGER,
      type TEXT NOT NULL DEFAULT 'other', notes TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_personal_dates_user ON personal_dates(user_id);
    CREATE INDEX IF NOT EXISTS idx_curiosity_user ON curiosity_gaps(user_id, dismissed, asked_at);
    CREATE TABLE IF NOT EXISTS streak_completions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_type TEXT NOT NULL, item_id TEXT NOT NULL, date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, item_type, item_id, date)
    );
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      summary TEXT NOT NULL, message_count INTEGER NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS access_requests (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, note TEXT,
      created_at TEXT NOT NULL, handled_at TEXT
    );
    CREATE TABLE IF NOT EXISTS door_tokens (
      token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signup_verification_tokens (
      token_hash TEXT PRIMARY KEY, email_hash TEXT NOT NULL, expires_at TEXT NOT NULL,
      used_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS whatsapp_links (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      phone_e164 TEXT NOT NULL UNIQUE,
      verified_at TEXT NOT NULL,
      last_inbound_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS radar_findings (
      finding_key TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      kind TEXT NOT NULL,
      signal TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      url TEXT,
      workflow TEXT,
      branch TEXT,
      found_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS radar_deliveries (
      finding_key TEXT NOT NULL REFERENCES radar_findings(finding_key) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      delivered_at TEXT NOT NULL,
      PRIMARY KEY (finding_key, user_id)
    );
    CREATE TABLE IF NOT EXISTS radar_mutes (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      repo TEXT NOT NULL,
      muted_at TEXT NOT NULL,
      PRIMARY KEY (user_id, repo)
    );
    CREATE TABLE IF NOT EXISTS catchup_seen (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_key TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      dismissed_at TEXT,
      PRIMARY KEY (user_id, item_key)
    );
    CREATE INDEX IF NOT EXISTS idx_catchup_seen_user ON catchup_seen(user_id);
    CREATE TABLE IF NOT EXISTS soul_records (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      record_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS soul_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      source TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_soul_history_user ON soul_history(user_id, version DESC);
    -- Proactive memory (2026-10-16): tracks which memories were volunteered
    -- unprompted (in chat or via a proactive push) so nothing repeats.
    -- content_snapshot + memory_created_at keep the "why are you telling me
    -- this?" answer exact even if the memory is later edited or deleted.
    CREATE TABLE IF NOT EXISTS memory_surfacing (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      memory_id TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      via TEXT NOT NULL,
      reason TEXT,
      content_snapshot TEXT,
      memory_created_at TEXT,
      surfaced_at TEXT NOT NULL,
      UNIQUE(user_id, occurrence_key)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_surfacing_user ON memory_surfacing(user_id, surfaced_at DESC);
    CREATE TABLE IF NOT EXISTS study_questions (
      id TEXT PRIMARY KEY, exam TEXT NOT NULL, topic TEXT NOT NULL,
      question TEXT NOT NULL, choices TEXT NOT NULL, correct_index INTEGER NOT NULL,
      explanation TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'seed'
    );
    CREATE TABLE IF NOT EXISTS study_attempts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, question_id TEXT NOT NULL,
      correct INTEGER NOT NULL, attempted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_study_questions_exam ON study_questions(exam);
    CREATE INDEX IF NOT EXISTS idx_study_attempts_user ON study_attempts(user_id, attempted_at DESC);
    CREATE TABLE IF NOT EXISTS canvas_revisions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(message_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_canvas_revisions_message ON canvas_revisions(message_id, version DESC);
    CREATE INDEX IF NOT EXISTS idx_radar_findings_repo ON radar_findings(repo, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_radar_findings_created ON radar_findings(created_at DESC);
    CREATE TABLE IF NOT EXISTS waitlist (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT,
      status TEXT NOT NULL DEFAULT 'pending', notes TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_waitlist_status ON waitlist(status, created_at);
    CREATE TABLE IF NOT EXISTS signup_risk_events (
      id TEXT PRIMARY KEY, subject_hash TEXT, mode TEXT NOT NULL, decision TEXT NOT NULL,
      score INTEGER NOT NULL, signals_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_signup_risk_created ON signup_risk_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pw_reset_user ON password_reset_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_signup_verification_expiry ON signup_verification_tokens(expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_signup_verification_email ON signup_verification_tokens(email_hash);
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
  `);

  // Upgrade v0.1 databases in place without discarding user data.
  ensureColumn(db, 'reports', 'owner_note', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'users', 'moderation_blocked', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'email_verified_at', 'TEXT');
  ensureColumn(db, 'users', 'ai_sharing_consent_at', 'TEXT');
  ensureColumn(db, 'messages', 'user_id', 'TEXT');
  ensureColumn(db, 'messages', 'conversation_id', 'TEXT');
  ensureColumn(db, 'messages', 'reply_job_id', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_reply_job ON messages(reply_job_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(user_id, conversation_id, created_at DESC)');
  for (const row of db.prepare('SELECT DISTINCT user_id FROM messages WHERE conversation_id IS NULL AND user_id IS NOT NULL').all()) adoptOrphanMessages(db, row.user_id);
  ensureColumn(db, 'memories', 'user_id', 'TEXT');
  ensureColumn(db, 'memories', 'kind', "TEXT NOT NULL DEFAULT 'fact'");
  ensureColumn(db, 'memories', 'source', "TEXT NOT NULL DEFAULT 'legacy'");
  ensureColumn(db, 'memories', 'status', "TEXT NOT NULL DEFAULT 'approved'");
  ensureColumn(db, 'memories', 'confidence', 'REAL NOT NULL DEFAULT 1');
  ensureColumn(db, 'memories', 'expires_at', 'TEXT');
  ensureColumn(db, 'memories', 'last_confirmed_at', 'TEXT');
  ensureColumn(db, 'memories', 'last_mentioned_at', 'TEXT');
  ensureColumn(db, 'memories', 'relevance_score', 'REAL NOT NULL DEFAULT 1.0');
  ensureColumn(db, 'memories', 'superseded_by', 'TEXT');
  ensureColumn(db, 'memories', 'embedding', 'TEXT');
  ensureColumn(db, 'memories', 'proactive_allowed', 'INTEGER NOT NULL DEFAULT 1');
  // L3 multi-user polish: server-side dismissal of the "what can Orbit do" intro card.
  ensureColumn(db, 'user_preferences', 'intro_dismissed', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'memory_suggestions', 'kind', "TEXT NOT NULL DEFAULT 'fact'");
  ensureColumn(db, 'memory_suggestions', 'confidence', 'REAL NOT NULL DEFAULT 0.7');
  ensureColumn(db, 'follow_ups', 'priority', 'INTEGER NOT NULL DEFAULT 2');
  ensureColumn(db, 'follow_ups', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'follow_ups', 'next_attempt_at', 'TEXT');
  ensureColumn(db, 'follow_ups', 'last_error', 'TEXT');
  ensureColumn(db, 'tasks', 'user_id', 'TEXT');
  ensureColumn(db, 'tasks', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'tasks', 'lease_expires_at', 'TEXT');
  ensureColumn(db, 'tasks', 'last_error', 'TEXT');
  ensureColumn(db, 'tasks', 'delivery_channel', "TEXT NOT NULL DEFAULT 'push'");
  ensureColumn(db, 'events', 'user_id', 'TEXT');
  ensureColumn(db, 'proactive_state', 'last_outreach_at', 'TEXT');
  ensureColumn(db, 'proactive_state', 'outreach_date', 'TEXT');
  ensureColumn(db, 'people_mentions', 'context_summary', 'TEXT');
  ensureColumn(db, 'personal_dates', 'gift_nag', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'personal_dates', 'gift_done', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'people_mentions', 'sentiment', 'TEXT');
  ensureColumn(db, 'people_mentions', 'last_context_update', 'TEXT');
  ensureColumn(db, 'proactive_state', 'outreach_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'proactive_state', 'last_app_open_at', 'TEXT');
  ensureColumn(db, 'user_preferences', 'briefing_tone', "TEXT NOT NULL DEFAULT 'motivational'");
  ensureColumn(db, 'user_preferences', 'briefing_length', "TEXT NOT NULL DEFAULT 'quick'");
  ensureColumn(db, 'user_preferences', 'buddy_name', 'TEXT');
  ensureColumn(db, 'reply_jobs', 'delivery_to_phone', 'TEXT');
  ensureColumn(db, 'reply_jobs', 'delivery_link_verified_at', 'TEXT');
  // X5 "Writes like you": opt-in flag + distilled style profile (additive only).
  ensureColumn(db, 'user_preferences', 'writing_voice_opt_in', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'user_preferences', 'writing_voice_profile', 'TEXT');
  ensureColumn(db, 'user_preferences', 'writing_voice_updated_at', 'TEXT');
  ensureColumn(db, 'user_preferences', 'writing_voice_offered', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'approvals', 'execution_started_at', 'TEXT');
  ensureColumn(db, 'subscriptions', 'last_event_signed_at', 'TEXT');
  ensureColumn(db, 'processed_notifications', 'state', "TEXT NOT NULL DEFAULT 'processed'");
  ensureColumn(db, 'processed_notifications', 'completed_at', 'TEXT');
  db.exec("UPDATE processed_notifications SET state='processed',completed_at=COALESCE(completed_at,received_at) WHERE state IS NULL OR state!='processing'");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_app_token_unique ON subscriptions(app_account_token) WHERE app_account_token IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_original_txn_unique ON subscriptions(original_transaction_id) WHERE original_transaction_id IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_intents_transaction_unique ON subscription_purchase_intents(transaction_id) WHERE transaction_id IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_purchase_intents_user_pending ON subscription_purchase_intents(user_id,status,expires_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_user_status ON memories(user_id, status, updated_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_artifacts_user ON artifacts(user_id, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_calendar_feeds_user ON calendar_feeds(user_id)');

  if (encryptionKey) {
    const legacyFeeds = db.prepare("SELECT id,url FROM calendar_feeds WHERE url NOT LIKE 'enc:v1:%'").all();
    const updateFeed = db.prepare('UPDATE calendar_feeds SET url=?,updated_at=? WHERE id=?');
    if (legacyFeeds.length) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const feed of legacyFeeds) updateFeed.run(protectSecret(feed.url), timestamp(), feed.id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  }

  const legacyFollowups = db.prepare("SELECT id,user_id,content,created_at FROM memories WHERE status='approved' AND lower(content) LIKE 'follow up:% on ____-__-__'").all();
  const insertFollowup = db.prepare("INSERT OR IGNORE INTO follow_ups(id,user_id,description,due_date,status,source_message_id,created_at,completed_at) VALUES(?,?,?,?,'scheduled',NULL,?,NULL)");
  const archiveMemory = db.prepare("UPDATE memories SET status='archived',updated_at=? WHERE id=?");
  for (const memory of legacyFollowups) {
    const match = /^follow up:\s*(.+?)\s+on\s+(\d{4}-\d{2}-\d{2})\s*$/i.exec(memory.content);
    if (match && memory.user_id) {
      insertFollowup.run(randomUUID(), memory.user_id, match[1], match[2], memory.created_at || timestamp());
      archiveMemory.run(timestamp(), memory.id);
    }
  }

  const s = {
    countUsers: db.prepare('SELECT COUNT(*) AS count FROM users'),
    listUsers: db.prepare('SELECT id,email,display_name,role,disabled,moderation_blocked,ai_sharing_consent_at,created_at,updated_at FROM users ORDER BY created_at'),
    createUser: db.prepare('INSERT INTO users(id,email,display_name,password_hash,password_salt,role,disabled,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)'),
    createDemoUser: db.prepare('INSERT INTO users(id,email,display_name,password_hash,password_salt,role,disabled,is_demo,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)'),
    listExpiredDemoUsers: db.prepare("SELECT id FROM users WHERE is_demo=1 AND created_at<=?"),
    deleteUser: db.prepare('DELETE FROM users WHERE id=?'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    authIdentity: db.prepare('SELECT * FROM auth_identities WHERE provider=? AND subject=?'),
    authIdentityForUser: db.prepare('SELECT 1 FROM auth_identities WHERE provider=? AND user_id=? LIMIT 1'),
    linkAuthIdentity: db.prepare('INSERT INTO auth_identities(provider,subject,user_id,created_at,updated_at) VALUES(?,?,?,?,?)'),
    updatePassword: db.prepare('UPDATE users SET password_hash=?, password_salt=?, updated_at=? WHERE id=?'),
    setUserDisabled: db.prepare('UPDATE users SET disabled=?, updated_at=? WHERE id=? AND (?=1 OR moderation_blocked=0)'),
    setModerationBlocked: db.prepare("UPDATE users SET disabled=?,moderation_blocked=?,updated_at=? WHERE id=? AND role='member' AND disabled=? AND moderation_blocked=?"),
    markUserEmailVerified: db.prepare('UPDATE users SET email_verified_at=?, updated_at=? WHERE id=? AND email_verified_at IS NULL'),
    claimMessages: db.prepare('UPDATE messages SET user_id=? WHERE user_id IS NULL'),
    claimMemories: db.prepare('UPDATE memories SET user_id=? WHERE user_id IS NULL'),
    claimTasks: db.prepare('UPDATE tasks SET user_id=? WHERE user_id IS NULL'),
    claimEvents: db.prepare('UPDATE events SET user_id=? WHERE user_id IS NULL'),
    createSession: db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)'),
    session: db.prepare(`SELECT sessions.*, users.email, users.display_name, users.role, users.disabled, users.moderation_blocked, users.is_demo
      FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?`),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash=?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id=?'),
    pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at<=?'),
    clearRecovery: db.prepare('DELETE FROM recovery_codes WHERE user_id=?'),
    addRecovery: db.prepare('INSERT INTO recovery_codes VALUES (?, ?, ?, NULL, ?)'),
    recovery: db.prepare('SELECT * FROM recovery_codes WHERE code_hash=? AND used_at IS NULL'),
    useRecovery: db.prepare('UPDATE recovery_codes SET used_at=? WHERE id=? AND used_at IS NULL'),
    setting: db.prepare('SELECT value FROM settings WHERE key=?'),
    setSetting: db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`),
    addMessage: db.prepare('INSERT INTO messages(id,user_id,conversation_id,role,content,created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    createConversation: db.prepare('INSERT INTO conversations(id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)'),
    listConversations: db.prepare('SELECT * FROM conversations WHERE user_id=? ORDER BY updated_at DESC,rowid DESC'),
    getConversation: db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?'),
    // W3: conversation share/export — user-agnostic existence check so a
    // foreign id 403s while a truly unknown id 404s (same pattern as W1).
    getConversationAny: db.prepare('SELECT id FROM conversations WHERE id=?'),
    touchConversation: db.prepare('UPDATE conversations SET updated_at=? WHERE id=? AND user_id=?'),
    deleteConversation: db.prepare('DELETE FROM conversations WHERE id=? AND user_id=?'),
    deleteConversationMessages: db.prepare('DELETE FROM messages WHERE conversation_id=? AND user_id=?'),
    listConversationMessages: db.prepare('SELECT * FROM messages WHERE user_id=? AND conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?'),
    listConversationMessagesThrough: db.prepare(`SELECT * FROM messages WHERE user_id=? AND conversation_id=? AND rowid<=
      (SELECT rowid FROM messages WHERE id=? AND user_id=? AND conversation_id=?) ORDER BY created_at DESC,rowid DESC LIMIT ?`),
    listMessages: db.prepare('SELECT * FROM messages WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?'),
    listMessagesByInsertion: db.prepare('SELECT * FROM messages WHERE user_id=? ORDER BY rowid DESC LIMIT ?'),
    getReportSubmission: db.prepare('SELECT * FROM reports WHERE reporter_user_id=? AND submission_id=?'),
    countRecentReports: db.prepare('SELECT COUNT(*) AS count FROM reports WHERE reporter_user_id=? AND created_at>=?'),
    addReport: db.prepare(`INSERT INTO reports(id,reporter_user_id,submission_id,kind,reason,description,message_id,message_excerpt,status,created_at,updated_at,reviewed_at)
      VALUES(?,?,?,?,?,?,?,?,'new',?,?,NULL) ON CONFLICT(reporter_user_id,submission_id) DO NOTHING`),
    listReports: db.prepare(`SELECT reports.*, users.display_name AS reporter_name FROM reports
      JOIN users ON users.id=reports.reporter_user_id ORDER BY CASE WHEN reports.status IN ('new','reviewing') THEN 0 ELSE 1 END, CASE WHEN reports.status IN ('new','reviewing') THEN reports.created_at END ASC, reports.created_at DESC,reports.rowid DESC LIMIT ?`),
    listOwnReports: db.prepare('SELECT id,kind,reason,status,created_at,updated_at,reviewed_at,owner_note FROM reports WHERE reporter_user_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?'),
    reportQueueSummary: db.prepare("SELECT status,COUNT(*) AS count,MIN(created_at) AS oldest_at FROM reports GROUP BY status"),
    updateReportStatus: db.prepare('UPDATE reports SET status=?,owner_note=COALESCE(?,owner_note),updated_at=?,reviewed_at=COALESCE(reviewed_at,?) WHERE id=?'),
    getReport: db.prepare('SELECT * FROM reports WHERE id=?'),
    // W1: per-message actions.
    getMessage: db.prepare('SELECT * FROM messages WHERE id=? AND user_id=?'),
    getMessageAny: db.prepare('SELECT * FROM messages WHERE id=?'),
    deleteMessageRow: db.prepare('DELETE FROM messages WHERE id=? AND user_id=?'),
    setMessageContentRow: db.prepare('UPDATE messages SET content=? WHERE id=? AND user_id=?'),
    // L1 Canvas v2: revision history (immutable rows).
    addCanvasRevision: db.prepare('INSERT INTO canvas_revisions(id,user_id,message_id,version,content,created_at) VALUES (?,?,?,?,?,?)'),
    listCanvasRevisions: db.prepare('SELECT * FROM canvas_revisions WHERE user_id=? AND message_id=? ORDER BY version DESC LIMIT 50'),
    getCanvasRevision: db.prepare('SELECT * FROM canvas_revisions WHERE user_id=? AND message_id=? AND version=?'),
    retimeMessageRow: db.prepare('UPDATE messages SET created_at=? WHERE id=? AND user_id=?'),
    addMemory: db.prepare(`INSERT INTO memories(id,user_id,content,created_at,updated_at,kind,source,status,confidence,expires_at,last_confirmed_at,last_mentioned_at,relevance_score,superseded_by,embedding,proactive_allowed)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, NULL, 1.0, NULL, ?, ?)`),
    listMemories: db.prepare("SELECT * FROM memories WHERE user_id=? AND status='approved' ORDER BY updated_at DESC,rowid DESC LIMIT 100"),
    getMemory: db.prepare("SELECT * FROM memories WHERE id=? AND user_id=? AND status='approved'"),
    updateMemory: db.prepare("UPDATE memories SET content=?,kind=?,proactive_allowed=?,last_confirmed_at=?,relevance_score=1.0,updated_at=? WHERE id=? AND user_id=? AND status='approved'"),
    deleteMemory: db.prepare('DELETE FROM memories WHERE id=? AND user_id=?'),
    addMemorySuggestion: db.prepare('INSERT INTO memory_suggestions(id,user_id,content,created_at,kind,confidence) VALUES (?,?,?,?,?,?)'),
    getMemorySuggestion: db.prepare('SELECT * FROM memory_suggestions WHERE id=? AND user_id=?'),
    listMemorySuggestions: db.prepare('SELECT * FROM memory_suggestions WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50'),
    deleteMemorySuggestion: db.prepare('DELETE FROM memory_suggestions WHERE id=? AND user_id=?'),
    addImportJob: db.prepare('INSERT INTO import_jobs(id,user_id,filename,status,total_chunks,done_chunks,suggestions_added,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'),
    expireStaleImportJobs: db.prepare("UPDATE import_jobs SET status='failed',error='Import stopped before completion. Please try again.',updated_at=? WHERE user_id=? AND status='processing' AND updated_at<?"),
    activeImportJob: db.prepare("SELECT 1 FROM import_jobs WHERE user_id=? AND status='processing' LIMIT 1"),
    countRecentImportJobs: db.prepare('SELECT COUNT(*) AS count FROM import_jobs WHERE user_id=? AND created_at>=?'),
    getImportJob: db.prepare('SELECT * FROM import_jobs WHERE id=? AND user_id=?'),
    listImportJobs: db.prepare('SELECT * FROM import_jobs WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 5'),
    updateImportJob: db.prepare('UPDATE import_jobs SET status=?,total_chunks=?,done_chunks=?,suggestions_added=?,error=?,updated_at=? WHERE id=? AND user_id=?'),
    addFollowUp: db.prepare("INSERT OR IGNORE INTO follow_ups(id,user_id,description,due_date,status,priority,source_message_id,attempt_count,next_attempt_at,last_error,created_at,completed_at) VALUES(?,?,?,?,'scheduled',?,?,0,NULL,NULL,?,NULL)"),
    listFollowUps: db.prepare("SELECT * FROM follow_ups WHERE user_id=? AND status='scheduled' ORDER BY priority DESC,due_date,created_at"),
    dueFollowUps: db.prepare("SELECT * FROM follow_ups WHERE user_id=? AND status='scheduled' AND due_date<=? AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY priority DESC,due_date,created_at"),
    completeFollowUp: db.prepare("UPDATE follow_ups SET status='completed',completed_at=?,next_attempt_at=NULL,last_error=NULL WHERE id=? AND user_id=? AND status='scheduled'"),
    failFollowUp: db.prepare("UPDATE follow_ups SET attempt_count=attempt_count+1,next_attempt_at=?,last_error=? WHERE id=? AND user_id=? AND status='scheduled'"),
    deleteFollowUp: db.prepare('DELETE FROM follow_ups WHERE id=? AND user_id=?'),
    addPersonalDate: db.prepare(`INSERT INTO personal_dates(id,user_id,label,month,day,year,type,notes,gift_nag,gift_done,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`),
    listPersonalDates: db.prepare('SELECT * FROM personal_dates WHERE user_id=? ORDER BY month,day,label'),
    getPersonalDate: db.prepare('SELECT * FROM personal_dates WHERE id=? AND user_id=?'),
    updatePersonalDate: db.prepare('UPDATE personal_dates SET label=?,month=?,day=?,year=?,type=?,notes=?,gift_nag=?,gift_done=?,updated_at=? WHERE id=? AND user_id=?'),
    deletePersonalDate: db.prepare('DELETE FROM personal_dates WHERE id=? AND user_id=?'),
    addGoal: db.prepare(`INSERT INTO goals(id,user_id,title,description,status,priority,progress,target_date,next_step,created_at,updated_at,completed_at)
      VALUES(?,?,?,?,'active',?,0,?,?,?, ?,NULL)`),
    getGoal: db.prepare('SELECT * FROM goals WHERE id=? AND user_id=?'),
    listGoals: db.prepare("SELECT * FROM goals WHERE user_id=? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,priority DESC,COALESCE(target_date,'9999-12-31'),updated_at DESC"),
    updateGoal: db.prepare('UPDATE goals SET progress=?,status=?,next_step=?,updated_at=?,completed_at=? WHERE id=? AND user_id=?'),
    updateGoalFields: db.prepare('UPDATE goals SET title=?,priority=?,target_date=?,updated_at=? WHERE id=? AND user_id=?'),
    deleteGoal: db.prepare('DELETE FROM goals WHERE id=? AND user_id=?'),
    addGoalCheckin: db.prepare('INSERT INTO goal_checkins(id,goal_id,user_id,progress,note,created_at) VALUES(?,?,?,?,?,?)'),
    listGoalCheckins: db.prepare('SELECT * FROM goal_checkins WHERE goal_id=? AND user_id=? ORDER BY created_at DESC LIMIT ?'),
    addRoutine: db.prepare(`INSERT INTO routines(id,user_id,title,prompt,kind,cadence,time_local,day_of_week,enabled,last_run_date,last_run_at,lease_date,lease_expires_at,last_error,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,1,NULL,NULL,NULL,NULL,NULL,?,?)`),
    getRoutine: db.prepare('SELECT * FROM routines WHERE id=? AND user_id=?'),
    listRoutines: db.prepare('SELECT * FROM routines WHERE user_id=? ORDER BY enabled DESC,time_local,title COLLATE NOCASE'),
    updateRoutineEnabled: db.prepare('UPDATE routines SET enabled=?,lease_date=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND user_id=?'),
    updateRoutineFields: db.prepare('UPDATE routines SET title=?,time_local=?,cadence=?,day_of_week=?,enabled=?,updated_at=? WHERE id=? AND user_id=?'),
    deleteRoutine: db.prepare('DELETE FROM routines WHERE id=? AND user_id=?'),
    claimRoutine: db.prepare(`UPDATE routines SET lease_date=?,lease_expires_at=?,last_error=NULL,updated_at=? WHERE id=? AND user_id=? AND enabled=1
      AND (last_run_date IS NULL OR last_run_date<>?) AND (lease_expires_at IS NULL OR lease_expires_at<=?)`),
    completeRoutine: db.prepare('UPDATE routines SET last_run_date=?,last_run_at=?,lease_date=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=? WHERE id=? AND user_id=? AND lease_date=?'),
    failRoutine: db.prepare('UPDATE routines SET lease_date=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=? AND user_id=? AND lease_date=?'),
    addProject: db.prepare(`INSERT INTO projects(id,user_id,title,description,status,priority,target_date,created_at,updated_at,completed_at)
      VALUES(?,?,?,?,'active',?,?,?, ?,NULL)`),
    getProject: db.prepare('SELECT * FROM projects WHERE id=? AND user_id=?'),
    listProjects: db.prepare("SELECT * FROM projects WHERE user_id=? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,priority DESC,COALESCE(target_date,'9999-12-31'),updated_at DESC"),
    updateProject: db.prepare('UPDATE projects SET title=?,description=?,status=?,priority=?,target_date=?,updated_at=?,completed_at=? WHERE id=? AND user_id=?'),
    deleteProject: db.prepare('DELETE FROM projects WHERE id=? AND user_id=?'),
    addProjectStep: db.prepare(`INSERT INTO project_steps(id,project_id,user_id,title,details,status,position,due_date,created_at,updated_at,completed_at)
      VALUES(?,?,?,?,?,'planned',?,?,?, ?,NULL)`),
    getProjectStep: db.prepare('SELECT * FROM project_steps WHERE id=? AND user_id=?'),
    listProjectSteps: db.prepare('SELECT * FROM project_steps WHERE project_id=? AND user_id=? ORDER BY position,created_at'),
    listUserProjectSteps: db.prepare('SELECT * FROM project_steps WHERE user_id=? ORDER BY project_id,position,created_at'),
    updateProjectStep: db.prepare('UPDATE project_steps SET title=?,details=?,status=?,position=?,due_date=?,updated_at=?,completed_at=? WHERE id=? AND user_id=?'),
    deleteProjectStep: db.prepare('DELETE FROM project_steps WHERE id=? AND user_id=?'),
    addApproval: db.prepare(`INSERT INTO approvals(id,user_id,kind,title,summary,payload_json,status,source_message_id,result_json,last_error,created_at,updated_at,reviewed_at)
      VALUES(?,?,?,?,?,?,'pending',?,NULL,NULL,?,?,NULL)`),
    getApproval: db.prepare('SELECT * FROM approvals WHERE id=? AND user_id=?'),
    listApprovals: db.prepare("SELECT * FROM approvals WHERE user_id=? ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,created_at DESC,rowid DESC LIMIT 200"),
    claimApproval: db.prepare("UPDATE approvals SET execution_started_at=?,updated_at=? WHERE id=? AND user_id=? AND status='pending' AND (execution_started_at IS NULL OR execution_started_at<=?)"),
    resolveApproval: db.prepare("UPDATE approvals SET status=?,result_json=?,last_error=?,execution_started_at=NULL,reviewed_at=?,updated_at=? WHERE id=? AND user_id=? AND status='pending' AND execution_started_at IS NULL"),
    finishApproval: db.prepare("UPDATE approvals SET status=?,result_json=?,last_error=?,execution_started_at=NULL,reviewed_at=?,updated_at=? WHERE id=? AND user_id=? AND status='pending' AND execution_started_at IS NOT NULL"),
    lastUserMessage: db.prepare("SELECT MAX(created_at) AS last_at FROM messages WHERE user_id=? AND role='user'"),
    getQuietNudge: db.prepare('SELECT last_quiet_nudge_at FROM proactive_state WHERE user_id=?'),
    setQuietNudge: db.prepare(`INSERT INTO proactive_state(user_id,last_quiet_nudge_at) VALUES(?,?)
      ON CONFLICT(user_id) DO UPDATE SET last_quiet_nudge_at=excluded.last_quiet_nudge_at`),
    getProactiveState: db.prepare('SELECT * FROM proactive_state WHERE user_id=?'),
    upsertProactiveSlot: db.prepare(`INSERT INTO proactive_state(user_id,outreach_date,outreach_count) VALUES(?,?,1)
      ON CONFLICT(user_id) DO UPDATE SET outreach_date=excluded.outreach_date,
      outreach_count=CASE WHEN proactive_state.outreach_date=excluded.outreach_date THEN proactive_state.outreach_count+1 ELSE 1 END`),
    markOutreach: db.prepare('UPDATE proactive_state SET last_outreach_at=? WHERE user_id=?'),
    releaseProactiveSlot: db.prepare(`UPDATE proactive_state SET outreach_count=MAX(0,outreach_count-1)
      WHERE user_id=? AND outreach_date=? AND outreach_count>0`),
    getPreferences: db.prepare('SELECT * FROM user_preferences WHERE user_id=?'),
    getWritingVoiceState: db.prepare('SELECT writing_voice_opt_in AS opt_in, writing_voice_profile AS profile, writing_voice_updated_at AS updated_at, writing_voice_offered AS offered FROM user_preferences WHERE user_id=?'),
    setWritingVoiceOptIn: db.prepare('UPDATE user_preferences SET writing_voice_opt_in=?, updated_at=? WHERE user_id=?'),
    setWritingVoiceProfile: db.prepare('UPDATE user_preferences SET writing_voice_opt_in=1, writing_voice_profile=?, writing_voice_updated_at=?, updated_at=? WHERE user_id=?'),
    clearWritingVoice: db.prepare('UPDATE user_preferences SET writing_voice_opt_in=0, writing_voice_profile=NULL, writing_voice_updated_at=NULL, updated_at=? WHERE user_id=?'),
    setWritingVoiceOffered: db.prepare('UPDATE user_preferences SET writing_voice_offered=1, updated_at=? WHERE user_id=?'),
    // Soul core: versioned personality record per user + append-only edit history.
    getSoulRecord: db.prepare('SELECT user_id, record_json, version, updated_at FROM soul_records WHERE user_id=?'),
    upsertSoulRecord: db.prepare(`INSERT INTO soul_records(user_id, record_json, version, updated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET record_json=excluded.record_json, version=excluded.version, updated_at=excluded.updated_at`),
    insertSoulHistory: db.prepare('INSERT INTO soul_history(id, user_id, version, record_json, source, created_at) VALUES(?,?,?,?,?,?)'),
    listSoulHistory: db.prepare('SELECT id, user_id, version, record_json, source, created_at FROM soul_history WHERE user_id=? ORDER BY version DESC LIMIT ?'),
    getSoulHistoryVersion: db.prepare('SELECT id, user_id, version, record_json, source, created_at FROM soul_history WHERE user_id=? AND version=?'),
    // Proactive memory: surfacing dedup + explainability. INSERT OR IGNORE
    // keeps recording idempotent on (user_id, occurrence_key).
    recordMemorySurfacing: db.prepare(`INSERT OR IGNORE INTO memory_surfacing(id,user_id,memory_id,occurrence_key,kind,via,reason,content_snapshot,memory_created_at,surfaced_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`),
    getMemorySurfacing: db.prepare('SELECT * FROM memory_surfacing WHERE user_id=? AND occurrence_key=?'),
    listMemorySurfacings: db.prepare('SELECT * FROM memory_surfacing WHERE user_id=? ORDER BY surfaced_at DESC LIMIT ?'),
    getLastMemorySurfacing: db.prepare('SELECT * FROM memory_surfacing WHERE user_id=? ORDER BY surfaced_at DESC LIMIT 1'),
    // Memory connections (2026-10-16): stable occurrence keys (pattern kind+theme)
    // are re-surfaced after their cooldown — refresh surfaced_at on re-record
    // since recordMemorySurfacing is INSERT OR IGNORE.
    touchMemorySurfacing: db.prepare('UPDATE memory_surfacing SET surfaced_at=? WHERE user_id=? AND occurrence_key=?'),
    trackPersonMention: db.prepare(`INSERT INTO people_mentions(user_id,person_name,last_mentioned_at,last_nudged_at,dismissed,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,person_name) DO UPDATE SET last_mentioned_at=excluded.last_mentioned_at,
      dismissed=0,updated_at=excluded.updated_at`),
    getStalePeople: db.prepare(`SELECT person_name,last_mentioned_at,last_nudged_at FROM people_mentions
      WHERE user_id=? AND dismissed=0 AND last_mentioned_at<? AND (last_nudged_at IS NULL OR last_nudged_at<?)
      ORDER BY last_mentioned_at ASC`),
    listPersonMentions: db.prepare('SELECT person_name FROM people_mentions WHERE user_id=? AND dismissed=0'),
    dismissPersonNudge: db.prepare('UPDATE people_mentions SET dismissed=1,updated_at=? WHERE user_id=? AND person_name=?'),
    markPersonNudged: db.prepare('UPDATE people_mentions SET last_nudged_at=?,updated_at=? WHERE user_id=? AND person_name=?'),
    addCuriosityGap: db.prepare('INSERT INTO curiosity_gaps(id,user_id,question,context,priority,asked_at,dismissed,created_at) VALUES(?,?,?,?,?,?,?,?)'),
    listCuriosityGaps: db.prepare('SELECT id,question,context,priority FROM curiosity_gaps WHERE user_id=? AND dismissed=0 AND asked_at IS NULL ORDER BY priority DESC,created_at ASC LIMIT 5'),
    markCuriosityGapAsked: db.prepare('UPDATE curiosity_gaps SET asked_at=? WHERE id=? AND user_id=?'),
    getMotivationProfile: db.prepare('SELECT * FROM motivation_profile WHERE user_id=?'),
    setMotivationProfile: db.prepare(`INSERT INTO motivation_profile(user_id,style,evidence,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET style=excluded.style,evidence=excluded.evidence,updated_at=excluded.updated_at`),
    getEmotionalProfile: db.prepare('SELECT * FROM emotional_profile WHERE user_id=?'),
    setEmotionalProfile: db.prepare(`INSERT INTO emotional_profile(user_id,support_style,energy_notes,evidence,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET support_style=excluded.support_style,energy_notes=excluded.energy_notes,evidence=excluded.evidence,updated_at=excluded.updated_at`),
    listMemoriesBySource: db.prepare("SELECT * FROM memories WHERE user_id=? AND source=? AND status='approved' ORDER BY updated_at DESC LIMIT ?"),
    listTrackedPeople: db.prepare('SELECT person_name,context_summary,sentiment,last_mentioned_at FROM people_mentions WHERE user_id=? AND dismissed=0 ORDER BY last_mentioned_at DESC'),
    getPersonContext: db.prepare('SELECT context_summary,sentiment FROM people_mentions WHERE user_id=? AND person_name=?'),
    updatePersonContext: db.prepare('UPDATE people_mentions SET context_summary=?,sentiment=?,last_context_update=?,updated_at=? WHERE user_id=? AND person_name=?'),
    recentlyMentionedPeople: db.prepare('SELECT person_name FROM people_mentions WHERE user_id=? AND dismissed=0 AND last_mentioned_at>? ORDER BY last_mentioned_at DESC LIMIT 5'),
    listMemoriesOnDate: db.prepare(`SELECT content,created_at FROM memories WHERE user_id=? AND status='approved'
      AND strftime('%m',created_at)=? AND strftime('%d',created_at)=? AND strftime('%Y',created_at)!=?
      ORDER BY created_at DESC LIMIT 5`),
    recordStreakCompletion: db.prepare(`INSERT OR IGNORE INTO streak_completions(user_id,item_type,item_id,date,created_at) VALUES(?,?,?,?,?)`),
    listStreakDates: db.prepare(`SELECT date FROM streak_completions WHERE user_id=? AND item_type=? AND item_id=? ORDER BY date DESC LIMIT 400`),
    listGoalCheckinDates: db.prepare(`SELECT DISTINCT substr(created_at,1,10) AS date FROM goal_checkins WHERE user_id=? AND goal_id=? ORDER BY date DESC LIMIT 400`),
    listTasksCompletedSince: db.prepare(`SELECT * FROM tasks WHERE user_id=? AND status='completed' AND updated_at>=? ORDER BY updated_at DESC`),
    listMemoriesSince: db.prepare(`SELECT * FROM memories WHERE user_id=? AND status='approved' AND created_at>=? ORDER BY created_at DESC`),
    listGoalCheckinsSince: db.prepare(`SELECT gc.*, g.title AS goal_title FROM goal_checkins gc JOIN goals g ON g.id=gc.goal_id
      WHERE gc.user_id=? AND gc.created_at>=? ORDER BY gc.created_at DESC`),
    getTimelineNarrative: db.prepare('SELECT narrative, generated_at FROM timeline_cache WHERE user_id=? AND month_key=?'),
    setTimelineNarrative: db.prepare(`INSERT INTO timeline_cache(user_id,month_key,narrative,generated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id,month_key) DO UPDATE SET narrative=excluded.narrative, generated_at=excluded.generated_at`),
    timelineMemories: db.prepare(`SELECT content, kind FROM memories WHERE user_id=? AND status='approved' AND source!='registration' AND substr(created_at,1,7)=? ORDER BY created_at DESC LIMIT 8`),
    timelineConversations: db.prepare(`SELECT c.title FROM conversations c WHERE c.user_id=? AND substr(c.created_at,1,7)=? AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.role='user') ORDER BY c.created_at DESC LIMIT 12`),
    timelineGoalsCreated: db.prepare(`SELECT title FROM goals WHERE user_id=? AND substr(created_at,1,7)=? LIMIT 10`),
    timelineGoalsCompleted: db.prepare(`SELECT title FROM goals WHERE user_id=? AND status='completed' AND completed_at IS NOT NULL AND substr(completed_at,1,7)=? LIMIT 10`),
    timelineCheckinCount: db.prepare(`SELECT COUNT(*) AS n FROM goal_checkins WHERE user_id=? AND substr(created_at,1,7)=?`),
    upsertPreferences: db.prepare(`INSERT INTO user_preferences(user_id,time_zone,quiet_start,quiet_end,proactive_enabled,briefing_tone,briefing_length,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET time_zone=excluded.time_zone,quiet_start=excluded.quiet_start,
      quiet_end=excluded.quiet_end,proactive_enabled=excluded.proactive_enabled,briefing_tone=excluded.briefing_tone,
      briefing_length=excluded.briefing_length,updated_at=excluded.updated_at`),
    setBuddyName: db.prepare('UPDATE user_preferences SET buddy_name=?, updated_at=? WHERE user_id=?'),
    getConversationSummary: db.prepare('SELECT * FROM conversation_summaries WHERE conversation_id=? AND user_id=?'),
    upsertConversationSummary: db.prepare(`INSERT INTO conversation_summaries(conversation_id,user_id,summary,message_count,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET summary=excluded.summary,message_count=excluded.message_count,updated_at=excluded.updated_at
      WHERE excluded.message_count>conversation_summaries.message_count`),
    countConversationMessages: db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id=? AND user_id=?'),
    countUserMessages: db.prepare("SELECT COUNT(*) AS count FROM messages WHERE user_id=? AND role='user'"),
    addTask: db.prepare(`INSERT INTO tasks(id,user_id,title,prompt,status,risk,schedule_at,recurrence,delivery_channel,result,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?)`),
    listTasks: db.prepare('SELECT * FROM tasks WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200'),
    addCalendarFeed: db.prepare(`INSERT INTO calendar_feeds(id,user_id,label,url,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`),
    listCalendarFeeds: db.prepare('SELECT * FROM calendar_feeds WHERE user_id=? ORDER BY label COLLATE NOCASE'),
    deleteCalendarFeed: db.prepare('DELETE FROM calendar_feeds WHERE id=? AND user_id=?'),
    getTask: db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?'),
    updateTask: db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=? AND user_id=?'),
    updateTaskFields: db.prepare('UPDATE tasks SET title=?,prompt=?,schedule_at=?,recurrence=?,updated_at=? WHERE id=? AND user_id=?'),
    deleteTask: db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?'),
    startTask: db.prepare("UPDATE tasks SET status='running',attempt_count=attempt_count+1,lease_expires_at=?,last_error=NULL,updated_at=? WHERE id=? AND user_id=? AND status IN ('queued','scheduled') AND (schedule_at IS NULL OR schedule_at<=?) RETURNING attempt_count"),
    recoverTasks: db.prepare("UPDATE tasks SET status=CASE WHEN schedule_at IS NULL OR schedule_at<=? THEN 'queued' ELSE 'scheduled' END,lease_expires_at=NULL,updated_at=? WHERE status='running' AND (lease_expires_at IS NULL OR lease_expires_at<=?)"),
    completeTask: db.prepare("UPDATE tasks SET status=?,result=?,schedule_at=?,lease_expires_at=NULL,last_error=NULL,updated_at=? WHERE id=? AND user_id=? AND attempt_count=? AND status='running' AND lease_expires_at>?"),
    failTask: db.prepare("UPDATE tasks SET status='failed',result=?,schedule_at=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=? AND user_id=? AND attempt_count=? AND status='running' AND lease_expires_at>?"),
    dueTasks: db.prepare(`SELECT * FROM tasks WHERE status IN ('queued','scheduled')
      AND EXISTS(SELECT 1 FROM users WHERE users.id=tasks.user_id AND users.ai_sharing_consent_at IS NOT NULL)
      AND (schedule_at IS NULL OR schedule_at<=?) ORDER BY COALESCE(schedule_at,created_at),rowid LIMIT 10`),
    addEvent: db.prepare('INSERT INTO events(id,user_id,type,message,detail,created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    listEvents: db.prepare('SELECT * FROM events WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?'),
    countToolUseSince: db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='tool_use' AND message LIKE ? AND created_at>=?"),
    addArtifact: db.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    listArtifacts: db.prepare('SELECT id,task_id,name,mime_type,size_bytes,created_at FROM artifacts WHERE user_id=? ORDER BY created_at DESC LIMIT 200'),
    getArtifact: db.prepare('SELECT * FROM artifacts WHERE id=? AND user_id=?'),
    deleteArtifact: db.prepare('DELETE FROM artifacts WHERE id=? AND user_id=?'),
    addPush: db.prepare(`INSERT INTO push_subscriptions VALUES(?,?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth`),
    listPush: db.prepare('SELECT * FROM push_subscriptions WHERE user_id=?'),
    deletePush: db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?'),
    deletePushById: db.prepare('DELETE FROM push_subscriptions WHERE id=?'),
    upsertApnsToken: db.prepare(`INSERT INTO apns_device_tokens(id,user_id,device_token,platform,apns_environment,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,device_token) DO UPDATE SET updated_at=excluded.updated_at`),
    listApnsTokens: db.prepare('SELECT * FROM apns_device_tokens WHERE user_id=?'),
    deleteApnsToken: db.prepare('DELETE FROM apns_device_tokens WHERE device_token=?'),
    upsertSubscription: db.prepare(`INSERT INTO subscriptions(id,user_id,product_id,status,expires_at,app_account_token,environment,original_transaction_id,last_event_signed_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET product_id=excluded.product_id,status=excluded.status,
      expires_at=excluded.expires_at,app_account_token=excluded.app_account_token,environment=excluded.environment,
      original_transaction_id=excluded.original_transaction_id,last_event_signed_at=COALESCE(excluded.last_event_signed_at,subscriptions.last_event_signed_at),updated_at=excluded.updated_at`),
    getSubscription: db.prepare('SELECT * FROM subscriptions WHERE user_id=?'),
    getDailyUsage: db.prepare('SELECT count FROM daily_usage WHERE user_id=? AND day_ny=?'),
    incrementDailyUsage: db.prepare(`INSERT INTO daily_usage(user_id,day_ny,count,updated_at) VALUES(?,?,1,?)
      ON CONFLICT(user_id,day_ny) DO UPDATE SET count=count+1,updated_at=excluded.updated_at`),
    resetDailyUsage: db.prepare('DELETE FROM daily_usage WHERE day_ny<?'),
    insertNotification: db.prepare(`INSERT INTO processed_notifications(notification_id,received_at,state,completed_at) VALUES(?,?,'processing',NULL)
      ON CONFLICT(notification_id) DO UPDATE SET received_at=excluded.received_at,state='processing',completed_at=NULL
      WHERE processed_notifications.state='processing' AND processed_notifications.received_at<?`),
    completeNotification: db.prepare("UPDATE processed_notifications SET state='processed',completed_at=? WHERE notification_id=? AND state='processing'"),
    releaseNotification: db.prepare("DELETE FROM processed_notifications WHERE notification_id=? AND state='processing'"),
    pruneNotifications: db.prepare("DELETE FROM processed_notifications WHERE state='processed' AND received_at < datetime('now','-30 days')"),
    findUserByAppAccountToken: db.prepare('SELECT user_id FROM subscriptions WHERE app_account_token=?'),
    insertPurchaseIntent: db.prepare(`INSERT INTO subscription_purchase_intents(id,user_id,product_id,app_account_token,status,transaction_id,expires_at,created_at,completed_at)
      VALUES(?,?,?,?,'pending',NULL,?,?,NULL)`),
    getPurchaseIntent: db.prepare("SELECT * FROM subscription_purchase_intents WHERE user_id=? AND app_account_token=? AND product_id=? AND status='pending' AND expires_at>? ORDER BY created_at DESC LIMIT 1"),
    completePurchaseIntent: db.prepare("UPDATE subscription_purchase_intents SET status='verified',transaction_id=?,completed_at=? WHERE id=? AND status='pending'"),
    prunePurchaseIntents: db.prepare("DELETE FROM subscription_purchase_intents WHERE (status='pending' AND expires_at<?) OR (completed_at IS NOT NULL AND completed_at<datetime('now','-30 days'))"),
    upsertConnector: db.prepare(`INSERT INTO connectors VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,provider) DO UPDATE SET access_encrypted=excluded.access_encrypted,
      refresh_encrypted=excluded.refresh_encrypted,scopes=excluded.scopes,expires_at=excluded.expires_at,
      profile_json=excluded.profile_json,updated_at=excluded.updated_at`),
    listConnectors: db.prepare('SELECT id,provider,scopes,expires_at,profile_json,created_at,updated_at FROM connectors WHERE user_id=?'),
    connector: db.prepare('SELECT * FROM connectors WHERE user_id=? AND provider=?'),
    deleteConnector: db.prepare('DELETE FROM connectors WHERE user_id=? AND provider=?'),
    addOauthState: db.prepare('INSERT INTO oauth_states VALUES(?,?,?,?,?,?)'),
    consumeOauthState: db.prepare('SELECT * FROM oauth_states WHERE state_hash=? AND expires_at>?'),
    deleteOauthState: db.prepare('DELETE FROM oauth_states WHERE state_hash=?'),
    addAccessRequest: db.prepare('INSERT INTO access_requests VALUES (?, ?, ?, ?, ?, NULL)'),
    addWaitlistEntry: db.prepare('INSERT INTO waitlist (id,email,name,status,created_at,updated_at) VALUES (?,?,?,?,?,?)'),
    addSignupRiskEvent: db.prepare('INSERT INTO signup_risk_events(id,subject_hash,mode,decision,score,signals_json,created_at) VALUES(?,?,?,?,?,?,?)'),
    listSignupRiskEvents: db.prepare('SELECT mode,decision,score,signals_json,created_at FROM signup_risk_events ORDER BY created_at DESC,id DESC LIMIT ?'),
    listWaitlist: db.prepare('SELECT id,email,name,status,notes,created_at FROM waitlist ORDER BY created_at DESC LIMIT 500'),
    updateWaitlistStatus: db.prepare('UPDATE waitlist SET status=?,updated_at=? WHERE id=?'),
    waitlistPosition: db.prepare("SELECT COUNT(*) AS c FROM waitlist WHERE status='pending' AND created_at<=?"),
    getAccessRequest: db.prepare('SELECT * FROM access_requests WHERE id=?'),
    listAccessRequests: db.prepare('SELECT * FROM access_requests ORDER BY created_at DESC,rowid DESC LIMIT 100'),
    dismissAccessRequest: db.prepare('UPDATE access_requests SET handled_at=? WHERE id=? AND handled_at IS NULL'),
    addDoorToken: db.prepare('INSERT INTO door_tokens VALUES (?, ?, NULL, ?)'),
    consumeDoorToken: db.prepare('SELECT * FROM door_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?'),
    useDoorToken: db.prepare('UPDATE door_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL'),
    pruneDoorTokens: db.prepare('DELETE FROM door_tokens WHERE expires_at<=? OR used_at IS NOT NULL'),
    addPwResetToken: db.prepare('INSERT INTO password_reset_tokens VALUES (?, ?, ?, 0, ?)'),
    getPwResetToken: db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash=? AND used=0 AND expires_at>?'),
    usePwResetToken: db.prepare('UPDATE password_reset_tokens SET used=1 WHERE token_hash=? AND used=0'),
    cleanPwResetTokens: db.prepare('DELETE FROM password_reset_tokens WHERE expires_at<=? OR used=1'),
    addSignupVerificationToken: db.prepare(`INSERT INTO signup_verification_tokens(token_hash,email_hash,expires_at,used_at,created_at) VALUES(?,?,?,NULL,?)
      ON CONFLICT(email_hash) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,used_at=NULL,created_at=excluded.created_at`),
    getPendingSignupVerificationForEmail: db.prepare('SELECT token_hash FROM signup_verification_tokens WHERE email_hash=? AND used_at IS NULL AND expires_at>?'),
    getSignupVerificationToken: db.prepare('SELECT token_hash FROM signup_verification_tokens WHERE token_hash=? AND email_hash=? AND used_at IS NULL AND expires_at>?'),
    useSignupVerificationToken: db.prepare('UPDATE signup_verification_tokens SET used_at=? WHERE token_hash=? AND email_hash=? AND used_at IS NULL AND expires_at>?'),
    deleteSignupVerificationToken: db.prepare('DELETE FROM signup_verification_tokens WHERE token_hash=? AND used_at IS NULL'),
    cleanSignupVerificationTokens: db.prepare('DELETE FROM signup_verification_tokens WHERE expires_at<=? OR used_at IS NOT NULL'),
    linkWhatsApp: db.prepare(`INSERT INTO whatsapp_links(user_id,phone_e164,verified_at,last_inbound_at,created_at)
      VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET phone_e164=excluded.phone_e164,verified_at=excluded.verified_at,created_at=excluded.created_at`),
    getWhatsAppLink: db.prepare('SELECT * FROM whatsapp_links WHERE user_id=?'),
    getUserByWhatsApp: db.prepare('SELECT * FROM whatsapp_links WHERE phone_e164=?'),
    setWhatsAppLastInbound: db.prepare('UPDATE whatsapp_links SET last_inbound_at=? WHERE user_id=?'),
    unlinkWhatsApp: db.prepare('DELETE FROM whatsapp_links WHERE user_id=?'),
    radarFindingSeen: db.prepare('SELECT 1 FROM radar_findings WHERE finding_key=?'),
    storeRadarFinding: db.prepare(`INSERT INTO radar_findings(finding_key,repo,kind,signal,title,detail,url,workflow,branch,found_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(finding_key) DO NOTHING`),
    listRecentRadarFindings: db.prepare('SELECT * FROM radar_findings ORDER BY found_at DESC, created_at DESC LIMIT ?'),
    radarUnrecoveredFailures: db.prepare(`SELECT workflow, branch FROM radar_findings f
      WHERE repo=? AND kind='run' AND signal='high' AND workflow IS NOT NULL AND branch IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM radar_findings r
        WHERE r.repo=f.repo AND r.kind='run' AND r.workflow=f.workflow AND r.branch=f.branch
          AND r.finding_key LIKE '%:recovered' AND r.created_at>=f.created_at
      )`),
    radarFindingDelivered: db.prepare('SELECT 1 FROM radar_deliveries WHERE finding_key=? AND user_id=?'),
    markRadarFindingDelivered: db.prepare('INSERT INTO radar_deliveries(finding_key,user_id,delivered_at) VALUES(?,?,?) ON CONFLICT(finding_key,user_id) DO NOTHING'),
    muteRadarRepo: db.prepare('INSERT INTO radar_mutes(user_id,repo,muted_at) VALUES(?,?,?) ON CONFLICT(user_id,repo) DO NOTHING'),
    unmuteRadarRepo: db.prepare('DELETE FROM radar_mutes WHERE user_id=? AND repo=?'),
    listRadarMutes: db.prepare('SELECT * FROM radar_mutes WHERE user_id=? ORDER BY muted_at DESC'),
    radarMute: db.prepare('SELECT 1 FROM radar_mutes WHERE user_id=? AND repo=?'),
    addStudyQuestion: db.prepare(`INSERT INTO study_questions(id,exam,topic,question,choices,correct_index,explanation,created_at,source)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`),
    getStudyQuestion: db.prepare('SELECT * FROM study_questions WHERE id=?'),
    listStudyQuestions: db.prepare('SELECT * FROM study_questions WHERE exam=? ORDER BY created_at,rowid'),
    countStudyQuestions: db.prepare('SELECT COUNT(*) AS c FROM study_questions'),
    recordStudyAttempt: db.prepare('INSERT INTO study_attempts(id,user_id,question_id,correct,attempted_at) VALUES(?,?,?,?,?)'),
    // "Catch me up" digest: last app-open tracking + seen/dismissed item keys.
    getLastAppOpen: db.prepare('SELECT last_app_open_at FROM proactive_state WHERE user_id=?'),
    setLastAppOpen: db.prepare(`INSERT INTO proactive_state(user_id,last_app_open_at) VALUES(?,?)
      ON CONFLICT(user_id) DO UPDATE SET last_app_open_at=excluded.last_app_open_at`),
    listCatchupSeenKeys: db.prepare('SELECT item_key FROM catchup_seen WHERE user_id=?'),
    markCatchupSeen: db.prepare(`INSERT INTO catchup_seen(user_id,item_key,seen_at,dismissed_at) VALUES(?,?,?,NULL)
      ON CONFLICT(user_id,item_key) DO NOTHING`),
    dismissCatchupItem: db.prepare(`INSERT INTO catchup_seen(user_id,item_key,seen_at,dismissed_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id,item_key) DO UPDATE SET dismissed_at=excluded.dismissed_at`),
    listCatchupEvents: db.prepare(`SELECT id,type,message,detail,created_at FROM events
      WHERE user_id=? AND created_at>? AND type IN ('smart_checkin_sent','quiet_nudge_sent','radar_checkin_sent','followup_sent','routine_sent','weekly_review_sent','email_urgent_sent','study_nudge_sent','calendar_feed_added','calendar_feed_removed')
      ORDER BY created_at DESC LIMIT ?`),
    listUndeliveredRadarFindingsSince: db.prepare(`SELECT f.* FROM radar_findings f
      LEFT JOIN radar_deliveries d ON d.finding_key=f.finding_key AND d.user_id=?
      WHERE f.found_at>? AND d.finding_key IS NULL
      ORDER BY f.found_at DESC LIMIT ?`),
    listUnrecoveredFailureDetails: db.prepare(`SELECT f.repo,f.workflow,f.branch,f.title,f.url,f.found_at FROM radar_findings f
      WHERE f.kind='run' AND f.signal='high' AND f.workflow IS NOT NULL AND f.branch IS NOT NULL
      AND f.created_at=(SELECT MAX(r.created_at) FROM radar_findings r
        WHERE r.repo=f.repo AND r.kind='run' AND r.signal='high' AND r.workflow=f.workflow AND r.branch=f.branch)
      AND NOT EXISTS (
        SELECT 1 FROM radar_findings r2
        WHERE r2.repo=f.repo AND r2.kind='run' AND r2.workflow=f.workflow AND r2.branch=f.branch
          AND r2.finding_key LIKE '%:recovered' AND r2.created_at>=f.created_at)
      ORDER BY f.found_at DESC LIMIT ?`),
    listTasksDueBefore: db.prepare(`SELECT id,title,schedule_at,status,created_at FROM tasks
      WHERE user_id=? AND status NOT IN ('completed','cancelled','failed')
        AND schedule_at IS NOT NULL AND schedule_at<=?
      ORDER BY schedule_at ASC LIMIT ?`),
    getStudyAttemptsByTopic: db.prepare(`SELECT q.exam AS exam, q.topic AS topic, COUNT(*) AS total,
        SUM(CASE WHEN a.correct=0 THEN 1 ELSE 0 END) AS wrong
      FROM study_attempts a JOIN study_questions q ON q.id=a.question_id
      WHERE a.user_id=? AND a.attempted_at>=? GROUP BY q.exam,q.topic`),
    getStudyAttemptTimes: db.prepare('SELECT attempted_at AS at FROM study_attempts WHERE user_id=? ORDER BY at DESC LIMIT 2000'),
    getLastStudyActivity: db.prepare('SELECT MAX(attempted_at) AS last_at FROM study_attempts WHERE user_id=?'),
  };

  return {
    close: () => db.close(),
    countUsers: () => s.countUsers.get().count,
    listUsers: () => s.listUsers.all(),
    createUser({ email, displayName, passwordHash, passwordSalt, role }) {
      const now = timestamp(); const id = randomUUID();
      s.createUser.run(id, email, displayName, passwordHash, passwordSalt, role, now, now);
      return s.userById.get(id);
    },
    createDemoUser() {
      const now = timestamp(); const id = randomUUID();
      const email = `demo-${id.slice(0,8)}@demo.orbitbuddy.app`;
      s.createDemoUser.run(id, email, 'Demo Explorer', 'demo', 'demo', 'member', now, now);
      return s.userById.get(id);
    },
    listExpiredDemoUsers(maxAgeMs) {
      const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
      return s.listExpiredDemoUsers.all(cutoff);
    },
    countUserMessages: (userId) => s.countUserMessages.get(userId).count,
    deleteDemoUser(id) {
      s.deleteUserSessions.run(id);
      s.deleteUser.run(id);
    },
    getUserByEmail: (email) => s.userByEmail.get(email),
    getUserById: (id) => s.userById.get(id),
    setAiSharingConsent: (id, accepted) => db.prepare('UPDATE users SET ai_sharing_consent_at=?, updated_at=? WHERE id=?').run(accepted ? timestamp() : null,timestamp(),id).changes>0,
    setSignupPause(paused) {s.setSetting.run('signups_paused',String(paused),timestamp());},
    createSignupAccount({email,displayName,passwordHash,passwordSalt,verificationHash=null,emailHash=null,automatic=false,environmentPaused=false,appleProofHash=null,appleEmailHash=null}) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const apple=appleProofHash?db.prepare('DELETE FROM apple_signup_proofs WHERE token_hash=? AND email_hash=? AND expires_at>? RETURNING subject').get(appleProofHash,appleEmailHash,timestamp()):null;
        if(appleProofHash&&!apple)throw new Error('Apple proof expired');
        if(verificationHash && !s.useSignupVerificationToken.run(timestamp(),verificationHash,emailHash,timestamp()).changes) throw new Error('Verification expired');
        const count=s.countUsers.get().count;
        if(count>0&&(environmentPaused||s.setting.get('signups_paused')?.value==='true'||(!automatic&&s.setting.get('registration_open')?.value!=='true')))throw new Error('Registration unavailable');
        const role=count===0?'owner':'member';
        const id=randomUUID(),now=timestamp();s.createUser.run(id,email,displayName,passwordHash,passwordSalt,role,now,now);
        if(verificationHash||apple)s.markUserEmailVerified.run(now,now,id);
        if(apple)s.linkAuthIdentity.run('apple',apple.subject,id,now,now);
        db.exec('COMMIT');return s.userById.get(id);
      } catch(error) {db.exec('ROLLBACK');throw error;}
    },
    addAppleSignupProof(hash,subject,emailHash,expiresAt) {
      db.prepare('DELETE FROM apple_signup_proofs WHERE expires_at<=?').run(timestamp());
      db.prepare('INSERT INTO apple_signup_proofs VALUES(?,?,?,?)').run(hash,subject,emailHash,expiresAt);
    },
    getAppleSignupProof: (hash,emailHash) => db.prepare('SELECT subject FROM apple_signup_proofs WHERE token_hash=? AND email_hash=? AND expires_at>?').get(hash,emailHash,timestamp()),
    addSignupChallenge(hash, purpose, binding, expiresAt) {
      db.prepare('DELETE FROM signup_challenges WHERE expires_at<=?').run(timestamp());
      db.prepare('INSERT INTO signup_challenges VALUES(?,?,?,?,?)').run(hash,purpose,binding,expiresAt,timestamp());
    },
    consumeSignupChallenge(hash,purpose,binding) {
      return db.prepare('DELETE FROM signup_challenges WHERE token_hash=? AND purpose=? AND binding=? AND expires_at>? RETURNING token_hash').get(hash,purpose,binding,timestamp()) != null;
    },
    getAppAttestKey: (id) => db.prepare('SELECT * FROM app_attest_keys WHERE key_id=?').get(id),
    addAppAttestKey(id,key,environment) { db.prepare('INSERT INTO app_attest_keys VALUES(?,?,?,0,?)').run(id,key,environment,timestamp()); },
    advanceAppAttestCounter(id,previous,next) {
      return next>previous && db.prepare('UPDATE app_attest_keys SET sign_count=? WHERE key_id=? AND sign_count=?').run(next,id,previous).changes>0;
    },
    addSignupAppeal(email,note) {
      const id=randomUUID(),now=timestamp();
      db.prepare('DELETE FROM signup_appeals WHERE created_at<?').run(new Date(Date.now()-30*86400_000).toISOString());
      db.prepare("INSERT INTO signup_appeals VALUES(?,?,?,'pending',?,?)").run(id,email,note,now,now);
      return id;
    },
    listSignupAppeals: () => db.prepare('SELECT * FROM signup_appeals ORDER BY created_at DESC LIMIT 100').all(),
    resolveSignupAppeal(id,status) { return db.prepare('UPDATE signup_appeals SET status=?,updated_at=? WHERE id=?').run(status,timestamp(),id).changes>0; },
    finishRecovery(userId,codeHash,passwordHash,passwordSalt,newCodes) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const user=s.userById.get(userId),row=s.recovery.get(codeHash);
        if(!user||user.disabled||!row||row.user_id!==userId||!s.useRecovery.run(timestamp(),row.id).changes){db.exec('ROLLBACK');return false;}
        s.updatePassword.run(passwordHash,passwordSalt,timestamp(),userId);s.deleteUserSessions.run(userId);s.clearRecovery.run(userId);
        db.prepare('UPDATE password_reset_tokens SET used=1 WHERE user_id=?').run(userId);
        for(const hash of newCodes)s.addRecovery.run(randomUUID(),userId,hash,timestamp());
        db.exec('COMMIT');return true;
      }catch(error){db.exec('ROLLBACK');throw error;}
    },
    finishPasswordReset(hash,passwordHash,passwordSalt) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row=s.getPwResetToken.get(hash,timestamp());
        if(!row || !s.userById.get(row.user_id) || s.userById.get(row.user_id).disabled) { db.exec('ROLLBACK');return false; }
        if(!s.usePwResetToken.run(hash).changes) { db.exec('ROLLBACK');return false; }
        s.updatePassword.run(passwordHash,passwordSalt,timestamp(),row.user_id);
        s.deleteUserSessions.run(row.user_id);
        db.prepare('UPDATE password_reset_tokens SET used=1 WHERE user_id=?').run(row.user_id);
        db.exec('COMMIT');return true;
      } catch(error) { db.exec('ROLLBACK');throw error; }
    },
    getAuthIdentity: (provider, subject) => s.authIdentity.get(provider, subject),
    hasAuthIdentityForUser: (provider, userId) => !!s.authIdentityForUser.get(provider, userId),
    linkAuthIdentity(provider, subject, userId) {
      const now = timestamp();
      s.linkAuthIdentity.run(provider, subject, userId, now, now);
      return s.authIdentity.get(provider, subject);
    },
    updatePassword(id, passwordHash, passwordSalt) { s.updatePassword.run(passwordHash, passwordSalt, timestamp(), id); },
    setUserDisabled(id, disabled) { return s.setUserDisabled.run(disabled ? 1 : 0, timestamp(), id, disabled?1:0).changes>0; },
    setModerationBlocked(id,blocked){return s.setModerationBlocked.run(blocked?1:0,blocked?1:0,timestamp(),id,blocked?0:1,blocked?0:1).changes>0;},
    markUserEmailVerified(id) { const now=timestamp();return s.markUserEmailVerified.run(now,now,id).changes>0; },
    deleteUserAccount(userId) {
      const account = s.userById.get(userId);
      if (!account) return { deleted: false, successorId: null };
      let successorId = null;
      db.exec('BEGIN IMMEDIATE');
      try {
        if (account.role === 'owner') {
          const successor = db.prepare(`SELECT id FROM users
            WHERE id<>? AND is_demo=0 AND disabled=0
            ORDER BY created_at,id LIMIT 1`).get(userId);
          if (successor) {
            db.prepare("UPDATE users SET role='owner',updated_at=? WHERE id=?").run(timestamp(), successor.id);
            successorId = successor.id;
          }
        }

        // Delete every table row carrying this user_id, including legacy
        // tables that predate foreign-key cascades. Parent tables are last so
        // dependent rows are always gone first.
        const parentTables = new Set(['conversations', 'goals', 'projects', 'radar_findings']);
        const userTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
          .map((row) => row.name)
          .filter((name) => db.prepare(`PRAGMA table_info("${String(name).replaceAll('"', '""')}")`).all().some((column) => column.name === 'user_id'))
          .sort((a, b) => Number(parentTables.has(a)) - Number(parentTables.has(b)) || a.localeCompare(b));
        for (const table of userTables) {
          const quoted = `"${String(table).replaceAll('"', '""')}"`;
          db.prepare(`DELETE FROM ${quoted} WHERE user_id=?`).run(userId);
        }
        db.prepare('DELETE FROM settings WHERE instr(key, ?) > 0').run(userId);
        db.prepare('DELETE FROM access_requests WHERE lower(email)=lower(?)').run(account.email);
        db.prepare('DELETE FROM waitlist WHERE lower(email)=lower(?)').run(account.email);
        s.deleteUser.run(userId);
        db.exec('COMMIT');
        return { deleted: true, successorId };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    claimOrphans(userId) { s.claimMessages.run(userId); s.claimMemories.run(userId); s.claimTasks.run(userId); s.claimEvents.run(userId); adoptOrphanMessages(db, userId); },
    createSession({ tokenHash, userId, csrfToken, expiresAt, userAgent }) { s.createSession.run(tokenHash,userId,csrfToken,expiresAt,timestamp(),userAgent || null); },
    getSession: (tokenHash) => s.session.get(tokenHash, timestamp()),
    deleteSession: (tokenHash) => s.deleteSession.run(tokenHash),
    deleteUserSessions: (userId) => s.deleteUserSessions.run(userId),
    pruneSessions: () => s.pruneSessions.run(timestamp()),
    replaceRecoveryCodes(userId, hashes) {
      db.exec('BEGIN IMMEDIATE');
      try {
        s.clearRecovery.run(userId);
        for (const hash of hashes) s.addRecovery.run(randomUUID(),userId,hash,timestamp());
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    consumeRecoveryCode(hash,userId) { const row=s.recovery.get(hash); if(!row || (userId && row.user_id!==userId)) return null; return s.useRecovery.run(timestamp(),row.id).changes ? row : null; },
    getSetting: (key, fallback=null) => s.setting.get(key)?.value ?? fallback,
    setSetting(key,value) { s.setSetting.run(key,String(value),timestamp()); },
    ensureDefaultConversation(userId) { const existing=s.listConversations.get(userId); if(existing){adoptOrphanMessages(db,userId);return existing;}
      const now=timestamp();const row={id:randomUUID(),user_id:userId,title:'General',created_at:now,updated_at:now};
      s.createConversation.run(row.id,row.user_id,row.title,row.created_at,row.updated_at);adoptOrphanMessages(db,userId);return row; },
    createConversation(userId,title){const now=timestamp();const row={id:randomUUID(),user_id:userId,title,created_at:now,updated_at:now};s.createConversation.run(row.id,row.user_id,row.title,row.created_at,row.updated_at);return row;},
    listConversations:(userId)=>s.listConversations.all(userId),
    getConversation:(userId,id)=>s.getConversation.get(id,userId),
    conversationExists:(id)=>!!s.getConversationAny.get(id),
    touchConversation:(userId,id)=>s.touchConversation.run(timestamp(),id,userId).changes>0,
    deleteConversation(userId,id){db.exec('BEGIN IMMEDIATE');try{s.deleteConversationMessages.run(id,userId);const gone=s.deleteConversation.run(id,userId).changes>0;db.exec('COMMIT');return gone;}catch(error){db.exec('ROLLBACK');throw error;}},
    addMessage(userId, conversationId, role, content) { const row={id:randomUUID(),user_id:userId,conversation_id:conversationId,role,content,created_at:timestamp()}; s.addMessage.run(row.id,row.user_id,row.conversation_id,row.role,row.content,row.created_at); return row; },
    acceptReplyJob(userId,conversationId,content,options={}){return withImmediate(()=>{
      const userMessage={id:randomUUID(),user_id:userId,conversation_id:conversationId,role:'user',content,created_at:timestamp()};
      s.addMessage.run(userMessage.id,userId,conversationId,'user',content,userMessage.created_at);
      const job=insertReplyJob({userId,conversationId,userMessageId:userMessage.id,...options});
      s.touchConversation.run(timestamp(),conversationId,userId);
      return{userMessage,job};
    });},
    acceptRegenerateReplyJob(userId,conversationId,userMessageId,targetMessageId,insertCreatedAt,quotaPolicy=null){return withImmediate(()=>{
      const userMessage=s.getMessage.get(userMessageId,userId);
      if(!userMessage||userMessage.conversation_id!==conversationId||userMessage.role!=='user')return null;
      const target=s.getMessage.get(targetMessageId,userId);
      if(!target||target.conversation_id!==conversationId||target.role!=='assistant')return null;
      if(quotaPolicy?.enforced){
        const prior=s.getDailyUsage.get(userId,quotaPolicy.day)?.count||0;
        if(prior>=quotaPolicy.limit)return{quotaDenied:{...quotaPolicy,allowed:false,used:prior}};
        s.incrementDailyUsage.run(userId,quotaPolicy.day,timestamp());
      }
      s.deleteMessageRow.run(targetMessageId,userId);
      const job=insertReplyJob({userId,conversationId,userMessageId,kind:'regenerate',insertCreatedAt});
      s.touchConversation.run(timestamp(),conversationId,userId);
      return{userMessage,job};
    });},
    getReplyJob:(id)=>db.prepare('SELECT * FROM reply_jobs WHERE id=?').get(id)||null,
    getConversationReplyJobState:(userId,conversationId)=>db.prepare('SELECT id,status,completed_at FROM reply_jobs WHERE user_id=? AND conversation_id=? ORDER BY seq DESC LIMIT 1').get(userId,conversationId)||null,
    cancelDisallowedReplyJobs(){return db.prepare(`UPDATE reply_jobs SET status='cancelled',completed_at=?,lease_expires_at=NULL
      WHERE status IN ('queued','running') AND EXISTS(SELECT 1 FROM users u WHERE u.id=reply_jobs.user_id
        AND (u.disabled=1 OR u.moderation_blocked=1))`).run(timestamp()).changes;},
    cancelReplyJob(id,token){return db.prepare(`UPDATE reply_jobs SET status='cancelled',completed_at=?,lease_expires_at=NULL
      WHERE id=? AND status='running' AND lease_token=?`).run(timestamp(),id,token).changes>0;},
    renewQueuedEphemeralReplyJobs(instanceId){return db.prepare(`UPDATE reply_jobs SET lease_expires_at=? WHERE origin_instance=? AND requires_ephemeral=1 AND status='queued'`)
      .run(new Date(Date.now()+REPLY_LEASE_MS).toISOString(),instanceId).changes;},
    claimNextReplyJob(instanceId,leaseMs=REPLY_LEASE_MS){return withImmediate(()=>{
      const job=db.prepare(`SELECT j.* FROM reply_jobs j WHERE j.status='queued'
        AND (j.requires_ephemeral=0 OR j.origin_instance=?)
        AND NOT EXISTS(SELECT 1 FROM reply_jobs active WHERE active.conversation_id=j.conversation_id AND active.status='running')
        AND NOT EXISTS(SELECT 1 FROM reply_jobs prior WHERE prior.conversation_id=j.conversation_id
          AND prior.seq<j.seq AND prior.status IN ('queued','running'))
        ORDER BY j.seq LIMIT 1`).get(instanceId);
      if(!job)return null;
      const token=randomUUID(),claimedAt=timestamp(),expiresAt=new Date(Date.now()+leaseMs).toISOString();
      db.prepare(`UPDATE reply_jobs SET status='running',claimed_at=?,lease_expires_at=?,lease_token=? WHERE id=? AND status='queued'`)
        .run(claimedAt,expiresAt,token,job.id);
      return{...job,status:'running',claimed_at:claimedAt,lease_expires_at:expiresAt,lease_token:token};
    });},
    renewReplyJobLease(id,token,leaseMs=REPLY_LEASE_MS){return db.prepare(`UPDATE reply_jobs SET lease_expires_at=? WHERE id=? AND lease_token=? AND status='running' AND lease_expires_at>?`)
      .run(new Date(Date.now()+leaseMs).toISOString(),id,token,timestamp()).changes>0;},
    releaseReplyJob(id,token){return db.prepare(`UPDATE reply_jobs SET status='queued',claimed_at=NULL,lease_expires_at=CASE
      WHEN requires_ephemeral=1 THEN ? ELSE NULL END,lease_token=NULL
      WHERE id=? AND lease_token=? AND status='running'`).run(new Date(Date.now()+REPLY_LEASE_MS).toISOString(),id,token).changes>0;},
    completeReplyJob(id,token,content,insertCreatedAt=null){return withImmediate(()=>{
      const job=db.prepare('SELECT * FROM reply_jobs WHERE id=?').get(id);
      if(!job||job.status!=='running'||job.lease_token!==token||job.lease_expires_at<=timestamp())return null;
      const account=db.prepare('SELECT disabled,moderation_blocked FROM users WHERE id=?').get(job.user_id);
      if(!account||account.disabled===1||account.moderation_blocked===1){
        db.prepare("UPDATE reply_jobs SET status='cancelled',completed_at=?,lease_expires_at=NULL WHERE id=?").run(timestamp(),id);
        return null;
      }
      const message={id:randomUUID(),user_id:job.user_id,conversation_id:job.conversation_id,role:'assistant',content,
        created_at:insertCreatedAt||timestamp(),reply_job_id:id};
      db.prepare('INSERT INTO messages(id,user_id,conversation_id,role,content,created_at,reply_job_id) VALUES(?,?,?,?,?,?,?)')
        .run(message.id,message.user_id,message.conversation_id,message.role,message.content,message.created_at,id);
      db.prepare(`UPDATE reply_jobs SET status='completed',completed_at=?,lease_expires_at=NULL,reply_message_id=? WHERE id=? AND lease_token=?`)
        .run(timestamp(),message.id,id,token);
      return message;
    });},
    recoverExpiredReplyJobs(nowMs=Date.now()){return withImmediate(()=>{
      const current=new Date(nowMs).toISOString();
      const jobs=db.prepare(`SELECT * FROM reply_jobs WHERE
        (status='running' AND lease_expires_at<=?) OR
        (status='queued' AND requires_ephemeral=1 AND lease_expires_at<=?) ORDER BY seq`).all(current,current);
      for(const job of jobs){
        const messageId=randomUUID();
        db.prepare(`INSERT OR IGNORE INTO messages(id,user_id,conversation_id,role,content,created_at,reply_job_id)
          VALUES(?, ?, ?, 'assistant', ?, ?, ?)`).run(messageId,job.user_id,job.conversation_id,REPLY_INTERRUPTED_TEXT,job.insert_created_at||current,job.id);
        const reply=db.prepare('SELECT id FROM messages WHERE reply_job_id=?').get(job.id);
        db.prepare(`UPDATE reply_jobs SET status='interrupted',completed_at=?,lease_expires_at=NULL,reply_message_id=? WHERE id=?`)
          .run(current,reply?.id||null,job.id);
      }
      return jobs.length;
    });},
    markReplyDeliveryAttempted(id){return db.prepare(`UPDATE reply_jobs SET delivery_attempted_at=? WHERE id=? AND channel='whatsapp'
      AND status IN ('completed','interrupted') AND delivery_attempted_at IS NULL`).run(timestamp(),id).changes>0;},
    listPendingReplyDeliveries(limit=10){return db.prepare(`SELECT * FROM reply_jobs WHERE channel='whatsapp' AND status IN ('completed','interrupted')
      AND delivery_attempted_at IS NULL AND reply_message_id IS NOT NULL ORDER BY seq LIMIT ?`).all(Math.min(Math.max(limit,1),50));},
    listConversationMessages(userId, conversationId, limit=60) { return s.listConversationMessages.all(userId,conversationId,Math.min(Math.max(limit,1),200)).reverse(); },
    listConversationMessagesThrough(userId,conversationId,messageId,limit=60){return s.listConversationMessagesThrough.all(userId,conversationId,messageId,userId,conversationId,Math.min(Math.max(limit,1),200)).reverse();},
    // Chat hot path: keep the SQLite and PostgreSQL adapters on one contract.
    // PostgreSQL resolves these independent reads concurrently inside its
    // worker, collapsing several blocking worker/database round trips into one.
    getChatReplyContext(userId,conversationId,historyLimit=24){
      const preferences=this.getPreferences(userId);
      const keys=[`buddy_name_asked_${userId}`,`ambient_context_${userId}`,`ambient_asked_${userId}`];
      const settings=Object.fromEntries(keys.map((key)=>[key,s.setting.get(key)?.value??null]));
      return{
        conversation:s.getConversation.get(conversationId,userId)||null,
        messageCount:s.countConversationMessages.get(conversationId,userId).count,
        history:historyLimit>0?s.listConversationMessages.all(userId,conversationId,Math.min(Math.max(historyLimit,1),200)).reverse():[],
        preferences,
        summary:s.getConversationSummary.get(conversationId,userId)||null,
        settings,
        writingVoice:{
          optIn:preferences?.writing_voice_opt_in===1,
          profile:preferences?.writing_voice_profile||null,
          updatedAt:preferences?.writing_voice_updated_at||null,
          offered:preferences?.writing_voice_offered===1,
        },
      };
    },
    listMessages(userId, limit=60) { return s.listMessages.all(userId,Math.min(Math.max(limit,1),200)).reverse(); },
    getReportSubmission:(userId,submissionId)=>s.getReportSubmission.get(userId,submissionId),
    countRecentReports:(userId,since)=>s.countRecentReports.get(userId,since).count,
    addReport(userId,report){const now=timestamp();const row={id:randomUUID(),reporter_user_id:userId,submission_id:report.submissionId,kind:report.kind,reason:report.reason,description:report.description,message_id:report.messageId||null,message_excerpt:report.messageExcerpt||null,status:'new',created_at:now,updated_at:now,reviewed_at:null};const result=s.addReport.run(row.id,row.reporter_user_id,row.submission_id,row.kind,row.reason,row.description,row.message_id,row.message_excerpt,now,now);return{report:s.getReportSubmission.get(userId,report.submissionId),created:result.changes>0};},
    listReports:(limit=100)=>s.listReports.all(Math.min(Math.max(limit,1),100)),
    listOwnReports:(userId,limit=50)=>s.listOwnReports.all(userId,Math.min(Math.max(limit,1),50)),
    reportQueueSummary:()=>s.reportQueueSummary.all(),
    updateReportStatus(id,status,ownerNote=null){const now=timestamp();if(!s.updateReportStatus.run(status,ownerNote,now,status==='new'?null:now,id).changes)return null;return s.getReport.get(id);},
    // W1: per-message actions.
    getMessage:(userId,id)=>s.getMessage.get(id,userId),
    messageExists:(id)=>!!s.getMessageAny.get(id),
    deleteMessage(userId,id){return s.deleteMessageRow.run(id,userId).changes>0;},
    // W1: move a message to an explicit position in conversation order
    // (regenerate re-inserts the new answer where the old one was).
    retimeMessage(userId,id,createdAt){return s.retimeMessageRow.run(createdAt,id,userId).changes>0;},
    // L1 Canvas v2: revision history (immutable — rows are only ever inserted).
    addCanvasRevision(userId,messageId,version,content){const row={id:randomUUID(),user_id:userId,message_id:messageId,version,content,created_at:timestamp()};s.addCanvasRevision.run(row.id,row.user_id,row.message_id,row.version,row.content,row.created_at);return row;},
    listCanvasRevisions:(userId,messageId)=>s.listCanvasRevisions.all(userId,messageId),
    getCanvasRevision:(userId,messageId,version)=>s.getCanvasRevision.get(userId,messageId,version),
    setMessageContent(userId,id,content){return s.setMessageContentRow.run(content,id,userId).changes>0;},
    // Deletes a whole turn: the target message plus the adjacent partner that
    // completes it. Deleting an assistant reply also removes the user message
    // it answered; deleting a user message also removes the assistant reply
    // that followed it, if any. Returns the deleted ids, or null when the
    // message does not exist for this user.
    deleteMessageTurn(userId,messageId){
      const target=s.getMessage.get(messageId,userId);
      if(!target)return null;
      const ordered=s.listConversationMessages.all(userId,target.conversation_id,200).reverse();
      const idx=ordered.findIndex((m)=>m.id===messageId);
      const ids=[messageId];
      const prev=idx>0?ordered[idx-1]:null;
      const next=idx>=0&&idx<ordered.length-1?ordered[idx+1]:null;
      if(target.role==='assistant'&&prev&&prev.role==='user')ids.push(prev.id);
      if(target.role==='user'&&next&&next.role==='assistant')ids.push(next.id);
      db.exec('BEGIN IMMEDIATE');
      try{
        for(const id of ids){
          db.prepare(`UPDATE reply_jobs SET status='cancelled',completed_at=?,lease_expires_at=NULL
            WHERE user_id=? AND user_message_id=? AND status IN ('queued','running')`).run(timestamp(),userId,id);
          s.deleteMessageRow.run(id,userId);
        }
        db.exec('COMMIT');
      }
      catch(error){db.exec('ROLLBACK');throw error;}
      return ids;
    },
    addMemory(userId, content, options={}) {
      content=assertMemorySafe(content);
      const now=timestamp();
      const row={id:randomUUID(),user_id:userId,content,created_at:now,updated_at:now,
        kind:normalizeMemoryKind(options.kind),source:String(options.source||'user').slice(0,40),status:'approved',
        confidence:Math.max(0,Math.min(Number(options.confidence??1),1)),expires_at:options.expiresAt||null,last_confirmed_at:now,
        embedding:options.embedding||null,proactive_allowed:options.proactiveAllowed===false?0:1};
      s.addMemory.run(row.id,row.user_id,row.content,row.created_at,row.updated_at,row.kind,row.source,row.confidence,row.expires_at,row.last_confirmed_at,row.embedding,row.proactive_allowed);
      // Contradiction detection: if the new memory conflicts with an existing one,
      // mark the old one as superseded (kept for history, excluded from context).
      try {
        const contradiction=detectContradiction(content,s.listMemories.all(userId));
        if(contradiction&&contradiction.contradicted&&contradiction.contradicted.id!==row.id){
          db.prepare("UPDATE memories SET superseded_by=?,updated_at=? WHERE id=? AND user_id=?").run(row.id,now,contradiction.contradicted.id,userId);
          row.superseded=contradiction.contradicted.id;
        }
      } catch {}
      return row;
    },
    listMemories: (userId) => s.listMemories.all(userId),
    getMemory: (userId,id) => s.getMemory.get(id,userId)||null,
    updateMemory(userId,id,{content,kind,proactiveAllowed}={}){
      const current=s.getMemory.get(id,userId);if(!current)return null;
      const nextContent=content===undefined?current.content:assertMemorySafe(content);
      const nextKind=kind===undefined?current.kind:normalizeMemoryKind(kind);
      const nextProactive=proactiveAllowed===undefined?(current.proactive_allowed===0?0:1):(proactiveAllowed?1:0);
      const now=timestamp();
      s.updateMemory.run(nextContent,nextKind,nextProactive,now,now,id,userId);
      return s.getMemory.get(id,userId)||null;
    },
    listRelevantMemories(userId,query,limit=8){
      const ranked=rankMemories(s.listMemories.all(userId),query,limit);
      // Episodic recall: stamp last_mentioned_at whenever a memory is used in context.
      if(ranked.length){
        const now=timestamp();
        const ids=ranked.map((memory)=>memory.id);
        db.prepare(`UPDATE memories SET last_mentioned_at=? WHERE user_id=? AND id IN (${ids.map(()=>'?').join(',')})`).run(now,userId,...ids);
      }
      return ranked;
    },
    // Load the independent model-context reads as one logical operation. On
    // SQLite this is just a compact local read; on PostgreSQL it is one sync
    // worker crossing and the underlying selects run concurrently.
    getChatModelContext(userId,query,{includePlanning=false,memoryLimit=8}={}){
      const allMemories=s.listMemories.all(userId);
      const memories=rankMemories(allMemories,query,memoryLimit);
      if(memories.length){
        const ids=memories.map((memory)=>memory.id);
        db.prepare(`UPDATE memories SET last_mentioned_at=? WHERE user_id=? AND id IN (${ids.map(()=>'?').join(',')})`).run(timestamp(),userId,...ids);
      }
      if(!includePlanning)return{memories,allMemories,followUps:[],goals:[],projects:[]};
      const rows=s.listProjects.all(userId);const grouped=new Map();
      for(const step of s.listUserProjectSteps.all(userId)){const steps=grouped.get(step.project_id)||[];steps.push(step);grouped.set(step.project_id,steps);}
      return{
        memories,
        allMemories,
        followUps:s.listFollowUps.all(userId).slice(0,8),
        goals:rankGoals(s.listGoals.all(userId),10),
        projects:rows.filter((project)=>project.status!=='completed').map((row)=>({...row,steps:grouped.get(row.id)||[]})),
      };
    },
    getChatProactiveContext(userId){
      return{
        surfacedRows:s.listMemorySurfacings.all(userId,200),
        personalDates:s.listPersonalDates.all(userId),
      };
    },
    // Memory decay: recalculate relevance scores based on inactivity.
    // Run during the daily learning cycle.
    applyMemoryDecay(userId){
      const nowMs=Date.now();
      const update=db.prepare("UPDATE memories SET relevance_score=? WHERE id=? AND user_id=?");
      let updated=0;
      for(const memory of s.listMemories.all(userId)){
        const newScore=calculateRelevance(memory,nowMs);
        const current=Number.isFinite(Number(memory.relevance_score))?Number(memory.relevance_score):1.0;
        if(Math.abs(newScore-current)>0.01){update.run(newScore,memory.id,userId);updated++;}
      }
      return updated;
    },
    deleteMemory: (userId,id) => s.deleteMemory.run(id,userId).changes>0,
    addMemorySuggestion(userId,content,options={}){content=assertMemorySafe(content);const now=timestamp();const row={id:randomUUID(),user_id:userId,content,created_at:now,kind:normalizeMemoryKind(options.kind),confidence:Math.max(0,Math.min(Number(options.confidence??0.7),1))};s.addMemorySuggestion.run(row.id,row.user_id,row.content,row.created_at,row.kind,row.confidence);return row;},
    listMemorySuggestions: (userId) => s.listMemorySuggestions.all(userId),
    dismissMemorySuggestion: (userId,id) => s.deleteMemorySuggestion.run(id,userId).changes>0,
    approveMemorySuggestion(userId,id,options={}){const row=s.getMemorySuggestion.get(id,userId);if(!row)return null;const saved=this.addMemory(userId,row.content,{kind:row.kind,source:options.source||'suggestion',confidence:row.confidence});s.deleteMemorySuggestion.run(id,userId);return {...row,memory_id:saved.id};},
    // Memory v2 (chat-native, 2026-10-16): auto-recall is ON by default — suggestions older
    // than the review window persist automatically. A suggestion that contradicts an
    // existing memory is NEVER auto-saved: it stays pending for explicit approval
    // (verified behavior 2026-10-10 — conflicts are flagged, never silently overwritten).
    autoApproveMemorySuggestions(userId,windowMinutes=15){
      const cutoff=new Date(Date.now()-windowMinutes*60_000).toISOString();
      const stale=s.listMemorySuggestions.all(userId).filter((r)=>r.created_at<=cutoff);
      if(!stale.length)return 0;
      const existing=s.listMemories.all(userId);
      let saved=0;
      for(const row of stale){
        let contradicted=false;
        try{const c=detectContradiction(row.content,existing);contradicted=!!(c&&c.contradicted&&c.contradicted.id);}catch{}
        if(contradicted)continue;
        const approved=this.approveMemorySuggestion(userId,row.id,{source:'auto-suggestion'});
        if(approved){saved++;existing.push({id:approved.memory_id,content:row.content,status:'approved',superseded_by:null,kind:row.kind});}
      }
      return saved;
    },
    createImportJob(userId,filename){return withImmediate(()=>{
      const now=timestamp();
      s.expireStaleImportJobs.run(now,userId,new Date(Date.now()-15*60_000).toISOString());
      if(s.activeImportJob.get(userId)||s.countRecentImportJobs.get(userId,new Date(Date.now()-24*60*60_000).toISOString()).count>=3)return null;
      const row={id:randomUUID(),user_id:userId,filename:String(filename||'').slice(0,200),status:'processing',total_chunks:0,done_chunks:0,suggestions_added:0,error:null,created_at:now,updated_at:now};
      s.addImportJob.run(row.id,row.user_id,row.filename,row.status,row.total_chunks,row.done_chunks,row.suggestions_added,row.error,row.created_at,row.updated_at);return row;
    });},
    getImportJob:(userId,id)=>s.getImportJob.get(id,userId)||null,
    listImportJobs:(userId)=>s.listImportJobs.all(userId),
    updateImportJob(userId,id,patch={}){const cur=s.getImportJob.get(id,userId);if(!cur)return null;const next={status:patch.status||cur.status,total_chunks:patch.total_chunks??cur.total_chunks,done_chunks:patch.done_chunks??cur.done_chunks,suggestions_added:patch.suggestions_added??cur.suggestions_added,error:patch.error!==undefined?patch.error:cur.error,updated_at:timestamp()};s.updateImportJob.run(next.status,next.total_chunks,next.done_chunks,next.suggestions_added,next.error,next.updated_at,id,userId);return {...cur,...next};},
    isImportJobActive(userId,id){
      const row=s.getImportJob.get(id,userId),user=s.userById.get(userId);
      return !!(row?.status==='processing'&&user&&!user.disabled&&!user.moderation_blocked&&!user.is_demo&&s.setting.get('system_paused')?.value!=='true');
    },
    updateImportJobIfCurrent(userId,id,patch={},allowInactive=false){return withImmediate(()=>{
      const cur=s.getImportJob.get(id,userId);
      if(cur?.status!=='processing')return null;
      const user=s.userById.get(userId);
      if(!allowInactive&&(!user||user.disabled||user.moderation_blocked||user.is_demo||s.setting.get('system_paused')?.value==='true'))return null;
      const next={status:patch.status||cur.status,total_chunks:patch.total_chunks??cur.total_chunks,
        done_chunks:patch.done_chunks??cur.done_chunks,suggestions_added:patch.suggestions_added??cur.suggestions_added,
        error:patch.error!==undefined?patch.error:cur.error,updated_at:timestamp()};
      s.updateImportJob.run(next.status,next.total_chunks,next.done_chunks,next.suggestions_added,next.error,next.updated_at,id,userId);
      return{...cur,...next};
    });},
    addImportSuggestionIfCurrent(userId,id,content,options={}){return withImmediate(()=>{
      const job=s.getImportJob.get(id,userId),user=s.userById.get(userId);
      if(job?.status!=='processing'||!user||user.disabled||user.moderation_blocked||user.is_demo||s.setting.get('system_paused')?.value==='true')return null;
      const now=timestamp(),row={id:randomUUID(),user_id:userId,content:assertMemorySafe(content),created_at:now,
        kind:normalizeMemoryKind(options.kind),confidence:Math.max(0,Math.min(Number(options.confidence??0.7),1))};
      s.addMemorySuggestion.run(row.id,row.user_id,row.content,row.created_at,row.kind,row.confidence);
      return row;
    });},
    addFollowUp(userId,{description,dueDate,priority=2,sourceMessageId=null}){const row={id:randomUUID(),user_id:userId,description,due_date:validDateString(dueDate)||dueDate,status:'scheduled',priority:normalizePriority(priority),source_message_id:sourceMessageId,created_at:timestamp(),completed_at:null};const result=s.addFollowUp.run(row.id,row.user_id,row.description,row.due_date,row.priority,row.source_message_id,row.created_at);return result.changes?row:s.listFollowUps.all(userId).find((item)=>item.description===description&&item.due_date===row.due_date);},
    listFollowUps:(userId)=>s.listFollowUps.all(userId),
    dueFollowUps:(userId,today,at=timestamp())=>s.dueFollowUps.all(userId,today,at),
    completeFollowUp:(userId,id)=>s.completeFollowUp.run(timestamp(),id,userId).changes>0,
    failFollowUp:(userId,id,error,retryMs=15*60_000)=>s.failFollowUp.run(new Date(Date.now()+retryMs).toISOString(),String(error||'').slice(0,1000),id,userId).changes>0,
    deleteFollowUp:(userId,id)=>s.deleteFollowUp.run(id,userId).changes>0,
    addPersonalDate(userId,{label,month,day,year=null,type='other',notes=null,giftNag=null}){
      const m=Math.floor(Number(month)),d=Math.floor(Number(day));
      if(!Number.isInteger(m)||m<1||m>12)throw new Error('month must be 1-12.');
      if(!Number.isInteger(d)||d<1||d>31)throw new Error('day must be 1-31.');
      const daysInMonth=[31,29,31,30,31,30,31,31,30,31,30,31][m-1];
      if(d>daysInMonth)throw new Error(`day must be 1-${daysInMonth} for that month.`);
      const y=year==null?null:Math.floor(Number(year));
      if(y!==null&&(!Number.isInteger(y)||y<1900||y>2100))throw new Error('year must be 1900-2100.');
      const cleanType=['birthday','anniversary','other'].includes(type)?type:'other';
      const gift_nag=giftNag===null||giftNag===undefined?((cleanType==='birthday'||cleanType==='anniversary')?1:0):(giftNag?1:0);
      const now=timestamp();
      const row={id:randomUUID(),user_id:userId,label:String(label||'').trim().slice(0,120),month:m,day:d,year:y,type:cleanType,notes:notes?String(notes).trim().slice(0,500):null,gift_nag,gift_done:0,created_at:now,updated_at:now};
      if(!row.label)throw new Error('label is required.');
      s.addPersonalDate.run(row.id,row.user_id,row.label,row.month,row.day,row.year,row.type,row.notes,row.gift_nag,row.gift_done,row.created_at,row.updated_at);
      return row;
    },
    listPersonalDates:(userId)=>s.listPersonalDates.all(userId),
    getPersonalDate:(userId,id)=>s.getPersonalDate.get(id,userId)||null,
    updatePersonalDate(userId,id,{label,month,day,year,type,notes,giftNag,giftDone}={}){
      const current=s.getPersonalDate.get(id,userId);if(!current)return null;
      const m=month===undefined?current.month:Math.floor(Number(month));
      const d=day===undefined?current.day:Math.floor(Number(day));
      if(m<1||m>12||d<1||d>31)throw new Error('month must be 1-12 and day 1-31.');
      const daysInMonth=[31,29,31,30,31,30,31,31,30,31,30,31][m-1];
      if(d>daysInMonth)throw new Error(`day must be 1-${daysInMonth} for that month.`);
      const y=year===undefined?current.year:(year==null?null:Math.floor(Number(year)));
      const cleanType=type===undefined?current.type:(['birthday','anniversary','other'].includes(type)?type:'other');
      const next={label:label===undefined?current.label:String(label).trim().slice(0,120),month:m,day:d,year:y,type:cleanType,notes:notes===undefined?current.notes:(notes?String(notes).trim().slice(0,500):null),gift_nag:giftNag===undefined?current.gift_nag:(giftNag?1:0),gift_done:giftDone===undefined?current.gift_done:(giftDone?1:0)};
      if(!next.label)throw new Error('label is required.');
      s.updatePersonalDate.run(next.label,next.month,next.day,next.year,next.type,next.notes,next.gift_nag,next.gift_done,timestamp(),id,userId);
      return s.getPersonalDate.get(id,userId);
    },
    deletePersonalDate:(userId,id)=>s.deletePersonalDate.run(id,userId).changes>0,
    markGiftDone(userId,id){return !!(s.getPersonalDate.get(id,userId)&&this.updatePersonalDate(userId,id,{giftDone:true}));},
    addGoal(userId,{title,description=null,priority=2,targetDate=null,nextStep=null}){const now=timestamp();const row={id:randomUUID(),user_id:userId,title,description:description||null,status:'active',priority:normalizePriority(priority),progress:0,target_date:targetDate?validDateString(targetDate):null,next_step:nextStep||null,created_at:now,updated_at:now,completed_at:null};s.addGoal.run(row.id,row.user_id,row.title,row.description,row.priority,row.target_date,row.next_step,row.created_at,row.updated_at);return row;},
    getGoal:(userId,id)=>s.getGoal.get(id,userId)||null,
    listGoals:(userId)=>s.listGoals.all(userId),
    listActiveGoals(userId,limit=10){return rankGoals(s.listGoals.all(userId),limit);},
    updateGoal(userId,id,{progress,status,nextStep,note=null,title,priority,targetDate}={}){const current=s.getGoal.get(id,userId);if(!current)return null;const nextProgress=Math.max(0,Math.min(Math.round(Number(progress??current.progress)),100));let nextStatus=['active','paused','completed'].includes(status)?status:current.status;if(nextProgress>=100)nextStatus='completed';const completedAt=nextStatus==='completed'?(current.completed_at||timestamp()):null;const nextTitle=title===undefined?current.title:(String(title||'').trim().slice(0,120)||current.title);const nextPriority=priority===undefined?current.priority:normalizePriority(priority);const nextTarget=targetDate===undefined?current.target_date:(targetDate?validDateString(targetDate):null);const updated=timestamp();s.updateGoal.run(nextProgress,nextStatus,nextStep===undefined?current.next_step:(nextStep||null),updated,completedAt,id,userId);s.updateGoalFields.run(nextTitle,nextPriority,nextTarget,updated,id,userId);if(note||nextProgress!==current.progress)s.addGoalCheckin.run(randomUUID(),id,userId,nextProgress,note?String(note).slice(0,1000):null,updated);return s.getGoal.get(id,userId);},
    deleteGoal:(userId,id)=>s.deleteGoal.run(id,userId).changes>0,
    listGoalCheckins:(userId,goalId,limit=20)=>s.listGoalCheckins.all(goalId,userId,Math.min(Math.max(limit,1),100)),
    addRoutine(userId,{title,prompt,kind='custom',cadence='daily',timeLocal='09:00',dayOfWeek=null}){const now=timestamp();const cleanKind=['briefing','reflection','custom'].includes(kind)?kind:'custom';const cleanCadence=['daily','weekdays','weekly'].includes(cadence)?cadence:'daily';const requestedDay=Number(dayOfWeek);const cleanDay=cleanCadence==='weekly'&&Number.isInteger(requestedDay)&&requestedDay>=0&&requestedDay<=6?requestedDay:(cleanCadence==='weekly'?1:null);const row={id:randomUUID(),user_id:userId,title,prompt,kind:cleanKind,cadence:cleanCadence,time_local:validTimeString(timeLocal,'09:00'),day_of_week:cleanDay,enabled:1,last_run_date:null,last_run_at:null,lease_date:null,lease_expires_at:null,last_error:null,created_at:now,updated_at:now};s.addRoutine.run(row.id,row.user_id,row.title,row.prompt,row.kind,row.cadence,row.time_local,row.day_of_week,row.created_at,row.updated_at);return row;},
    getRoutine:(userId,id)=>s.getRoutine.get(id,userId)||null,
    listRoutines:(userId)=>s.listRoutines.all(userId),
    setRoutineEnabled(userId,id,enabled){return s.updateRoutineEnabled.run(enabled?1:0,timestamp(),id,userId).changes>0;},
    updateRoutine(userId,id,{title,timeLocal,cadence,dayOfWeek,enabled}={}){const current=s.getRoutine.get(id,userId);if(!current)return null;const now=timestamp();const nextTitle=title===undefined?current.title:(String(title||'').trim().slice(0,120)||current.title);const nextTime=timeLocal===undefined?current.time_local:validTimeString(timeLocal,'09:00');const nextCadence=cadence===undefined?current.cadence:(['daily','weekdays','weekly'].includes(cadence)?cadence:current.cadence);const requestedDay=Number(dayOfWeek);const nextDay=dayOfWeek===undefined?current.day_of_week:(nextCadence==='weekly'&&Number.isInteger(requestedDay)&&requestedDay>=0&&requestedDay<=6?requestedDay:(nextCadence==='weekly'?1:null));const nextEnabled=enabled===undefined?current.enabled:(enabled?1:0);s.updateRoutineFields.run(nextTitle,nextTime,nextCadence,nextDay,nextEnabled,now,id,userId);return s.getRoutine.get(id,userId);},
    deleteRoutine:(userId,id)=>s.deleteRoutine.run(id,userId).changes>0,
    claimRoutine(userId,id,localDate,leaseMs=2*60_000){const now=timestamp();return s.claimRoutine.run(localDate,new Date(Date.now()+leaseMs).toISOString(),now,id,userId,localDate,now).changes>0;},
    completeRoutine(userId,id,localDate){const now=timestamp();return s.completeRoutine.run(localDate,now,now,id,userId,localDate).changes>0;},
    failRoutine(userId,id,localDate,error){return s.failRoutine.run(String(error||'').slice(0,1000),timestamp(),id,userId,localDate).changes>0;},
    addProject(userId,{title,description=null,priority=2,targetDate=null,steps=[]}){
      const now=timestamp();const row={id:randomUUID(),user_id:userId,title,description:description||null,status:'active',priority:normalizePriority(priority),target_date:targetDate?validDateString(targetDate):null,created_at:now,updated_at:now,completed_at:null};
      db.exec('BEGIN IMMEDIATE');
      try{
        s.addProject.run(row.id,row.user_id,row.title,row.description,row.priority,row.target_date,row.created_at,row.updated_at);
        let position=0;
        for(const value of steps.slice(0,50)){
          const step=typeof value==='string'?{title:value}:{...value};const stepTitle=String(step.title||'').trim().slice(0,160);if(!stepTitle)continue;
          const stepNow=timestamp();s.addProjectStep.run(randomUUID(),row.id,userId,stepTitle,typeof step.details==='string'&&step.details.trim()?step.details.trim().slice(0,1000):null,position,step.dueDate?validDateString(step.dueDate):null,stepNow,stepNow);position+=1;
        }
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
      return {...row,steps:s.listProjectSteps.all(row.id,userId)};
    },
    getProject(userId,id){const row=s.getProject.get(id,userId);return row?{...row,steps:s.listProjectSteps.all(id,userId)}:null;},
    listProjects(userId){
      const rows=s.listProjects.all(userId);const grouped=new Map();
      for(const step of s.listUserProjectSteps.all(userId)){const steps=grouped.get(step.project_id)||[];steps.push(step);grouped.set(step.project_id,steps);}
      return rows.map((row)=>({...row,steps:grouped.get(row.id)||[]}));
    },
    updateProject(userId,id,patch={}){const current=s.getProject.get(id,userId);if(!current)return null;const status=patch.status===undefined?current.status:(['active','paused','completed'].includes(patch.status)?patch.status:current.status);const title=patch.title===undefined?current.title:String(patch.title||'').trim().slice(0,120)||current.title;const description=patch.description===undefined?current.description:(String(patch.description||'').trim().slice(0,1000)||null);const priority=patch.priority===undefined?current.priority:normalizePriority(patch.priority);const targetDate=patch.targetDate===undefined?current.target_date:(patch.targetDate?validDateString(patch.targetDate):null);const now=timestamp();const completedAt=status==='completed'?(current.completed_at||now):null;s.updateProject.run(title,description,status,priority,targetDate,now,completedAt,id,userId);return this.getProject(userId,id);},
    deleteProject:(userId,id)=>s.deleteProject.run(id,userId).changes>0,
    addProjectStep(userId,projectId,{title,details=null,dueDate=null}){if(!s.getProject.get(projectId,userId))return null;const existing=s.listProjectSteps.all(projectId,userId);const now=timestamp();const row={id:randomUUID(),project_id:projectId,user_id:userId,title,details:details||null,status:'planned',position:existing.length,due_date:dueDate?validDateString(dueDate):null,created_at:now,updated_at:now,completed_at:null};s.addProjectStep.run(row.id,row.project_id,row.user_id,row.title,row.details,row.position,row.due_date,row.created_at,row.updated_at);return row;},
    getProjectStep:(userId,id)=>s.getProjectStep.get(id,userId)||null,
    updateProjectStep(userId,id,patch={}){const current=s.getProjectStep.get(id,userId);if(!current)return null;const status=patch.status===undefined?current.status:(['planned','in_progress','blocked','completed'].includes(patch.status)?patch.status:current.status);const title=patch.title===undefined?current.title:String(patch.title||'').trim().slice(0,160)||current.title;const details=patch.details===undefined?current.details:(String(patch.details||'').trim().slice(0,1000)||null);const position=patch.position===undefined?current.position:Math.max(0,Math.min(Number(patch.position)||0,1000));const dueDate=patch.dueDate===undefined?current.due_date:(patch.dueDate?validDateString(patch.dueDate):null);const now=timestamp();const completedAt=status==='completed'?(current.completed_at||now):null;s.updateProjectStep.run(title,details,status,position,dueDate,now,completedAt,id,userId);const project=s.getProject.get(current.project_id,userId);if(project)s.updateProject.run(project.title,project.description,project.status,project.priority,project.target_date,now,project.completed_at,project.id,userId);return s.getProjectStep.get(id,userId);},
    deleteProjectStep:(userId,id)=>s.deleteProjectStep.run(id,userId).changes>0,
    addApproval(userId,{kind,title,summary,payload={},sourceMessageId=null}){const now=timestamp();const row={id:randomUUID(),user_id:userId,kind:String(kind||'proposal').slice(0,60),title,summary,payload_json:JSON.stringify(payload),status:'pending',source_message_id:sourceMessageId,result_json:null,last_error:null,created_at:now,updated_at:now,reviewed_at:null};s.addApproval.run(row.id,row.user_id,row.kind,row.title,row.summary,row.payload_json,row.source_message_id,row.created_at,row.updated_at);return {...row,payload};},
    getApproval(userId,id){const row=s.getApproval.get(id,userId);if(!row)return null;let payload={},result=null;try{payload=JSON.parse(row.payload_json||'{}');}catch{}try{result=row.result_json?JSON.parse(row.result_json):null;}catch{}return {...row,payload,result};},
    listApprovals(userId){return s.listApprovals.all(userId).map((row)=>{let payload={},result=null;try{payload=JSON.parse(row.payload_json||'{}');}catch{}try{result=row.result_json?JSON.parse(row.result_json):null;}catch{}return {...row,payload,result};});},
    claimApproval(userId,id){const at=timestamp();const staleBefore=new Date(Date.now()-10*60_000).toISOString();if(!s.claimApproval.run(at,at,id,userId,staleBefore).changes)return null;return this.getApproval(userId,id);},
    resolveApproval(userId,id,status,{result=null,error=null}={}){if(!['executed','rejected','failed'].includes(status))return null;const at=timestamp();if(!s.resolveApproval.run(status,result?JSON.stringify(result):null,error?String(error).slice(0,1000):null,at,at,id,userId).changes)return null;return this.getApproval(userId,id);},
    finishApproval(userId,id,status,{result=null,error=null}={}){if(!['executed','failed'].includes(status))return null;const at=timestamp();if(!s.finishApproval.run(status,result?JSON.stringify(result):null,error?String(error).slice(0,1000):null,at,at,id,userId).changes)return null;return this.getApproval(userId,id);},
    executeDeleteApprovalIfCurrent(userId,approvalId){return withImmediate(()=>{
      const raw=s.getApproval.get(approvalId,userId);
      if(!raw||raw.status!=='pending'||raw.execution_started_at)return{status:'already'};
      const approval=decodeApprovalRow(raw),{id,objectType}=approval.payload||{};
      const target=objectType==='goal'?s.getGoal.get(id,userId):objectType==='task'?s.getTask.get(id,userId):objectType==='routine'?s.getRoutine.get(id,userId):null;
      const recent=s.listMessagesByInsertion.all(userId,200);
      const selected=currentDeleteApproval(approval,recent,target);
      const now=timestamp();
      if(!selected){
        db.prepare("UPDATE approvals SET status='rejected',last_error=?,execution_started_at=NULL,reviewed_at=?,updated_at=? WHERE id=? AND user_id=? AND status='pending'").run('Deletion request or target changed.',now,now,approvalId,userId);
        return{status:'stale',approval:decodeApprovalRow(s.getApproval.get(approvalId,userId))};
      }
      const deleted=selected.objectType==='goal'?s.deleteGoal.run(id,userId).changes:selected.objectType==='task'?s.deleteTask.run(id,userId).changes:s.deleteRoutine.run(id,userId).changes;
      if(!deleted)throw new Error('Deletion target changed during transaction.');
      const result={deleted:approval.kind,id:selected.id,title:selected.title};
      db.prepare("UPDATE approvals SET status='executed',result_json=?,last_error=NULL,execution_started_at=NULL,reviewed_at=?,updated_at=? WHERE id=? AND user_id=? AND status='pending'").run(JSON.stringify(result),now,now,approvalId,userId);
      return{status:'executed',approval:decodeApprovalRow(s.getApproval.get(approvalId,userId)),result};
    });},
    lastUserMessageAt: (userId) => s.lastUserMessage.get(userId)?.last_at || null,
    getLastQuietNudgeAt: (userId) => s.getQuietNudge.get(userId)?.last_quiet_nudge_at || null,
    setLastQuietNudgeAt: (userId,iso) => s.setQuietNudge.run(userId,iso),
    getLastOutreachAt: (userId) => s.getProactiveState.get(userId)?.last_outreach_at || null,
    claimProactiveSlot(userId,localDate,limit=3){const current=s.getProactiveState.get(userId);if(current?.outreach_date===localDate&&current.outreach_count>=limit)return false;s.upsertProactiveSlot.run(userId,localDate);return true;},
    markOutreach:(userId)=>s.markOutreach.run(timestamp(),userId).changes>0,
    releaseProactiveSlot:(userId,localDate)=>s.releaseProactiveSlot.run(userId,localDate).changes>0,
    getPreferences(userId){const row=s.getPreferences.get(userId);if(row)return row;const now=timestamp();s.upsertPreferences.run(userId,'America/New_York','22:00','08:00',1,'motivational','quick',now,now);return s.getPreferences.get(userId);},
    setPreferences(userId,value){const current=this.getPreferences(userId);const next=normalizePreferences(value,current);const now=timestamp();s.upsertPreferences.run(userId,next.timeZone,next.quietStart,next.quietEnd,next.proactiveEnabled?1:0,next.briefingTone,next.briefingLength,current.created_at||now,now);return s.getPreferences.get(userId);},
    setBuddyName(userId,name){this.getPreferences(userId);const clean=String(name||'').trim().slice(0,40);if(!clean)throw new Error('Provide a name for your buddy (1-40 characters).');s.setBuddyName.run(clean,timestamp(),userId);return clean;},
    // L3 multi-user polish: persist "what can Orbit do" intro-card dismissal per user (server-side, not localStorage).
    markIntroDismissed(userId){this.getPreferences(userId);db.prepare('UPDATE user_preferences SET intro_dismissed=1, updated_at=? WHERE user_id=?').run(timestamp(),userId);return true;},
    // X5 "Writes like you": per-user writing voice opt-in + distilled profile.
    // Additive columns only; the explicit-column upserts never touch them.
    getWritingVoice(userId){this.getPreferences(userId);const row=s.getWritingVoiceState.get(userId);return {optIn:row?.opt_in===1,profile:row?.profile||null,updatedAt:row?.updated_at||null,offered:row?.offered===1};},
    setWritingVoiceOptIn(userId,optIn){this.getPreferences(userId);s.setWritingVoiceOptIn.run(optIn?1:0,timestamp(),userId);return this.getWritingVoice(userId);},
    markWritingVoiceOffered(userId){this.getPreferences(userId);s.setWritingVoiceOffered.run(timestamp(),userId);},
    setWritingVoiceProfile(userId,profile){this.getPreferences(userId);const clean=String(profile||'').trim().slice(0,1200);if(!clean)throw new Error('A writing voice profile is required.');s.setWritingVoiceProfile.run(clean,timestamp(),timestamp(),userId);return this.getWritingVoice(userId);},
    clearWritingVoice(userId){this.getPreferences(userId);s.clearWritingVoice.run(timestamp(),userId);return this.getWritingVoice(userId);},
    // Soul core: versioned personality record per user (personality only — no
    // personal facts) + append-only edit history for "go back to how you were".
    // Revisions are insert-only; the current record is always max(version).
    getSoulRecord(userId){const row=s.getSoulRecord.get(userId);if(!row)return null;let record=null;try{record=JSON.parse(row.record_json);}catch{}if(!record||typeof record!=='object')return null;return {...record,version:row.version,updatedAt:row.updated_at};},
    saveSoulRecord(userId,record,source){const current=this.getSoulRecord(userId);const version=(current?.version||0)+1;const clean={...record};delete clean.version;delete clean.updatedAt;const json=JSON.stringify(clean);const now=timestamp();s.upsertSoulRecord.run(userId,json,version,now);s.insertSoulHistory.run(randomUUID(),userId,version,json,String(source||'').slice(0,80),now);return {...clean,version,updatedAt:now};},
    listSoulHistory(userId,limit=10){return s.listSoulHistory.all(userId,Math.max(1,Math.min(50,limit||10)));},
    // Proactive memory: which memories were volunteered unprompted, and why.
    // Dedup key is (user_id, occurrence_key); repeats are ignored.
    recordMemorySurfacing(userId,{memoryId,occurrenceKey,kind,via,reason=null,contentSnapshot=null,memoryCreatedAt=null}={}){
      if(!userId||!memoryId||!occurrenceKey||!kind||!via)return false;
      const now=timestamp();
      const changes=s.recordMemorySurfacing.run(randomUUID(),userId,memoryId,String(occurrenceKey).slice(0,200),
        String(kind).slice(0,20),String(via).slice(0,20),
        reason==null?null:String(reason).slice(0,300),
        contentSnapshot==null?null:String(contentSnapshot).slice(0,500),
        memoryCreatedAt==null?null:String(memoryCreatedAt).slice(0,32),now).changes;
      return changes>0;
    },
    getMemorySurfacing:(userId,occurrenceKey)=>s.getMemorySurfacing.get(userId,occurrenceKey)||null,
    listMemorySurfacings:(userId,limit=100)=>s.listMemorySurfacings.all(userId,Math.max(1,Math.min(500,limit||100))),
    getLastMemorySurfacing:(userId)=>s.getLastMemorySurfacing.get(userId)||null,
    // Memory connections: refresh surfaced_at when a stable-occurrence-key
    // insight is re-surfaced after its cooldown (INSERT OR IGNORE won't).
    touchMemorySurfacing(userId,occurrenceKey){
      if(!userId||!occurrenceKey)return false;
      return s.touchMemorySurfacing.run(timestamp(),userId,occurrenceKey).changes>0;
    },
    getSoulHistoryVersion(userId,version){const row=s.getSoulHistoryVersion.get(userId,version);if(!row)return null;let record=null;try{record=JSON.parse(row.record_json);}catch{}return {...row,record};},
    trackPersonMention(userId,personName){const name=String(personName||'').trim().slice(0,80);if(!name)return null;const now=timestamp();s.trackPersonMention.run(userId,name,now,null,0,now,now);return name;},
    getStalePeople(userId,daysThreshold=14){const nowMs=Date.now();const mentionedCutoff=new Date(nowMs-daysThreshold*86400_000).toISOString();const nudgeCutoff=new Date(nowMs-30*86400_000).toISOString();return s.getStalePeople.all(userId,mentionedCutoff,nudgeCutoff);},
    dismissPersonNudge:(userId,personName)=>s.dismissPersonNudge.run(timestamp(),userId,personName).changes>0,
    markPersonNudged(userId,personName){const now=timestamp();return s.markPersonNudged.run(now,now,userId,personName).changes>0;},
    addCuriosityGap(userId,{question,context='',priority=2}={}){const q=String(question||'').trim().slice(0,300);if(q.length<10)return null;const now=timestamp();const id=randomUUID();s.addCuriosityGap.run(id,userId,q,String(context||'').slice(0,300),Math.max(1,Math.min(Number(priority)||2,3)),null,0,now);return id;},
    listCuriosityGaps:(userId)=>s.listCuriosityGaps.all(userId),
    markCuriosityGapAsked:(userId,id)=>s.markCuriosityGapAsked.run(timestamp(),id,userId).changes>0,
    getMotivationProfile(userId){const row=s.getMotivationProfile.get(userId);return row||{user_id:userId,style:'unknown',evidence:null,updated_at:null};},
    setMotivationProfile(userId,style,evidence){const valid=['encouragement','data-driven','tough-love','calm','unknown'];const st=valid.includes(String(style))?String(style):'unknown';s.setMotivationProfile.run(userId,st,String(evidence||'').slice(0,500),timestamp());return st;},
    getEmotionalProfile(userId){const row=s.getEmotionalProfile.get(userId);return row||{user_id:userId,support_style:'unknown',energy_notes:null,evidence:null,updated_at:null};},
    setEmotionalProfile(userId,style,energyNotes,evidence){const valid=['solutions','listening','questions','humor','space','unknown'];const st=valid.includes(String(style))?String(style):'unknown';s.setEmotionalProfile.run(userId,st,String(energyNotes||'').slice(0,500),String(evidence||'').slice(0,500),timestamp());return st;},
    listMemoriesBySource:(userId,source,limit=20)=>s.listMemoriesBySource.all(userId,String(source).slice(0,40),Math.min(Math.max(limit,1),50)),
    listTrackedPeople:(userId)=>s.listTrackedPeople.all(userId),
    getPersonContext(userId,personName){return s.getPersonContext.get(userId,personName)||null;},
    updatePersonContext(userId,personName,contextSummary,sentiment){const now=timestamp();const sent=['positive','neutral','mixed'].includes(String(sentiment).toLowerCase())?String(sentiment).toLowerCase():'neutral';return s.updatePersonContext.run(String(contextSummary||'').slice(0,500),sent,now,now,userId,personName).changes>0;},
    recentlyMentionedPeople:(userId,sinceIso)=>s.recentlyMentionedPeople.all(userId,sinceIso).map((r)=>r.person_name),
    listMemoriesOnDate(userId,month,day){const mm=String(month).padStart(2,'0');const dd=String(day).padStart(2,'0');const yyyy=String(new Date().getUTCFullYear());return s.listMemoriesOnDate.all(userId,mm,dd,yyyy).map((row)=>({...row,year:row.created_at.slice(0,4)}));},
    recordStreakCompletion(userId,itemType,itemId,dateStr){return s.recordStreakCompletion.run(userId,itemType,itemId,dateStr,timestamp()).changes>0;},
    // Count consecutive days with a completion, working backward from today (or yesterday if today has none).
    // dateStrs: array of YYYY-MM-DD strings, most recent first. timeZone-aware "today" passed in.
    getStreak(userId,itemType,itemId,todayStr){
      const rows=s.listStreakDates.all(userId,itemType,itemId).map((r)=>r.date);
      return countConsecutiveDays(rows,todayStr);
    },
    // Goals use goal_checkins history directly (no separate streak table needed).
    getGoalStreak(userId,goalId,todayStr){
      const rows=s.listGoalCheckinDates.all(userId,goalId).map((r)=>r.date);
      return countConsecutiveDays(rows,todayStr);
    },
    // One-time backfill: seed streak_completions for goals from existing checkin history.
    backfillGoalStreaks(userId){
      const goals=s.listGoals.all(userId);
      let seeded=0;
      for(const g of goals){
        const dates=s.listGoalCheckinDates.all(userId,g.id);
        for(const {date} of dates){if(s.recordStreakCompletion.run(userId,'goal',g.id,date,timestamp()).changes>0)seeded++;}
      }
      return seeded;
    },
    listTasksCompletedSince:(userId,sinceISO)=>s.listTasksCompletedSince.all(userId,sinceISO),
    listMemoriesSince:(userId,sinceISO)=>s.listMemoriesSince.all(userId,sinceISO),
    listGoalCheckinsSince:(userId,sinceISO)=>s.listGoalCheckinsSince.all(userId,sinceISO),
    getTimelineNarrative:(userId,monthKey)=>{const row=s.getTimelineNarrative.get(userId,monthKey);return row?row.narrative:null;},
    getTimelineNarrativeRecord:(userId,monthKey)=>s.getTimelineNarrative.get(userId,monthKey)||null,
    setTimelineNarrative:(userId,monthKey,narrative)=>{s.setTimelineNarrative.run(userId,monthKey,narrative,timestamp());},
    claimTimelineNarrative(userId,monthKey,freshAfter=null){return withImmediate(()=>{
      const user=s.userById.get(userId);
      if(!user||user.disabled||user.moderation_blocked||user.is_demo||s.setting.get('system_paused')?.value==='true')return null;
      const cached=s.getTimelineNarrative.get(userId,monthKey);
      if(cached&&(!freshAfter||cached.generated_at>freshAfter))return null;
      const now=timestamp(),token=randomUUID();
      const claimed=db.prepare(`INSERT INTO timeline_generation_leases(user_id,month_key,token,expires_at) VALUES(?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET month_key=excluded.month_key,token=excluded.token,expires_at=excluded.expires_at
        WHERE timeline_generation_leases.expires_at<=?`).run(userId,monthKey,token,new Date(Date.now()+5*60_000).toISOString(),now);
      return claimed.changes?token:null;
    });},
    isTimelineNarrativeLeaseActive(userId,monthKey,token){
      const user=s.userById.get(userId);
      const lease=db.prepare('SELECT token,month_key,expires_at FROM timeline_generation_leases WHERE user_id=?').get(userId);
      return !!(user&&!user.disabled&&!user.moderation_blocked&&!user.is_demo&&s.setting.get('system_paused')?.value!=='true'
        &&lease?.token===token&&lease.month_key===monthKey&&lease.expires_at>timestamp());
    },
    completeTimelineNarrative(userId,monthKey,token,narrative){return withImmediate(()=>{
      const user=s.userById.get(userId);
      const lease=db.prepare('SELECT token,month_key,expires_at FROM timeline_generation_leases WHERE user_id=?').get(userId);
      if(!user||user.disabled||user.moderation_blocked||user.is_demo||s.setting.get('system_paused')?.value==='true'
        ||lease?.token!==token||lease.month_key!==monthKey||lease.expires_at<=timestamp())return false;
      s.setTimelineNarrative.run(userId,monthKey,narrative,timestamp());
      db.prepare('DELETE FROM timeline_generation_leases WHERE user_id=? AND token=?').run(userId,token);
      return true;
    });},
    releaseTimelineNarrative(userId,token){db.prepare('DELETE FROM timeline_generation_leases WHERE user_id=? AND token=?').run(userId,token);},
    timelineMonthData(userId,monthKey){
      return {
        memories:s.timelineMemories.all(userId,monthKey),
        conversations:s.timelineConversations.all(userId,monthKey),
        goalsCreated:s.timelineGoalsCreated.all(userId,monthKey),
        goalsCompleted:s.timelineGoalsCompleted.all(userId,monthKey),
        checkins:s.timelineCheckinCount.get(userId,monthKey).n,
      };
    },
    getConversationSummary:(userId,conversationId)=>s.getConversationSummary.get(conversationId,userId)||null,
    setConversationSummary(userId,conversationId,summary,messageCount){s.upsertConversationSummary.run(conversationId,userId,summary,messageCount,timestamp());return s.getConversationSummary.get(conversationId,userId);},
    countConversationMessages:(userId,conversationId)=>s.countConversationMessages.get(conversationId,userId).count,
    addTask(userId,{title,prompt,risk='internal',scheduleAt=null,recurrence='none',deliveryChannel='push'}) {
      const now=timestamp(); const status=risk==='external'?'waiting_approval':scheduleAt?'scheduled':'queued';
      const channel=deliveryChannel==='whatsapp'?'whatsapp':'push'; // validated: only push/whatsapp
      const row={id:randomUUID(),user_id:userId,title,prompt,status,risk,schedule_at:scheduleAt,recurrence,delivery_channel:channel,result:null,created_at:now,updated_at:now};
      s.addTask.run(row.id,row.user_id,row.title,row.prompt,row.status,row.risk,row.schedule_at,row.recurrence,row.delivery_channel,row.created_at,row.updated_at); return row;
    },
    listTasks: (userId) => s.listTasks.all(userId),
    addCalendarFeed(userId, { label, url }) {
      const now = timestamp();
      const row = { id: randomUUID(), user_id: userId, label, url, created_at: now, updated_at: now };
      s.addCalendarFeed.run(row.id, row.user_id, row.label, protectSecret(row.url), row.created_at, row.updated_at);
      return row;
    },
    listCalendarFeeds: (userId) => s.listCalendarFeeds.all(userId).map((row)=>({...row,url:revealSecret(row.url)})),
    deleteCalendarFeed: (userId, id) => s.deleteCalendarFeed.run(id, userId).changes > 0,
    getTask: (userId,id) => s.getTask.get(id,userId),
    setTaskStatus: (userId,id,status) => s.updateTask.run(status,timestamp(),id,userId).changes>0,
    updateTask(userId,id,{title,prompt,scheduleAt,recurrence}={}){const current=s.getTask.get(id,userId);if(!current)return null;const now=timestamp();const nextTitle=title===undefined?current.title:(String(title||'').trim().slice(0,120)||current.title);const nextPrompt=prompt===undefined?current.prompt:(String(prompt||'').trim().slice(0,6000)||current.prompt);let nextSchedule=current.schedule_at;if(scheduleAt!==undefined)nextSchedule=scheduleAt?new Date(scheduleAt).toISOString():null;const nextRecurrence=recurrence===undefined?current.recurrence:(['none','daily','weekly'].includes(recurrence)?recurrence:current.recurrence);s.updateTaskFields.run(nextTitle,nextPrompt,nextSchedule,nextRecurrence,now,id,userId);return s.getTask.get(id,userId);},
    deleteTask: (userId,id) => s.deleteTask.run(id,userId).changes>0,
    startTask:(userId,id,leaseMs=2*60_000)=>s.startTask.get(new Date(Date.now()+leaseMs).toISOString(),timestamp(),id,userId,timestamp())?.attempt_count||null,
    // The monotonically increasing attempt fences workers after recovery/restart.
    renewTaskLease:(userId,id,attempt,leaseMs=2*60_000)=>db.prepare("UPDATE tasks SET lease_expires_at=? WHERE id=? AND user_id=? AND attempt_count=? AND status='running' AND lease_expires_at>?").run(new Date(Date.now()+leaseMs).toISOString(),id,userId,attempt,timestamp()).changes>0,
    recoverStaleTasks(){const current=timestamp();return s.recoverTasks.run(current,current,current).changes;},
    // Explicit user completion is independent of a worker's lease and revokes it.
    completeTaskByUser:(userId,id,result)=>db.prepare("UPDATE tasks SET status='completed',result=?,schedule_at=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=? WHERE id=? AND user_id=? AND status NOT IN ('completed','cancelled','failed')").run(result,timestamp(),id,userId).changes>0,
    completeTask: (userId,id,attempt,result,status='completed',scheduleAt=null) => s.completeTask.run(status,result,scheduleAt,timestamp(),id,userId,attempt,timestamp()).changes>0,
    failTask:(userId,id,attempt,message,error)=>s.failTask.run(message,String(error||'').slice(0,1000),timestamp(),id,userId,attempt,timestamp()).changes>0,
    dueTasks: () => s.dueTasks.all(timestamp()),
    addEvent(userId,type,message,detail=null) { const row={id:randomUUID(),user_id:userId,type,message,detail,created_at:timestamp()}; s.addEvent.run(row.id,row.user_id,row.type,row.message,row.detail,row.created_at); return row; },
    listEvents: (userId,limit=80) => s.listEvents.all(userId,Math.min(Math.max(limit,1),200)),
    countToolUseSince: (toolName,since) => s.countToolUseSince.get(`Used ${toolName}%`,since).n,
    addArtifact(userId,{taskId=null,name,mimeType='text/markdown',content}) { const now=timestamp(); const size=Buffer.byteLength(content); const row={id:randomUUID(),user_id:userId,task_id:taskId,name,mime_type:mimeType,content,size_bytes:size,created_at:now}; s.addArtifact.run(row.id,row.user_id,row.task_id,row.name,row.mime_type,row.content,row.size_bytes,row.created_at); return row; },
    listArtifacts: (userId) => s.listArtifacts.all(userId),
    getArtifact: (userId,id) => s.getArtifact.get(id,userId),
    deleteArtifact: (userId,id) => s.deleteArtifact.run(id,userId).changes>0,
    savePush(userId,{endpoint,keys}) { s.addPush.run(randomUUID(),userId,endpoint,keys.p256dh,keys.auth,timestamp()); },
    listPush: (userId) => s.listPush.all(userId),
    deletePush: (userId,endpoint) => s.deletePush.run(endpoint,userId),
    deletePushById: (id) => s.deletePushById.run(id),
    saveApnsToken(userId,token) { const now=timestamp(); s.upsertApnsToken.run(randomUUID(),userId,token,'ios','production',now,now); },
    listApnsTokens: (userId) => s.listApnsTokens.all(userId),
    deleteApnsToken: (token) => s.deleteApnsToken.run(token),
    saveSubscription(userId,{productId,status,expiresAt,appAccountToken,environment,originalTransactionId,lastEventSignedAt=null}) {
      const now=timestamp();
      s.upsertSubscription.run(randomUUID(),userId,productId,status,expiresAt||null,appAccountToken||null,environment||'production',originalTransactionId||null,lastEventSignedAt,now,now);
    },
    getSubscription: (userId) => s.getSubscription.get(userId)||null,
    getDailyUsageCount(userId,dayNy) { const row=s.getDailyUsage.get(userId,dayNy); return row?row.count:0; },
    incrementDailyUsage(userId,dayNy) { s.incrementDailyUsage.run(userId,dayNy,timestamp()); },
    consumeDailyUsage(userId,dayNy,limit) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row=s.getDailyUsage.get(userId,dayNy);
        if(row&&row.count>=limit){db.exec('COMMIT');return {allowed:false,count:row.count};}
        s.incrementDailyUsage.run(userId,dayNy,timestamp());
        const count=s.getDailyUsage.get(userId,dayNy).count;
        db.exec('COMMIT');return {allowed:true,count};
      }catch(error){db.exec('ROLLBACK');throw error;}
    },
    pruneDailyUsage(beforeDayNy) { s.resetDailyUsage.run(beforeDayNy); },
    claimNotification(notificationId) { const now=timestamp();const staleBefore=new Date(Date.now()-5*60_000).toISOString();return s.insertNotification.run(notificationId,now,staleBefore).changes>0; },
    completeNotification(notificationId) { return s.completeNotification.run(timestamp(),notificationId).changes>0; },
    releaseNotification(notificationId) { return s.releaseNotification.run(notificationId).changes>0; },
    pruneNotifications() { s.pruneNotifications.run(); },
    findUserByAppAccountToken(appAccountToken) { const row=s.findUserByAppAccountToken.get(appAccountToken); return row?row.user_id:null; },
    createPurchaseIntent(userId,productId,appAccountToken,expiresAt) { const row={id:randomUUID(),user_id:userId,product_id:productId,app_account_token:appAccountToken,status:'pending',expires_at:expiresAt,created_at:timestamp()}; s.insertPurchaseIntent.run(row.id,row.user_id,row.product_id,row.app_account_token,row.expires_at,row.created_at); return row; },
    getPurchaseIntent(userId,appAccountToken,productId) { return s.getPurchaseIntent.get(userId,appAccountToken,productId,timestamp())||null; },
    completePurchaseIntent(id,transactionId) { return s.completePurchaseIntent.run(transactionId,timestamp(),id).changes>0; },
    prunePurchaseIntents() { s.prunePurchaseIntents.run(timestamp()); },
    saveConnector(userId,provider,data) { const now=timestamp(); s.upsertConnector.run(data.id||randomUUID(),userId,provider,data.accessEncrypted,data.refreshEncrypted||null,data.scopes||'',data.expiresAt||null,JSON.stringify(data.profile||{}),now,now); },
    listConnectors: (userId) => s.listConnectors.all(userId),
    // Encrypted access tokens use fresh random IVs, so they also identify the
    // credential revision. Refreshes must never insert or mutate a replacement.
    refreshConnector:(userId,provider,previous,data)=>db.prepare('UPDATE connectors SET access_encrypted=?,refresh_encrypted=?,expires_at=?,updated_at=? WHERE user_id=? AND provider=? AND id=? AND access_encrypted=?').run(data.accessEncrypted,data.refreshEncrypted||null,data.expiresAt||null,timestamp(),userId,provider,previous.id,previous.access_encrypted).changes>0,
    deleteConnectorIfCurrent:(userId,provider,previous)=>db.prepare('DELETE FROM connectors WHERE user_id=? AND provider=? AND id=? AND access_encrypted=?').run(userId,provider,previous.id,previous.access_encrypted).changes>0,
    getConnector: (userId,provider) => s.connector.get(userId,provider),
    deleteConnector: (userId,provider) => s.deleteConnector.run(userId,provider).changes>0,
    linkWhatsApp(userId,phoneE164) { const now=timestamp(); s.linkWhatsApp.run(userId,phoneE164,now,now,now); return s.getWhatsAppLink.get(userId); },
    getWhatsAppLink: (userId) => s.getWhatsAppLink.get(userId) || null,
    getUserByWhatsApp: (phoneE164) => s.getUserByWhatsApp.get(phoneE164) || null,
    setWhatsAppLastInbound: (userId,at=timestamp()) => s.setWhatsAppLastInbound.run(at,userId).changes>0,
    unlinkWhatsApp: (userId) => s.unlinkWhatsApp.run(userId).changes>0,
    // X6 project radar: surfaced findings (dedupe), per-user deliveries, per-user repo mutes.
    radarFindingSeen: (key) => Boolean(s.radarFindingSeen.get(key)),
    storeRadarFinding(f) { const now=timestamp(); s.storeRadarFinding.run(f.key,f.repo,f.kind,f.signal,f.title,f.detail||null,f.url||null,f.workflow||null,f.branch||null,f.foundAt||now,now); },
    listRecentRadarFindings: (limit=20) => s.listRecentRadarFindings.all(Math.max(1,Math.min(100,Number(limit)||20))),
    listRadarUnrecoveredFailures: (repo) => s.radarUnrecoveredFailures.all(repo),
    radarFindingDelivered: (key,userId) => Boolean(s.radarFindingDelivered.get(key,userId)),
    markRadarFindingDelivered(key,userId) { s.markRadarFindingDelivered.run(key,userId,timestamp()); },
    muteRadarRepo: (userId,repo) => { s.muteRadarRepo.run(userId,String(repo).toLowerCase(),timestamp()); },
    unmuteRadarRepo: (userId,repo) => s.unmuteRadarRepo.run(userId,String(repo).toLowerCase()).changes>0,
    listRadarMutes: (userId) => s.listRadarMutes.all(userId),
    isRadarMuted: (userId,repo) => Boolean(s.radarMute.get(userId,String(repo).toLowerCase())),
    // Study coach: question bank + quiz attempts (drives weak spots + streaks).
    addStudyQuestion({id,exam,topic,question,choices,correctIndex,explanation,source}) {
      s.addStudyQuestion.run(id,exam,topic,question,JSON.stringify(choices),correctIndex,explanation,timestamp(),source||'chat');
    },
    getStudyQuestion: (id) => s.getStudyQuestion.get(id) || null,
    listStudyQuestions: (exam) => s.listStudyQuestions.all(exam),
    countStudyQuestions: () => s.countStudyQuestions.get().c,
    recordStudyAttempt({id,userId,questionId,correct}) { s.recordStudyAttempt.run(id,userId,questionId,correct?1:0,timestamp()); },
    getStudyAttemptsByTopic: (userId,cutoff) => s.getStudyAttemptsByTopic.all(userId,cutoff),
    getStudyAttemptTimes: (userId) => s.getStudyAttemptTimes.all(userId).map((r)=>r.at),
    getLastStudyActivity: (userId) => s.getLastStudyActivity.get(userId)?.last_at || null,
    // "Catch me up" digest: last app-open tracking + seen/dismissed item keys.
    getLastAppOpen: (userId) => s.getLastAppOpen.get(userId)?.last_app_open_at || null,
    setLastAppOpen: (userId, iso) => { s.setLastAppOpen.run(userId, iso); },
    listCatchupSeenKeys: (userId) => s.listCatchupSeenKeys.all(userId).map((r) => r.item_key),
    markCatchupSeen(userId, keys) {
      const now = timestamp();
      for (const key of new Set((keys || []).map((k) => String(k || '').slice(0, 200)).filter(Boolean))) {
        s.markCatchupSeen.run(userId, key, now);
      }
    },
    dismissCatchupItems(userId, keys) {
      const now = timestamp();
      let n = 0;
      for (const key of new Set((keys || []).map((k) => String(k || '').slice(0, 200)).filter(Boolean))) {
        s.dismissCatchupItem.run(userId, key, now, now);
        n++;
      }
      return n;
    },
    listCatchupEvents: (userId, sinceIso, limit = 60) => s.listCatchupEvents.all(userId, sinceIso, Math.max(1, Math.min(100, Number(limit) || 60))),
    listUndeliveredRadarFindingsSince: (userId, sinceIso, limit = 15) => s.listUndeliveredRadarFindingsSince.all(userId, sinceIso, Math.max(1, Math.min(50, Number(limit) || 15))),
    listUnrecoveredFailureDetails: (limit = 10) => s.listUnrecoveredFailureDetails.all(Math.max(1, Math.min(25, Number(limit) || 10))),
    listTasksDueBefore: (userId, cutoffIso, limit = 10) => s.listTasksDueBefore.all(userId, cutoffIso, Math.max(1, Math.min(25, Number(limit) || 10))),
    addOauthState(row) { s.addOauthState.run(row.stateHash,row.userId,row.provider,row.codeVerifier||null,row.redirectUri,row.expiresAt); },
    consumeOauthState(hash) { const row=s.consumeOauthState.get(hash,timestamp()); if(row) s.deleteOauthState.run(hash); return row; },
    addAccessRequest({name,email,note}) { const id=randomUUID(); s.addAccessRequest.run(id,name,email,note||null,timestamp()); return s.getAccessRequest.get(id); },
    getAccessRequest: (id) => s.getAccessRequest.get(id),
    listAccessRequests: () => s.listAccessRequests.all(),
    addWaitlistEntry({id,email,name}) { s.addWaitlistEntry.run(id,email,name||null,'pending',timestamp(),timestamp()); },
    recordSignupRiskDecision({subjectHash=null,mode,decision,score,signals=[]}) { const row={id:randomUUID(),subject_hash:subjectHash,mode,decision,score:Number(score)||0,signals_json:JSON.stringify(signals),created_at:timestamp()};s.addSignupRiskEvent.run(row.id,row.subject_hash,row.mode,row.decision,row.score,row.signals_json,row.created_at);return row; },
    listSignupRiskEvents: (limit=100) => s.listSignupRiskEvents.all(Math.max(1,Math.min(500,Number(limit)||100))),
    listWaitlist: () => s.listWaitlist.all(),
    updateWaitlistStatus: (id,status) => s.updateWaitlistStatus.run(status,timestamp(),id).changes>0,
    waitlistPosition: (createdAt) => s.waitlistPosition.get(createdAt).c,
    dismissAccessRequest: (id) => s.dismissAccessRequest.run(timestamp(),id).changes>0,
    addDoorToken(tokenHash,expiresAt) { s.addDoorToken.run(tokenHash,expiresAt,timestamp()); },
    consumeDoorToken(tokenHash) { const row=s.consumeDoorToken.get(tokenHash,timestamp()); if(row)s.useDoorToken.run(timestamp(),tokenHash); return row; },
    addPasswordResetToken(tokenHash,userId,expiresAt) { s.addPwResetToken.run(tokenHash,userId,expiresAt,timestamp()); },
    getPasswordResetToken(tokenHash) { return s.getPwResetToken.get(tokenHash,timestamp()); },
    markPasswordResetTokenUsed(tokenHash) { return s.usePwResetToken.run(tokenHash).changes>0; },
    cleanExpiredPasswordResetTokens() { s.cleanPwResetTokens.run(timestamp()); },
    addSignupVerificationToken(tokenHash,emailHash,expiresAt) { s.addSignupVerificationToken.run(tokenHash,emailHash,expiresAt,timestamp()); },
    getPendingSignupVerificationForEmail(emailHash) { return s.getPendingSignupVerificationForEmail.get(emailHash,timestamp()); },
    getSignupVerificationToken(tokenHash,emailHash) { return s.getSignupVerificationToken.get(tokenHash,emailHash,timestamp()); },
    consumeSignupVerificationToken(tokenHash,emailHash) { const now=timestamp();return s.useSignupVerificationToken.run(now,tokenHash,emailHash,now).changes>0; },
    deleteSignupVerificationToken(tokenHash) { return s.deleteSignupVerificationToken.run(tokenHash).changes>0; },
    cleanSignupVerificationTokens() { s.cleanSignupVerificationTokens.run(timestamp()); },
    pruneDoorTokens: () => s.pruneDoorTokens.run(timestamp()),
    exportUser(userId) {
      const user=s.userById.get(userId);
      if(!user)throw new Error('Backup user not found.');
      this.getPreferences(userId); // Create defaults before opening a read snapshot.
      db.exec('BEGIN');
      try{
        const bundle={version:6,exportedAt:timestamp(),user:{id:user.id,email:user.email,display_name:user.display_name},
          conversations:s.listConversations.all(userId),
          messages:db.prepare('SELECT * FROM messages WHERE user_id=? ORDER BY created_at,rowid').all(userId),
          memories:db.prepare('SELECT * FROM memories WHERE user_id=? ORDER BY created_at,id').all(userId),
          memorySuggestions:db.prepare('SELECT * FROM memory_suggestions WHERE user_id=? ORDER BY created_at,id').all(userId),
          followUps:db.prepare('SELECT * FROM follow_ups WHERE user_id=? ORDER BY created_at,id').all(userId),
          goals:s.listGoals.all(userId),
          goalCheckins:db.prepare('SELECT * FROM goal_checkins WHERE user_id=? ORDER BY created_at').all(userId),
          routines:s.listRoutines.all(userId),projects:s.listProjects.all(userId),
          projectSteps:db.prepare('SELECT * FROM project_steps WHERE user_id=? ORDER BY project_id,position,created_at').all(userId),
          approvals:db.prepare('SELECT * FROM approvals WHERE user_id=? ORDER BY created_at,id').all(userId),
          preferences:this.getPreferences(userId),
          conversationSummaries:db.prepare('SELECT * FROM conversation_summaries WHERE user_id=?').all(userId),
          calendarFeeds:this.listCalendarFeeds(userId),
          tasks:db.prepare('SELECT * FROM tasks WHERE user_id=? ORDER BY created_at,id').all(userId),
          events:db.prepare('SELECT * FROM events WHERE user_id=? ORDER BY created_at,id').all(userId),
          artifacts:db.prepare('SELECT * FROM artifacts WHERE user_id=? ORDER BY created_at,id').all(userId)};
        for(const entry of PORTABLE_USER_TABLES){
          bundle[entry.key]=db.prepare(`SELECT ${entry.columns.join(',')} FROM ${entry.table} WHERE user_id=?`).all(userId);
        }
        db.exec('COMMIT');
        return bundle;
      }catch(error){db.exec('ROLLBACK');throw error;}
    },
    restoreUser(userId, bundle) {
      if (!bundle || ![2,3,4,5,6].includes(bundle.version)) throw Object.assign(new Error('Backup version is not supported.'), { status: 400 });
      const inserts = {
        conversation: db.prepare('INSERT OR IGNORE INTO conversations(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)'),
        message: db.prepare('INSERT OR IGNORE INTO messages(id,user_id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?,?)'),
        memory: db.prepare(`INSERT OR IGNORE INTO memories(id,user_id,content,created_at,updated_at,kind,source,status,confidence,expires_at,
          last_confirmed_at,last_mentioned_at,relevance_score,superseded_by,embedding,proactive_allowed)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
        suggestion: db.prepare('INSERT OR IGNORE INTO memory_suggestions(id,user_id,content,created_at,kind,confidence) VALUES(?,?,?,?,?,?)'),
        followUp: db.prepare('INSERT OR IGNORE INTO follow_ups(id,user_id,description,due_date,status,priority,source_message_id,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?)'),
        goal: db.prepare('INSERT OR IGNORE INTO goals(id,user_id,title,description,status,priority,progress,target_date,next_step,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'),
        goalCheckin: db.prepare('INSERT OR IGNORE INTO goal_checkins(id,goal_id,user_id,progress,note,created_at) VALUES(?,?,?,?,?,?)'),
        routine: db.prepare('INSERT OR IGNORE INTO routines(id,user_id,title,prompt,kind,cadence,time_local,day_of_week,enabled,last_run_date,last_run_at,lease_date,lease_expires_at,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
        project: db.prepare('INSERT OR IGNORE INTO projects(id,user_id,title,description,status,priority,target_date,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?)'),
        projectStep: db.prepare('INSERT OR IGNORE INTO project_steps(id,project_id,user_id,title,details,status,position,due_date,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)'),
        approval: db.prepare('INSERT OR IGNORE INTO approvals(id,user_id,kind,title,summary,payload_json,status,source_message_id,result_json,last_error,created_at,updated_at,reviewed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'),
        summary: db.prepare('INSERT OR IGNORE INTO conversation_summaries(conversation_id,user_id,summary,message_count,updated_at) VALUES(?,?,?,?,?)'),
        calendar: db.prepare('INSERT OR IGNORE INTO calendar_feeds(id,user_id,label,url,created_at,updated_at) VALUES(?,?,?,?,?,?)'),
        task: db.prepare(`INSERT OR IGNORE INTO tasks(id,user_id,title,prompt,status,risk,schedule_at,recurrence,delivery_channel,result,
          created_at,updated_at,attempt_count,lease_expires_at,last_error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
        event: db.prepare('INSERT OR IGNORE INTO events(id,user_id,type,message,detail,created_at) VALUES(?,?,?,?,?,?)'),
        artifact: db.prepare('INSERT OR IGNORE INTO artifacts(id,user_id,task_id,name,mime_type,content,size_bytes,created_at) VALUES(?,?,?,?,?,?,?,?)')
      };
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of bundle.conversations || []) inserts.conversation.run(row.id,userId,row.title,row.created_at,row.updated_at);
        for (const row of bundle.messages || []) inserts.message.run(row.id,userId,row.conversation_id||null,row.role,row.content,row.created_at);
        for (const row of bundle.memories || []) inserts.memory.run(row.id,userId,assertMemorySafe(row.content),row.created_at,row.updated_at,normalizeMemoryKind(row.kind),row.source||'backup',row.status||'approved',row.confidence??1,row.expires_at||null,row.last_confirmed_at||row.updated_at,row.last_mentioned_at||null,row.relevance_score??1,row.superseded_by||null,row.embedding||null,row.proactive_allowed===0?0:1);
        for (const row of bundle.memorySuggestions || []) inserts.suggestion.run(row.id,userId,assertMemorySafe(row.content),row.created_at,normalizeMemoryKind(row.kind),row.confidence??0.7);
        for (const row of bundle.followUps || []) inserts.followUp.run(row.id,userId,row.description,row.due_date,row.status||'scheduled',normalizePriority(row.priority),row.source_message_id||null,row.created_at,row.completed_at||null);
        for (const row of bundle.goals || []) inserts.goal.run(row.id,userId,row.title,row.description||null,row.status||'active',normalizePriority(row.priority),Math.max(0,Math.min(Number(row.progress)||0,100)),row.target_date||null,row.next_step||null,row.created_at,row.updated_at,row.completed_at||null);
        for (const row of bundle.goalCheckins || []) inserts.goalCheckin.run(row.id,row.goal_id,userId,row.progress,row.note||null,row.created_at);
        for (const row of bundle.routines || []) inserts.routine.run(row.id,userId,row.title,row.prompt,row.kind||'custom',row.cadence||'daily',validTimeString(row.time_local,'09:00'),row.day_of_week??null,row.enabled===0?0:1,row.last_run_date||null,row.last_run_at||null,null,null,row.last_error||null,row.created_at,row.updated_at);
        for (const row of bundle.projects || []) inserts.project.run(row.id,userId,row.title,row.description||null,['active','paused','completed'].includes(row.status)?row.status:'active',normalizePriority(row.priority),row.target_date||null,row.created_at,row.updated_at,row.completed_at||null);
        for (const row of bundle.projectSteps || []) inserts.projectStep.run(row.id,row.project_id,userId,row.title,row.details||null,['planned','in_progress','blocked','completed'].includes(row.status)?row.status:'planned',Number(row.position)||0,row.due_date||null,row.created_at,row.updated_at,row.completed_at||null);
        for (const row of bundle.approvals || []) inserts.approval.run(row.id,userId,row.kind,row.title,row.summary,row.payload_json||'{}',['pending','executed','rejected','failed'].includes(row.status)?row.status:'pending',row.source_message_id||null,row.result_json||null,row.last_error||null,row.created_at,row.updated_at,row.reviewed_at||null);
        for (const row of bundle.conversationSummaries || []) inserts.summary.run(row.conversation_id,userId,row.summary,row.message_count,row.updated_at);
        for (const row of bundle.calendarFeeds || []) inserts.calendar.run(row.id,userId,row.label,protectSecret(row.url),row.created_at,row.updated_at);
        for (const row of bundle.tasks || []) inserts.task.run(row.id,userId,row.title,row.prompt,row.status,row.risk,row.schedule_at,row.recurrence,
          row.delivery_channel==='whatsapp'?'whatsapp':'push',row.result,row.created_at,row.updated_at,row.attempt_count||0,null,row.last_error||null);
        for (const row of bundle.events || []) inserts.event.run(row.id,userId,row.type,row.message,row.detail,row.created_at);
        for (const row of bundle.artifacts || []) inserts.artifact.run(row.id,userId,row.task_id,row.name,row.mime_type,row.content,row.size_bytes,row.created_at);
        if(bundle.version===6){
          for(const entry of PORTABLE_USER_TABLES){
            const insert=db.prepare(portableInsertSql(entry));
            for(const row of bundle[entry.key]||[])insert.run(...portableRowValues(entry,row,userId));
          }
        }
        if(bundle.preferences){
          const p=normalizePreferences(bundle.preferences);const current=s.getPreferences.get(userId);const created=current?.created_at||timestamp();
          s.upsertPreferences.run(userId,p.timeZone,p.quietStart,p.quietEnd,p.proactiveEnabled?1:0,p.briefingTone,p.briefingLength,created,timestamp());
          if(bundle.version===6){
            const old=bundle.preferences;
            db.prepare(`UPDATE user_preferences SET buddy_name=?,writing_voice_opt_in=?,writing_voice_profile=?,writing_voice_updated_at=?,
              writing_voice_offered=?,intro_dismissed=? WHERE user_id=?`).run(old.buddy_name||null,old.writing_voice_opt_in===1?1:0,
              old.writing_voice_profile||null,old.writing_voice_updated_at||null,old.writing_voice_offered===1?1:0,
              old.intro_dismissed===1?1:0,userId);
          }
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
}
