import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const mobile = fs.readFileSync(new URL('../public/mobile.css', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const welcome = fs.readFileSync(new URL('../public/welcome.html', import.meta.url), 'utf8');
const project = fs.readFileSync(new URL('../ios/App/App.xcodeproj/project.pbxproj', import.meta.url), 'utf8');

test('mobile layout prevents WebKit text inflation and horizontal viewport drift', () => {
  assert.match(mobile, /html\{[^}]*-webkit-text-size-adjust:100%[^}]*max-width:100%[^}]*overflow-x:hidden/);
  assert.match(mobile, /body\{[^}]*-webkit-text-size-adjust:100%[^}]*max-width:100%[^}]*overflow-x:hidden/);
  assert.match(mobile, /@media\(max-width:380px\)/);
  assert.match(mobile, /body\{min-height:100dvh\}/);
});

test('mobile conversation controls stack without squeezing the message field', () => {
  assert.match(mobile, /\.panel-heading\{flex-direction:column/);
  assert.match(mobile, /\.chat-search\{width:100%;display:grid;grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(mobile, /\.composer #chat-input\{grid-column:1\/-1;grid-row:1/);
  assert.match(mobile, /\.composer \.primary\{grid-column:3;grid-row:2/);
});

test('mobile overlays use the dynamic viewport and safe areas', () => {
  assert.match(mobile, /\.login-card\{[^}]*max-height:calc\(100dvh/);
  assert.match(mobile, /#report-dialog\{[^}]*height:100%[^}]*env\(safe-area-inset-top\)[^}]*overflow:auto/);
  assert.match(mobile, /#report-dialog \.report-card\{[^}]*max-height:none[^}]*overflow:visible/);
  assert.match(mobile, /#voice-overlay\{[^}]*env\(safe-area-inset-top\)/);
  assert.match(mobile, /\.voice-shell\{max-height:calc\(100dvh/);
});

test('report dialog keeps one scroll surface and reachable actions at large text sizes', () => {
  assert.match(styles, /#report-dialog\{[^}]*overflow:auto[^}]*scroll-padding-block/);
  assert.match(styles, /\.report-card\{[^}]*max-height:none[^}]*overflow:visible/);
  assert.match(styles, /\.report-card textarea,[^}]*scroll-margin-block/);
});

test('welcome screen keeps compact iPhone controls and 16px form inputs', () => {
  assert.match(welcome, /html,body\{[^}]*overflow-x:hidden/);
  assert.match(welcome, /html,body\{[^}]*-webkit-text-size-adjust:100%/);
  assert.match(welcome, /#waitlist-form input\{font-size:16px\}/);
  assert.match(welcome, /\.cta-row\{display:grid;grid-template-columns:1fr 1fr/);
});

test('native bundle uses the polished CSS revision and replacement 1.1 build', () => {
  assert.match(index, /mobile\.css\?v=20261022c/);
  assert.equal((project.match(/CURRENT_PROJECT_VERSION = 20261027;/g) || []).length, 2);
  assert.equal((project.match(/MARKETING_VERSION = 1\.1;/g) || []).length, 2);
});
