import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createVoiceMode } from '../public/voice-mode.js';
import {
  isNativeRuntime,
  nativeRuntimeInfo,
  shouldUseWebSpeech,
} from '../public/native-runtime.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

function runtime(overrides = {}) {
  return {
    location: { protocol: 'https:', ...(overrides.location || {}) },
    navigator: {
      userAgent: 'Mozilla/5.0 desktop',
      platform: 'Linux x86_64',
      maxTouchPoints: 0,
      ...(overrides.navigator || {}),
    },
    ...overrides,
  };
}

test('capacitor scheme is native even when the bridge global is missing', () => {
  const win = runtime({ location: { protocol: 'capacitor:' } });
  assert.equal(isNativeRuntime(win), true);
  assert.equal(shouldUseWebSpeech(win), false);
});

test('native bridge is sufficient even when Capacitor reports web', () => {
  const win = runtime({
    Capacitor: { getPlatform: () => 'web', isNativePlatform: () => false },
    webkit: { messageHandlers: { bridge: {} } },
  });
  const info = nativeRuntimeInfo(win);
  assert.equal(info.bridgePresent, true);
  assert.equal(info.native, true);
  assert.equal(shouldUseWebSpeech(win), false);
});

test('iPhone and iPadOS stay off Web Speech without any Capacitor signal', () => {
  const iphone = runtime({ navigator: { userAgent: 'Mozilla/5.0 (iPhone)', platform: 'iPhone' } });
  const ipadDesktopUa = runtime({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 } });
  assert.equal(shouldUseWebSpeech(iphone), false);
  assert.equal(shouldUseWebSpeech(ipadDesktopUa), false);
});

test('ordinary desktop web may use Web Speech', () => {
  assert.equal(isNativeRuntime(runtime()), false);
  assert.equal(shouldUseWebSpeech(runtime()), true);
});

test('mic click gates speech recognition through the shared runtime classifier', () => {
  const start = appJs.indexOf('// Tap the mic: dictate into the composer');
  const end = appJs.indexOf('})();', start);
  assert.ok(start > -1 && end > start, 'mic button block must exist');
  const body = appJs.slice(start, end);
  const clickIdx = body.lastIndexOf("addEventListener('click'");
  const handler = body.slice(clickIdx);
  assert.match(handler, /if\(!shouldUseWebSpeech\(window\)\)\{openVoiceMode\(\);return;\}/);
  assert.ok(handler.indexOf('shouldUseWebSpeech(window)') < handler.indexOf('new SR()'));
});

function fakeClassList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    toggle: (name, force) => force ? values.add(name) : values.delete(name),
    contains: (name) => values.has(name),
  };
}

function fakeElement() {
  return {
    classList: fakeClassList(),
    dataset: {},
    textContent: '',
    scrollTop: 0,
    scrollHeight: 0,
    replaceChildren() {},
    appendChild() {},
    append() {},
    querySelector() { return null; },
    addEventListener() {},
  };
}

function installVoiceDom(win) {
  const ids = new Map([
    ['voice-overlay', fakeElement()],
    ['voice-orb', fakeElement()],
    ['voice-status', fakeElement()],
    ['voice-transcript', fakeElement()],
    ['voice-name', fakeElement()],
    ['voice-done', fakeElement()],
  ]);
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = win;
  globalThis.document = {
    body: { classList: fakeClassList() },
    getElementById: (id) => ids.get(id) || null,
  };
  return {
    ids,
    restore() {
      if (previous.window === undefined) delete globalThis.window;
      else globalThis.window = previous.window;
      if (previous.document === undefined) delete globalThis.document;
      else globalThis.document = previous.document;
    },
  };
}

function voiceDeps(isNative = () => false) {
  return {
    buddyName: () => 'Orbit',
    sendTurn: async () => '',
    transcribeAudio: async () => '',
    isNative,
  };
}

test('native controller never constructs SpeechRecognition', () => {
  let constructions = 0;
  class FakeRecognition { constructor() { constructions += 1; } }
  const win = runtime({
    location: { protocol: 'capacitor:' },
    navigator: { userAgent: 'Mozilla/5.0 (iPhone)', platform: 'iPhone' },
    SpeechRecognition: FakeRecognition,
  });
  const env = installVoiceDom(win);
  try {
    const controller = createVoiceMode(voiceDeps());
    controller.open();
    assert.equal(constructions, 0);
    assert.equal(env.ids.get('voice-status').textContent, 'Tap the mic, say your piece, tap again to send.');
    controller.close();
  } finally {
    env.restore();
  }
});

test('service-not-allowed behaviorally enters tap-to-record mode', () => {
  const instances = [];
  class FakeRecognition {
    constructor() { instances.push(this); }
    start() {}
    abort() { this.aborted = true; }
  }
  const win = runtime({ SpeechRecognition: FakeRecognition });
  const env = installVoiceDom(win);
  try {
    const controller = createVoiceMode(voiceDeps());
    controller.open();
    assert.equal(env.ids.get('voice-status').textContent, 'Listening…');
    assert.equal(instances.length, 1);
    instances[0].onerror({ error: 'service-not-allowed' });
    assert.equal(env.ids.get('voice-status').textContent, 'Tap the mic, say your piece, tap again to send.');
    assert.equal(instances[0].aborted, true);
    controller.close();
  } finally {
    env.restore();
  }
});
