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

test('updatePushButton waits for the native bridge ahead of the web-push check', () => {
  const body = updatePushButtonBody();
  const nativeIdx = body.indexOf('isNativeRuntime(window)');
  const webIdx = body.indexOf('serviceWorker');
  assert.ok(nativeIdx > -1, 'must consult the live native runtime');
  assert.ok(webIdx > -1, 'must keep the web-push path');
  assert.ok(nativeIdx < webIdx, 'native branch must come before the web check');
  assert.match(body, /await waitForNativePushPlugin\(1500\)/);
  assert.match(body, /checkPermissions/);
});

test('native branch never reports "not supported" before checking the plugin', () => {
  const body = updatePushButtonBody();
  const nativeSection = body.slice(0, body.indexOf("if(!('serviceWorker'in navigator)"));
  assert.doesNotMatch(nativeSection, /Not supported on this device/);
  assert.match(nativeSection, /Send test notification/);
  assert.match(nativeSection, /Enable on this device/);
});

test('APNs registration event uploads the token via the authenticated api() helper', () => {
  assert.match(appJs, /addListener\('PushNotifications','registration'/);
  const listenerIdx = appJs.indexOf("addListener('PushNotifications','registration'");
  const region = appJs.slice(listenerIdx, listenerIdx + 600);
  assert.match(region, /postApnsToken\(token,verifyDelivery\)/);
  // postApnsToken itself POSTs through the authenticated api() helper.
  assert.match(appJs, /async function postApnsToken\(token,verifyDelivery=false\)\{[^}]*api\('\/api\/push\/token',\{method:'POST'/);
});

test('native enable flow requests permission then registers via the bridge', () => {
  const clickIdx = appJs.indexOf("$('#enable-push').addEventListener");
  const region = appJs.slice(clickIdx, clickIdx + 1200);
  assert.match(region, /isNativeRuntime\(window\)/);
  assert.match(region, /await waitForNativePushPlugin\(\)/);
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
  assert.match(listeners, /\.catch\(\(error\)=>\{[\s\S]*?toast\('Push setup failed: '/);
  assert.match(listeners, /Notification setup needs attention:/);
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
  assert.match(appJs, /postApnsToken\(token,verifyDelivery\)\.then\(\(\)=>\{toast\(verifyDelivery\?'Push notifications enabled — test sent\.':'Push notifications enabled\.'\);/);
});

test('push registration has a timeout when Apple never responds', () => {
  assert.match(appJs, /pushRegistrationPending=true;/);
  assert.match(appJs, /setTimeout\(\(\)=>\{if\(pushRegistrationPending\)\{pushRegistrationPending=false;toast\('Push setup timed out/);
});

test('explicit enable verifies delivery while launch refresh does not spam a test push', () => {
  assert.match(appJs, /const verifyDelivery=pushRegistrationPending;/);
  assert.match(appJs, /postApnsToken\(token,verifyDelivery\)/);
  assert.match(appJs, /JSON\.stringify\(\{token,verifyDelivery\}\)/);
  const setupIdx = appJs.indexOf('async function setupNativePush()');
  const setupBody = appJs.slice(setupIdx, setupIdx + 800);
  assert.doesNotMatch(setupBody, /pushRegistrationPending=true/);
});

test('native setup waits for the bridge and starts only after authenticated connect', () => {
  assert.match(appJs, /async function waitForNativePushPlugin\(timeoutMs=8000\)/);
  const setupIdx = appJs.indexOf('async function setupNativePush()');
  const setupBody = appJs.slice(setupIdx, setupIdx + 900);
  assert.match(setupBody, /await waitForNativePushPlugin\(\)/);
  const connectIdx = appJs.indexOf('async function connect()');
  const connectBody = appJs.slice(connectIdx, connectIdx + 1400);
  assert.match(connectBody, /await refresh\(\)[\s\S]*?setupNativePush\(\)/);
  assert.doesNotMatch(appJs, /updatePushButton\(\);\s*if\(isNativeRuntime\(window\)\)setupNativePush\(\);/);
});

test('an enabled native device can always request a verified test push', () => {
  const body = updatePushButtonBody();
  assert.match(body, /permission==='granted'&&apnsRegistered\(\)[\s\S]*?btn\.disabled=false/);
  assert.match(body, /Send test notification/);
});

test('foreground native pushes surface visibly instead of logging only', () => {
  assert.match(appJs, /addListener\('PushNotifications','pushNotificationReceived'.*toast\(/);
});

test('iOS target carries the APNs entitlement and capability', () => {
  const entitlements = fs.readFileSync(path.join(root, 'ios', 'App', 'App', 'App.entitlements'), 'utf8');
  const project = fs.readFileSync(path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'), 'utf8');
  assert.match(entitlements, /<key>aps-environment<\/key>/);
  assert.match(project, /CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/);
  assert.match(project, /com\.apple\.Push = \{[\s\S]*?enabled = 1;/);
});

test('AppDelegate forwards Apple push callbacks to Capacitor', () => {
  // Without these, iOS delivers the APNs token/error to the AppDelegate and
  // it goes nowhere: the JS registration events never fire (silent timeout).
  const delegate = fs.readFileSync(path.join(root, 'ios', 'App', 'App', 'AppDelegate.swift'), 'utf8');
  assert.match(delegate, /func application\(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data\)/);
  assert.match(delegate, /NotificationCenter\.default\.post\(name: \.capacitorDidRegisterForRemoteNotifications, object: deviceToken\)/);
  assert.match(delegate, /func application\(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error\)/);
  assert.match(delegate, /NotificationCenter\.default\.post\(name: \.capacitorDidFailToRegisterForRemoteNotifications, object: error\)/);
});
