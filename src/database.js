import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const timestamp = () => new Date().toISOString();

function ensureColumn(db, table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
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

export function openDatabase(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  const db = new DatabaseSync(filePath);
  fs.chmodSync(filePath, 0o600);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
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
    CREATE TABLE IF NOT EXISTS automation_tokens (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL,
      created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proactive_state (
      user_id TEXT PRIMARY KEY, last_quiet_nudge_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(status, schedule_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at);
  `);

  // Upgrade v0.1 databases in place without discarding user data.
  ensureColumn(db, 'messages', 'user_id', 'TEXT');
  ensureColumn(db, 'messages', 'conversation_id', 'TEXT');
  for (const row of db.prepare('SELECT DISTINCT user_id FROM messages WHERE conversation_id IS NULL AND user_id IS NOT NULL').all()) adoptOrphanMessages(db, row.user_id);
  ensureColumn(db, 'memories', 'user_id', 'TEXT');
  ensureColumn(db, 'tasks', 'user_id', 'TEXT');
  ensureColumn(db, 'events', 'user_id', 'TEXT');

  const s = {
    countUsers: db.prepare('SELECT COUNT(*) AS count FROM users'),
    listUsers: db.prepare('SELECT id,email,display_name,role,disabled,created_at,updated_at FROM users ORDER BY created_at'),
    createUser: db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    updatePassword: db.prepare('UPDATE users SET password_hash=?, password_salt=?, updated_at=? WHERE id=?'),
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
    addMemory: db.prepare('INSERT INTO memories(id,user_id,content,created_at,updated_at) VALUES (?, ?, ?, ?, ?)'),
    listMemories: db.prepare('SELECT * FROM memories WHERE user_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 100'),
    deleteMemory: db.prepare('DELETE FROM memories WHERE id=? AND user_id=?'),
    lastUserMessage: db.prepare("SELECT MAX(created_at) AS last_at FROM messages WHERE user_id=? AND role='user'"),
    getQuietNudge: db.prepare('SELECT last_quiet_nudge_at FROM proactive_state WHERE user_id=?'),
    setQuietNudge: db.prepare(`INSERT INTO proactive_state(user_id,last_quiet_nudge_at) VALUES(?,?)
      ON CONFLICT(user_id) DO UPDATE SET last_quiet_nudge_at=excluded.last_quiet_nudge_at`),
    addTask: db.prepare(`INSERT INTO tasks(id,user_id,title,prompt,status,risk,schedule_at,recurrence,result,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,NULL,?,?)`),
    listTasks: db.prepare('SELECT * FROM tasks WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200'),
    getTask: db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?'),
    updateTask: db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=? AND user_id=?'),
    completeTask: db.prepare('UPDATE tasks SET status=?,result=?,schedule_at=?,updated_at=? WHERE id=? AND user_id=?'),
    dueTasks: db.prepare(`SELECT * FROM tasks WHERE status IN ('queued','scheduled')
      AND (schedule_at IS NULL OR schedule_at<=?) ORDER BY COALESCE(schedule_at,created_at),rowid LIMIT 10`),
    addEvent: db.prepare('INSERT INTO events(id,user_id,type,message,detail,created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    listEvents: db.prepare('SELECT * FROM events WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?'),
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
    addAutomation: db.prepare(`INSERT INTO automation_tokens
      (id,user_id,label,token_hash,scopes,created_at,last_used_at,revoked_at)
      VALUES(?,?,?,?,?,?,NULL,NULL)`),
    listAutomation: db.prepare('SELECT id,label,scopes,created_at,last_used_at,revoked_at FROM automation_tokens WHERE user_id=? ORDER BY created_at DESC'),
    automation: db.prepare('SELECT * FROM automation_tokens WHERE token_hash=? AND revoked_at IS NULL'),
    touchAutomation: db.prepare('UPDATE automation_tokens SET last_used_at=? WHERE id=?'),
    revokeAutomation: db.prepare('UPDATE automation_tokens SET revoked_at=? WHERE id=? AND user_id=?')
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
    getUserByEmail: (email) => s.userByEmail.get(email),
    getUserById: (id) => s.userById.get(id),
    updatePassword(id, passwordHash, passwordSalt) { s.updatePassword.run(passwordHash, passwordSalt, timestamp(), id); },
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
    addMemory(userId, content) { const now=timestamp(); const row={id:randomUUID(),user_id:userId,content,created_at:now,updated_at:now}; s.addMemory.run(row.id,row.user_id,row.content,row.created_at,row.updated_at); return row; },
    listMemories: (userId) => s.listMemories.all(userId),
    deleteMemory: (userId,id) => s.deleteMemory.run(id,userId).changes>0,
    lastUserMessageAt: (userId) => s.lastUserMessage.get(userId)?.last_at || null,
    getLastQuietNudgeAt: (userId) => s.getQuietNudge.get(userId)?.last_quiet_nudge_at || null,
    setLastQuietNudgeAt: (userId,iso) => s.setQuietNudge.run(userId,iso),
    addTask(userId,{title,prompt,risk='internal',scheduleAt=null,recurrence='none'}) {
      const now=timestamp(); const status=risk==='external'?'waiting_approval':scheduleAt?'scheduled':'queued';
      const row={id:randomUUID(),user_id:userId,title,prompt,status,risk,schedule_at:scheduleAt,recurrence,result:null,created_at:now,updated_at:now};
      s.addTask.run(row.id,row.user_id,row.title,row.prompt,row.status,row.risk,row.schedule_at,row.recurrence,row.created_at,row.updated_at); return row;
    },
    listTasks: (userId) => s.listTasks.all(userId),
    getTask: (userId,id) => s.getTask.get(id,userId),
    setTaskStatus: (userId,id,status) => s.updateTask.run(status,timestamp(),id,userId).changes>0,
    completeTask: (userId,id,result,status='completed',scheduleAt=null) => s.completeTask.run(status,result,scheduleAt,timestamp(),id,userId).changes>0,
    dueTasks: () => s.dueTasks.all(timestamp()),
    addEvent(userId,type,message,detail=null) { const row={id:randomUUID(),user_id:userId,type,message,detail,created_at:timestamp()}; s.addEvent.run(row.id,row.user_id,row.type,row.message,row.detail,row.created_at); return row; },
    listEvents: (userId,limit=80) => s.listEvents.all(userId,Math.min(Math.max(limit,1),200)),
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
    addAutomationToken(userId,{label,tokenHash,scopes}) { const id=randomUUID(); s.addAutomation.run(id,userId,label,tokenHash,scopes,timestamp()); return {id,label,scopes}; },
    listAutomationTokens: (userId) => s.listAutomation.all(userId),
    getAutomationToken(hash) { const row=s.automation.get(hash); if(row) s.touchAutomation.run(timestamp(),row.id); return row; },
    revokeAutomationToken: (userId,id) => s.revokeAutomation.run(timestamp(),id,userId).changes>0,
    exportUser(userId) { return {version:2,exportedAt:timestamp(),user:s.userById.get(userId),conversations:s.listConversations.all(userId),messages:s.listMessages.all(userId,20000).reverse(),memories:s.listMemories.all(userId),tasks:s.listTasks.all(userId),events:s.listEvents.all(userId,20000),artifacts:s.listArtifacts.all(userId).map((a)=>s.getArtifact.get(a.id,userId))}; },
    restoreUser(userId, bundle) {
      if (!bundle || bundle.version !== 2) throw Object.assign(new Error('Backup version is not supported.'), { status: 400 });
      const inserts = {
        conversation: db.prepare('INSERT OR IGNORE INTO conversations(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)'),
        message: db.prepare('INSERT OR IGNORE INTO messages(id,user_id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?,?)'),
        memory: db.prepare('INSERT OR IGNORE INTO memories(id,user_id,content,created_at,updated_at) VALUES(?,?,?,?,?)'),
        task: db.prepare('INSERT OR IGNORE INTO tasks(id,user_id,title,prompt,status,risk,schedule_at,recurrence,result,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)'),
        event: db.prepare('INSERT OR IGNORE INTO events(id,user_id,type,message,detail,created_at) VALUES(?,?,?,?,?,?)'),
        artifact: db.prepare('INSERT OR IGNORE INTO artifacts(id,user_id,task_id,name,mime_type,content,size_bytes,created_at) VALUES(?,?,?,?,?,?,?,?)')
      };
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of bundle.conversations || []) inserts.conversation.run(row.id,userId,row.title,row.created_at,row.updated_at);
        for (const row of bundle.messages || []) inserts.message.run(row.id,userId,row.conversation_id||null,row.role,row.content,row.created_at);
        for (const row of bundle.memories || []) inserts.memory.run(row.id,userId,row.content,row.created_at,row.updated_at);
        for (const row of bundle.tasks || []) inserts.task.run(row.id,userId,row.title,row.prompt,row.status,row.risk,row.schedule_at,row.recurrence,row.result,row.created_at,row.updated_at);
        for (const row of bundle.events || []) inserts.event.run(row.id,userId,row.type,row.message,row.detail,row.created_at);
        for (const row of bundle.artifacts || []) inserts.artifact.run(row.id,userId,row.task_id,row.name,row.mime_type,row.content,row.size_bytes,row.created_at);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
}
