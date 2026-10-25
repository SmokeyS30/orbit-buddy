import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const desktop = fs.readFileSync(new URL('../public/desktop.css', import.meta.url), 'utf8');
const mobile = fs.readFileSync(new URL('../public/mobile.css', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const chatScroll = fs.readFileSync(new URL('../public/chat-scroll.js', import.meta.url), 'utf8');
const plist = fs.readFileSync(new URL('../ios/App/App/Info.plist', import.meta.url), 'utf8');

// The stage-1 adaptive tier is everything from its media query to end of file
// (it is appended last in desktop.css so it wins the cascade in its range).
const duoStart = desktop.indexOf('@media(min-width:761px) and (max-width:1023px)');
const duo = duoStart >= 0 ? desktop.slice(duoStart) : '';

test('an intermediate tier fills the 761-1023px gap (unfolded Duo / large panes)', () => {
  assert.ok(duoStart >= 0, 'intermediate tier media query missing from desktop.css');
  // Tab bar wraps instead of scrolling, mirroring the >=1024px desktop tier.
  assert.match(duo, /\.tabs\{overflow:visible;flex-wrap:wrap\}/);
  assert.match(duo, /\.tab\{flex:1 1 auto;min-width:90px\}/);
  // Two-pane hero kept, scaled down from desktop; forms drop to two columns.
  assert.match(duo, /\.hero-card\{grid-template-columns:240px 1fr;padding:34px 40px\}/);
  assert.match(duo, /\.form-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
  // Chat column gets a little more height and slightly narrower bubbles than base.
  assert.match(duo, /\.messages\{max-height:520px\}/);
  assert.match(duo, /\.message\{max-width:78%\}/);
});

test('intermediate tier respects the foldable inner-display safe areas', () => {
  assert.match(duo, /\.shell\{[^}]*env\(safe-area-inset-left\)[^}]*env\(safe-area-inset-right\)/);
});

test('phone and desktop tiers are untouched by the intermediate tier', () => {
  assert.match(desktop, /@media\(min-width:1024px\)\{\s*\.tabs\{overflow:visible;flex-wrap:wrap\}/);
  assert.match(desktop, /@media\(min-width:1400px\)\{\s*\.shell\{width:min\(1320px,calc\(100% - 48px\)\)\}/);
  assert.match(mobile, /@media\(max-width:760px\)/);
  assert.match(mobile, /@media\(max-width:380px\)/);
  // The intermediate tier exists exactly once, so its rules cannot leak
  // into phone or desktop widths through a second unbounded block.
  assert.equal(desktop.split('@media(min-width:761px)').length - 1, 1);
});

test('chat stays bottom-anchored in every tier', () => {
  // The tier must not restack the message column or reorder the composer;
  // bottom-anchoring is the column direction plus the JS scroll-to-bottom.
  assert.ok(!duo.includes('flex-direction'), 'duo tier must not change flex direction');
  assert.ok(!duo.includes('.composer'), 'duo tier must not touch the composer');
  assert.match(styles, /\.messages\{display:flex;flex-direction:column/);
  assert.match(chatScroll, /container\.scrollTop = Math\.max\(0, container\.scrollHeight - container\.clientHeight\)/);
});

test('Split View stays off until the multi-scene bridge audit is done on a Mac', () => {
  // Deliberate stage-1 decision, see docs/duo-stage1-notes.md: each scene
  // would spawn its own Capacitor bridge with fresh StoreKit/App Attest
  // plugin instances, and that cannot be verified without Xcode + hardware.
  assert.match(plist, /UIApplicationSupportsMultipleScenes<\/key>\s*<false\/>/);
});
