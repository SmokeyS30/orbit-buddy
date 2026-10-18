import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

// The mic-button IIFE: starts at the "Tap the mic" comment, ends at its "})();".
function micBlock() {
  const start = appJs.indexOf('// Tap the mic: dictate into the composer');
  assert.ok(start > -1, 'mic button block must exist');
  const end = appJs.indexOf('})();', start);
  assert.ok(end > -1, 'mic IIFE must close');
  return appJs.slice(start, end);
}

test('mic tap routes native to voice mode before ever touching Web Speech', () => {
  const body = micBlock();
  // Newer iOS exposes a SpeechRecognition constructor inside WKWebView whose
  // service is blocked: recognition.start() fails with "service-not-allowed".
  // The tap handler must check the live native platform first and send native
  // taps to voice mode (tap-to-record + server Whisper) without constructing SR.
  const clickIdx = body.lastIndexOf("addEventListener('click'");
  assert.ok(clickIdx > -1, 'mic click handler must exist');
  const handler = body.slice(clickIdx);
  const nativeCheck = handler.indexOf('isNative()');
  const newSR = handler.indexOf('new SR()');
  assert.ok(nativeCheck > -1, 'click handler must call isNative()');
  assert.ok(newSR === -1 || nativeCheck < newSR, 'isNative() must come before any new SR()');
  assert.match(handler, /if\(isNative\(\)\)\{openVoiceMode\(\);return;\}/);
});

test('mic block defines a live Capacitor native check, not eval-time only', () => {
  const body = micBlock();
  // IS_NATIVE is evaluated once at script load, before the Capacitor bridge
  // may be ready; the mic handler needs its own live check at tap time.
  assert.match(body, /const isNative=\(\)=>[^;]*isNativePlatform/);
});

test('mic button falls through to voice mode when the speech service is blocked', () => {
  const body = micBlock();
  // On iOS WKWebView the Web Speech constructor exists but the service is
  // blocked: instead of stranding the user on an error toast, open voice
  // mode, which falls back to tap-to-record + Whisper on its own.
  assert.match(
    body,
    /if\(event\.error==='service-not-allowed'\|\|event\.error==='not-allowed'\)\{openVoiceMode\(\);return;\}/
  );
});

test('voice mode falls back to tap-to-record when Web Speech hangs', () => {
  const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const src = fs.readFileSync(path.join(rootDir, 'public', 'voice-mode.js'), 'utf8');
  // A hang timer watches recognition.start(): if nothing fires (blocked
  // service in WKWebView), the user lands on tap-to-record + Whisper.
  assert.match(src, /const webSpeechHangTimer = setTimeout\(/);
  assert.match(src, /if \(state === 'listening'\) fallbackToTap\(\);/);
  assert.match(src, /const fallbackToTap = \(\) => \{[\s\S]{0,400}state = 'idle-tap'/);
});

test('voice mode service-not-allowed falls back instead of dead-ending', () => {
  const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const src = fs.readFileSync(path.join(rootDir, 'public', 'voice-mode.js'), 'utf8');
  const errBlock = src.slice(src.indexOf('recognition.onerror = (event) => {'));
  assert.ok(
    errBlock.indexOf('fallbackToTap()') > -1 &&
    errBlock.indexOf('fallbackToTap()') < errBlock.indexOf("if (err !== 'aborted')"),
    'service-not-allowed must trigger fallbackToTap()'
  );
  assert.doesNotMatch(
    errBlock.slice(0, errBlock.indexOf("if (err !== 'aborted')")),
    /Microphone is blocked/
  );
});
