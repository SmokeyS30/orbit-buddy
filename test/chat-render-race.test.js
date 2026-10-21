import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the actual app function with a controlled lazy-import boundary.
// DOM counters measure rebuilds, not browser layout or device latency.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const renderSource = source.slice(source.indexOf("let lastMessageFingerprint="), source.indexOf('// --- W1:'));
function harness() {
  let composing = false;
  const loads = [];
  const root = { rebuilds: 0, children: [], replaceChildren() { this.rebuilds++; this.children=[]; }, append(el) { this.children.push(el); } };
  const context = vm.createContext({
    state: { snapshot: { activeConversation: { id: 'a' } } }, activeConversationId: 'a', typingActive: false,
    document: { getElementById: () => root, createElement: () => ({ dataset: {} }) },
    loadCanvas: () => new Promise(resolve => loads.push(resolve)), isComposing: () => composing,
    isNearBottom: () => false, shouldSettleAtBottom: () => false,
    buildMessageActionRow() {}, empty() {},
  });
  vm.runInContext(renderSource, context);
  return { context, root, loads, composing(value) { composing=value; }, render: items => context.renderMessages(items) };
}
const message = (id, content='hello') => ({ id, content, role: 'user' });

test('typing during a pending chunk load prevents rebuilding history and allows an idle retry', async () => {
  const h=harness();
  const pending=h.render([message('1')]);
  h.composing(true); h.loads.shift()(null); await pending;
  assert.equal(h.root.rebuilds, 0);
  h.composing(false);
  const retry=h.render([message('1')]);
  assert.equal(h.loads.length, 1, 'deferred fingerprint must not suppress retry');
  h.loads.shift()(null); await retry;
  assert.equal(h.root.rebuilds, 1);
});

test('an older render cannot overwrite a newer snapshot when chunk promises resolve out of order', async () => {
  const h=harness();
  const old=h.render([message('1', 'old')]);
  const latest=h.render([message('2', 'latest')]);
  h.loads[1](null); await latest;
  h.loads[0](null); await old;
  assert.equal(h.root.rebuilds, 1);
  assert.equal(h.root.children[0].textContent, 'latest');
});

test('switching conversation during chunk load discards the previous history', async () => {
  const h=harness();
  const pending=h.render([message('1')]);
  h.context.state.snapshot.activeConversation.id='b';
  h.loads.shift()(null); await pending;
  assert.equal(h.root.rebuilds, 0);
});

test('unchanged idle history avoids another chunk load or DOM rebuild', async () => {
  const h=harness();
  const pending=h.render([message('1')]); h.loads.shift()(null); await pending;
  await h.render([message('1')]);
  assert.equal(h.loads.length, 0);
  assert.equal(h.root.rebuilds, 1);
});
