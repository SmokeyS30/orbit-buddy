// Synchronous wrapper around async PostgreSQL adapter (ES module)
// Uses worker thread + shared memory to block until async ops complete
// Server.js API unchanged: db.xxx() returns values directly (not Promises)

import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BUFFER_SIZE = 10 * 1024 * 1024;
const FLAG_OFFSET = 0;
const LEN_OFFSET = 4;
const DATA_OFFSET = 8;

export function createSyncPgAdapter(connectionString, { encryptionKey = null } = {}) {
  const sharedBuffer = new SharedArrayBuffer(BUFFER_SIZE);
  const sharedArray = new Int32Array(sharedBuffer);
  
  const worker = new Worker(path.join(__dirname, 'pg-worker.mjs'), {
    workerData: { connectionString, encryptionKey, sharedBuffer }
  });
  
  let ready = false;
  worker.on('message', (msg) => {
    if (msg.ready) ready = true;
  });
  worker.on('error', (err) => {
    console.error('PG worker error:', err);
    process.exit(1);
  });
  
  // Wait for worker ready (max 10s)
  const start = Date.now();
  while (!ready && Date.now() - start < 10000) {
    Atomics.wait(sharedArray, 0, 0, 100);
  }
  if (!ready) throw new Error('PG worker failed to start');
  
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
        const waitResult = Atomics.wait(sharedArray, FLAG_OFFSET / 4, 0, 30000);
        if (waitResult === 'timed-out') {
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
