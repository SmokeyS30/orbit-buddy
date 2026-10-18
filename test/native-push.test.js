// B1: native iOS push client wiring (source-pattern tests over public/app.js).
// - updatePushButton checks the native Capacitor plugin state instead of
//   reporting "Not supported on this device" on iPhones.
// - The APNs registration event uploads the device token via the
//   authenticated api() helper to POST /api/push/token.
// - All native calls go through the low-level window.Capacitor bridge
//   (nativePromise / addListener) — no bundler, no vendored plugin JS.
// - APNs stays server-side: the client never touches api.push.apple.com.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

function updatePushButtonBody() {
  const start = appJs.indexOf('async function updatePushButton()');
  assert.ok(start > -1, 'updatePushButton must exist');
  const end = appJs.indexOf("$('#enable-push').addEventListener", start);
  assert.ok(end > -1, 'push click handler must follow updatePushButton');
  return appJs.slice(start, end);
}

test('updatePushButton has a native branch ahead of the web-push check', () => {
  const body = updatePushButtonBody();
  const nativeIdx = body.indexOf('nativePushAvailable()');
  const webIdx = body.indexOf('serviceWorker');
  assert.ok(nativeIdx > -1, 'must consult nativePushAvailable()');
  assert.ok(webIdx > -1, 'must keep the web-push path');
  assert.ok(nativeIdx < webIdx, 'native branch must come before the web check');
  assert.match(body, /checkPermissions/);
});

test('native branch never reports "not supported" before checking the plugin', () => {
  const body = updatePushButtonBody();
  const nativeSection = body.slice(0, body.indexOf("if(!('serviceWorker'in navigator)"));
  assert.doesNotMatch(nativeSection, /Not supported on this device/);
  assert.match(nativeSection, /Notifications enabled/);
  assert.match(nativeSection, /Enable on this device/);
});

test('APNs registration event uploads the token via the authenticated api() helper', () => {
  assert.match(appJs, /addListener\('PushNotifications','registration'/);
  const listenerIdx = appJs.indexOf("addListener('PushNotifications','registration'");
  const region = appJs.slice(listenerIdx, listenerIdx + 600);
  assert.match(region, /postApnsToken\(token\)/);
  // postApnsToken itself POSTs through the authenticated api() helper.
  assert.match(appJs, /async function postApnsToken\(token\)\{[^}]*api\('\/api\/push\/token',\{method:'POST'/);
});

test('native enable flow requests permission then registers via the bridge', () => {
  const clickIdx = appJs.indexOf("$('#enable-push').addEventListener");
  const region = appJs.slice(clickIdx, clickIdx + 1200);
  assert.match(region, /nativePushAvailable\(\)/);
  assert.match(region, /nativePromise\('PushNotifications','requestPermissions'/);
  assert.match(region, /nativePromise\('PushNotifications','register'/);
});

test('native push setup re-registers on launch when already allowed', () => {
  assert.match(appJs, /async function setupNativePush\(\)/);
  const idx = appJs.indexOf('async function setupNativePush()');
  const region = appJs.slice(idx, idx + 800);
  assert.match(region, /checkPermissions/);
  assert.match(region, /'register'/);
  assert.match(appJs, /if\(isNativeRuntime\(window\)\)setupNativePush\(\);/);
});

test('client never talks to APNs directly (server-side only)', () => {
  assert.doesNotMatch(appJs, /api\.push\.apple\.com/);
});

test('push listeners attach once (no duplicate registrations)', () => {
  assert.match(appJs, /nativePushListenersAttached/);
});

test('push failures surface as toasts, not silent console warnings', () => {
  // Registration and upload failures must be visible on the phone: the
  // iPhone's console is not accessible, so console.warn-only errors are
  // undebuggable in the field.
  const listeners = appJs.slice(appJs.indexOf('function attachNativePushListeners()'));
  assert.match(listeners, /registrationError.*toast\('Push registration failed: '/);
  assert.match(listeners, /\.catch\(\(error\)=>toast\('Push setup failed: '/);
});

test('push success toast fires only after the token upload completes', () => {
  // The premature "enabled" toast in the click handler lied: it fired after
  // register() but before the token reached the server. Success is now
  // toasted from the registration listener after postApnsToken resolves.
  const clickStart = appJs.indexOf("$('#enable-push').addEventListener('click'");
  const clickBody = appJs.slice(clickStart, appJs.indexOf('updatePushButton();', clickStart) + 500);
  assert.doesNotMatch(
    clickBody.slice(0, clickBody.indexOf('pushRegistrationPending=true')),
    /toast\('Push notifications enabled\.'\)/
  );
  assert.match(appJs, /postApnsToken\(token\)\.then\(\(\)=>\{toast\('Push notifications enabled\.'\);/);
});

test('push registration has a timeout when Apple never responds', () => {
  assert.match(appJs, /pushRegistrationPending=true;/);
  assert.match(appJs, /setTimeout\(\(\)=>\{if\(pushRegistrationPending\)\{pushRegistrationPending=false;toast\('Push setup timed out/);
});
