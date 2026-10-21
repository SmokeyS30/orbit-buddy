import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitServer } from '../server.js';
import { hashToken } from '../src/security.js';
import { evaluateSignupRisk, shouldBlockSignup, signupAdmission, signupAuditSubject, signupRiskMode, signupsPaused, summarizeSignupRiskEvents } from '../src/signup-risk.js';

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
  const commandLine = evaluateSignupRisk({ email: 'person@example.com', userAgent: 'curl/8.7.1' });
  assert.equal(commandLine.decision, 'verify');
  assert.deepEqual(commandLine.signals, ['non_browser_client']);
  assert.equal(shouldBlockSignup('observe', bot), false);
  assert.equal(shouldBlockSignup('enforce', bot), true);
});

test('automatic admission preserves observation mode and never locks initial owner setup', () => {
  const allow = { decision: 'allow' };
  const verify = { decision: 'verify' };
  const deny = { decision: 'deny' };
  assert.deepEqual(signupAdmission({ mode: 'enforce', result: deny, hasOwner: false }), { action: 'allow', reason: 'initial_owner' });
  assert.equal(signupAdmission({ mode: 'observe', result: allow, hasOwner: true, registrationOpen: false }).action, 'closed');
  assert.equal(signupAdmission({ mode: 'observe', result: deny, hasOwner: true, registrationOpen: true }).action, 'allow');
  assert.equal(signupAdmission({ mode: 'enforce', result: allow, hasOwner: true, registrationOpen: false }).action, 'allow');
  assert.equal(signupAdmission({ mode: 'enforce', result: verify, hasOwner: true, registrationOpen: true }).action, 'verify');
  assert.deepEqual(signupAdmission({ mode: 'enforce', result: verify, hasOwner: true, verifiedEmail: true }), { action: 'allow', reason: 'verified_email' });
  assert.equal(signupAdmission({ mode: 'enforce', result: deny, hasOwner: true, registrationOpen: true }).action, 'deny');
});

test('audit subjects are keyed and never store the raw email', () => {
  const hash = signupAuditSubject('Person@Example.com', 'test-secret');
  assert.equal(hash.length, 64);
  assert.doesNotMatch(hash, /person|example/i);
  assert.equal(signupAuditSubject('person@example.com', ''), null);
  for (const file of ['../src/database.js', '../src/db/postgres-schema.sql']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const table = source.match(/CREATE TABLE IF NOT EXISTS signup_verification_tokens \([\s\S]*?\n\s*\);/i)?.[0] || '';
    assert.match(table, /email_hash TEXT NOT NULL/);
    assert.doesNotMatch(table, /\bemail TEXT\b/i, `${file} must not store a raw pending email`);
  }
});

