import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { decryptSecret, encryptSecret } from './security.js';
import { normalizeMemoryKind, normalizePreferences, normalizePriority, rankGoals, rankMemories, validDateString, validTimeString } from './intelligence.js';

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
  fs.chmodSync(path.dirname(filePath), 0o700);
  const db = new DatabaseSync(filePath);
  fs.chmodSync(filePath, 0o600);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
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
      disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, user_agent TEXT
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
      source_message_id TEXT, result_json TEXT, last_error TEXT,
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
    DROP TABLE IF EXISTS automation_tokens;
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
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
  ensureColumn(db, 'users', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'messages', 'user_id', 'TEXT');
  ensureColumn(db, 'messages', 'conversation_id', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(user_id, conversation_id, created_at DESC)');
  for (const row of db.prepare('SELECT DISTINCT user_id FROM messages WHERE conversation_id IS NULL AND user_id IS NOT NULL').all()) adoptOrphanMessages(db, row.user_id);
  ensureColumn(db, 'memories', 'user_id', 'TEXT');
  ensureColumn(db, 'memories', 'kind', "TEXT NOT NULL DEFAULT 'fact'");
  ensureColumn(db, 'memories', 'source', "TEXT NOT NULL DEFAULT 'legacy'");
  ensureColumn(db, 'memories', 'status', "TEXT NOT NULL DEFAULT 'approved'");
  ensureColumn(db, 'memories', 'confidence', 'REAL NOT NULL DEFAULT 1');
  ensureColumn(db, 'memories', 'expires_at', 'TEXT');
  ensureColumn(db, 'memories', 'last_confirmed_at', 'TEXT');
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
  ensureColumn(db, 'events', 'user_id', 'TEXT');
  ensureColumn(db, 'proactive_state', 'last_outreach_at', 'TEXT');
  ensureColumn(db, 'proactive_state', 'outreach_date', 'TEXT');
  ensureColumn(db, 'people_mentions', 'context_summary', 'TEXT');
  ensureColumn(db, 'personal_dates', 'gift_nag', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'personal_dates', 'gift_done', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'people_mentions', 'sentiment', 'TEXT');
  ensureColumn(db, 'people_mentions', 'last_context_update', 'TEXT');
  ensureColumn(db, 'proactive_state', 'outreach_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'user_preferences', 'briefing_tone', "TEXT NOT NULL DEFAULT 'motivational'");
  ensureColumn(db, 'user_preferences', 'briefing_length', "TEXT NOT NULL DEFAULT 'quick'");
  ensureColumn(db, 'user_preferences', 'buddy_name', 'TEXT');

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
    listUsers: db.prepare('SELECT id,email,display_name,role,disabled,created_at,updated_at FROM users ORDER BY created_at'),
    createUser: db.prepare('INSERT INTO users(id,email,display_name,password_hash,password_salt,role,disabled,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)'),
    createDemoUser: db.prepare('INSERT INTO users(id,email,display_name,password_hash,password_salt,role,disabled,is_demo,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)'),
    listExpiredDemoUsers: db.prepare("SELECT id FROM users WHERE is_demo=1 AND created_at<?"),
    deleteUser: db.prepare('DELETE FROM users WHERE id=?'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    updatePassword: db.prepare('UPDATE users SET password_hash=?, password_salt=?, updated_at=? WHERE id=?'),
    setUserDisabled: db.prepare('UPDATE users SET disabled=?, updated_at=? WHERE id=?'),
    claimMessages: db.prepare('UPDATE messages SET user_id=? WHERE user_id IS NULL'),
    claimMemories: db.prepare('UPDATE memories SET user_id=? WHERE user_id IS NULL'),
    claimTasks: db.prepare('UPDATE tasks SET user_id=? WHERE user_id IS NULL'),
    claimEvents: db.prepare('UPDATE events SET user_id=? WHERE user_id IS NULL'),
    createSession: db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)'),
    session: db.prepare(`SELECT sessions.*, users.email, users.display_name, users.role, users.disabled
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
    touchConversation: db.prepare('UPDATE conversations SET updated_at=? WHERE id=? AND user_id=?'),
    deleteConversation: db.prepare('DELETE FROM conversations WHERE id=? AND user_id=?'),
    deleteConversationMessages: db.prepare('DELETE FROM messages WHERE conversation_id=? AND user_id=?'),
    listConversationMessages: db.prepare('SELECT * FROM messages WHERE user_id=? AND conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?'),
    listMessages: db.prepare('SELECT * FROM messages WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?'),
    addMemory: db.prepare(`INSERT INTO memories(id,user_id,content,created_at,updated_at,kind,source,status,confidence,expires_at,last_confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)`),
    listMemories: db.prepare("SELECT * FROM memories WHERE user_id=? AND status='approved' ORDER BY updated_at DESC,rowid DESC LIMIT 100"),
    deleteMemory: db.prepare('DELETE FROM memories WHERE id=? AND user_id=?'),
    addMemorySuggestion: db.prepare('INSERT INTO memory_suggestions(id,user_id,content,created_at,kind,confidence) VALUES (?,?,?,?,?,?)'),
    getMemorySuggestion: db.prepare('SELECT * FROM memory_suggestions WHERE id=? AND user_id=?'),
    listMemorySuggestions: db.prepare('SELECT * FROM memory_suggestions WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50'),
    deleteMemorySuggestion: db.prepare('DELETE FROM memory_suggestions WHERE id=? AND user_id=?'),
    addImportJob: db.prepare('INSERT INTO import_jobs(id,user_id,filename,status,total_chunks,done_chunks,suggestions_added,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'),
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
    deleteGoal: db.prepare('DELETE FROM goals WHERE id=? AND user_id=?'),
    addGoalCheckin: db.prepare('INSERT INTO goal_checkins(id,goal_id,user_id,progress,note,created_at) VALUES(?,?,?,?,?,?)'),
    listGoalCheckins: db.prepare('SELECT * FROM goal_checkins WHERE goal_id=? AND user_id=? ORDER BY created_at DESC LIMIT ?'),
    addRoutine: db.prepare(`INSERT INTO routines(id,user_id,title,prompt,kind,cadence,time_local,day_of_week,enabled,last_run_date,last_run_at,lease_date,lease_expires_at,last_error,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,1,NULL,NULL,NULL,NULL,NULL,?,?)`),
    getRoutine: db.prepare('SELECT * FROM routines WHERE id=? AND user_id=?'),
    listRoutines: db.prepare('SELECT * FROM routines WHERE user_id=? ORDER BY enabled DESC,time_local,title COLLATE NOCASE'),
    updateRoutineEnabled: db.prepare('UPDATE routines SET enabled=?,lease_date=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND user_id=?'),
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
    updateProjectStep: db.prepare('UPDATE project_steps SET title=?,details=?,status=?,position=?,due_date=?,updated_at=?,completed_at=? WHERE id=? AND user_id=?'),
    deleteProjectStep: db.prepare('DELETE FROM project_steps WHERE id=? AND user_id=?'),
    addApproval: db.prepare(`INSERT INTO approvals(id,user_id,kind,title,summary,payload_json,status,source_message_id,result_json,last_error,created_at,updated_at,reviewed_at)
      VALUES(?,?,?,?,?,?,'pending',?,NULL,NULL,?,?,NULL)`),
    getApproval: db.prepare('SELECT * FROM approvals WHERE id=? AND user_id=?'),
    listApprovals: db.prepare("SELECT * FROM approvals WHERE user_id=? ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,created_at DESC,rowid DESC LIMIT 200"),
    resolveApproval: db.prepare("UPDATE approvals SET status=?,result_json=?,last_error=?,reviewed_at=?,updated_at=? WHERE id=? AND user_id=? AND status='pending'"),
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
    timelineMemories: db.prepare(`SELECT content, kind FROM memories WHERE user_id=? AND status='approved' AND substr(created_at,1,7)=? ORDER BY created_at DESC LIMIT 8`),
    timelineConversations: db.prepare(`SELECT c.title FROM conversations c WHERE c.user_id=? AND substr(c.created_at,1,7)=? AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id) ORDER BY c.created_at DESC LIMIT 12`),
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
      VALUES(?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET summary=excluded.summary,message_count=excluded.message_count,updated_at=excluded.updated_at`),
    countConversationMessages: db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id=? AND user_id=?'),
    countUserMessages: db.prepare("SELECT COUNT(*) AS count FROM messages WHERE user_id=? AND role='user'"),
    addTask: db.prepare(`INSERT INTO tasks(id,user_id,title,prompt,status,risk,schedule_at,recurrence,result,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,NULL,?,?)`),
    listTasks: db.prepare('SELECT * FROM tasks WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200'),
    addCalendarFeed: db.prepare(`INSERT INTO calendar_feeds(id,user_id,label,url,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`),
    listCalendarFeeds: db.prepare('SELECT * FROM calendar_feeds WHERE user_id=? ORDER BY label COLLATE NOCASE'),
    deleteCalendarFeed: db.prepare('DELETE FROM calendar_feeds WHERE id=? AND user_id=?'),
    getTask: db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?'),
    updateTask: db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=? AND user_id=?'),
    startTask: db.prepare("UPDATE tasks SET status='running',attempt_count=attempt_count+1,lease_expires_at=?,last_error=NULL,updated_at=? WHERE id=? AND user_id=? AND status IN ('queued','scheduled')"),
    recoverTasks: db.prepare("UPDATE tasks SET status=CASE WHEN schedule_at IS NULL OR schedule_at<=? THEN 'queued' ELSE 'scheduled' END,lease_expires_at=NULL,updated_at=? WHERE status='running' AND (lease_expires_at IS NULL OR lease_expires_at<=?)"),
    completeTask: db.prepare('UPDATE tasks SET status=?,result=?,schedule_at=?,lease_expires_at=NULL,last_error=NULL,updated_at=? WHERE id=? AND user_id=?'),
    failTask: db.prepare("UPDATE tasks SET status='failed',result=?,schedule_at=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=? AND user_id=?"),
    dueTasks: db.prepare(`SELECT * FROM tasks WHERE status IN ('queued','scheduled')
      AND (schedule_at IS NULL OR schedule_at<=?) ORDER BY COALESCE(schedule_at,created_at),rowid LIMIT 10`),
    addEvent: db.prepare('INSERT INTO events(id,user_id,type,message,detail,created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    listEvents: db.prepare('SELECT * FROM events WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?'),
    countToolUseSince: db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='tool_use' AND message LIKE ? AND created_at>=?"),
    addArtifact: db.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    listArtifacts: db.prepare('SELECT id,task_id,name,mime_type,size_bytes,created_at FROM artifacts WHERE user_id=? ORDER BY created_at DESC LIMIT 200'),
    getArtifact: db.prepare('SELECT * FROM artifacts WHERE id=? AND user_id=?'),
    addPush: db.prepare(`INSERT INTO push_subscriptions VALUES(?,?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth`),
    listPush: db.prepare('SELECT * FROM push_subscriptions WHERE user_id=?'),
    deletePush: db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?'),
    deletePushById: db.prepare('DELETE FROM push_subscriptions WHERE id=?'),
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
    getAccessRequest: db.prepare('SELECT * FROM access_requests WHERE id=?'),
    listAccessRequests: db.prepare('SELECT * FROM access_requests ORDER BY created_at DESC,rowid DESC LIMIT 100'),
    dismissAccessRequest: db.prepare('UPDATE access_requests SET handled_at=? WHERE id=? AND handled_at IS NULL'),
    addDoorToken: db.prepare('INSERT INTO door_tokens VALUES (?, ?, NULL, ?)'),
    consumeDoorToken: db.prepare('SELECT * FROM door_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?'),
    useDoorToken: db.prepare('UPDATE door_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL'),
    pruneDoorTokens: db.prepare('DELETE FROM door_tokens WHERE expires_at<=? OR used_at IS NOT NULL')
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
    updatePassword(id, passwordHash, passwordSalt) { s.updatePassword.run(passwordHash, passwordSalt, timestamp(), id); },
    setUserDisabled(id, disabled) { s.setUserDisabled.run(disabled ? 1 : 0, timestamp(), id); },
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
    consumeRecoveryCode(hash) { const row=s.recovery.get(hash); if(!row) return null; return s.useRecovery.run(timestamp(),row.id).changes ? row : null; },
    getSetting: (key, fallback=null) => s.setting.get(key)?.value ?? fallback,
    setSetting(key,value) { s.setSetting.run(key,String(value),timestamp()); },
    ensureDefaultConversation(userId) { const existing=s.listConversations.get(userId); if(existing){adoptOrphanMessages(db,userId);return existing;}
      const now=timestamp();const row={id:randomUUID(),user_id:userId,title:'General',created_at:now,updated_at:now};
      s.createConversation.run(row.id,row.user_id,row.title,row.created_at,row.updated_at);adoptOrphanMessages(db,userId);return row; },
    createConversation(userId,title){const now=timestamp();const row={id:randomUUID(),user_id:userId,title,created_at:now,updated_at:now};s.createConversation.run(row.id,row.user_id,row.title,row.created_at,row.updated_at);return row;},
    listConversations:(userId)=>s.listConversations.all(userId),
    getConversation:(userId,id)=>s.getConversation.get(id,userId),
    touchConversation:(userId,id)=>s.touchConversation.run(timestamp(),id,userId).changes>0,
    deleteConversation(userId,id){db.exec('BEGIN IMMEDIATE');try{s.deleteConversationMessages.run(id,userId);const gone=s.deleteConversation.run(id,userId).changes>0;db.exec('COMMIT');return gone;}catch(error){db.exec('ROLLBACK');throw error;}},
    addMessage(userId, conversationId, role, content) { const row={id:randomUUID(),user_id:userId,conversation_id:conversationId,role,content,created_at:timestamp()}; s.addMessage.run(row.id,row.user_id,row.conversation_id,row.role,row.content,row.created_at); return row; },
    listConversationMessages(userId, conversationId, limit=60) { return s.listConversationMessages.all(userId,conversationId,Math.min(Math.max(limit,1),200)).reverse(); },
    listMessages(userId, limit=60) { return s.listMessages.all(userId,Math.min(Math.max(limit,1),200)).reverse(); },
    addMemory(userId, content, options={}) {
      const now=timestamp();
      const row={id:randomUUID(),user_id:userId,content,created_at:now,updated_at:now,
        kind:normalizeMemoryKind(options.kind),source:String(options.source||'user').slice(0,40),status:'approved',
        confidence:Math.max(0,Math.min(Number(options.confidence??1),1)),expires_at:options.expiresAt||null,last_confirmed_at:now};
      s.addMemory.run(row.id,row.user_id,row.content,row.created_at,row.updated_at,row.kind,row.source,row.confidence,row.expires_at,row.last_confirmed_at);
      return row;
    },
    listMemories: (userId) => s.listMemories.all(userId),
    listRelevantMemories(userId,query,limit=8){return rankMemories(s.listMemories.all(userId),query,limit);},
    deleteMemory: (userId,id) => s.deleteMemory.run(id,userId).changes>0,
    addMemorySuggestion(userId,content,options={}){const now=timestamp();const row={id:randomUUID(),user_id:userId,content,created_at:now,kind:normalizeMemoryKind(options.kind),confidence:Math.max(0,Math.min(Number(options.confidence??0.7),1))};s.addMemorySuggestion.run(row.id,row.user_id,row.content,row.created_at,row.kind,row.confidence);return row;},
    listMemorySuggestions: (userId) => s.listMemorySuggestions.all(userId),
    dismissMemorySuggestion: (userId,id) => s.deleteMemorySuggestion.run(id,userId).changes>0,
    approveMemorySuggestion(userId,id){const row=s.getMemorySuggestion.get(id,userId);if(!row)return null;const saved=this.addMemory(userId,row.content,{kind:row.kind,source:'suggestion',confidence:row.confidence});s.deleteMemorySuggestion.run(id,userId);return {...row,memory_id:saved.id};},
    createImportJob(userId,filename){const now=timestamp();const row={id:randomUUID(),user_id:userId,filename:String(filename||'').slice(0,200),status:'processing',total_chunks:0,done_chunks:0,suggestions_added:0,error:null,created_at:now,updated_at:now};s.addImportJob.run(row.id,row.user_id,row.filename,row.status,row.total_chunks,row.done_chunks,row.suggestions_added,row.error,row.created_at,row.updated_at);return row;},
    getImportJob:(userId,id)=>s.getImportJob.get(id,userId)||null,
    listImportJobs:(userId)=>s.listImportJobs.all(userId),
    updateImportJob(userId,id,patch={}){const cur=s.getImportJob.get(id,userId);if(!cur)return null;const next={status:patch.status||cur.status,total_chunks:patch.total_chunks??cur.total_chunks,done_chunks:patch.done_chunks??cur.done_chunks,suggestions_added:patch.suggestions_added??cur.suggestions_added,error:patch.error!==undefined?patch.error:cur.error,updated_at:timestamp()};s.updateImportJob.run(next.status,next.total_chunks,next.done_chunks,next.suggestions_added,next.error,next.updated_at,id,userId);return {...cur,...next};},
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
    updateGoal(userId,id,{progress,status,nextStep,note=null}={}){const current=s.getGoal.get(id,userId);if(!current)return null;const nextProgress=Math.max(0,Math.min(Math.round(Number(progress??current.progress)),100));let nextStatus=['active','paused','completed'].includes(status)?status:current.status;if(nextProgress>=100)nextStatus='completed';const completedAt=nextStatus==='completed'?(current.completed_at||timestamp()):null;const updated=timestamp();s.updateGoal.run(nextProgress,nextStatus,nextStep===undefined?current.next_step:(nextStep||null),updated,completedAt,id,userId);if(note||nextProgress!==current.progress)s.addGoalCheckin.run(randomUUID(),id,userId,nextProgress,note?String(note).slice(0,1000):null,updated);return s.getGoal.get(id,userId);},
    deleteGoal:(userId,id)=>s.deleteGoal.run(id,userId).changes>0,
    listGoalCheckins:(userId,goalId,limit=20)=>s.listGoalCheckins.all(goalId,userId,Math.min(Math.max(limit,1),100)),
    addRoutine(userId,{title,prompt,kind='custom',cadence='daily',timeLocal='09:00',dayOfWeek=null}){const now=timestamp();const cleanKind=['briefing','reflection','custom'].includes(kind)?kind:'custom';const cleanCadence=['daily','weekdays','weekly'].includes(cadence)?cadence:'daily';const requestedDay=Number(dayOfWeek);const cleanDay=cleanCadence==='weekly'&&Number.isInteger(requestedDay)&&requestedDay>=0&&requestedDay<=6?requestedDay:(cleanCadence==='weekly'?1:null);const row={id:randomUUID(),user_id:userId,title,prompt,kind:cleanKind,cadence:cleanCadence,time_local:validTimeString(timeLocal,'09:00'),day_of_week:cleanDay,enabled:1,last_run_date:null,last_run_at:null,lease_date:null,lease_expires_at:null,last_error:null,created_at:now,updated_at:now};s.addRoutine.run(row.id,row.user_id,row.title,row.prompt,row.kind,row.cadence,row.time_local,row.day_of_week,row.created_at,row.updated_at);return row;},
    getRoutine:(userId,id)=>s.getRoutine.get(id,userId)||null,
    listRoutines:(userId)=>s.listRoutines.all(userId),
    setRoutineEnabled(userId,id,enabled){return s.updateRoutineEnabled.run(enabled?1:0,timestamp(),id,userId).changes>0;},
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
    listProjects(userId){return s.listProjects.all(userId).map((row)=>({...row,steps:s.listProjectSteps.all(row.id,userId)}));},
    updateProject(userId,id,patch={}){const current=s.getProject.get(id,userId);if(!current)return null;const status=patch.status===undefined?current.status:(['active','paused','completed'].includes(patch.status)?patch.status:current.status);const title=patch.title===undefined?current.title:String(patch.title||'').trim().slice(0,120)||current.title;const description=patch.description===undefined?current.description:(String(patch.description||'').trim().slice(0,1000)||null);const priority=patch.priority===undefined?current.priority:normalizePriority(patch.priority);const targetDate=patch.targetDate===undefined?current.target_date:(patch.targetDate?validDateString(patch.targetDate):null);const now=timestamp();const completedAt=status==='completed'?(current.completed_at||now):null;s.updateProject.run(title,description,status,priority,targetDate,now,completedAt,id,userId);return this.getProject(userId,id);},
    deleteProject:(userId,id)=>s.deleteProject.run(id,userId).changes>0,
    addProjectStep(userId,projectId,{title,details=null,dueDate=null}){if(!s.getProject.get(projectId,userId))return null;const existing=s.listProjectSteps.all(projectId,userId);const now=timestamp();const row={id:randomUUID(),project_id:projectId,user_id:userId,title,details:details||null,status:'planned',position:existing.length,due_date:dueDate?validDateString(dueDate):null,created_at:now,updated_at:now,completed_at:null};s.addProjectStep.run(row.id,row.project_id,row.user_id,row.title,row.details,row.position,row.due_date,row.created_at,row.updated_at);return row;},
    getProjectStep:(userId,id)=>s.getProjectStep.get(id,userId)||null,
    updateProjectStep(userId,id,patch={}){const current=s.getProjectStep.get(id,userId);if(!current)return null;const status=patch.status===undefined?current.status:(['planned','in_progress','blocked','completed'].includes(patch.status)?patch.status:current.status);const title=patch.title===undefined?current.title:String(patch.title||'').trim().slice(0,160)||current.title;const details=patch.details===undefined?current.details:(String(patch.details||'').trim().slice(0,1000)||null);const position=patch.position===undefined?current.position:Math.max(0,Math.min(Number(patch.position)||0,1000));const dueDate=patch.dueDate===undefined?current.due_date:(patch.dueDate?validDateString(patch.dueDate):null);const now=timestamp();const completedAt=status==='completed'?(current.completed_at||now):null;s.updateProjectStep.run(title,details,status,position,dueDate,now,completedAt,id,userId);const project=s.getProject.get(current.project_id,userId);if(project)s.updateProject.run(project.title,project.description,project.status,project.priority,project.target_date,now,project.completed_at,project.id,userId);return s.getProjectStep.get(id,userId);},
    deleteProjectStep:(userId,id)=>s.deleteProjectStep.run(id,userId).changes>0,
    addApproval(userId,{kind,title,summary,payload={},sourceMessageId=null}){const now=timestamp();const row={id:randomUUID(),user_id:userId,kind:String(kind||'proposal').slice(0,60),title,summary,payload_json:JSON.stringify(payload),status:'pending',source_message_id:sourceMessageId,result_json:null,last_error:null,created_at:now,updated_at:now,reviewed_at:null};s.addApproval.run(row.id,row.user_id,row.kind,row.title,row.summary,row.payload_json,row.source_message_id,row.created_at,row.updated_at);return {...row,payload};},
    getApproval(userId,id){const row=s.getApproval.get(id,userId);if(!row)return null;let payload={},result=null;try{payload=JSON.parse(row.payload_json||'{}');}catch{}try{result=row.result_json?JSON.parse(row.result_json):null;}catch{}return {...row,payload,result};},
    listApprovals(userId){return s.listApprovals.all(userId).map((row)=>{let payload={},result=null;try{payload=JSON.parse(row.payload_json||'{}');}catch{}try{result=row.result_json?JSON.parse(row.result_json):null;}catch{}return {...row,payload,result};});},
    resolveApproval(userId,id,status,{result=null,error=null}={}){if(!['executed','rejected','failed'].includes(status))return null;const at=timestamp();if(!s.resolveApproval.run(status,result?JSON.stringify(result):null,error?String(error).slice(0,1000):null,at,at,id,userId).changes)return null;return this.getApproval(userId,id);},
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
    setTimelineNarrative:(userId,monthKey,narrative)=>{s.setTimelineNarrative.run(userId,monthKey,narrative,timestamp());},
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
    addTask(userId,{title,prompt,risk='internal',scheduleAt=null,recurrence='none'}) {
      const now=timestamp(); const status=risk==='external'?'waiting_approval':scheduleAt?'scheduled':'queued';
      const row={id:randomUUID(),user_id:userId,title,prompt,status,risk,schedule_at:scheduleAt,recurrence,result:null,created_at:now,updated_at:now};
      s.addTask.run(row.id,row.user_id,row.title,row.prompt,row.status,row.risk,row.schedule_at,row.recurrence,row.created_at,row.updated_at); return row;
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
    startTask:(userId,id,leaseMs=2*60_000)=>s.startTask.run(new Date(Date.now()+leaseMs).toISOString(),timestamp(),id,userId).changes>0,
    recoverStaleTasks(){const current=timestamp();return s.recoverTasks.run(current,current,current).changes;},
    completeTask: (userId,id,result,status='completed',scheduleAt=null) => s.completeTask.run(status,result,scheduleAt,timestamp(),id,userId).changes>0,
    failTask:(userId,id,message,error)=>s.failTask.run(message,String(error||'').slice(0,1000),timestamp(),id,userId).changes>0,
    dueTasks: () => s.dueTasks.all(timestamp()),
    addEvent(userId,type,message,detail=null) { const row={id:randomUUID(),user_id:userId,type,message,detail,created_at:timestamp()}; s.addEvent.run(row.id,row.user_id,row.type,row.message,row.detail,row.created_at); return row; },
    listEvents: (userId,limit=80) => s.listEvents.all(userId,Math.min(Math.max(limit,1),200)),
    countToolUseSince: (toolName,since) => s.countToolUseSince.get(`Used ${toolName}%`,since).n,
    addArtifact(userId,{taskId=null,name,mimeType='text/markdown',content}) { const now=timestamp(); const size=Buffer.byteLength(content); const row={id:randomUUID(),user_id:userId,task_id:taskId,name,mime_type:mimeType,content,size_bytes:size,created_at:now}; s.addArtifact.run(row.id,row.user_id,row.task_id,row.name,row.mime_type,row.content,row.size_bytes,row.created_at); return row; },
    listArtifacts: (userId) => s.listArtifacts.all(userId),
    getArtifact: (userId,id) => s.getArtifact.get(id,userId),
    savePush(userId,{endpoint,keys}) { s.addPush.run(randomUUID(),userId,endpoint,keys.p256dh,keys.auth,timestamp()); },
    listPush: (userId) => s.listPush.all(userId),
    deletePush: (userId,endpoint) => s.deletePush.run(endpoint,userId),
    deletePushById: (id) => s.deletePushById.run(id),
    saveConnector(userId,provider,data) { const now=timestamp(); s.upsertConnector.run(data.id||randomUUID(),userId,provider,data.accessEncrypted,data.refreshEncrypted||null,data.scopes||'',data.expiresAt||null,JSON.stringify(data.profile||{}),now,now); },
    listConnectors: (userId) => s.listConnectors.all(userId),
    getConnector: (userId,provider) => s.connector.get(userId,provider),
    deleteConnector: (userId,provider) => s.deleteConnector.run(userId,provider).changes>0,
    addOauthState(row) { s.addOauthState.run(row.stateHash,row.userId,row.provider,row.codeVerifier||null,row.redirectUri,row.expiresAt); },
    consumeOauthState(hash) { const row=s.consumeOauthState.get(hash,timestamp()); if(row) s.deleteOauthState.run(hash); return row; },
    addAccessRequest({name,email,note}) { const id=randomUUID(); s.addAccessRequest.run(id,name,email,note||null,timestamp()); return s.getAccessRequest.get(id); },
    listAccessRequests: () => s.listAccessRequests.all(),
    dismissAccessRequest: (id) => s.dismissAccessRequest.run(timestamp(),id).changes>0,
    addDoorToken(tokenHash,expiresAt) { s.addDoorToken.run(tokenHash,expiresAt,timestamp()); },
    consumeDoorToken(tokenHash) { const row=s.consumeDoorToken.get(tokenHash,timestamp()); if(row)s.useDoorToken.run(timestamp(),tokenHash); return row; },
    pruneDoorTokens: () => s.pruneDoorTokens.run(timestamp()),
    exportUser(userId) { return {version:5,exportedAt:timestamp(),user:s.userById.get(userId),conversations:s.listConversations.all(userId),messages:s.listMessages.all(userId,20000).reverse(),memories:s.listMemories.all(userId),memorySuggestions:s.listMemorySuggestions.all(userId),followUps:s.listFollowUps.all(userId),goals:s.listGoals.all(userId),goalCheckins:db.prepare('SELECT * FROM goal_checkins WHERE user_id=? ORDER BY created_at').all(userId),routines:s.listRoutines.all(userId),projects:s.listProjects.all(userId),projectSteps:db.prepare('SELECT * FROM project_steps WHERE user_id=? ORDER BY project_id,position,created_at').all(userId),approvals:s.listApprovals.all(userId),preferences:this.getPreferences(userId),conversationSummaries:db.prepare('SELECT * FROM conversation_summaries WHERE user_id=?').all(userId),calendarFeeds:this.listCalendarFeeds(userId),tasks:s.listTasks.all(userId),events:s.listEvents.all(userId,20000),artifacts:s.listArtifacts.all(userId).map((a)=>s.getArtifact.get(a.id,userId))}; },
    restoreUser(userId, bundle) {
      if (!bundle || ![2,3,4,5].includes(bundle.version)) throw Object.assign(new Error('Backup version is not supported.'), { status: 400 });
      const inserts = {
        conversation: db.prepare('INSERT OR IGNORE INTO conversations(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)'),
        message: db.prepare('INSERT OR IGNORE INTO messages(id,user_id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?,?)'),
        memory: db.prepare(`INSERT OR IGNORE INTO memories(id,user_id,content,created_at,updated_at,kind,source,status,confidence,expires_at,last_confirmed_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`),
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
        task: db.prepare(`INSERT OR IGNORE INTO tasks(id,user_id,title,prompt,status,risk,schedule_at,recurrence,result,created_at,updated_at,attempt_count,lease_expires_at,last_error)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
        event: db.prepare('INSERT OR IGNORE INTO events(id,user_id,type,message,detail,created_at) VALUES(?,?,?,?,?,?)'),
        artifact: db.prepare('INSERT OR IGNORE INTO artifacts(id,user_id,task_id,name,mime_type,content,size_bytes,created_at) VALUES(?,?,?,?,?,?,?,?)')
      };
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of bundle.conversations || []) inserts.conversation.run(row.id,userId,row.title,row.created_at,row.updated_at);
        for (const row of bundle.messages || []) inserts.message.run(row.id,userId,row.conversation_id||null,row.role,row.content,row.created_at);
        for (const row of bundle.memories || []) inserts.memory.run(row.id,userId,row.content,row.created_at,row.updated_at,normalizeMemoryKind(row.kind),row.source||'backup',row.status||'approved',row.confidence??1,row.expires_at||null,row.last_confirmed_at||row.updated_at);
        for (const row of bundle.memorySuggestions || []) inserts.suggestion.run(row.id,userId,row.content,row.created_at,normalizeMemoryKind(row.kind),row.confidence??0.7);
        for (const row of bundle.followUps || []) inserts.followUp.run(row.id,userId,row.description,row.due_date,row.status||'scheduled',normalizePriority(row.priority),row.source_message_id||null,row.created_at,row.completed_at||null);
        for (const row of bundle.goals || []) inserts.goal.run(row.id,userId,row.title,row.description||null,row.status||'active',normalizePriority(row.priority),Math.max(0,Math.min(Number(row.progress)||0,100)),row.target_date||null,row.next_step||null,row.created_at,row.updated_at,row.completed_at||null);
        for (const row of bundle.goalCheckins || []) inserts.goalCheckin.run(row.id,row.goal_id,userId,row.progress,row.note||null,row.created_at);
        for (const row of bundle.routines || []) inserts.routine.run(row.id,userId,row.title,row.prompt,row.kind||'custom',row.cadence||'daily',validTimeString(row.time_local,'09:00'),row.day_of_week??null,row.enabled===0?0:1,row.last_run_date||null,row.last_run_at||null,null,null,row.last_error||null,row.created_at,row.updated_at);
        for (const row of bundle.projects || []) inserts.project.run(row.id,userId,row.title,row.description||null,['active','paused','completed'].includes(row.status)?row.status:'active',normalizePriority(row.priority),row.target_date||null,row.created_at,row.updated_at,row.completed_at||null);
        for (const row of bundle.projectSteps || []) inserts.projectStep.run(row.id,row.project_id,userId,row.title,row.details||null,['planned','in_progress','blocked','completed'].includes(row.status)?row.status:'planned',Number(row.position)||0,row.due_date||null,row.created_at,row.updated_at,row.completed_at||null);
        for (const row of bundle.approvals || []) inserts.approval.run(row.id,userId,row.kind,row.title,row.summary,row.payload_json||'{}',['pending','executed','rejected','failed'].includes(row.status)?row.status:'pending',row.source_message_id||null,row.result_json||null,row.last_error||null,row.created_at,row.updated_at,row.reviewed_at||null);
        for (const row of bundle.conversationSummaries || []) inserts.summary.run(row.conversation_id,userId,row.summary,row.message_count,row.updated_at);
        for (const row of bundle.calendarFeeds || []) inserts.calendar.run(row.id,userId,row.label,protectSecret(row.url),row.created_at,row.updated_at);
        for (const row of bundle.tasks || []) inserts.task.run(row.id,userId,row.title,row.prompt,row.status,row.risk,row.schedule_at,row.recurrence,row.result,row.created_at,row.updated_at,row.attempt_count||0,row.lease_expires_at||null,row.last_error||null);
        for (const row of bundle.events || []) inserts.event.run(row.id,userId,row.type,row.message,row.detail,row.created_at);
        for (const row of bundle.artifacts || []) inserts.artifact.run(row.id,userId,row.task_id,row.name,row.mime_type,row.content,row.size_bytes,row.created_at);
        if(bundle.preferences){const p=normalizePreferences(bundle.preferences);const current=s.getPreferences.get(userId);const created=current?.created_at||timestamp();s.upsertPreferences.run(userId,p.timeZone,p.quietStart,p.quietEnd,p.proactiveEnabled?1:0,p.briefingTone,p.briefingLength,created,timestamp());}
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
}
