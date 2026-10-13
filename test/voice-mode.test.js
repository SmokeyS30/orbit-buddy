import test from 'node:test';
import assert from 'node:assert/strict';

import { isVoiceModeCommand, speechText, pickVoice } from '../public/voice-mode.js';

test('isVoiceModeCommand matches explicit voice-mode invocations', () => {
  for (const cmd of ['call Orbit', 'Call orbit!', 'call you', 'phone Orbit', 'ring you', 'voice mode', 'voice chat', "let's talk", 'lets talk', 'talk to me']) {
    assert.equal(isVoiceModeCommand(cmd), true, JSON.stringify(cmd));
  }
});

test('isVoiceModeCommand rejects ordinary chat text', () => {
  for (const text of ['', 'call your mom', 'recall orbit', 'voice input', 'voice note', 'what is the weather', 'call orbit and tell me the weather', 'a voice mode would be nice']) {
    assert.equal(isVoiceModeCommand(text), false, JSON.stringify(text));
  }
});

test('speechText strips code fences instead of reading code aloud', () => {
  const out = speechText('Here is the fix:\n```js\nconst a = 1;\n```\nDone.');
  assert.ok(!out.includes('```'), 'no fence markers');
  assert.ok(!out.includes('const a'), 'no code content');
  assert.match(out, /fix/i);
});

test('speechText converts markdown to flowing sentences', () => {
  const out = speechText('## Plan\n\n**Bold** move and *italic* aside.\n\n- one\n- two\n\n[Orbit](https://orbitbuddy.app) rocks.');
  assert.match(out, /Plan\./);
  assert.ok(!out.includes('**'), 'no bold markers');
  assert.ok(!out.includes('['), 'no link brackets');
  assert.match(out, /one/);
  assert.match(out, /Orbit rocks/);
});

test('speechText flattens tables to comma phrases', () => {
  const out = speechText('| A | B |\n|---|---|\n| 1 | 2 |');
  assert.ok(!out.includes('|'), 'no pipes');
  assert.match(out, /A, B/);
  assert.match(out, /1, 2/);
});

test('speechText caps very long replies for TTS sanity', () => {
  const out = speechText('word '.repeat(1000));
  assert.ok(out.length <= 1600, `length ${out.length}`);
  assert.ok(out.endsWith('…'), 'ends with ellipsis');
});

test('speechText handles empty input', () => {
  assert.equal(speechText(''), '');
  assert.equal(speechText(null), '');
});

test('pickVoice prefers a natural en-US voice', () => {
  const voices = [
    { name: 'Daniel', lang: 'en-GB', localService: true, default: true },
    { name: 'Samantha', lang: 'en-US', localService: true, default: false },
    { name: 'Google US English', lang: 'en-US', localService: false, default: false },
  ];
  assert.equal(pickVoice(voices).name, 'Samantha');
});

test('pickVoice skips novelty voices', () => {
  const voices = [
    { name: 'Zarvox', lang: 'en-US', localService: true, default: true },
    { name: 'Alex', lang: 'en-US', localService: true, default: false },
  ];
  assert.equal(pickVoice(voices).name, 'Alex');
});

test('pickVoice returns null when there are no voices', () => {
  assert.equal(pickVoice([]), null);
  assert.equal(pickVoice(null), null);
});
