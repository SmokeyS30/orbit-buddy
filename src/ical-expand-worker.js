import { parentPort, workerData } from 'node:worker_threads';
import { expandEvents } from './ical.js';

try {
  parentPort.postMessage({ events: expandEvents(
    workerData.vevents, workerData.rangeStartMs, workerData.rangeEndMs, workerData.defaultZone
  ) });
} catch (error) {
  parentPort.postMessage({ error: String(error?.message || error).slice(0, 200), status: error?.status || 400 });
}
