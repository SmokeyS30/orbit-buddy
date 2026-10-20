import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';
import { evaluateSignupRisk, shouldBlockSignup, signupAuditSubject, signupRiskMode, signupsPaused } from '../src/signup-risk.js';

test('signup risk defaults off and pause defaults false', () => {
  assert.equal(signupRiskMode({}), 'off');
  assert.equal(signupsPaused({}), false);
  assert.equal(signupsPaused({ SIGNUPS_PAUSED: 'true' }), true);
});

test('ordinary signup is allowed while obvious automation is denied only in enforce mode', () => {
  const normal = evaluateSignupRisk({ email: 'person@example.com', userAgent: 'OrbitBuddy/1.1', native: true, attested: true });
  assert.equal(normal.decision, 'allow');
  const bot = evaluateSignupRisk({ email: 'bot@example.com', userAgent: 'HeadlessBot/1.0' });
  assert.equal(bot.decision, 'deny');
  assert.equal(shouldBlockSignup('observe', bot), false);
  assert.equal(shouldBlockSignup('enforce', bot), true);
});

test('audit subjects are keyed and never store the raw email', () => {
  const hash = signupAuditSubject('Person@Example.com', 'test-secret');
  assert.equal(hash.length, 64);
  assert.doesNotMatch(hash, /person|example/i);
  assert.equal(signupAuditSubject('person@example.com', ''), null);
});

test('observation mode records risk but does not block registration', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-signup-risk-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', SIGNUP_RISK_MODE: 'observe', SIGNUP_AUDIT_KEY: 'test-secret' } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'HeadlessBot/1.0' }, body: JSON.stringify({ email: 'person@example.com', displayName: 'Person', password: 'correct horse battery staple' }) });
  assert.equal(response.status, 201);
});
