import test from 'node:test';
import assert from 'node:assert/strict';

import { isVoiceModeCommand, speechText, pickVoice, createBargeInDetector } from '../public/voice-mode.js';

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

test('bargeInDetector: sustained energy above threshold triggers once', () => {
  const d = createBargeInDetector();
  d.arm(0, 0.01); // Orbit's own voice level ≈ -40 dBFS; floor -30 dBFS dominates
  const out = [];
  for (let i = 0; i < 6; i++) out.push(d.sample(0.1, i * 50));
  assert.deepEqual(out, [false, false, false, false, false, true]);
  // Auto-disarmed after the trigger: further samples are ignored.
  assert.equal(d.isArmed(), false);
  assert.equal(d.sample(0.1, 400), false);
});

test('bargeInDetector: spike then drop does not trigger', () => {
  const d = createBargeInDetector();
  d.arm(0, 0.01);
  const out = [];
  for (let i = 0; i < 3; i++) out.push(d.sample(0.1, i * 50));      // 150ms spike (door slam)
  for (let i = 3; i < 10; i++) out.push(d.sample(0.005, i * 50));   // back below threshold
  assert.ok(out.every((x) => x === false), 'no trigger on a transient spike');
});

test('bargeInDetector: cooldown suppresses re-trigger', () => {
  const d = createBargeInDetector();
  d.arm(0, 0.01);
  let trig = false;
  for (let i = 0; i < 6; i++) trig = d.sample(0.1, i * 50);
  assert.equal(trig, true, 'fires at t=250ms');
  // Next utterance starts 150ms after the trigger: still inside the 1.5s
  // cooldown, so the tail of the user's own interruption can't re-fire.
  d.arm(400, 0.01);
  for (let i = 0; i < 6; i++) trig = d.sample(0.1, 400 + i * 50);
  assert.equal(trig, false, 'suppressed inside cooldown');
  // After the cooldown it works again.
  d.arm(2000, 0.01);
  for (let i = 0; i < 6; i++) trig = d.sample(0.1, 2000 + i * 50);
  assert.equal(trig, true, 'fires again after cooldown');
});

test('bargeInDetector: not-armed state ignores samples', () => {
  const d = createBargeInDetector();
  assert.equal(d.sample(0.9, 0), false, 'loud sample before arm is ignored');
  assert.equal(d.isArmed(), false);
  d.arm(0, 0.01);
  d.disarm();
  assert.equal(d.sample(0.9, 100), false, 'loud sample after disarm is ignored');
});

test('bargeInDetector: relative trigger adapts to speaker volume', () => {
  const d = createBargeInDetector({ floorDb: -60 }); // floor far below speaker level
  d.arm(0, 0.05); // Orbit's own voice ≈ -26 dBFS → threshold 2.5× = 0.125
  for (let i = 0; i < 6; i++) {
    assert.equal(d.sample(0.06, i * 50), false, 'Orbit-level energy never triggers');
  }
  d.arm(1000, 0.05);
  let trig = false;
  for (let i = 0; i < 6; i++) trig = d.sample(0.2, 1000 + i * 50);
  assert.equal(trig, true, 'user voice well above the speaking baseline triggers');
});

test('bargeInDetector: disarm before frames are complete resets the count', () => {
  const d = createBargeInDetector();
  d.arm(0, 0.01);
  for (let i = 0; i < 3; i++) assert.equal(d.sample(0.1, i * 50), false);
  d.disarm();
  d.arm(500, 0.01); // the 3 previous above-threshold frames must not carry over
  for (let i = 0; i < 5; i++) assert.equal(d.sample(0.1, 500 + i * 50), false);
  assert.equal(d.sample(0.1, 500 + 5 * 50), true);
});
