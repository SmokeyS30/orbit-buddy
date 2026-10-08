// Worker thread holding the async PG adapter (ES module)
// Writes results directly to shared memory for synchronous access

import { parentPort, workerData } from 'node:worker_threads';
import { openPostgres } from './postgres-adapter.js';

const BUFFER_SIZE = 10 * 1024 * 1024;
const FLAG_OFFSET = 0;
const LEN_OFFSET = 4;
const DATA_OFFSET = 8;

async function main() {
  const db = await openPostgres(workerData.connectionString, {
    encryptionKey: workerData.encryptionKey || null
  });
  
  const sharedArray = new Int32Array(workerData.sharedBuffer);
  const sharedBytes = new Uint8Array(workerData.sharedBuffer);
  
  parentPort.on('message', async ({ id, method, args }) => {
    try {
      const result = await db[method](...args);
      const json = JSON.stringify({ ok: true, result });
      const bytes = Buffer.from(json, 'utf8');
      
      if (bytes.length > BUFFER_SIZE - DATA_OFFSET) {
        throw new Error('Result too large for shared buffer');
      }
      
      sharedArray[LEN_OFFSET / 4] = bytes.length;
      sharedBytes.set(bytes, DATA_OFFSET);
      Atomics.store(sharedArray, FLAG_OFFSET / 4, 1);
      Atomics.notify(sharedArray, FLAG_OFFSET / 4, 1);
    } catch (err) {
      const json = JSON.stringify({ 
        ok: false, 
        error: { message: err.message, stack: err.stack } 
      });
      const bytes = Buffer.from(json, 'utf8');
      sharedArray[LEN_OFFSET / 4] = bytes.length;
      sharedBytes.set(bytes, DATA_OFFSET);
      Atomics.store(sharedArray, FLAG_OFFSET / 4, 1);
      Atomics.notify(sharedArray, FLAG_OFFSET / 4, 1);
    }
  });
  
  parentPort.postMessage({ ready: true });
}

main().catch(err => {
  console.error('Worker fatal:', err);
  process.exit(1);
});
