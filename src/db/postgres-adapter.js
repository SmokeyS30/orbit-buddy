// PostgreSQL adapter for orbit-buddy (Stage 1)
//
// Implements the same method interface as src/database.js (SQLite version)
// but using async PostgreSQL queries via the `pg` library.
//
// KEY DIFFERENCES from SQLite version:
// - All methods are async (return Promises)
// - Query parameters use $1, $2, ... instead of ? (via toPgPlaceholders)
// - `strftime` → `to_char(...::timestamp, ...)`
// - `INSERT OR IGNORE` → `INSERT ... ON CONFLICT DO NOTHING`
// - `COLLATE NOCASE` on email → CITEXT column (plain = is case-insensitive)
// - `ORDER BY x COLLATE NOCASE` → `ORDER BY LOWER(x)`
// - `rowid` tiebreakers → `id` (deterministic; UUIDs, not insertion order)
// - `MAX(0, ...)` scalar → `GREATEST(0, ...)`
// - COUNT(*) returns are cast to Number (pg returns int8 as string)
// - Transactions use a pooled client with BEGIN/COMMIT/ROLLBACK
//
// Stage 1: This adapter is built and tested but NOT used in production.
// Production continues on SQLite until Stage 2 (explicit owner approval).

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../security.js';
import { normalizeMemoryKind, normalizePreferences, normalizePriority, rankGoals, rankMemories, validDateString, validTimeString } from '../intelligence.js';

const { Pool } = pg;
const timestamp = () => new Date().toISOString();

// Convert ? placeholders to $1, $2, ... for PostgreSQL
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
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

async function adoptOrphanMessages({ get, run }, userId) {
  let convo = await get('SELECT * FROM conversations WHERE user_id=? ORDER BY updated_at DESC LIMIT 1', userId);
  if (!convo) {
    const now = timestamp(); const id = randomUUID();
    await run('INSERT INTO conversations(id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)', id, userId, 'General', now, now);
    convo = { id };
  }
  await run('UPDATE messages SET conversation_id=? WHERE user_id=? AND conversation_id IS NULL', convo.id, userId);
  return convo.id;
}

