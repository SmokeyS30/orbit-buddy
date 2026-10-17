import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const welcomeHtml = fs.readFileSync(path.join(root, 'public', 'welcome.html'), 'utf8');

function connectBody() {
  const start = appJs.indexOf('async function connect()');
  assert.ok(start > -1, 'connect() must exist');
  const end = appJs.indexOf('function setAuthMode', start);
  return appJs.slice(start, end);
}

test('welcome page has a prominent Sign in button', () => {
  assert.match(welcomeHtml, /<a class="btn btn-primary" href="index\.html#signin">Sign in<\/a>/);
});

test('welcome page keeps the waitlist option', () => {
  assert.match(welcomeHtml, /href="#waitlist">Join the Waitlist<\/a>/);
});

test('connect() does NOT auto-open the auth dialog on plain launch', () => {
  const body = connectBody();
  // No unconditional showModal in connect()'s auth path — dialog opens only
  // via the #signin launch flag (handled below).
  assert.doesNotMatch(body, /if\(!\$\('#auth-dialog'\)\.open\)\$\('#auth-dialog'\)\.showModal\(\)/);
});

test('native first launch (signed out) redirects to the welcome page', () => {
  const body = connectBody();
  assert.match(body, /if\(IS_NATIVE&&!state\.launchSignin\)\{location\.href='welcome\.html';return;\}/);
});

test('#signin launch flag opens the auth dialog instead of redirecting', () => {
  const body = connectBody();
  assert.match(body, /if\(state\.launchSignin\)\{const d=\$\('#auth-dialog'\);if\(d&&!d\.open\)d\.showModal\(\);\}/);
});

test('launch captures the #signin flag before the hash is cleared', () => {
  const flagPos = appJs.indexOf("state.launchSignin=location.hash==='#signin'");
  const clearPos = appJs.indexOf("if(location.hash)history.replaceState(null,'',location.pathname+location.search);");
  assert.ok(flagPos > -1 && clearPos > -1 && flagPos < clearPos,
    '#signin must be captured before the hash is cleared');
});

test('web signed-out launch still shows the hero sign-in button', () => {
  assert.match(indexHtml, /id="hero-signin"/);
  const body = connectBody();
  assert.match(body, /\$\('#hero-signin'\)\?\.classList\.remove\('hidden'\)/);
});

test('connect() hides the hero sign-in button when signed in', () => {
  const body = connectBody();
  assert.match(body, /\$\('#hero-signin'\)\?\.classList\.add\('hidden'\)/);
});

test('hero sign-in button opens the auth dialog on click', () => {
  assert.match(appJs, /\$\('#hero-signin'\)\?\.addEventListener\('click'/);
});

test('sending a message while signed out prompts for sign-in', () => {
  const sendStart = appJs.indexOf('async function sendChatMessage');
  assert.ok(sendStart > -1, 'sendChatMessage must exist');
  const sendBody = appJs.slice(sendStart, sendStart + 2000);
  assert.match(sendBody, /if\(!state\.user\)/);
  assert.match(sendBody, /auth-dialog/);
});
