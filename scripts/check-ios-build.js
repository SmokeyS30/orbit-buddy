#!/usr/bin/env node
/**
 * pre-archive check for Orbit Buddy iOS builds.
 *
 * Run this on your Mac BEFORE archiving for TestFlight:
 *   node scripts/check-ios-build.js
 *
 * It verifies three things that have bitten us before:
 *   1. Web assets are synced — ios/App/App/public matches public/
 *   2. Native API base is absolute — the app talks to https://orbitbuddy.app, not relative URLs
 *   3. Sign-in is wired — the auth form has a submit handler and the button actually submits
 *
 * Fails fast with the exact problem. Exit 0 = safe to archive.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SYNCED_DIR = path.join(ROOT, 'ios', 'App', 'App', 'public');
const APP_JS = path.join(PUBLIC_DIR, 'app.js');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

let failures = 0;
function fail(msg) {
  failures++;
  console.error(`  ✗ ${msg}`);
}
function pass(msg) {
  console.log(`  ✓ ${msg}`);
}
function section(name) {
  console.log(`\n${name}`);
}

function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
function walkFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p, base));
    else out.push(path.relative(base, p));
  }
  return out.sort();
}

// --- 1. Web asset sync -------------------------------------------------------
section('1. Web asset sync (public/ → ios/App/App/public)');
if (!fs.existsSync(SYNCED_DIR)) {
  fail('ios/App/App/public does not exist — run `npx cap sync ios` first.');
} else {
  const srcFiles = walkFiles(PUBLIC_DIR);
  const syncedFiles = new Set(walkFiles(SYNCED_DIR));
  const missing = srcFiles.filter(f => !syncedFiles.has(f));
  const stale = [];
  for (const f of srcFiles) {
    if (syncedFiles.has(f)) {
      try {
        if (hashFile(path.join(PUBLIC_DIR, f)) !== hashFile(path.join(SYNCED_DIR, f))) stale.push(f);
      } catch (_) { /* unreadable — treat as stale */ stale.push(f); }
    }
  }
  if (missing.length) fail(`${missing.length} file(s) in public/ never synced (e.g. ${missing[0]}) — run \`npx cap sync ios\`.`);
  if (stale.length) fail(`${stale.length} synced file(s) are outdated (e.g. ${stale[0]}) — run \`npx cap sync ios\`.`);
  if (!missing.length && !stale.length) pass(`${srcFiles.length} files synced and current.`);
}

// --- 2. Native API base ------------------------------------------------------
section('2. Native API base (absolute URL on iOS)');
if (!fs.existsSync(APP_JS)) {
  fail('public/app.js not found.');
} else {
  const js = fs.readFileSync(APP_JS, 'utf8');
  const m = js.match(/const API_BASE\s*=\s*IS_NATIVE\s*\?\s*['"]([^'"]+)['"]/);
  if (!m) {
    fail('API_BASE is not set from IS_NATIVE — native calls may use relative URLs and fail.');
  } else if (!/^https:\/\//.test(m[1])) {
    fail(`API_BASE for native is "${m[1]}" — must be an absolute https URL.`);
  } else {
    pass(`native API base is absolute: ${m[1]}`);
  }
  // Every fetch of a /api path must go through API_BASE or the api() helper.
  const bareApiCalls = [...js.matchAll(/fetch\(\s*['"]\/api\//g)];
  if (bareApiCalls.length) {
    fail(`${bareApiCalls.length} fetch() call(s) use a bare "/api/..." path without API_BASE — they will fail on native.`);
  } else {
    pass('no bare relative /api fetch calls.');
  }
}

// --- 3. Sign-in wiring -------------------------------------------------------
section('3. Sign-in wiring (tap reaches a real handler)');
if (!fs.existsSync(APP_JS) || !fs.existsSync(INDEX_HTML)) {
  fail('app.js or index.html not found.');
} else {
  const js = fs.readFileSync(APP_JS, 'utf8');
  const html = fs.readFileSync(INDEX_HTML, 'utf8');

  const hasSubmitListener = /\$\(['"]#auth-form['"]\)\.addEventListener\(\s*['"]submit['"]/.test(js)
    || /getElementById\(['"]auth-form['"]\)\.addEventListener\(\s*['"]submit['"]/.test(js);
  const buttonMatch = html.match(/<button[^>]*id=["']auth-submit["'][^>]*>/);
  const buttonIsSubmit = buttonMatch && /type=["']submit["']/.test(buttonMatch[0]);
  const formExists = /<form[^>]*id=["']auth-form["']/.test(html);
  const dialogOpens = /showModal\(\)/.test(js) && /\$\(['"]#auth-dialog['"]\)/.test(js);

  if (!formExists) fail('#auth-form not found in index.html.');
  if (!hasSubmitListener) fail('no submit handler on #auth-form in app.js — the sign-in tap does nothing.');
  if (!buttonIsSubmit) fail('#auth-submit is not type="submit" — tapping it will not submit the form on iOS.');
  if (!dialogOpens) fail('nothing opens #auth-dialog — the sign-in screen can never appear.');
  if (formExists && hasSubmitListener && buttonIsSubmit && dialogOpens) {
    pass('auth form, submit handler, submit button, and dialog open all wired.');
  }
}

// --- Verdict -----------------------------------------------------------------
console.log('');
if (failures) {
  console.error(`FAILED: ${failures} problem(s). Fix them before archiving — do not upload this build to TestFlight.`);
  process.exit(1);
}
console.log('PASSED: safe to archive for TestFlight.');
