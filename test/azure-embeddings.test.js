import test from 'node:test';
import assert from 'node:assert/strict';
import { getEmbedding, embedMemory } from '../src/semantic-search.js';

const AZURE_VARS = ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_EMBEDDING_DEPLOYMENT'];
const savedEnv = Object.fromEntries(AZURE_VARS.map((k) => [k, process.env[k]]));
const savedFetch = globalThis.fetch;

function clearAzureEnv() {
  for (const k of AZURE_VARS) delete process.env[k];
}

function restoreEnv() {
  for (const k of AZURE_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

// Captures the fetch call and returns a canned embedding response.
function stubFetch() {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    };
  };
  return calls;
}

function restoreFetch() {
  globalThis.fetch = savedFetch;
}

test('getEmbedding uses Azure Foundry when AZURE_OPENAI_ENDPOINT is configured', async (t) => {
  clearAzureEnv();
  t.after(restoreEnv);
  // Trailing slash on the endpoint must be stripped (model.js pattern).
  process.env.AZURE_OPENAI_ENDPOINT = 'https://example-foundry.openai.azure.com/';
  process.env.AZURE_OPENAI_API_KEY = 'fake-azure-key';
  process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT = 'text-embedding-3-small';
  const calls = stubFetch();
  t.after(restoreFetch);

  const vec = await getEmbedding('hello world', 'direct-key-that-must-not-be-used');
  assert.deepEqual(vec, [0.1, 0.2, 0.3]);
  assert.equal(calls.length, 1);
  const { url, opts } = calls[0];
  assert.equal(url, 'https://example-foundry.openai.azure.com/openai/v1/embeddings');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers['api-key'], 'fake-azure-key');
  assert.ok(!('Authorization' in opts.headers), 'no Bearer header on the Azure path');
  const body = JSON.parse(opts.body);
  assert.equal(body.model, 'text-embedding-3-small');
  assert.equal(body.input, 'hello world');
});

test('getEmbedding falls back to direct OpenAI when Azure env is unset', async (t) => {
  clearAzureEnv();
  t.after(restoreEnv);
  const calls = stubFetch();
  t.after(restoreFetch);

  const vec = await getEmbedding('hello world', 'direct-key-123');
  assert.deepEqual(vec, [0.1, 0.2, 0.3]);
  assert.equal(calls.length, 1);
  const { url, opts } = calls[0];
  assert.equal(url, 'https://api.openai.com/v1/embeddings');
  assert.equal(opts.headers['Authorization'], 'Bearer direct-key-123');
  assert.ok(!('api-key' in opts.headers), 'no api-key header on the direct path');
  const body = JSON.parse(opts.body);
  assert.equal(body.model, 'text-embedding-3-small');
  assert.equal(body.input, 'hello world');
});

test('getEmbedding falls back to direct OpenAI when Azure env is only partially set', async (t) => {
  clearAzureEnv();
  t.after(restoreEnv);
  process.env.AZURE_OPENAI_ENDPOINT = 'https://example-foundry.openai.azure.com';
  // No AZURE_OPENAI_API_KEY / AZURE_OPENAI_EMBEDDING_DEPLOYMENT set.
  const calls = stubFetch();
  t.after(restoreFetch);

  await getEmbedding('hello world', 'direct-key-123');
  assert.equal(calls[0].url, 'https://api.openai.com/v1/embeddings');
  assert.equal(calls[0].opts.headers['Authorization'], 'Bearer direct-key-123');
});

test('embedMemory routes through the Azure path when configured', async (t) => {
  clearAzureEnv();
  t.after(restoreEnv);
  process.env.AZURE_OPENAI_ENDPOINT = 'https://example-foundry.openai.azure.com';
  process.env.AZURE_OPENAI_API_KEY = 'fake-azure-key';
  process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT = 'custom-embedding-deploy';
  const calls = stubFetch();
  t.after(restoreFetch);

  const vec = await embedMemory('a memory about pizza', 'direct-key');
  assert.deepEqual(vec, [0.1, 0.2, 0.3]);
  assert.equal(calls[0].url, 'https://example-foundry.openai.azure.com/openai/v1/embeddings');
  assert.equal(JSON.parse(calls[0].opts.body).model, 'custom-embedding-deploy');
});
