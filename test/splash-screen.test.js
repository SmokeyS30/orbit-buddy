import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

function readPublic(name) {
  return fs.readFileSync(path.join(repoRoot, 'public', name), 'utf8');
}

test('splash screen markup is present in index.html', () => {
  const html = readPublic('index.html');
  assert.ok(html.includes('id="orbit-splash"'), 'splash overlay div exists');
  assert.ok(html.includes('splash-orb'), 'orbit orb element exists');
  assert.ok(html.includes('splash-ring'), 'orbit rings exist');
  assert.ok(html.includes('splash-brand'), 'brand block exists');
  assert.ok(html.includes('splash-loader'), 'loading bar exists');
  assert.ok(html.includes('warming up your universe'), 'tagline exists');
  assert.ok(html.includes('Orbit Buddy'), 'brand name exists');
});

test('splash CSS uses the welcome-page palette', () => {
  const html = readPublic('index.html');
  assert.ok(html.includes('#0b0d17'), 'deep navy background color present');
  assert.ok(html.includes('#232a5e'), 'purple radial glow present');
  assert.ok(html.includes('#6c8cff'), 'periwinkle accent present');
  assert.ok(html.includes('#8b5cf6'), 'violet accent present');
});

test('splash signals completion for the welcome redirect', () => {
  const html = readPublic('index.html');
  assert.ok(html.includes("__orbitSplashComplete=true"), 'splash sets completion flag');
  assert.ok(html.includes("orbit-splash-done"), 'splash dispatches done event');
  const appJs = readPublic('app.js');
  assert.ok(appJs.includes("orbit-splash-done"), 'app waits for splash before welcome redirect');
});

test('splash hides on a timer with a hard cap', () => {
  const html = readPublic('index.html');
  // 5s display timer
  assert.ok(html.includes('setTimeout(hide,10000)'), 'splash hides after ~10s');
  // Fade-out class + DOM removal
  assert.ok(html.includes('splash-hide'), 'fade-out class exists');
  assert.ok(html.includes('removeChild(splash)'), 'splash removed from DOM after fade');
  // Never blocks the app if something fails
  assert.ok(html.includes('splash must never break the app'), 'splash errors are swallowed');
});

test('splash generates a starfield', () => {
  const html = readPublic('index.html');
  assert.ok(html.includes('splash-stars'), 'star container exists');
  assert.ok(html.includes('splash-star'), 'star CSS class exists');
  assert.ok(html.includes('splash-twinkle'), 'twinkle animation exists');
});

test('splash respects reduced-motion preferences', () => {
  const html = readPublic('index.html');
  assert.ok(html.includes('prefers-reduced-motion'), 'reduced-motion media query present');
});

test('splash exposes an early-dismiss hook for the app', () => {
  const html = readPublic('index.html');
  assert.ok(html.includes('__orbitSplashDone'), 'app can dismiss splash early when ready');
});

test('Support return removes the splash synchronously before app modules load', () => {
  const html = readPublic('index.html');
  const supportGuard = html.indexOf("if(window.__orbitSupportReturnView==='safety')");
  const appModule = html.search(/<script type="module" src="\/app\.js\?v=[^"]+"><\/script>/);
  assert.ok(supportGuard > -1, 'inline Support-return guard exists');
  assert.ok(appModule > supportGuard, 'guard runs before app.js');
  assert.match(html, /__orbitSupportReturnView==='safety'[\s\S]*?removeChild\(splash\)[\s\S]*?__orbitSplashComplete=true[\s\S]*?return;/);

  const appJs = readPublic('app.js');
  assert.match(appJs, /function dismissSplashForSupportReturn\(\)[\s\S]*?removeChild\(splash\)[\s\S]*?__orbitSplashComplete=true/);
  assert.match(appJs, /if\(view==='safety'\)dismissSplashForSupportReturn\(\);[\s\S]*?classList\.remove\('orbit-support-returning'\)/);

  const controller = html.match(/<script>\s*(\/\/ Splash screen: stars \+ timed fade-out\.[\s\S]*?)<\/script>/)?.[1];
  assert.ok(controller, 'inline splash controller is extractable');
  let removed = false;
  const splash = { parentNode: { removeChild(node) { removed = node === splash; } } };
  const window = { __orbitSupportReturnView: 'safety' };
  vm.runInNewContext(controller, {
    window,
    document: { getElementById: (id) => id === 'orbit-splash' ? splash : null },
  });
  assert.equal(removed, true, 'Support return removes the splash immediately');
  assert.equal(window.__orbitSplashComplete, true, 'Support return marks launch animation complete');
});

test('iOS launch screen uses dark background (no white flash)', () => {
  const storyboard = fs.readFileSync(
    path.join(repoRoot, 'ios/App/App/Base.lproj/LaunchScreen.storyboard'), 'utf8');
  // #0b0d17 = rgb(11, 13, 23) ≈ (0.043, 0.051, 0.090)
  assert.ok(storyboard.includes('0.0431372549'), 'launch screen background is dark navy');
  assert.ok(!storyboard.includes('systemColor="systemBackgroundColor"'),
    'launch screen no longer uses system (white) background');
});
