// Synchronous wrapper around async PostgreSQL adapter (ES module)
// Uses worker thread + shared memory to block until async ops complete
// Server.js API unchanged: db.xxx() returns values directly (not Promises)
//
// Readiness handshake: the worker signals via shared-memory Atomics, NOT via
// the 'message' event. The main thread blocks in Atomics.wait during startup,
// which freezes the event loop — a 'message' callback could never run.

import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BUFFER_SIZE = 10 * 1024 * 1024;
const FLAG_OFFSET = 0;      // per-query completion flag
const LEN_OFFSET = 4;       // per-query result length
const DATA_OFFSET = 8;      // per-query result bytes
const READY_OFFSET = 12;    // worker readiness flag (set once at startup)

const DEFAULT_READY_TIMEOUT_MS = 30000;
const QUERY_TIMEOUT_MS = 30000;

export function createSyncPgAdapter(connectionString, { encryptionKey = null, readyTimeoutMs = null } = {}) {
  // Allow fast-fail for tests: ?readyTimeoutMs=2000 in connection string
  // or readyTimeoutMs option. Defaults to 30s for production.
  let readyTimeout = readyTimeoutMs || DEFAULT_READY_TIMEOUT_MS;
  const timeoutMatch = /[?&]readyTimeoutMs=(\d+)/.exec(connectionString);
  if (timeoutMatch) readyTimeout = parseInt(timeoutMatch[1], 10);
  const sharedBuffer = new SharedArrayBuffer(BUFFER_SIZE);
  const sharedArray = new Int32Array(sharedBuffer);

  const worker = new Worker(path.join(__dirname, 'pg-worker.mjs'), {
    workerData: { connectionString, encryptionKey, sharedBuffer }
  });

  let workerExitCode = null;
  worker.on('error', (err) => {
    console.error('PG worker error:', err);
  });
  worker.on('exit', (code) => {
    workerExitCode = code;
    // Wake the main thread if it's waiting for readiness.
    Atomics.notify(sharedArray, READY_OFFSET / 4, 1);
    if (code !== 0 && Atomics.load(sharedArray, READY_OFFSET / 4) === 0) {
      console.error(`PG worker exited with code ${code} before signaling ready`);
    }
  });

  // Wait for the worker's Atomics readiness signal (shared memory, not 'message').
  // Poll in short intervals so a worker crash fails fast instead of waiting out
  // the full timeout.
  const readyDeadline = Date.now() + readyTimeout;
  let ready = false;
  while (Date.now() < readyDeadline) {
    if (Atomics.load(sharedArray, READY_OFFSET / 4) === 1) {
      ready = true;
      break;
    }
    if (workerExitCode !== null && workerExitCode !== 0) {
      break;
    }
    Atomics.wait(sharedArray, READY_OFFSET / 4, 0, 1000);
  }
  if (!ready) {
    try { worker.terminate(); } catch {}
    throw new Error(
      `PG worker failed to start${workerExitCode !== null ? ` (worker exited with code ${workerExitCode})` : ' (readiness timeout)'}. ` +
      `Check DATABASE_URL, network access, and PostgreSQL availability.`
    );
  }

  let nextId = 1;

  return new Proxy({}, {
    get(target, method) {
      if (method === 'close') {
        return () => { worker.terminate(); };
      }
      if (typeof method !== 'string') return undefined;

      return (...args) => {
        const id = nextId++;
        Atomics.store(sharedArray, FLAG_OFFSET / 4, 0);
        worker.postMessage({ id, method, args });
        const result = Atomics.wait(sharedArray, FLAG_OFFSET / 4, 0, QUERY_TIMEOUT_MS);
        if (result === 'timed-out') {
          throw new Error(`PG query timeout: ${method}`);
        }
        const len = sharedArray[LEN_OFFSET / 4];
        const bytes = Buffer.from(sharedBuffer, DATA_OFFSET, len);
        const msg = JSON.parse(bytes.toString('utf8'));

        if (!msg.ok) {
          const err = new Error(msg.error.message);
          err.stack = msg.error.stack;
          throw err;
        }
        return msg.result;
      };
    }
  });
}
