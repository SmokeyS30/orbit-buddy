// Worker thread holding the async PG adapter (ES module)
// Writes results directly to shared memory for synchronous access

import { parentPort, workerData } from 'node:worker_threads';
import { openPostgres } from './postgres-adapter.js';

const BUFFER_SIZE = 10 * 1024 * 1024;
const FLAG_OFFSET = 0;
const LEN_OFFSET = 4;
const DATA_OFFSET = 8;
const READY_OFFSET = 12;

async function main() {
  const db = await openPostgres(workerData.connectionString, {
    encryptionKey: workerData.encryptionKey || null
  });
  
  const readyArray = new Int32Array(workerData.sharedBuffer);
  
  parentPort.on('message', async ({ id, method, args, sharedBuffer, async: asynchronous = false }) => {
    const responseBuffer=sharedBuffer||workerData.sharedBuffer;
    const sharedArray=asynchronous?null:new Int32Array(responseBuffer);
    const sharedBytes=asynchronous?null:new Uint8Array(responseBuffer);
    try {
      const result = await db[method](...args);
      const json = JSON.stringify({ id, ok: true, result });
      if (asynchronous) {
        parentPort.postMessage({ id, json });
        return;
      }
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
        id,
        ok: false, 
        error: { message: err.message, stack: err.stack } 
      });
      if (asynchronous) {
        parentPort.postMessage({ id, json });
        return;
      }
      const bytes = Buffer.from(json, 'utf8');
      sharedArray[LEN_OFFSET / 4] = bytes.length;
      sharedBytes.set(bytes, DATA_OFFSET);
      Atomics.store(sharedArray, FLAG_OFFSET / 4, 1);
      Atomics.notify(sharedArray, FLAG_OFFSET / 4, 1);
    }
  });
  
  parentPort.postMessage({ ready: true });

  // Signal readiness via shared memory (the main thread is blocked in
  // Atomics.wait and cannot receive 'message' events during startup).
  Atomics.store(readyArray, READY_OFFSET / 4, 1);
  Atomics.notify(readyArray, READY_OFFSET / 4, 1);
}

main().catch(err => {
  console.error('Worker fatal:', err);
  process.exit(1);
});
