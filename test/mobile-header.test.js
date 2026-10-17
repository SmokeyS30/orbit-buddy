import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mobileCss = fs.readFileSync(path.join(root, 'public', 'mobile.css'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

// Extract the mobile header-compaction media block for focused assertions.
const block = mobileCss.match(/\/\* --- Mobile header compaction[\s\S]*?\n\}/);
assert.ok(block, 'mobile.css must contain the Mobile header compaction block');
const css = block[0];

test('mobile header stops iOS text inflation', () => {
  assert.match(css, /-webkit-text-size-adjust:\s*100%/);
  assert.match(css, /\.topbar,\s*\.tabs/);
});

test('mobile header is compacted (padding, brand, avatar)', () => {
  assert.match(css, /\.topbar\{[^}]*padding-bottom:\s*12px/);
  assert.match(css, /\.brand-mark\{[^}]*width:\s*30px/);
  assert.match(css, /\.brand strong\{[^}]*font-size:\s*15px/);
  assert.match(css, /\.brand small\{[^}]*font-size:\s*11px/);
});

test('mobile account button is constrained', () => {
  assert.match(css, /#account-button\{[^}]*max-width:\s*38vw/);
  assert.match(css, /#account-button\{[^}]*text-overflow:\s*ellipsis/);
});

test('mobile tab bar scrolls cleanly without clipping', () => {
  assert.match(css, /\.tabs\{[^}]*overflow-x:\s*auto/);
  assert.match(css, /\.tabs\{[^}]*overscroll-behavior-x:\s*contain/);
  // Tabs size to content (flex:0 0 auto) so the strip scrolls instead of clipping.
  assert.match(css, /\.tabs \.tab\{[^}]*flex:\s*0 0 auto/);
});

test('launch always lands on the welcome (today) screen', () => {
  assert.match(
    appJs,
    /Launch always lands on the welcome screen[\s\S]*?activateView\('today',\{updateHash:false\}\)/,
    'app.js must activate the today view on launch'
  );
});

test('launch clears any stale hash', () => {
  assert.match(
    appJs,
    /if\(location\.hash\)history\.replaceState\(null,'',location\.pathname\+location\.search\)/
  );
});

test('in-app hash navigation still works after launch', () => {
  assert.match(
    appJs,
    /addEventListener\('hashchange',\(\)=>activateView\(location\.hash\.slice\(1\),\{updateHash:false\}\)\)/
  );
});

test('mobile form fields stay at 16px to prevent iOS focus zoom', () => {
  const zoomBlock = mobileCss.match(/\/\* --- Prevent iOS auto-zoom[\s\S]*?\n\}/);
  assert.ok(zoomBlock, 'mobile.css must contain the anti-zoom block');
  const css = zoomBlock[0];
  assert.match(css, /@media\s*\(\s*max-width:\s*760px\s*\)/);
  assert.match(css, /input,textarea,select\{[^}]*font-size:\s*16px/);
});

test('mobile text-size-adjust is applied page-wide', () => {
  const zoomBlock = mobileCss.match(/\/\* --- Prevent iOS auto-zoom[\s\S]*?\n\}/);
  assert.ok(zoomBlock, 'mobile.css must contain the anti-zoom block');
  const css = zoomBlock[0];
  assert.match(css, /html\{[^}]*-webkit-text-size-adjust:\s*100%/);
  assert.match(css, /html\{[^}]*text-size-adjust:\s*100%/);
});
