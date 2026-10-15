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

test('developer prompt routes chat deletion through confirm-in-chat', () => {
  const prompt = buildStableDeveloperPrompt();
  assert.match(prompt, /delete_goal\/delete_task\/delete_routine/);
  assert.match(prompt, /confirm_delete_approval/);
  assert.match(prompt, /explicit yes/);
  assert.match(prompt, /Never delete on a single ambiguous message/);
});

test('developer prompt frames chat as the universal manager for updates', () => {
  const prompt = buildStableDeveloperPrompt();
  assert.match(prompt, /universal manager/);
  assert.match(prompt, /move that deadline to Friday/);
});