export async function openPostgres(databaseUrl, { encryptionKey = null } = {}) {
  // Azure Database for PostgreSQL presents a certificate chaining to the
  // DigiCert Global Root CA, which is in Node.js's default trust store.
  // We require full verification: the connection string must specify
  // sslmode=verify-full (or verify-ca), and we never disable verification.
  // If sslmode is absent, we append verify-full explicitly.
  // Exception: sslmode=disable is honored for local test containers.
  let connectionString = databaseUrl;
  const sslDisabled = /sslmode=disable/.test(connectionString);
  if (!sslDisabled) {
    // Upgrade sslmode=require to verify-full for explicit certificate
    // verification. Azure's cert chains to DigiCert Global Root CA.
    connectionString = connectionString.replace(/sslmode=require/, 'sslmode=verify-full');
    if (!/sslmode=/.test(connectionString)) {
      connectionString += (connectionString.includes('?') ? '&' : '?') + 'sslmode=verify-full';
    }
  }
  const pool = new Pool({
    connectionString,
    // ssl: true makes node-postgres verify the server certificate against
    // the default CA store. rejectUnauthorized is NOT disabled.
    // Disabled only for local test containers (sslmode=disable).
    ssl: sslDisabled ? false : true,
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

  // Transaction helper: runs fn with transaction-scoped get/all/run.
  // Commits on success, rolls back on error.
  const withTransaction = async (fn) => {
    const txClient = await pool.connect();
    const tQuery = async (sql, params = []) => txClient.query(toPgPlaceholders(sql), params);
    const tGet = async (sql, ...params) => (await tQuery(sql, params)).rows[0] || null;
    const tAll = async (sql, ...params) => (await tQuery(sql, params)).rows;
    const tRun = async (sql, ...params) => ({ changes: (await tQuery(sql, params)).rowCount || 0 });
    try {
      await txClient.query('BEGIN');
      const result = await fn({ query: tQuery, get: tGet, all: tAll, run: tRun });
      await txClient.query('COMMIT');
      return result;
    } catch (error) {
      await txClient.query('ROLLBACK');
      throw error;
    } finally {
      txClient.release();
    }
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

  // Shared UPSERT SQL for user_preferences (used by getPreferences/setPreferences/restoreUser)
  const upsertPreferencesSql = `INSERT INTO user_preferences(user_id,time_zone,quiet_start,quiet_end,proactive_enabled,briefing_tone,briefing_length,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET time_zone=excluded.time_zone,quiet_start=excluded.quiet_start,
    quiet_end=excluded.quiet_end,proactive_enabled=excluded.proactive_enabled,briefing_tone=excluded.briefing_tone,
    briefing_length=excluded.briefing_length,updated_at=excluded.updated_at`;

  return {
    // Connection management
    close: () => pool.end(),
    query, get, all, run,

    // --- Users ---
    countUsers: async () => Number((await get('SELECT COUNT(*) AS count FROM users')).count),
    listUsers: async () => all('SELECT id,email,display_name,role,disabled,created_at,updated_at FROM users ORDER BY created_at'),
    async createUser({ email, displayName, passwordHash, passwordSalt, role }) {
      const now = timestamp(); const id = randomUUID();
      await run('INSERT INTO users(id,email,display_name,password_hash,password_salt,role,disabled,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)', id, email, displayName, passwordHash, passwordSalt, role, now, now);
      return get('SELECT * FROM users WHERE id = ?', id);
    },
    async createDemoUser() {
      const now = timestamp(); const id = randomUUID();
      const email = `demo-${id.slice(0,8)}@demo.orbitbuddy.app`;
      await run('INSERT INTO users(id,email,display_name,password_hash,password_salt,role,disabled,is_demo,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)', id, email, 'Demo Explorer', 'demo', 'demo', 'member', now, now);
      return get('SELECT * FROM users WHERE id = ?', id);
    },
    async listExpiredDemoUsers(maxAgeMs) {
      const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
      return all('SELECT id FROM users WHERE is_demo=1 AND created_at<?', cutoff);
    },
    countUserMessages: async (userId) => Number((await get("SELECT COUNT(*) AS count FROM messages WHERE user_id=? AND role='user'", userId)).count),
    async deleteDemoUser(id) {
      await run('DELETE FROM sessions WHERE user_id=?', id);
      await run('DELETE FROM users WHERE id=?', id);
    },
    // email column is CITEXT: plain = is already case-insensitive
    getUserByEmail: async (email) => get('SELECT * FROM users WHERE email = ?', email),
    getUserById: async (id) => get('SELECT * FROM users WHERE id = ?', id),
    updatePassword: async (id, passwordHash, passwordSalt) => { await run('UPDATE users SET password_hash=?, password_salt=?, updated_at=? WHERE id=?', passwordHash, passwordSalt, timestamp(), id); },
    setUserDisabled: async (id, disabled) => { await run('UPDATE users SET disabled=?, updated_at=? WHERE id=?', disabled ? 1 : 0, timestamp(), id); },
    async claimOrphans(userId) {
      await run('UPDATE messages SET user_id=? WHERE user_id IS NULL', userId);
      await run('UPDATE memories SET user_id=? WHERE user_id IS NULL', userId);
      await run('UPDATE tasks SET user_id=? WHERE user_id IS NULL', userId);
      await run('UPDATE events SET user_id=? WHERE user_id IS NULL', userId);
      await adoptOrphanMessages({ get, run }, userId);
    },

    // --- Sessions ---
    createSession: async ({ tokenHash, userId, csrfToken, expiresAt, userAgent }) => { await run('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)', tokenHash, userId, csrfToken, expiresAt, timestamp(), userAgent || null); },
    getSession: async (tokenHash) => get(`SELECT sessions.*, users.email, users.display_name, users.role, users.disabled
      FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?`, tokenHash, timestamp()),
    deleteSession: async (tokenHash) => { await run('DELETE FROM sessions WHERE token_hash=?', tokenHash); },
    deleteUserSessions: async (userId) => { await run('DELETE FROM sessions WHERE user_id=?', userId); },
    pruneSessions: async () => { await run('DELETE FROM sessions WHERE expires_at<=?', timestamp()); },

    // --- Recovery codes ---
    async replaceRecoveryCodes(userId, hashes) {
      await withTransaction(async ({ run: tRun }) => {
        await tRun('DELETE FROM recovery_codes WHERE user_id=?', userId);
        for (const hash of hashes) await tRun('INSERT INTO recovery_codes VALUES (?, ?, ?, NULL, ?)', randomUUID(), userId, hash, timestamp());
      });
    },
    async consumeRecoveryCode(hash) {
      const row = await get('SELECT * FROM recovery_codes WHERE code_hash=? AND used_at IS NULL', hash);
      if (!row) return null;
      const result = await run('UPDATE recovery_codes SET used_at=? WHERE id=? AND used_at IS NULL', timestamp(), row.id);
      return result.changes ? row : null;
    },

    // --- Settings ---
    getSetting: async (key, fallback=null) => (await get('SELECT value FROM settings WHERE key=?', key))?.value ?? fallback,
    setSetting: async (key, value) => { await run(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, key, String(value), timestamp()); },

    // --- Conversations & messages ---
    async ensureDefaultConversation(userId) {
      const existing = await get('SELECT * FROM conversations WHERE user_id=? ORDER BY updated_at DESC,id DESC', userId);
      if (existing) { await adoptOrphanMessages({ get, run }, userId); return existing; }
      const now = timestamp();
      const row = { id: randomUUID(), user_id: userId, title: 'General', created_at: now, updated_at: now };
      await run('INSERT INTO conversations(id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)', row.id, row.user_id, row.title, row.created_at, row.updated_at);
      await adoptOrphanMessages({ get, run }, userId);
      return row;
    },
    async createConversation(userId, title) {
      const now = timestamp();
      const row = { id: randomUUID(), user_id: userId, title, created_at: now, updated_at: now };
      await run('INSERT INTO conversations(id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)', row.id, row.user_id, row.title, row.created_at, row.updated_at);
      return row;
    },
    listConversations: async (userId) => all('SELECT * FROM conversations WHERE user_id=? ORDER BY updated_at DESC,id DESC', userId),
    getConversation: async (userId, id) => get('SELECT * FROM conversations WHERE id=? AND user_id=?', id, userId),
    touchConversation: async (userId, id) => (await run('UPDATE conversations SET updated_at=? WHERE id=? AND user_id=?', timestamp(), id, userId)).changes > 0,
    async deleteConversation(userId, id) {
      return withTransaction(async ({ run: tRun }) => {
        await tRun('DELETE FROM messages WHERE conversation_id=? AND user_id=?', id, userId);
        const result = await tRun('DELETE FROM conversations WHERE id=? AND user_id=?', id, userId);
        return result.changes > 0;
      });
    },
    async addMessage(userId, conversationId, role, content) {
      const row = { id: randomUUID(), user_id: userId, conversation_id: conversationId, role, content, created_at: timestamp() };
      await run('INSERT INTO messages(id,user_id,conversation_id,role,content,created_at) VALUES (?, ?, ?, ?, ?, ?)', row.id, row.user_id, row.conversation_id, row.role, row.content, row.created_at);
      return row;
    },
    async listConversationMessages(userId, conversationId, limit=60) {
      return (await all('SELECT * FROM messages WHERE user_id=? AND conversation_id=? ORDER BY created_at DESC,id DESC LIMIT ?', userId, conversationId, Math.min(Math.max(limit, 1), 200))).reverse();
    },
    async listMessages(userId, limit=60) {
      return (await all('SELECT * FROM messages WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ?', userId, Math.min(Math.max(limit, 1), 200))).reverse();
    },

    // --- Memories ---
    async addMemory(userId, content, options={}) {
      const now = timestamp();
      const row = { id: randomUUID(), user_id: userId, content, created_at: now, updated_at: now,
        kind: normalizeMemoryKind(options.kind), source: String(options.source||'user').slice(0, 40), status: 'approved',
        confidence: Math.max(0, Math.min(Number(options.confidence ?? 1), 1)), expires_at: options.expiresAt || null, last_confirmed_at: now };
      await run(`INSERT INTO memories(id,user_id,content,created_at,updated_at,kind,source,status,confidence,expires_at,last_confirmed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)`,
        row.id, row.user_id, row.content, row.created_at, row.updated_at, row.kind, row.source, row.confidence, row.expires_at, row.last_confirmed_at);
      return row;
    },
    listMemories: async (userId) => all("SELECT * FROM memories WHERE user_id=? AND status='approved' ORDER BY updated_at DESC,id DESC LIMIT 100", userId),
    async listRelevantMemories(userId, query, limit=8) {
      return rankMemories(await all("SELECT * FROM memories WHERE user_id=? AND status='approved' ORDER BY updated_at DESC,id DESC LIMIT 100", userId), query, limit);
    },
    deleteMemory: async (userId, id) => (await run('DELETE FROM memories WHERE id=? AND user_id=?', id, userId)).changes > 0,
    async addMemorySuggestion(userId, content, options={}) {
      const now = timestamp();
      const row = { id: randomUUID(), user_id: userId, content, created_at: now, kind: normalizeMemoryKind(options.kind), confidence: Math.max(0, Math.min(Number(options.confidence ?? 0.7), 1)) };
      await run('INSERT INTO memory_suggestions(id,user_id,content,created_at,kind,confidence) VALUES (?,?,?,?,?,?)', row.id, row.user_id, row.content, row.created_at, row.kind, row.confidence);
      return row;
    },
    listMemorySuggestions: async (userId) => all('SELECT * FROM memory_suggestions WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 50', userId),
    dismissMemorySuggestion: async (userId, id) => (await run('DELETE FROM memory_suggestions WHERE id=? AND user_id=?', id, userId)).changes > 0,
    async approveMemorySuggestion(userId, id) {
      const row = await get('SELECT * FROM memory_suggestions WHERE id=? AND user_id=?', id, userId);
      if (!row) return null;
      const saved = await this.addMemory(userId, row.content, { kind: row.kind, source: 'suggestion', confidence: row.confidence });
      await run('DELETE FROM memory_suggestions WHERE id=? AND user_id=?', id, userId);
      return { ...row, memory_id: saved.id };
    },

    // --- Import jobs ---
    async createImportJob(userId, filename) {
      const now = timestamp();
      const row = { id: randomUUID(), user_id: userId, filename: String(filename||'').slice(0, 200), status: 'processing', total_chunks: 0, done_chunks: 0, suggestions_added: 0, error: null, created_at: now, updated_at: now };
      await run('INSERT INTO import_jobs(id,user_id,filename,status,total_chunks,done_chunks,suggestions_added,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', row.id, row.user_id, row.filename, row.status, row.total_chunks, row.done_chunks, row.suggestions_added, row.error, row.created_at, row.updated_at);
      return row;
    },
    getImportJob: async (userId, id) => (await get('SELECT * FROM import_jobs WHERE id=? AND user_id=?', id, userId)) || null,
    listImportJobs: async (userId) => all('SELECT * FROM import_jobs WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 5', userId),
    async updateImportJob(userId, id, patch={}) {
      const cur = await get('SELECT * FROM import_jobs WHERE id=? AND user_id=?', id, userId);
      if (!cur) return null;
      const next = { status: patch.status || cur.status, total_chunks: patch.total_chunks ?? cur.total_chunks, done_chunks: patch.done_chunks ?? cur.done_chunks, suggestions_added: patch.suggestions_added ?? cur.suggestions_added, error: patch.error !== undefined ? patch.error : cur.error, updated_at: timestamp() };
      await run('UPDATE import_jobs SET status=?,total_chunks=?,done_chunks=?,suggestions_added=?,error=?,updated_at=? WHERE id=? AND user_id=?', next.status, next.total_chunks, next.done_chunks, next.suggestions_added, next.error, next.updated_at, id, userId);
      return { ...cur, ...next };
    },

    // --- Follow-ups ---
    async addFollowUp(userId, { description, dueDate, priority=2, sourceMessageId=null }) {
      const row = { id: randomUUID(), user_id: userId, description, due_date: validDateString(dueDate) || dueDate, status: 'scheduled', priority: normalizePriority(priority), source_message_id: sourceMessageId, created_at: timestamp(), completed_at: null };
      const result = await run("INSERT INTO follow_ups(id,user_id,description,due_date,status,priority,source_message_id,attempt_count,next_attempt_at,last_error,created_at,completed_at) VALUES(?,?,?,?,'scheduled',?,?,0,NULL,NULL,?,NULL) ON CONFLICT DO NOTHING", row.id, row.user_id, row.description, row.due_date, row.priority, row.source_message_id, row.created_at);
      return result.changes ? row : (await all("SELECT * FROM follow_ups WHERE user_id=? AND status='scheduled' ORDER BY priority DESC,due_date,created_at", userId)).find((item) => item.description === description && item.due_date === row.due_date);
    },
    listFollowUps: async (userId) => all("SELECT * FROM follow_ups WHERE user_id=? AND status='scheduled' ORDER BY priority DESC,due_date,created_at", userId),
    dueFollowUps: async (userId, today, at=timestamp()) => all("SELECT * FROM follow_ups WHERE user_id=? AND status='scheduled' AND due_date<=? AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY priority DESC,due_date,created_at", userId, today, at),
    completeFollowUp: async (userId, id) => (await run("UPDATE follow_ups SET status='completed',completed_at=?,next_attempt_at=NULL,last_error=NULL WHERE id=? AND user_id=? AND status='scheduled'", timestamp(), id, userId)).changes > 0,
    failFollowUp: async (userId, id, error, retryMs=15*60_000) => (await run("UPDATE follow_ups SET attempt_count=attempt_count+1,next_attempt_at=?,last_error=? WHERE id=? AND user_id=? AND status='scheduled'", new Date(Date.now()+retryMs).toISOString(), String(error||'').slice(0, 1000), id, userId)).changes > 0,
    deleteFollowUp: async (userId, id) => (await run('DELETE FROM follow_ups WHERE id=? AND user_id=?', id, userId)).changes > 0,

    // --- Personal dates ---
    async addPersonalDate(userId, { label, month, day, year=null, type='other', notes=null, giftNag=null }) {
      const m = Math.floor(Number(month)), d = Math.floor(Number(day));
      if (!Number.isInteger(m) || m < 1 || m > 12) throw new Error('month must be 1-12.');
      if (!Number.isInteger(d) || d < 1 || d > 31) throw new Error('day must be 1-31.');
      const daysInMonth = [31,29,31,30,31,30,31,31,30,31,30,31][m-1];
      if (d > daysInMonth) throw new Error(`day must be 1-${daysInMonth} for that month.`);
      const y = year == null ? null : Math.floor(Number(year));
      if (y !== null && (!Number.isInteger(y) || y < 1900 || y > 2100)) throw new Error('year must be 1900-2100.');
      const cleanType = ['birthday','anniversary','other'].includes(type) ? type : 'other';
      const gift_nag = giftNag === null || giftNag === undefined ? ((cleanType === 'birthday' || cleanType === 'anniversary') ? 1 : 0) : (giftNag ? 1 : 0);
      const now = timestamp();
      const row = { id: randomUUID(), user_id: userId, label: String(label||'').trim().slice(0, 120), month: m, day: d, year: y, type: cleanType, notes: notes ? String(notes).trim().slice(0, 500) : null, gift_nag, gift_done: 0, created_at: now, updated_at: now };
      if (!row.label) throw new Error('label is required.');
      await run(`INSERT INTO personal_dates(id,user_id,label,month,day,year,type,notes,gift_nag,gift_done,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, row.id, row.user_id, row.label, row.month, row.day, row.year, row.type, row.notes, row.gift_nag, row.gift_done, row.created_at, row.updated_at);
      return row;
    },
    listPersonalDates: async (userId) => all('SELECT * FROM personal_dates WHERE user_id=? ORDER BY month,day,label', userId),
    getPersonalDate: async (userId, id) => (await get('SELECT * FROM personal_dates WHERE id=? AND user_id=?', id, userId)) || null,
    async updatePersonalDate(userId, id, { label, month, day, year, type, notes, giftNag, giftDone }={}) {
      const current = await get('SELECT * FROM personal_dates WHERE id=? AND user_id=?', id, userId);
      if (!current) return null;
      const m = month === undefined ? current.month : Math.floor(Number(month));
      const d = day === undefined ? current.day : Math.floor(Number(day));
      if (m < 1 || m > 12 || d < 1 || d > 31) throw new Error('month must be 1-12 and day 1-31.');
      const daysInMonth = [31,29,31,30,31,30,31,31,30,31,30,31][m-1];
      if (d > daysInMonth) throw new Error(`day must be 1-${daysInMonth} for that month.`);
      const y = year === undefined ? current.year : (year == null ? null : Math.floor(Number(year)));
      const cleanType = type === undefined ? current.type : (['birthday','anniversary','other'].includes(type) ? type : 'other');
      const next = { label: label === undefined ? current.label : String(label).trim().slice(0, 120), month: m, day: d, year: y, type: cleanType, notes: notes === undefined ? current.notes : (notes ? String(notes).trim().slice(0, 500) : null), gift_nag: giftNag === undefined ? current.gift_nag : (giftNag ? 1 : 0), gift_done: giftDone === undefined ? current.gift_done : (giftDone ? 1 : 0) };
      if (!next.label) throw new Error('label is required.');
      await run('UPDATE personal_dates SET label=?,month=?,day=?,year=?,type=?,notes=?,gift_nag=?,gift_done=?,updated_at=? WHERE id=? AND user_id=?', next.label, next.month, next.day, next.year, next.type, next.notes, next.gift_nag, next.gift_done, timestamp(), id, userId);
      return get('SELECT * FROM personal_dates WHERE id=? AND user_id=?', id, userId);
    },
    deletePersonalDate: async (userId, id) => (await run('DELETE FROM personal_dates WHERE id=? AND user_id=?', id, userId)).changes > 0,
    async markGiftDone(userId, id) { return !!((await get('SELECT * FROM personal_dates WHERE id=? AND user_id=?', id, userId)) && await this.updatePersonalDate(userId, id, { giftDone: true })); },

    // --- Goals ---
    async addGoal(userId, { title, description=null, priority=2, targetDate=null, nextStep=null }) {
      const now = timestamp();
      const row = { id: randomUUID(), user_id: userId, title, description: description || null, status: 'active', priority: normalizePriority(priority), progress: 0, target_date: targetDate ? validDateString(targetDate) : null, next_step: nextStep || null, created_at: now, updated_at: now, completed_at: null };
      await run(`INSERT INTO goals(id,user_id,title,description,status,priority,progress,target_date,next_step,created_at,updated_at,completed_at)
        VALUES(?,?,?,?,'active',?,0,?,?,?, ?,NULL)`, row.id, row.user_id, row.title, row.description, row.priority, row.target_date, row.next_step, row.created_at, row.updated_at);
      return row;
    },
    getGoal: async (userId, id) => (await get('SELECT * FROM goals WHERE id=? AND user_id=?', id, userId)) || null,
    listGoals: async (userId) => all("SELECT * FROM goals WHERE user_id=? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,priority DESC,COALESCE(target_date,'9999-12-31'),updated_at DESC", userId),
    async listActiveGoals(userId, limit=10) { return rankGoals(await all("SELECT * FROM goals WHERE user_id=? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,priority DESC,COALESCE(target_date,'9999-12-31'),updated_at DESC", userId), limit); },
    async updateGoal(userId, id, { progress, status, nextStep, note=null }={}) {
      const current = await get('SELECT * FROM goals WHERE id=? AND user_id=?', id, userId);
      if (!current) return null;
      const nextProgress = Math.max(0, Math.min(Math.round(Number(progress ?? current.progress)), 100));
      let nextStatus = ['active','paused','completed'].includes(status) ? status : current.status;
      if (nextProgress >= 100) nextStatus = 'completed';
      const completedAt = nextStatus === 'completed' ? (current.completed_at || timestamp()) : null;
      const updated = timestamp();
      await run('UPDATE goals SET progress=?,status=?,next_step=?,updated_at=?,completed_at=? WHERE id=? AND user_id=?', nextProgress, nextStatus, nextStep === undefined ? current.next_step : (nextStep || null), updated, completedAt, id, userId);
      if (note || nextProgress !== current.progress) await run('INSERT INTO goal_checkins(id,goal_id,user_id,progress,note,created_at) VALUES(?,?,?,?,?,?)', randomUUID(), id, userId, nextProgress, note ? String(note).slice(0, 1000) : null, updated);
      return get('SELECT * FROM goals WHERE id=? AND user_id=?', id, userId);
    },
    deleteGoal: async (userId, id) => (await run('DELETE FROM goals WHERE id=? AND user_id=?', id, userId)).changes > 0,
    listGoalCheckins: async (userId, goalId, limit=20) => all('SELECT * FROM goal_checkins WHERE goal_id=? AND user_id=? ORDER BY created_at DESC LIMIT ?', goalId, userId, Math.min(Math.max(limit, 1), 100)),

    // --- Routines ---
    async addRoutine(userId, { title, prompt, kind='custom', cadence='daily', timeLocal='09:00', dayOfWeek=null }) {
      const now = timestamp();
      const cleanKind = ['briefing','reflection','custom'].includes(kind) ? kind : 'custom';
      const cleanCadence = ['daily','weekdays','weekly'].includes(cadence) ? cadence : 'daily';
      const requestedDay = Number(dayOfWeek);
      const cleanDay = cleanCadence === 'weekly' && Number.isInteger(requestedDay) && requestedDay >= 0 && requestedDay <= 6 ? requestedDay : (cleanCadence === 'weekly' ? 1 : null);
      const row = { id: randomUUID(), user_id: userId, title, prompt, kind: cleanKind, cadence: cleanCadence, time_local: validTimeString(timeLocal, '09:00'), day_of_week: cleanDay, enabled: 1, last_run_date: null, last_run_at: null, lease_date: null, lease_expires_at: null, last_error: null, created_at: now, updated_at: now };
      await run(`INSERT INTO routines(id,user_id,title,prompt,kind,cadence,time_local,day_of_week,enabled,last_run_date,last_run_at,lease_date,lease_expires_at,last_error,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,1,NULL,NULL,NULL,NULL,NULL,?,?)`, row.id, row.user_id, row.title, row.prompt, row.kind, row.cadence, row.time_local, row.day_of_week, row.created_at, row.updated_at);
      return row;
    },
    getRoutine: async (userId, id) => (await get('SELECT * FROM routines WHERE id=? AND user_id=?', id, userId)) || null,
    listRoutines: async (userId) => all('SELECT * FROM routines WHERE user_id=? ORDER BY enabled DESC,time_local,LOWER(title)', userId),
    setRoutineEnabled: async (userId, id, enabled) => (await run('UPDATE routines SET enabled=?,lease_date=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND user_id=?', enabled ? 1 : 0, timestamp(), id, userId)).changes > 0,
    deleteRoutine: async (userId, id) => (await run('DELETE FROM routines WHERE id=? AND user_id=?', id, userId)).changes > 0,
    claimRoutine: async (userId, id, localDate, leaseMs=2*60_000) => {
      const now = timestamp();
      return (await run(`UPDATE routines SET lease_date=?,lease_expires_at=?,last_error=NULL,updated_at=? WHERE id=? AND user_id=? AND enabled=1
        AND (last_run_date IS NULL OR last_run_date<>?) AND (lease_expires_at IS NULL OR lease_expires_at<=?)`,
        localDate, new Date(Date.now()+leaseMs).toISOString(), now, id, userId, localDate, now)).changes > 0;
    },
    completeRoutine: async (userId, id, localDate) => {
      const now = timestamp();
      return (await run('UPDATE routines SET last_run_date=?,last_run_at=?,lease_date=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=? WHERE id=? AND user_id=? AND lease_date=?', localDate, now, now, id, userId, localDate)).changes > 0;
    },
    failRoutine: async (userId, id, localDate, error) => (await run('UPDATE routines SET lease_date=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=? AND user_id=? AND lease_date=?', String(error||'').slice(0, 1000), timestamp(), id, userId, localDate)).changes > 0,

    // --- Projects ---
    async addProject(userId, { title, description=null, priority=2, targetDate=null, steps=[] }) {
      const now = timestamp();
      const row = { id: randomUUID(), user_id: userId, title, description: description || null, status: 'active', priority: normalizePriority(priority), target_date: targetDate ? validDateString(targetDate) : null, created_at: now, updated_at: now, completed_at: null };
      await withTransaction(async ({ run: tRun }) => {
        await tRun(`INSERT INTO projects(id,user_id,title,description,status,priority,target_date,created_at,updated_at,completed_at)
          VALUES(?,?,?,?,'active',?,?,?, ?,NULL)`, row.id, row.user_id, row.title, row.description, row.priority, row.target_date, row.created_at, row.updated_at);
        let position = 0;
        for (const value of steps.slice(0, 50)) {
          const step = typeof value === 'string' ? { title: value } : { ...value };
          const stepTitle = String(step.title || '').trim().slice(0, 160);
          if (!stepTitle) continue;
          const stepNow = timestamp();
          await tRun(`INSERT INTO project_steps(id,project_id,user_id,title,details,status,position,due_date,created_at,updated_at,completed_at)
            VALUES(?,?,?,?,?,'planned',?,?,?, ?,NULL)`,
            randomUUID(), row.id, userId, stepTitle,
            typeof step.details === 'string' && step.details.trim() ? step.details.trim().slice(0, 1000) : null,
            position, step.dueDate ? validDateString(step.dueDate) : null, stepNow, stepNow);
          position += 1;
        }
      });
      return { ...row, steps: await all('SELECT * FROM project_steps WHERE project_id=? AND user_id=? ORDER BY position,created_at', row.id, userId) };
    },
    async getProject(userId, id) {
      const row = await get('SELECT * FROM projects WHERE id=? AND user_id=?', id, userId);
      return row ? { ...row, steps: await all('SELECT * FROM project_steps WHERE project_id=? AND user_id=? ORDER BY position,created_at', id, userId) } : null;
    },
    async listProjects(userId) {
      const rows = await all("SELECT * FROM projects WHERE user_id=? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,priority DESC,COALESCE(target_date,'9999-12-31'),updated_at DESC", userId);
      const out = [];
      for (const row of rows) out.push({ ...row, steps: await all('SELECT * FROM project_steps WHERE project_id=? AND user_id=? ORDER BY position,created_at', row.id, userId) });
      return out;
    },
    async updateProject(userId, id, patch={}) {
      const current = await get('SELECT * FROM projects WHERE id=? AND user_id=?', id, userId);
      if (!current) return null;
      const status = patch.status === undefined ? current.status : (['active','paused','completed'].includes(patch.status) ? patch.status : current.status);
      const title = patch.title === undefined ? current.title : String(patch.title || '').trim().slice(0, 120) || current.title;
      const description = patch.description === undefined ? current.description : (String(patch.description || '').trim().slice(0, 1000) || null);
      const priority = patch.priority === undefined ? current.priority : normalizePriority(patch.priority);
      const targetDate = patch.targetDate === undefined ? current.target_date : (patch.targetDate ? validDateString(patch.targetDate) : null);
      const now = timestamp();
      const completedAt = status === 'completed' ? (current.completed_at || now) : null;
      await run('UPDATE projects SET title=?,description=?,status=?,priority=?,target_date=?,updated_at=?,completed_at=? WHERE id=? AND user_id=?', title, description, status, priority, targetDate, now, completedAt, id, userId);
      return this.getProject(userId, id);
    },
    deleteProject: async (userId, id) => (await run('DELETE FROM projects WHERE id=? AND user_id=?', id, userId)).changes > 0,
    async addProjectStep(userId, projectId, { title, details=null, dueDate=null }) {
      if (!await get('SELECT * FROM projects WHERE id=? AND user_id=?', projectId, userId)) return null;
      const existing = await all('SELECT * FROM project_steps WHERE project_id=? AND user_id=? ORDER BY position,created_at', projectId, userId);
      const now = timestamp();
      const row = { id: randomUUID(), project_id: projectId, user_id: userId, title, details: details || null, status: 'planned', position: existing.length, due_date: dueDate ? validDateString(dueDate) : null, created_at: now, updated_at: now, completed_at: null };
      await run(`INSERT INTO project_steps(id,project_id,user_id,title,details,status,position,due_date,created_at,updated_at,completed_at)
        VALUES(?,?,?,?,?,'planned',?,?,?, ?,NULL)`, row.id, row.project_id, row.user_id, row.title, row.details, row.position, row.due_date, row.created_at, row.updated_at);
      return row;
    },
    getProjectStep: async (userId, id) => (await get('SELECT * FROM project_steps WHERE id=? AND user_id=?', id, userId)) || null,
    async updateProjectStep(userId, id, patch={}) {
      const current = await get('SELECT * FROM project_steps WHERE id=? AND user_id=?', id, userId);
      if (!current) return null;
      const status = patch.status === undefined ? current.status : (['planned','in_progress','blocked','completed'].includes(patch.status) ? patch.status : current.status);
      const title = patch.title === undefined ? current.title : String(patch.title || '').trim().slice(0, 160) || current.title;
      const details = patch.details === undefined ? current.details : (String(patch.details || '').trim().slice(0, 1000) || null);
      const position = patch.position === undefined ? current.position : Math.max(0, Math.min(Number(patch.position) || 0, 1000));
      const dueDate = patch.dueDate === undefined ? current.due_date : (patch.dueDate ? validDateString(patch.dueDate) : null);
      const now = timestamp();
      const completedAt = status === 'completed' ? (current.completed_at || now) : null;
      await run('UPDATE project_steps SET title=?,details=?,status=?,position=?,due_date=?,updated_at=?,completed_at=? WHERE id=? AND user_id=?', title, details, status, position, dueDate, now, completedAt, id, userId);
      const project = await get('SELECT * FROM projects WHERE id=? AND user_id=?', current.project_id, userId);
      if (project) await run('UPDATE projects SET title=?,description=?,status=?,priority=?,target_date=?,updated_at=?,completed_at=? WHERE id=? AND user_id=?', project.title, project.description, project.status, project.priority, project.target_date, now, project.completed_at, project.id, userId);
      return get('SELECT * FROM project_steps WHERE id=? AND user_id=?', id, userId);
    },
    deleteProjectStep: async (userId, id) => (await run('DELETE FROM project_steps WHERE id=? AND user_id=?', id, userId)).changes > 0,

    // --- Approvals ---
    async addApproval(userId, { kind, title, summary, payload={}, sourceMessageId=null }) {
      const now = timestamp();
      const row = { id: randomUUID(), user_id: userId, kind: String(kind||'proposal').slice(0, 60), title, summary, payload_json: JSON.stringify(payload), status: 'pending', source_message_id: sourceMessageId, result_json: null, last_error: null, created_at: now, updated_at: now, reviewed_at: null };
      await run(`INSERT INTO approvals(id,user_id,kind,title,summary,payload_json,status,source_message_id,result_json,last_error,created_at,updated_at,reviewed_at)
        VALUES(?,?,?,?,?,?,'pending',?,NULL,NULL,?,?,NULL)`, row.id, row.user_id, row.kind, row.title, row.summary, row.payload_json, row.source_message_id, row.created_at, row.updated_at);
      return { ...row, payload };
    },
    async getApproval(userId, id) {
      const row = await get('SELECT * FROM approvals WHERE id=? AND user_id=?', id, userId);
      if (!row) return null;
      let payload = {}, result = null;
      try { payload = JSON.parse(row.payload_json || '{}'); } catch {}
      try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch {}
      return { ...row, payload, result };
    },
    async listApprovals(userId) {
      const rows = await all("SELECT * FROM approvals WHERE user_id=? ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 200", userId);
      return rows.map((row) => {
        let payload = {}, result = null;
        try { payload = JSON.parse(row.payload_json || '{}'); } catch {}
        try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch {}
        return { ...row, payload, result };
      });
    },
    async claimApproval(userId, id) {
      const at = timestamp();
      const staleBefore = new Date(Date.now() - 10*60_000).toISOString();
      if (!(await run("UPDATE approvals SET execution_started_at=?,updated_at=? WHERE id=? AND user_id=? AND status='pending' AND (execution_started_at IS NULL OR execution_started_at<=?)", at, at, id, userId, staleBefore)).changes) return null;
      return this.getApproval(userId, id);
    },
    async resolveApproval(userId, id, status, { result=null, error=null }={}) {
      if (!['executed','rejected','failed'].includes(status)) return null;
      const at = timestamp();
      if (!(await run("UPDATE approvals SET status=?,result_json=?,last_error=?,execution_started_at=NULL,reviewed_at=?,updated_at=? WHERE id=? AND user_id=? AND status='pending' AND execution_started_at IS NULL", status, result ? JSON.stringify(result) : null, error ? String(error).slice(0, 1000) : null, at, at, id, userId)).changes) return null;
      return this.getApproval(userId, id);
    },
    async finishApproval(userId, id, status, { result=null, error=null }={}) {
      if (!['executed','failed'].includes(status)) return null;
      const at = timestamp();
      if (!(await run("UPDATE approvals SET status=?,result_json=?,last_error=?,execution_started_at=NULL,reviewed_at=?,updated_at=? WHERE id=? AND user_id=? AND status='pending' AND execution_started_at IS NOT NULL", status, result ? JSON.stringify(result) : null, error ? String(error).slice(0, 1000) : null, at, at, id, userId)).changes) return null;
      return this.getApproval(userId, id);
    },

    // --- Proactive / nudges ---
    lastUserMessageAt: async (userId) => (await get("SELECT MAX(created_at) AS last_at FROM messages WHERE user_id=? AND role='user'", userId))?.last_at || null,
    getLastQuietNudgeAt: async (userId) => (await get('SELECT last_quiet_nudge_at FROM proactive_state WHERE user_id=?', userId))?.last_quiet_nudge_at || null,
    setLastQuietNudgeAt: async (userId, iso) => { await run(`INSERT INTO proactive_state(user_id,last_quiet_nudge_at) VALUES(?,?)
      ON CONFLICT(user_id) DO UPDATE SET last_quiet_nudge_at=excluded.last_quiet_nudge_at`, userId, iso); },
    getLastOutreachAt: async (userId) => (await get('SELECT * FROM proactive_state WHERE user_id=?', userId))?.last_outreach_at || null,
    async claimProactiveSlot(userId, localDate, limit=3) {
      const current = await get('SELECT * FROM proactive_state WHERE user_id=?', userId);
      if (current?.outreach_date === localDate && current.outreach_count >= limit) return false;
      await run(`INSERT INTO proactive_state(user_id,outreach_date,outreach_count) VALUES(?,?,1)
        ON CONFLICT(user_id) DO UPDATE SET outreach_date=excluded.outreach_date,
        outreach_count=CASE WHEN proactive_state.outreach_date=excluded.outreach_date THEN proactive_state.outreach_count+1 ELSE 1 END`, userId, localDate);
      return true;
    },
    markOutreach: async (userId) => (await run('UPDATE proactive_state SET last_outreach_at=? WHERE user_id=?', timestamp(), userId)).changes > 0,
    releaseProactiveSlot: async (userId, localDate) => (await run(`UPDATE proactive_state SET outreach_count=GREATEST(0,outreach_count-1)
      WHERE user_id=? AND outreach_date=? AND outreach_count>0`, userId, localDate)).changes > 0,

    // --- Preferences ---
    async getPreferences(userId) {
      const row = await get('SELECT * FROM user_preferences WHERE user_id=?', userId);
      if (row) return row;
      const now = timestamp();
      await run(upsertPreferencesSql, userId, 'America/New_York', '22:00', '08:00', 1, 'motivational', 'quick', now, now);
      return get('SELECT * FROM user_preferences WHERE user_id=?', userId);
    },
    async setPreferences(userId, value) {
      const current = await this.getPreferences(userId);
      const next = normalizePreferences(value, current);
      const now = timestamp();
      await run(upsertPreferencesSql, userId, next.timeZone, next.quietStart, next.quietEnd, next.proactiveEnabled ? 1 : 0, next.briefingTone, next.briefingLength, current.created_at || now, now);
      return get('SELECT * FROM user_preferences WHERE user_id=?', userId);
    },
    async setBuddyName(userId, name) {
      await this.getPreferences(userId);
      const clean = String(name||'').trim().slice(0, 40);
      if (!clean) throw new Error('Provide a name for your buddy (1-40 characters).');
      await run('UPDATE user_preferences SET buddy_name=?, updated_at=? WHERE user_id=?', clean, timestamp(), userId);
      return clean;
    },

    // --- People ---
    trackPersonMention: async (userId, personName) => {
      const name = String(personName||'').trim().slice(0, 80);
      if (!name) return null;
      const now = timestamp();
      await run(`INSERT INTO people_mentions(user_id,person_name,last_mentioned_at,last_nudged_at,dismissed,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,person_name) DO UPDATE SET last_mentioned_at=excluded.last_mentioned_at,
        dismissed=0,updated_at=excluded.updated_at`, userId, name, now, null, 0, now, now);
      return name;
    },
    async getStalePeople(userId, daysThreshold=14) {
      const nowMs = Date.now();
      const mentionedCutoff = new Date(nowMs - daysThreshold*86400_000).toISOString();
      const nudgeCutoff = new Date(nowMs - 30*86400_000).toISOString();
      return all(`SELECT person_name,last_mentioned_at,last_nudged_at FROM people_mentions
        WHERE user_id=? AND dismissed=0 AND last_mentioned_at<? AND (last_nudged_at IS NULL OR last_nudged_at<?)
        ORDER BY last_mentioned_at ASC`, userId, mentionedCutoff, nudgeCutoff);
    },
    dismissPersonNudge: async (userId, personName) => (await run('UPDATE people_mentions SET dismissed=1,updated_at=? WHERE user_id=? AND person_name=?', timestamp(), userId, personName)).changes > 0,
    markPersonNudged: async (userId, personName) => {
      const now = timestamp();
      return (await run('UPDATE people_mentions SET last_nudged_at=?,updated_at=? WHERE user_id=? AND person_name=?', now, now, userId, personName)).changes > 0;
    },
    listTrackedPeople: async (userId) => all('SELECT person_name,context_summary,sentiment,last_mentioned_at FROM people_mentions WHERE user_id=? AND dismissed=0 ORDER BY last_mentioned_at DESC', userId),
    getPersonContext: async (userId, personName) => (await get('SELECT context_summary,sentiment FROM people_mentions WHERE user_id=? AND person_name=?', userId, personName)) || null,
    updatePersonContext: async (userId, personName, contextSummary, sentiment) => {
      const now = timestamp();
      const sent = ['positive','neutral','mixed'].includes(String(sentiment).toLowerCase()) ? String(sentiment).toLowerCase() : 'neutral';
      return (await run('UPDATE people_mentions SET context_summary=?,sentiment=?,last_context_update=?,updated_at=? WHERE user_id=? AND person_name=?', String(contextSummary||'').slice(0, 500), sent, now, now, userId, personName)).changes > 0;
    },
    recentlyMentionedPeople: async (userId, sinceIso) => (await all('SELECT person_name FROM people_mentions WHERE user_id=? AND dismissed=0 AND last_mentioned_at>? ORDER BY last_mentioned_at DESC LIMIT 5', userId, sinceIso)).map((r) => r.person_name),

    // --- Curiosity gaps ---
    addCuriosityGap: async (userId, { question, context='', priority=2 }={}) => {
      const q = String(question||'').trim().slice(0, 300);
      if (q.length < 10) return null;
      const now = timestamp();
      const id = randomUUID();
      await run('INSERT INTO curiosity_gaps(id,user_id,question,context,priority,asked_at,dismissed,created_at) VALUES(?,?,?,?,?,?,?,?)', id, userId, q, String(context||'').slice(0, 300), Math.max(1, Math.min(Number(priority) || 2, 3)), null, 0, now);
      return id;
    },
    listCuriosityGaps: async (userId) => all('SELECT id,question,context,priority FROM curiosity_gaps WHERE user_id=? AND dismissed=0 AND asked_at IS NULL ORDER BY priority DESC,created_at ASC LIMIT 5', userId),
    markCuriosityGapAsked: async (userId, id) => (await run('UPDATE curiosity_gaps SET asked_at=? WHERE id=? AND user_id=?', timestamp(), id, userId)).changes > 0,

    // --- Profiles ---
    getMotivationProfile: async (userId) => (await get('SELECT * FROM motivation_profile WHERE user_id=?', userId)) || { user_id: userId, style: 'unknown', evidence: null, updated_at: null },
    setMotivationProfile: async (userId, style, evidence) => {
      const valid = ['encouragement','data-driven','tough-love','calm','unknown'];
      const st = valid.includes(String(style)) ? String(style) : 'unknown';
      await run(`INSERT INTO motivation_profile(user_id,style,evidence,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET style=excluded.style,evidence=excluded.evidence,updated_at=excluded.updated_at`, userId, st, String(evidence||'').slice(0, 500), timestamp());
      return st;
    },
    getEmotionalProfile: async (userId) => (await get('SELECT * FROM emotional_profile WHERE user_id=?', userId)) || { user_id: userId, support_style: 'unknown', energy_notes: null, evidence: null, updated_at: null },
    setEmotionalProfile: async (userId, style, energyNotes, evidence) => {
      const valid = ['solutions','listening','questions','humor','space','unknown'];
      const st = valid.includes(String(style)) ? String(style) : 'unknown';
      await run(`INSERT INTO emotional_profile(user_id,support_style,energy_notes,evidence,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET support_style=excluded.support_style,energy_notes=excluded.energy_notes,evidence=excluded.evidence,updated_at=excluded.updated_at`, userId, st, String(energyNotes||'').slice(0, 500), String(evidence||'').slice(0, 500), timestamp());
      return st;
    },

    // --- Memory queries ---
    listMemoriesBySource: async (userId, source, limit=20) => all("SELECT * FROM memories WHERE user_id=? AND source=? AND status='approved' ORDER BY updated_at DESC LIMIT ?", userId, String(source).slice(0, 40), Math.min(Math.max(limit, 1), 50)),
    async listMemoriesOnDate(userId, month, day) {
      const mm = String(month).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      const yyyy = String(new Date().getUTCFullYear());
      return (await all(`SELECT content,created_at FROM memories WHERE user_id=? AND status='approved'
        AND to_char(created_at::timestamp, 'MM')=? AND to_char(created_at::timestamp, 'DD')=? AND to_char(created_at::timestamp, 'YYYY')!=?
        ORDER BY created_at DESC LIMIT 5`, userId, mm, dd, yyyy)).map((row) => ({ ...row, year: row.created_at.slice(0, 4) }));
    },
    listMemoriesSince: async (userId, sinceISO) => all("SELECT * FROM memories WHERE user_id=? AND status='approved' AND created_at>=? ORDER BY created_at DESC", userId, sinceISO),

    // --- Streaks ---
    recordStreakCompletion: async (userId, itemType, itemId, dateStr) => (await run('INSERT INTO streak_completions(user_id,item_type,item_id,date,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING', userId, itemType, itemId, dateStr, timestamp())).changes > 0,
    // Count consecutive days with a completion, working backward from today (or yesterday if today has none).
    // dateStrs: array of YYYY-MM-DD strings, most recent first. timeZone-aware "today" passed in.
    async getStreak(userId, itemType, itemId, todayStr) {
      const rows = (await all('SELECT date FROM streak_completions WHERE user_id=? AND item_type=? AND item_id=? ORDER BY date DESC LIMIT 400', userId, itemType, itemId)).map((r) => r.date);
      return countConsecutiveDays(rows, todayStr);
    },
    // Goals use goal_checkins history directly (no separate streak table needed).
    async getGoalStreak(userId, goalId, todayStr) {
      const rows = (await all('SELECT DISTINCT substr(created_at,1,10) AS date FROM goal_checkins WHERE user_id=? AND goal_id=? ORDER BY date DESC LIMIT 400', userId, goalId)).map((r) => r.date);
      return countConsecutiveDays(rows, todayStr);
    },
    // One-time backfill: seed streak_completions for goals from existing checkin history.
    async backfillGoalStreaks(userId) {
      const goals = await all("SELECT * FROM goals WHERE user_id=? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,priority DESC,COALESCE(target_date,'9999-12-31'),updated_at DESC", userId);
      let seeded = 0;
      for (const g of goals) {
        const dates = await all('SELECT DISTINCT substr(created_at,1,10) AS date FROM goal_checkins WHERE user_id=? AND goal_id=? ORDER BY date DESC LIMIT 400', userId, g.id);
        for (const { date } of dates) {
          if ((await run('INSERT INTO streak_completions(user_id,item_type,item_id,date,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING', userId, 'goal', g.id, date, timestamp())).changes > 0) seeded++;
        }
      }
      return seeded;
    },

    // --- Timeline ---
    listTasksCompletedSince: async (userId, sinceISO) => all("SELECT * FROM tasks WHERE user_id=? AND status='completed' AND updated_at>=? ORDER BY updated_at DESC", userId, sinceISO),
    listGoalCheckinsSince: async (userId, sinceISO) => all(`SELECT gc.*, g.title AS goal_title FROM goal_checkins gc JOIN goals g ON g.id=gc.goal_id
      WHERE gc.user_id=? AND gc.created_at>=? ORDER BY gc.created_at DESC`, userId, sinceISO),
    getTimelineNarrative: async (userId, monthKey) => {
      const row = await get('SELECT narrative, generated_at FROM timeline_cache WHERE user_id=? AND month_key=?', userId, monthKey);
      return row ? row.narrative : null;
    },
    setTimelineNarrative: async (userId, monthKey, narrative) => {
      await run(`INSERT INTO timeline_cache(user_id,month_key,narrative,generated_at) VALUES(?,?,?,?)
        ON CONFLICT(user_id,month_key) DO UPDATE SET narrative=excluded.narrative, generated_at=excluded.generated_at`, userId, monthKey, narrative, timestamp());
    },
    async timelineMonthData(userId, monthKey) {
      return {
        memories: await all("SELECT content, kind FROM memories WHERE user_id=? AND status='approved' AND substr(created_at,1,7)=? ORDER BY created_at DESC LIMIT 8", userId, monthKey),
        conversations: await all('SELECT c.title FROM conversations c WHERE c.user_id=? AND substr(c.created_at,1,7)=? AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id) ORDER BY c.created_at DESC LIMIT 12', userId, monthKey),
        goalsCreated: await all('SELECT title FROM goals WHERE user_id=? AND substr(created_at,1,7)=? LIMIT 10', userId, monthKey),
        goalsCompleted: await all("SELECT title FROM goals WHERE user_id=? AND status='completed' AND completed_at IS NOT NULL AND substr(completed_at,1,7)=? LIMIT 10", userId, monthKey),
        checkins: Number((await get('SELECT COUNT(*) AS n FROM goal_checkins WHERE user_id=? AND substr(created_at,1,7)=?', userId, monthKey)).n),
      };
    },

    // --- Conversation summaries ---
    getConversationSummary: async (userId, conversationId) => (await get('SELECT * FROM conversation_summaries WHERE conversation_id=? AND user_id=?', conversationId, userId)) || null,
    async setConversationSummary(userId, conversationId, summary, messageCount) {
      await run(`INSERT INTO conversation_summaries(conversation_id,user_id,summary,message_count,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET summary=excluded.summary,message_count=excluded.message_count,updated_at=excluded.updated_at`,
        conversationId, userId, summary, messageCount, timestamp());
      return get('SELECT * FROM conversation_summaries WHERE conversation_id=? AND user_id=?', conversationId, userId);
    },
    countConversationMessages: async (userId, conversationId) => Number((await get('SELECT COUNT(*) AS count FROM messages WHERE conversation_id=? AND user_id=?', conversationId, userId)).count),

    // --- Tasks ---
    async addTask(userId, { title, prompt, risk='internal', scheduleAt=null, recurrence='none' }) {
      const now = timestamp();
      const status = risk === 'external' ? 'waiting_approval' : scheduleAt ? 'scheduled' : 'queued';
      const row = { id: randomUUID(), user_id: userId, title, prompt, status, risk, schedule_at: scheduleAt, recurrence, result: null, created_at: now, updated_at: now };
      await run(`INSERT INTO tasks(id,user_id,title,prompt,status,risk,schedule_at,recurrence,result,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,NULL,?,?)`, row.id, row.user_id, row.title, row.prompt, row.status, row.risk, row.schedule_at, row.recurrence, row.created_at, row.updated_at);
      return row;
    },
    listTasks: async (userId) => all('SELECT * FROM tasks WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 200', userId),
    getTask: async (userId, id) => get('SELECT * FROM tasks WHERE id=? AND user_id=?', id, userId),
    setTaskStatus: async (userId, id, status) => (await run('UPDATE tasks SET status=?,updated_at=? WHERE id=? AND user_id=?', status, timestamp(), id, userId)).changes > 0,
    deleteTask: async (userId, id) => (await run('DELETE FROM tasks WHERE id=? AND user_id=?', id, userId)).changes > 0,
    startTask: async (userId, id, leaseMs=2*60_000) => (await run("UPDATE tasks SET status='running',attempt_count=attempt_count+1,lease_expires_at=?,last_error=NULL,updated_at=? WHERE id=? AND user_id=? AND status IN ('queued','scheduled')", new Date(Date.now()+leaseMs).toISOString(), timestamp(), id, userId)).changes > 0,
    recoverStaleTasks: async () => {
      const current = timestamp();
      return (await run("UPDATE tasks SET status=CASE WHEN schedule_at IS NULL OR schedule_at<=? THEN 'queued' ELSE 'scheduled' END,lease_expires_at=NULL,updated_at=? WHERE status='running' AND (lease_expires_at IS NULL OR lease_expires_at<=?)", current, current, current)).changes;
    },
    completeTask: async (userId, id, result, status='completed', scheduleAt=null) => (await run('UPDATE tasks SET status=?,result=?,schedule_at=?,lease_expires_at=NULL,last_error=NULL,updated_at=? WHERE id=? AND user_id=?', status, result, scheduleAt, timestamp(), id, userId)).changes > 0,
    failTask: async (userId, id, message, error) => (await run("UPDATE tasks SET status='failed',result=?,schedule_at=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=? AND user_id=?", message, String(error||'').slice(0, 1000), timestamp(), id, userId)).changes > 0,
    dueTasks: async () => all(`SELECT * FROM tasks WHERE status IN ('queued','scheduled')
      AND (schedule_at IS NULL OR schedule_at<=?) ORDER BY COALESCE(schedule_at,created_at),id LIMIT 10`, timestamp()),

    // --- Calendar feeds ---
    async addCalendarFeed(userId, { label, url }) {
      const now = timestamp();
      const row = { id: randomUUID(), user_id: userId, label, url, created_at: now, updated_at: now };
      await run(`INSERT INTO calendar_feeds(id,user_id,label,url,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`, row.id, row.user_id, row.label, protectSecret(row.url), row.created_at, row.updated_at);
      return row;
    },
    listCalendarFeeds: async (userId) => (await all('SELECT * FROM calendar_feeds WHERE user_id=? ORDER BY LOWER(label)', userId)).map((row) => ({ ...row, url: revealSecret(row.url) })),
    deleteCalendarFeed: async (userId, id) => (await run('DELETE FROM calendar_feeds WHERE id=? AND user_id=?', id, userId)).changes > 0,

    // --- Events ---
    addEvent: async (userId, type, message, detail=null) => {
      const row = { id: randomUUID(), user_id: userId, type, message, detail, created_at: timestamp() };
      await run('INSERT INTO events(id,user_id,type,message,detail,created_at) VALUES (?, ?, ?, ?, ?, ?)', row.id, row.user_id, row.type, row.message, row.detail, row.created_at);
      return row;
    },
    listEvents: async (userId, limit=80) => all('SELECT * FROM events WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ?', userId, Math.min(Math.max(limit, 1), 200)),
    countToolUseSince: async (toolName, since) => Number((await get("SELECT COUNT(*) AS n FROM events WHERE type='tool_use' AND message LIKE ? AND created_at>=?", `Used ${toolName}%`, since)).n),

    // --- Artifacts ---
    async addArtifact(userId, { taskId=null, name, mimeType='text/markdown', content }) {
      const now = timestamp();
      const size = Buffer.byteLength(content);
      const row = { id: randomUUID(), user_id: userId, task_id: taskId, name, mime_type: mimeType, content, size_bytes: size, created_at: now };
      await run('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?)', row.id, row.user_id, row.task_id, row.name, row.mime_type, row.content, row.size_bytes, row.created_at);
      return row;
    },
    listArtifacts: async (userId) => all('SELECT id,task_id,name,mime_type,size_bytes,created_at FROM artifacts WHERE user_id=? ORDER BY created_at DESC LIMIT 200', userId),
    getArtifact: async (userId, id) => get('SELECT * FROM artifacts WHERE id=? AND user_id=?', id, userId),

    // --- Push subscriptions ---
    savePush: async (userId, { endpoint, keys }) => {
      await run(`INSERT INTO push_subscriptions VALUES(?,?,?,?,?,?)
        ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth`, randomUUID(), userId, endpoint, keys.p256dh, keys.auth, timestamp());
    },
    listPush: async (userId) => all('SELECT * FROM push_subscriptions WHERE user_id=?', userId),
    deletePush: async (userId, endpoint) => { await run('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?', endpoint, userId); },
    deletePushById: async (id) => { await run('DELETE FROM push_subscriptions WHERE id=?', id); },

    // --- Connectors ---
    saveConnector: async (userId, provider, data) => {
      const now = timestamp();
      await run(`INSERT INTO connectors VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id,provider) DO UPDATE SET access_encrypted=excluded.access_encrypted,
        refresh_encrypted=excluded.refresh_encrypted,scopes=excluded.scopes,expires_at=excluded.expires_at,
        profile_json=excluded.profile_json,updated_at=excluded.updated_at`,
        data.id || randomUUID(), userId, provider, data.accessEncrypted, data.refreshEncrypted || null, data.scopes || '', data.expiresAt || null, JSON.stringify(data.profile || {}), now, now);
    },
    listConnectors: async (userId) => all('SELECT id,provider,scopes,expires_at,profile_json,created_at,updated_at FROM connectors WHERE user_id=?', userId),
    getConnector: async (userId, provider) => get('SELECT * FROM connectors WHERE user_id=? AND provider=?', userId, provider),
    deleteConnector: async (userId, provider) => (await run('DELETE FROM connectors WHERE user_id=? AND provider=?', userId, provider)).changes > 0,

    // --- OAuth states ---
    addOauthState: async (row) => { await run('INSERT INTO oauth_states VALUES(?,?,?,?,?,?)', row.stateHash, row.userId, row.provider, row.codeVerifier || null, row.redirectUri, row.expiresAt); },
    async consumeOauthState(hash) {
      const row = await get('SELECT * FROM oauth_states WHERE state_hash=? AND expires_at>?', hash, timestamp());
      if (row) await run('DELETE FROM oauth_states WHERE state_hash=?', hash);
      return row;
    },

    // --- Access requests ---
    async addAccessRequest({ name, email, note }) {
      const id = randomUUID();
      await run('INSERT INTO access_requests VALUES (?, ?, ?, ?, ?, NULL)', id, name, email, note || null, timestamp());
      return get('SELECT * FROM access_requests WHERE id=?', id);
    },
    getAccessRequest: async (id) => get('SELECT * FROM access_requests WHERE id=?', id),
    listAccessRequests: async () => all('SELECT * FROM access_requests ORDER BY created_at DESC,id DESC LIMIT 100'),
    dismissAccessRequest: async (id) => (await run('UPDATE access_requests SET handled_at=? WHERE id=? AND handled_at IS NULL', timestamp(), id)).changes > 0,

    // --- Door tokens ---
    addDoorToken: async (tokenHash, expiresAt) => { await run('INSERT INTO door_tokens VALUES (?, ?, NULL, ?)', tokenHash, expiresAt, timestamp()); },
    async consumeDoorToken(tokenHash) {
      const row = await get('SELECT * FROM door_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?', tokenHash, timestamp());
      if (row) await run('UPDATE door_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL', timestamp(), tokenHash);
      return row;
    },
    pruneDoorTokens: async () => { await run('DELETE FROM door_tokens WHERE expires_at<=? OR used_at IS NOT NULL', timestamp()); },

    // --- Export / restore ---
    async exportUser(userId) {
      const artifactIds = await all('SELECT id FROM artifacts WHERE user_id=? ORDER BY created_at DESC LIMIT 200', userId);
      const artifacts = [];
      for (const a of artifactIds) artifacts.push(await get('SELECT * FROM artifacts WHERE id=? AND user_id=?', a.id, userId));
      return {
        version: 5, exportedAt: timestamp(),
        user: await get('SELECT * FROM users WHERE id = ?', userId),
        conversations: await all('SELECT * FROM conversations WHERE user_id=? ORDER BY updated_at DESC,id DESC', userId),
        messages: (await all('SELECT * FROM messages WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ?', userId, 20000)).reverse(),
        memories: await all("SELECT * FROM memories WHERE user_id=? AND status='approved' ORDER BY updated_at DESC,id DESC LIMIT 100", userId),
        memorySuggestions: await all('SELECT * FROM memory_suggestions WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 50', userId),
        followUps: await all("SELECT * FROM follow_ups WHERE user_id=? AND status='scheduled' ORDER BY priority DESC,due_date,created_at", userId),
        goals: await all("SELECT * FROM goals WHERE user_id=? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,priority DESC,COALESCE(target_date,'9999-12-31'),updated_at DESC", userId),
        goalCheckins: await all('SELECT * FROM goal_checkins WHERE user_id=? ORDER BY created_at', userId),
        routines: await all('SELECT * FROM routines WHERE user_id=? ORDER BY enabled DESC,time_local,LOWER(title)', userId),
        projects: await all("SELECT * FROM projects WHERE user_id=? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,priority DESC,COALESCE(target_date,'9999-12-31'),updated_at DESC", userId),
        projectSteps: await all('SELECT * FROM project_steps WHERE user_id=? ORDER BY project_id,position,created_at', userId),
        approvals: await all("SELECT * FROM approvals WHERE user_id=? ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 200", userId),
        preferences: await this.getPreferences(userId),
        conversationSummaries: await all('SELECT * FROM conversation_summaries WHERE user_id=?', userId),
        calendarFeeds: await this.listCalendarFeeds(userId),
        tasks: await all('SELECT * FROM tasks WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 200', userId),
        events: await all('SELECT * FROM events WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ?', userId, 20000),
        artifacts,
      };
    },
    async restoreUser(userId, bundle) {
      if (!bundle || ![2,3,4,5].includes(bundle.version)) throw Object.assign(new Error('Backup version is not supported.'), { status: 400 });
      await withTransaction(async ({ run: tRun, get: tGet }) => {
        for (const row of bundle.conversations || []) await tRun('INSERT INTO conversations(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING', row.id, userId, row.title, row.created_at, row.updated_at);
        for (const row of bundle.messages || []) await tRun('INSERT INTO messages(id,user_id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING', row.id, userId, row.conversation_id || null, row.role, row.content, row.created_at);
        for (const row of bundle.memories || []) await tRun(`INSERT INTO memories(id,user_id,content,created_at,updated_at,kind,source,status,confidence,expires_at,last_confirmed_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`, row.id, userId, row.content, row.created_at, row.updated_at, normalizeMemoryKind(row.kind), row.source || 'backup', row.status || 'approved', row.confidence ?? 1, row.expires_at || null, row.last_confirmed_at || row.updated_at);
        for (const row of bundle.memorySuggestions || []) await tRun('INSERT INTO memory_suggestions(id,user_id,content,created_at,kind,confidence) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING', row.id, userId, row.content, row.created_at, normalizeMemoryKind(row.kind), row.confidence ?? 0.7);
        for (const row of bundle.followUps || []) await tRun('INSERT INTO follow_ups(id,user_id,description,due_date,status,priority,source_message_id,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING', row.id, userId, row.description, row.due_date, row.status || 'scheduled', normalizePriority(row.priority), row.source_message_id || null, row.created_at, row.completed_at || null);
        for (const row of bundle.goals || []) await tRun('INSERT INTO goals(id,user_id,title,description,status,priority,progress,target_date,next_step,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING', row.id, userId, row.title, row.description || null, row.status || 'active', normalizePriority(row.priority), Math.max(0, Math.min(Number(row.progress) || 0, 100)), row.target_date || null, row.next_step || null, row.created_at, row.updated_at, row.completed_at || null);
        for (const row of bundle.goalCheckins || []) await tRun('INSERT INTO goal_checkins(id,goal_id,user_id,progress,note,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING', row.id, row.goal_id, userId, row.progress, row.note || null, row.created_at);
        for (const row of bundle.routines || []) await tRun('INSERT INTO routines(id,user_id,title,prompt,kind,cadence,time_local,day_of_week,enabled,last_run_date,last_run_at,lease_date,lease_expires_at,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING', row.id, userId, row.title, row.prompt, row.kind || 'custom', row.cadence || 'daily', validTimeString(row.time_local, '09:00'), row.day_of_week ?? null, row.enabled === 0 ? 0 : 1, row.last_run_date || null, row.last_run_at || null, null, null, row.last_error || null, row.created_at, row.updated_at);
        for (const row of bundle.projects || []) await tRun('INSERT INTO projects(id,user_id,title,description,status,priority,target_date,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING', row.id, userId, row.title, row.description || null, ['active','paused','completed'].includes(row.status) ? row.status : 'active', normalizePriority(row.priority), row.target_date || null, row.created_at, row.updated_at, row.completed_at || null);
        for (const row of bundle.projectSteps || []) await tRun('INSERT INTO project_steps(id,project_id,user_id,title,details,status,position,due_date,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING', row.id, row.project_id, userId, row.title, row.details || null, ['planned','in_progress','blocked','completed'].includes(row.status) ? row.status : 'planned', Number(row.position) || 0, row.due_date || null, row.created_at, row.updated_at, row.completed_at || null);
        for (const row of bundle.approvals || []) await tRun('INSERT INTO approvals(id,user_id,kind,title,summary,payload_json,status,source_message_id,result_json,last_error,created_at,updated_at,reviewed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING', row.id, userId, row.kind, row.title, row.summary, row.payload_json || '{}', ['pending','executed','rejected','failed'].includes(row.status) ? row.status : 'pending', row.source_message_id || null, row.result_json || null, row.last_error || null, row.created_at, row.updated_at, row.reviewed_at || null);
        for (const row of bundle.conversationSummaries || []) await tRun('INSERT INTO conversation_summaries(conversation_id,user_id,summary,message_count,updated_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING', row.conversation_id, userId, row.summary, row.message_count, row.updated_at);
        for (const row of bundle.calendarFeeds || []) await tRun('INSERT INTO calendar_feeds(id,user_id,label,url,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING', row.id, userId, row.label, protectSecret(row.url), row.created_at, row.updated_at);
        for (const row of bundle.tasks || []) await tRun(`INSERT INTO tasks(id,user_id,title,prompt,status,risk,schedule_at,recurrence,result,created_at,updated_at,attempt_count,lease_expires_at,last_error)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`, row.id, userId, row.title, row.prompt, row.status, row.risk, row.schedule_at, row.recurrence, row.result, row.created_at, row.updated_at, row.attempt_count || 0, row.lease_expires_at || null, row.last_error || null);
        for (const row of bundle.events || []) await tRun('INSERT INTO events(id,user_id,type,message,detail,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING', row.id, userId, row.type, row.message, row.detail, row.created_at);
        for (const row of bundle.artifacts || []) await tRun('INSERT INTO artifacts(id,user_id,task_id,name,mime_type,content,size_bytes,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING', row.id, userId, row.task_id, row.name, row.mime_type, row.content, row.size_bytes, row.created_at);
        if (bundle.preferences) {
          const p = normalizePreferences(bundle.preferences);
          const current = await tGet('SELECT * FROM user_preferences WHERE user_id=?', userId);
          const created = current?.created_at || timestamp();
          await tRun(upsertPreferencesSql, userId, p.timeZone, p.quietStart, p.quietEnd, p.proactiveEnabled ? 1 : 0, p.briefingTone, p.briefingLength, created, timestamp());
        }
      });
    },

    _pool: pool, // exposed for testing
  };
}
