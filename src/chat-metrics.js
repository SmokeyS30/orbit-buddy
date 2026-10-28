// Anonymous, in-memory aggregates for the last hour. Never retain message
// text, account identifiers, conversation identifiers, or error messages.
const FIELDS = ['queueMs', 'databaseMs', 'contextMs', 'modelFirstTokenMs', 'modelCompletionMs', 'completionMs'];
const WINDOW_MS = 60 * 60_000;
const MAX_SAMPLES = 2_000;
const MIN_ALERT_SAMPLES = 20;

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(fraction * sorted.length) - 1]);
}

export function createChatMetrics({ now = Date.now } = {}) {
  const samples = [];
  function prune() {
    const cutoff = now() - WINDOW_MS;
    while (samples.length && samples[0].at < cutoff) samples.shift();
  }
  function record(input = {}) {
    const sample = { at: now(), error: input.error === true, modelFallback: input.modelFallback === true };
    for (const field of FIELDS) {
      const value = input[field];
      sample[field] = typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.min(value, 10 * 60_000) : null;
    }
    samples.push(sample);
    prune();
    if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  }
  function snapshot() {
    prune();
    const timings = {};
    for (const field of FIELDS) {
      const values = samples.map((sample) => sample[field]).filter((value) => value !== null);
      timings[field] = { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99) };
    }
    const count = samples.length;
    const errors = samples.filter((sample) => sample.error).length;
    const modelFallbacks = samples.filter((sample) => sample.modelFallback).length;
    const degraded = count >= MIN_ALERT_SAMPLES && (
      (errors >= 5 && errors / count >= 0.2) ||
      (timings.queueMs.count >= MIN_ALERT_SAMPLES && timings.queueMs.p95 > 30_000) ||
      (timings.modelFirstTokenMs.count >= MIN_ALERT_SAMPLES && timings.modelFirstTokenMs.p95 > 90_000) ||
      (timings.completionMs.count >= MIN_ALERT_SAMPLES && timings.completionMs.p95 > 180_000)
    );
    return { windowMinutes: 60, sampleCap: MAX_SAMPLES, count, errors, modelFallbacks,
      state: count < MIN_ALERT_SAMPLES ? 'insufficient' : degraded ? 'degraded' : 'ready', timings };
  }
  function publicStatus() {
    const { state, windowMinutes } = snapshot();
    return { state, windowMinutes };
  }
  return { record, snapshot, publicStatus };
}
