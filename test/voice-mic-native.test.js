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

test('desktop web also avoids unnamed browser speech services', () => {
  assert.equal(isNativeRuntime(runtime()), false);
  assert.equal(shouldUseWebSpeech(runtime()), false);
});

test('mic click opens consent-gated voice mode without browser recognition', () => {
  const start = appJs.indexOf('// The mic always opens consent-gated voice mode');
  const end = appJs.indexOf('})();', start);
  assert.ok(start > -1 && end > start, 'mic button block must exist');
  const body = appJs.slice(start, end);
  assert.match(body,/addEventListener\('click',openVoiceMode\)/);
  assert.doesNotMatch(body,/new\s+(?:SR|SpeechRecognition)\(/);
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

test('desktop controller never constructs a browser speech service', () => {
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
    assert.equal(env.ids.get('voice-status').textContent, 'Tap the mic, say your piece, tap again to send.');
    assert.equal(instances.length, 0);
    controller.close();
  } finally {
    env.restore();
  }
});

test('microphone tap records audio and uses the consent-gated transcription dependency', async () => {
  const win=runtime();
  const env=installVoiceDom(win);
  const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  const oldRecorder=Object.getOwnPropertyDescriptor(globalThis,'MediaRecorder');
  const stopped=[];
  let transcriptions=0;
  const sent=[];
  const stream={getTracks:()=>[{stop:()=>stopped.push(true)}]};
  class FakeRecorder {
    static isTypeSupported(){return true;}
    constructor(){this.state='inactive';this.mimeType='audio/webm';}
    start(){this.state='recording';}
    stop(){this.state='inactive';this.ondataavailable({data:new Blob(['synthetic audio'])});queueMicrotask(()=>this.onstop());}
  }
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>stream}}});
  Object.defineProperty(globalThis,'MediaRecorder',{configurable:true,value:FakeRecorder});
  globalThis.document.createElement=()=>fakeElement();
  try {
    const controller=createVoiceMode({buddyName:()=> 'Orbit',transcribeAudio:async blob=>{transcriptions++;assert.ok(blob.size>0);return 'synthetic transcript';},sendTurn:async text=>{sent.push(text);return '';}});
    controller.open();
    controller.interrupt();
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(env.ids.get('voice-status').textContent,'Recording… tap the mic to send.');
    controller.interrupt();
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(transcriptions,1);
    assert.deepEqual(sent,['synthetic transcript']);
    assert.equal(stopped.length,1);
    controller.close();
  } finally {
    if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else delete globalThis.navigator;
    if(oldRecorder)Object.defineProperty(globalThis,'MediaRecorder',oldRecorder);else delete globalThis.MediaRecorder;
    env.restore();
  }
});
