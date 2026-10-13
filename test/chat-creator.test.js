import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStableDeveloperPrompt } from '../src/model.js';

// B2: chat is the universal creator (slash-free natural commands). These pins
// keep the confirm-in-chat guidance from being silently dropped.
test('developer prompt frames chat as the universal creator', () => {
  const prompt = buildStableDeveloperPrompt();
  assert.match(prompt, /universal creator/);
  assert.match(prompt, /track a goal to/);
});

test('developer prompt requires confirm-in-chat instead of guessing', () => {
  const prompt = buildStableDeveloperPrompt();
  assert.match(prompt, /Confirm in chat, never guess/);
  assert.match(prompt, /ONE short clarifying question/);
});

test('developer prompt keeps deletion in the tab UIs', () => {
  const prompt = buildStableDeveloperPrompt();
  assert.match(prompt, /Deletion stays in the tabs/);
  assert.match(prompt, /no delete tools in chat/);
});
