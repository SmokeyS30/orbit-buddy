import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

test('splash hides on a timer with a hard cap', () => {
  const html = readPublic('index.html');
  // 5s display timer
  assert.ok(html.includes('setTimeout(hide,5000)'), 'splash hides after ~5s');
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

test('iOS launch screen uses dark background (no white flash)', () => {
  const storyboard = fs.readFileSync(
    path.join(repoRoot, 'ios/App/App/Base.lproj/LaunchScreen.storyboard'), 'utf8');
  // #0b0d17 = rgb(11, 13, 23) ≈ (0.043, 0.051, 0.090)
  assert.ok(storyboard.includes('0.0431372549'), 'launch screen background is dark navy');
  assert.ok(!storyboard.includes('systemColor="systemBackgroundColor"'),
    'launch screen no longer uses system (white) background');
});
