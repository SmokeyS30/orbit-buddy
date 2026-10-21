import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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
