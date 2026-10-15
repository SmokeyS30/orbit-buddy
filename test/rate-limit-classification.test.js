import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyModelError } from '../src/model.js';

// Regression test for the Oct 9/12 smart check-in failures: transient
// account-level OpenAI 429s must classify as 'rate_limit' so that
// (a) the model fallback loop throws immediately instead of burning through
//     model candidates, and
// (b) runSmartCheckins / runEmailTriage hit their silent-skip path
//     (worker retries in 5 min, no Reliability-tab failure event).

test('classifyModelError tags 429s as rate_limit', () => {
  assert.equal(classifyModelError({ status: 429, message: 'Rate limit reached' }), 'rate_limit');
  assert.equal(classifyModelError({ status: 429, message: 'requests per minute exceeded' }), 'rate_limit');
  assert.equal(classifyModelError({ status: 429, code: 'rate_limit_exceeded' }), 'rate_limit');
});

test('classifyModelError distinguishes quota exhaustion from rate limits', () => {
  assert.equal(
    classifyModelError({ status: 429, message: 'insufficient_quota: you exceeded your current quota' }),
    'quota'
  );
  assert.equal(
    classifyModelError({ status: 429, message: 'billing credit exhausted' }),
    'quota'
  );
});

test('classifyModelError keeps other transient classes intact', () => {
  assert.equal(classifyModelError({ status: 503, message: 'service unavailable' }), 'service');
  assert.equal(classifyModelError({ message: 'socket hang up' }), 'network');
  assert.equal(classifyModelError({ status: 401, message: 'invalid api key' }), 'authentication');
});