test('owner audit summary contains decisions and signals but no applicant identifiers', () => {
  const summary = summarizeSignupRiskEvents([
    { subject_hash: 'secret-a', mode: 'observe', decision: 'allow', score: 0, signals_json: '[]', created_at: '2026-10-20T20:00:00.000Z' },
    { subject_hash: 'secret-b', mode: 'observe', decision: 'deny', score: 80, signals_json: '["automation_user_agent"]', created_at: '2026-10-20T19:00:00.000Z' },
  ]);
  assert.equal(summary.total, 2);
  assert.deepEqual(summary.decisions, { allow: 1, verify: 0, deny: 1 });
  assert.equal(summary.signals.automation_user_agent, 1);
  assert.equal(summary.latestAt, '2026-10-20T20:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(summary), /secret-[ab]/);
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

test('enforcement automatically admits low-risk members without opening the legacy door', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-signup-enforce-'));
  const sentEmails = [];
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', SIGNUP_RISK_MODE: 'enforce', SIGNUP_AUDIT_KEY: 'test-secret' }, sendEmail: async (_env, message) => { sentEmails.push(message);return true; } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const register = (email, agent, verificationToken = null) => fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': agent }, body: JSON.stringify({ email, displayName: 'Person', password: 'correct horse battery staple', ...(verificationToken ? { verificationToken } : {}) }) });
  const ownerResponse = await register('owner@example.com', 'HeadlessBot/1.0');
  assert.equal(ownerResponse.status, 201, 'initial owner must not be locked out');
  const ownerCookie = ownerResponse.headers.get('set-cookie').split(';')[0];
  const setup = await (await fetch(`${base}/api/auth/setup-status`)).json();
  assert.equal(setup.registrationOpen, false);
  assert.equal(setup.automaticSignup, true);
  assert.equal(setup.emailVerificationReady, true);
  const memberResponse = await register('member@example.com', 'OrbitBuddy/1.1');
  assert.equal(memberResponse.status, 201);
  assert.equal(app.db.getUserByEmail('member@example.com').email_verified_at, null);
  const memberCookie = memberResponse.headers.get('set-cookie').split(';')[0];
  assert.equal((await register('bot@example.com', 'HeadlessBot/1.0')).status, 403);
  const verifyResponse = await register('verify@example.com', 'curl/8.7.1');
  assert.equal(verifyResponse.status, 403);
  assert.deepEqual(await verifyResponse.json(), { error: 'Check your email to verify your address and finish creating your Orbit account.', verificationRequired: true, verificationSent: true });
  assert.equal(sentEmails.length, 1);
  const verificationUrl = sentEmails[0].text.match(/https?:\/\/\S+/)[0];
  const verificationToken = new URL(verificationUrl).hash.replace('#signup-verify=', '');
  assert.ok(verificationToken);
  const repeatedResponse = await register('verify@example.com', 'curl/8.7.1');
  assert.equal(repeatedResponse.status, 403);
  assert.equal(sentEmails.length, 1, 'pending email verification must suppress duplicate sends');
  assert.equal((await register('verify@example.com', 'curl/8.7.1', verificationToken)).status, 201);
  assert.ok(app.db.getUserByEmail('verify@example.com').email_verified_at, 'step-up verification must persist on the account');
  const wrongEmailResponse = await register('other@example.com', 'curl/8.7.1', verificationToken);
  assert.equal(wrongEmailResponse.status, 403, 'verification token must stay bound to its email');
  assert.equal(sentEmails.length, 2, 'wrong-email token gets a fresh verification, not access');
  assert.equal((await fetch(`${base}/api/admin/signup-risk`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/signup-risk`, { headers: { Cookie: memberCookie } })).status, 403);
  const auditResponse = await fetch(`${base}/api/admin/signup-risk`, { headers: { Cookie: ownerCookie } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json();
  assert.equal(audit.total, 7);
  assert.deepEqual(audit.decisions, { allow: 1, verify: 4, deny: 2 });
  assert.doesNotMatch(JSON.stringify(audit), /subject|owner@example|member@example|bot@example/);
  const oneTimeEmailHash = signupAuditSubject('one-time@example.com', 'test-secret');
  const oneTimeTokenHash = hashToken('one-time-token');
  app.db.addSignupVerificationToken(oneTimeTokenHash, oneTimeEmailHash, new Date(Date.now() + 60_000).toISOString());
  assert.ok(app.db.getSignupVerificationToken(oneTimeTokenHash, oneTimeEmailHash));
  assert.equal(app.db.consumeSignupVerificationToken(oneTimeTokenHash, oneTimeEmailHash), true);
  assert.equal(app.db.consumeSignupVerificationToken(oneTimeTokenHash, oneTimeEmailHash), false, 'verification token must be one-time');
});

test('ambiguous enforcement fails safely when transactional email is unavailable', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-signup-no-email-'));
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', SIGNUP_RISK_MODE: 'enforce', SIGNUP_AUDIT_KEY: 'test-secret' } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const register = (email, agent) => fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': agent }, body: JSON.stringify({ email, displayName: 'Person', password: 'correct horse battery staple' }) });
  assert.equal((await register('owner@example.com', 'OrbitBuddy/1.1')).status, 201);
  const setup = await (await fetch(`${base}/api/auth/setup-status`)).json();
  assert.equal(setup.emailVerificationReady, false);
  const response = await register('ambiguous@example.com', 'curl/8.7.1');
  assert.equal(response.status, 503);
  assert.equal(app.db.countUsers(), 1, 'unverified applicant must not be created');
});

test('failed email delivery releases the pending slot for a safe retry', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-signup-email-failure-'));
  let attempts = 0;
  const app = createOrbitServer({ dataDir: directory, env: { NODE_ENV: 'test', OPENAI_MODEL: 'gpt-6-luna', SIGNUP_RISK_MODE: 'enforce', SIGNUP_AUDIT_KEY: 'test-secret' }, sendEmail: async () => { attempts++;return false; } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const register = (email, agent) => fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': agent }, body: JSON.stringify({ email, displayName: 'Person', password: 'correct horse battery staple' }) });
  assert.equal((await register('owner@example.com', 'OrbitBuddy/1.1')).status, 201);
  assert.equal((await register('retry@example.com', 'curl/8.7.1')).status, 503);
  assert.equal((await register('retry@example.com', 'curl/8.7.1')).status, 503);
  assert.equal(attempts, 2, 'a failed send must not leave a fake pending verification');
});
