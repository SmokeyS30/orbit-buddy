// Focused test: Azure multi-region failover + exponential backoff in src/model.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelClient } from '../src/model.js';

const ENV = {
  AZURE_OPENAI_ENDPOINT: 'https://primary.openai.azure.com',
  AZURE_OPENAI_API_KEY: 'primary-key',
  AZURE_OPENAI_DEPLOYMENT: 'gpt-6.1-sol',
  AZURE_OPENAI_FALLBACK_DEPLOYMENTS: 'gpt-6-astra,gpt-6-luna',
  AZURE_OPENAI_SECONDARY_ENDPOINT: 'https://secondary.cognitiveservices.azure.com',
  AZURE_OPENAI_SECONDARY_KEY: 'secondary-key'
};

function mockFetch(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    return handler(String(url), opts);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const okModels = (models) => ({ ok: true, status: 200, json: async () => ({ data: models.map((id) => ({ id })) }) });
const err503 = () => ({ ok: false, status: 503, json: async () => ({ error: { message: 'Service unavailable', code: 'service_unavailable' } }) });
const okResponses = (text) => ({ ok: true, status: 200, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }), headers: new Headers({}) });

test('health probe fails over to secondary when primary 503s', async () => {
  const { calls, restore } = mockFetch((url) => {
    if (url.includes('/models')) return url.includes('primary') ? err503() : okModels(['gpt-6.1-sol', 'gpt-6-astra']);
    return okResponses('hi');
  });
  try {
    const client = createModelClient({ ...ENV });
    const status = await client.checkConnection();
    assert.equal(status.state, 'fallback');
    assert.equal(status.activeModel, 'gpt-6.1-sol');
    assert.equal(status.activeEndpoint, 'secondary');
    assert.ok(calls.some((u) => u.includes('primary') && u.includes('/models')));
    assert.ok(calls.some((u) => u.includes('secondary') && u.includes('/models')));
  } finally { restore(); }
});

test('failback: requests return to primary automatically on recovery', async () => {
  let primaryUp = false;
  let primaryHits = 0;
  const { restore } = mockFetch((url) => {
    if (url.includes('/models')) return okModels(['gpt-6.1-sol']);
    if (url.includes('/responses')) {
      if (url.includes('primary')) {
        primaryHits += 1;
        return primaryUp ? okResponses('primary back') : err503();
      }
      return okResponses('secondary temp');
    }
    return err503();
  });
  try {
    const client = createModelClient({ ...ENV });
    let result = await client.respond({ buddyName: 'Orbit', userName: 'Edward', message: 'hi', tools: false });
    assert.equal(result.text, 'secondary temp');
    assert.equal(client.diagnostics().state, 'fallback');
    assert.equal(client.diagnostics().activeEndpoint, 'secondary');
    const hitsAfterOutage = primaryHits;
    assert.ok(hitsAfterOutage >= 1, 'primary should have been tried first');
    primaryUp = true;
    result = await client.respond({ buddyName: 'Orbit', userName: 'Edward', message: 'hi again', tools: false });
    assert.equal(result.text, 'primary back');
    assert.ok(primaryHits > hitsAfterOutage, 'recovered primary should be tried first again');
    assert.equal(client.diagnostics().state, 'ready');
    assert.equal(client.diagnostics().activeEndpoint, 'primary');
  } finally { restore(); }
});

test('chat request fails over to secondary after primary 503s (with backoff)', async () => {
  let primaryHits = 0;
  const { calls, restore } = mockFetch((url) => {
    if (url.includes('/responses')) {
      if (url.includes('primary')) { primaryHits += 1; return err503(); }
      return okResponses('hello from secondary');
    }
    return okModels(['gpt-6.1-sol']);
  });
  try {
    const client = createModelClient({ ...ENV });
    const started = Date.now();
    const result = await client.respond({ buddyName: 'Orbit', userName: 'Edward', message: 'hi', tools: false });
    const elapsed = Date.now() - started;
    assert.equal(result.text, 'hello from secondary');
    // 1 initial + 3 retries on primary before failover
    assert.equal(primaryHits, 4);
    assert.ok(calls.some((u) => u.includes('secondary') && u.includes('/responses')));
    // backoff delays actually happened (~1s + ~2s + ~4s jittered)
    assert.ok(elapsed >= 3000, `expected backoff delay, got ${elapsed}ms`);
    const diag = client.diagnostics();
    assert.equal(diag.state, 'fallback');
    assert.equal(diag.activeEndpoint, 'secondary');
  } finally { restore(); }
});

test('non-transient errors do not fail over (auth)', async () => {
  let secondaryHits = 0;
  const { restore } = mockFetch((url) => {
    if (url.includes('/responses')) {
      if (url.includes('secondary')) secondaryHits += 1;
      return { ok: false, status: 401, json: async () => ({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }) };
    }
    return okModels(['gpt-6.1-sol']);
  });
  try {
    const client = createModelClient({ ...ENV });
    await assert.rejects(
      client.respond({ buddyName: 'Orbit', userName: 'Edward', message: 'hi', tools: false }),
      /Invalid API key/
    );
    assert.equal(secondaryHits, 0);
  } finally { restore(); }
});

test('network failure on primary fails over to secondary', async () => {
  const { restore } = mockFetch((url) => {
    if (url.includes('/responses')) {
      if (url.includes('primary')) throw new TypeError('fetch failed');
      return okResponses('secondary wins');
    }
    return okModels(['gpt-6.1-sol']);
  });
  try {
    const client = createModelClient({ ...ENV });
    const result = await client.respond({ buddyName: 'Orbit', userName: 'Edward', message: 'hi', tools: false });
    assert.equal(result.text, 'secondary wins');
  } finally { restore(); }
});

test('no secondary configured: behaves as before (single endpoint + retries)', async () => {
  let hits = 0;
  const { restore } = mockFetch((url) => {
    if (url.includes('/models')) return okModels(['gpt-6.1-sol']);
    if (url.includes('/responses')) {
      hits += 1;
      return hits < 3 ? err503() : okResponses('recovered');
    }
    return err503();
  });
  try {
    const { AZURE_OPENAI_SECONDARY_ENDPOINT, AZURE_OPENAI_SECONDARY_KEY, ...single } = ENV;
    const client = createModelClient({ ...single });
    const result = await client.respond({ buddyName: 'Orbit', userName: 'Edward', message: 'hi', tools: false });
    assert.equal(result.text, 'recovered');
    assert.equal(hits, 3); // initial + 2 retries, no failover target
    const diag = client.diagnostics();
    assert.equal(diag.state, 'ready');
    assert.equal(diag.activeEndpoint, 'primary');
  } finally { restore(); }
});
