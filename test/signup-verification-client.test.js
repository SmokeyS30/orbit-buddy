import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('signup verification token is captured from the URL fragment and removed from the address bar', () => {
  assert.match(app, /location\.hash\.match\(\/\^#signup-verify=/);
  assert.match(app, /state\.signupVerificationToken=decodeURIComponent\(signupMatch\[1\]\)/);
  assert.match(app, /history\.replaceState\(null,'',location\.pathname\+location\.search\)/);
});

test('registration sends the in-memory verification token and handles step-up response', () => {
  assert.match(app, /verificationToken:state\.signupVerificationToken/);
  assert.match(app, /if\(body\.verificationRequired\)/);
  assert.match(app, /verificationSent===true/);
});

test('verification token is never persisted to browser storage', () => {
  assert.doesNotMatch(app, /(?:localStorage|sessionStorage)\.(?:setItem|getItem)\([^\n]*signup[_A-Z]*verification/i);
});
