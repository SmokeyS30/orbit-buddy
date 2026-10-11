import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isNearBottom, scrollToBottom, settleAtBottom, shouldSettleAtBottom } from '../public/chat-scroll.js';

test('isNearBottom distinguishes the bottom from conversation history', () => {
  const container = { scrollHeight: 1000, scrollTop: 700, clientHeight: 200 };
  assert.equal(isNearBottom(container), true);
  container.scrollTop = 400;
  assert.equal(isNearBottom(container), false);
});

test('scrollToBottom uses the exact bottom offset', () => {
  const container = { scrollHeight: 1000, scrollTop: 0, clientHeight: 200 };
  scrollToBottom(container);
  assert.equal(container.scrollTop, 800);
});

test('newly opened conversations always settle at the bottom', () => {
  assert.equal(shouldSettleAtBottom({ conversationChanged: true, hasMessages: true, wasNearBottom: false }), true);
  assert.equal(shouldSettleAtBottom({ conversationChanged: false, hasMessages: true, wasNearBottom: false }), false);
  assert.equal(shouldSettleAtBottom({ conversationChanged: false, hasMessages: true, wasNearBottom: true }), true);
});

test('settleAtBottom follows layout growth across animation frames', () => {
  const frames = [];
  const container = { scrollHeight: 500, scrollTop: 0, clientHeight: 200 };
  settleAtBottom(container, (callback) => frames.push(callback));
  assert.equal(container.scrollTop, 300);

  container.scrollHeight = 900;
  frames.shift()();
  assert.equal(container.scrollTop, 700);

  container.scrollHeight = 1200;
  frames.shift()();
  assert.equal(container.scrollTop, 1000);
});

test('conversation rendering avoids refresh and layout features that reset scroll', () => {
  const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const smoothCss = readFileSync(new URL('../public/smooth.css', import.meta.url), 'utf8');
  assert.doesNotMatch(appSource, /showSkeleton\(['"]messages['"]\)/);
  assert.match(appSource, /if\(name==='today'\)requestAnimationFrame\(\(\)=>settleAtBottom/);
  assert.doesNotMatch(smoothCss, /\.message\s*\{[^}]*content-visibility/s);
  assert.match(smoothCss, /#messages\s*\{[^}]*scroll-behavior:\s*auto/s);
});
