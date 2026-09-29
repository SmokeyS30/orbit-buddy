import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { openDatabase } from './src/database.js';
import { createModelClient } from './src/model.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(root, 'public');
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json'
};

function secureEqual(actual, expected) {
  const left = Buffer.from(actual || '');
  const right = Buffer.from(expected || '');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }); }
}

function cleanText(value, max, field) {
  if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error(`${field} is required.`), { status: 400 });
  return value.trim().slice(0, max);
}

function nextRun(recurrence, previous) {
  if (recurrence === 'none') return null;
  const date = previous ? new Date(previous) : new Date();
  date.setUTCDate(date.getUTCDate() + (recurrence === 'weekly' ? 7 : 1));
  while (date <= new Date()) date.setUTCDate(date.getUTCDate() + (recurrence === 'weekly' ? 7 : 1));
  return date.toISOString();
}

export function createOrbitServer(options = {}) {
  const env = options.env || process.env;
  const buddyName = env.BUDDY_NAME?.trim().slice(0, 40) || 'Orbit';
  const dataDir = path.resolve(options.dataDir || env.DATA_DIR || path.join(root, 'data'));
  const db = openDatabase(options.dbPath || path.join(dataDir, 'orbit.sqlite'));
  const model = createModelClient(env);
  let accessToken = env.BUDDY_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    if (env.NODE_ENV === 'production') throw new Error('BUDDY_ACCESS_TOKEN is required in production.');
    accessToken = randomBytes(24).toString('hex');
  }
  if (env.NODE_ENV === 'production' && accessToken.length < 24) {
    throw new Error('BUDDY_ACCESS_TOKEN must contain at least 24 characters in production.');
  }

  const attempts = new Map();
  const limited = (req) => {
    const key = req.socket.remoteAddress || 'unknown';
    const timestamp = Date.now();
    const recent = (attempts.get(key) || []).filter((time) => timestamp - time < 60_000);
    recent.push(timestamp);
    attempts.set(key, recent);
    return recent.length > 120;
  };

  let workerBusy = false;
  async function runDueTasks() {
    if (workerBusy) return;
    workerBusy = true;
    try {
      for (const task of db.dueTasks()) {
        db.setTaskStatus(task.id, 'running');
        db.addEvent('task_started', `Started “${task.title}”.`);
        try {
          const result = await model.respond({
            buddyName, message: task.prompt, memories: db.listMemories(), history: [], taskMode: true
          });
          const following = nextRun(task.recurrence, task.schedule_at);
          db.completeTask(task.id, result, following ? 'scheduled' : 'completed', following);
          db.addEvent('task_completed', `Completed “${task.title}”.`);
        } catch (error) {
          db.completeTask(task.id, error.message, 'failed', null);
          db.addEvent('task_failed', `Could not complete “${task.title}”.`, error.message);
        }
      }
    } finally { workerBusy = false; }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");

    if (limited(req)) return json(res, 429, { error: 'Too many requests. Try again shortly.' });
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, service: 'orbit-buddy' });

    if (url.pathname.startsWith('/api/')) {
      const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!secureEqual(bearer, accessToken)) return json(res, 401, { error: 'Authentication required.' });
      try {
        if (req.method === 'GET' && url.pathname === '/api/status') {
          return json(res, 200, { buddyName, model: model.model, modelConfigured: model.configured, version: '0.1.0' });
        }
        if (req.method === 'GET' && url.pathname === '/api/snapshot') {
          return json(res, 200, {
            messages: db.listMessages(), memories: db.listMemories(),
            tasks: db.listTasks(), events: db.listEvents()
          });
        }
        if (req.method === 'POST' && url.pathname === '/api/chat') {
          const body = await readJson(req);
          const message = cleanText(body.message, 6000, 'message');
          const history = db.listMessages(20);
          db.addMessage('user', message);
          const answer = await model.respond({
            buddyName, message, memories: db.listMemories(), history
          });
          const saved = db.addMessage('assistant', answer);
          db.addEvent('chat', 'Orbit replied to a message.');
          return json(res, 201, saved);
        }
        if (req.method === 'POST' && url.pathname === '/api/memories') {
          const body = await readJson(req);
          const memory = db.addMemory(cleanText(body.content, 2000, 'content'));
          db.addEvent('memory_added', 'Saved a user-approved memory.');
          return json(res, 201, memory);
        }
        const memoryMatch = url.pathname.match(/^\/api\/memories\/([0-9a-f-]+)$/);
        if (req.method === 'DELETE' && memoryMatch) {
          const removed = db.deleteMemory(memoryMatch[1]);
          if (!removed) return json(res, 404, { error: 'Memory not found.' });
          db.addEvent('memory_deleted', 'Deleted a memory.');
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/tasks') {
          const body = await readJson(req);
          const risk = body.risk === 'external' ? 'external' : 'internal';
          const recurrence = ['daily', 'weekly'].includes(body.recurrence) ? body.recurrence : 'none';
          let scheduleAt = null;
          if (body.scheduleAt) {
            const date = new Date(body.scheduleAt);
            if (Number.isNaN(date.valueOf())) throw Object.assign(new Error('scheduleAt must be a valid date.'), { status: 400 });
            scheduleAt = date.toISOString();
          }
          const task = db.addTask({
            title: cleanText(body.title, 120, 'title'),
            prompt: cleanText(body.prompt, 6000, 'prompt'), risk, scheduleAt, recurrence
          });
          db.addEvent('task_created', `Created “${task.title}”.`, risk === 'external' ? 'Waiting for approval.' : null);
          return json(res, 201, task);
        }
        const taskMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/(approve|cancel)$/);
        if (req.method === 'POST' && taskMatch) {
          const task = db.getTask(taskMatch[1]);
          if (!task) return json(res, 404, { error: 'Task not found.' });
          const action = taskMatch[2];
          const status = action === 'approve' ? (task.schedule_at ? 'scheduled' : 'queued') : 'cancelled';
          db.setTaskStatus(task.id, status);
          db.addEvent(`task_${action}d`, `${action === 'approve' ? 'Approved' : 'Cancelled'} “${task.title}”.`);
          if (action === 'approve') setImmediate(runDueTasks);
          return json(res, 200, { ...task, status });
        }
        return json(res, 404, { error: 'API route not found.' });
      } catch (error) {
        return json(res, error.status || 500, { error: error.status ? error.message : 'Request failed safely.' });
      }
    }

    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
    const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const resolved = path.resolve(publicRoot, `.${decodeURIComponent(requestPath)}`);
    if (!resolved.startsWith(`${publicRoot}${path.sep}`)) return json(res, 404, { error: 'Not found.' });
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) throw new Error('Not a file');
      res.writeHead(200, {
        'Content-Type': mimeTypes[path.extname(resolved)] || 'application/octet-stream',
        'Cache-Control': path.basename(resolved) === 'index.html' ? 'no-cache' : 'public, max-age=3600'
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(resolved).pipe(res);
    } catch { json(res, 404, { error: 'Not found.' }); }
  });

  const intervalMs = Math.max(Number(env.TASK_POLL_MS) || 15_000, 5_000);
  let timer;
  return {
    server, accessToken, db,
    startWorker() { timer = setInterval(runDueTasks, intervalMs); timer.unref(); setImmediate(runDueTasks); },
    async close() { if (timer) clearInterval(timer); await new Promise((resolve) => server.close(resolve)); db.close(); }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createOrbitServer();
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  app.server.listen(port, host, () => {
    app.startWorker();
    console.log(`Orbit Buddy is ready at http://${host}:${port}`);
    if (!process.env.BUDDY_ACCESS_TOKEN) console.log(`Development access token: ${app.accessToken}`);
  });
}
