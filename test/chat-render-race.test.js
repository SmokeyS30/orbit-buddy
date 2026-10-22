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
    buildMessageActionRow() {}, empty() {}, appendTypingBubble() {},
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
  // Match renderThreads(): the selected ID changes immediately while the old
  // snapshot stays in state until the replacement refresh finishes.
  h.context.activeConversationId='b';
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

test('an edit of the same length still updates the visible message',async()=>{
  const h=harness();
  const first=h.render([message('1','old')]);h.loads.shift()(null);await first;
  const edited=h.render([message('1','new')]);h.loads.shift()(null);await edited;
  assert.equal(h.root.rebuilds,2);
  assert.equal(h.root.children[0].textContent,'new');
});

test('an active typing indicator does not rebuild unchanged long history',async()=>{
  const h=harness();h.context.typingActive=true;
  const items=Array.from({length:60},(_,i)=>message(String(i),'text'.repeat(100)));
  const first=h.render(items);h.loads.shift()(null);await first;
  for(let i=0;i<5;i++)await h.render(items);
  assert.equal(h.root.rebuilds,1);
  assert.equal(h.loads.length,0);
});

test('explicit navigation may render the chosen thread while keeping a draft',async()=>{
  const h=harness();h.composing(true);
  h.context.activeConversationId='b';h.context.state.snapshot.activeConversation.id='b';
  const loading=h.context.renderMessages([message('2','new thread')],{allowWhileComposing:true});
  h.loads.shift()(null);await loading;
  assert.equal(h.root.children[0].textContent,'new thread');
});
