// Source-pattern tests for the StoreKit 2 client integration in public/app.js.
// These assert on the structure/order of the client code rather than running
// it (the StoreKit plugin only exists inside the native iOS runtime).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

// Slice one top-level declaration out of the bundle: everything from the
// start marker to the next line that begins a new top-level statement.
function fnSource(startMarker) {
  const start = SRC.indexOf(startMarker);
  assert.ok(start !== -1, `expected to find ${startMarker} in public/app.js`);
  const rest = SRC.slice(start);
  const boundary = rest.search(/\n(?:function |async function |let |const |var |\/\/ |\$\('#)/);
  return boundary === -1 ? rest : rest.slice(0, boundary);
}

const purchaseProductSrc = () => fnSource('async function purchaseProduct(');
const restorePurchasesSrc = () => fnSource('async function restorePurchases(');
const loadProductsSrc = () => fnSource('async function loadStoreKitProducts(');
const paywallSrc = () => fnSource('function showInlinePaywall(');
const sendChatSrc = () => fnSource('async function sendChatMessage(');

test('(a) purchase flow calls purchase-intent before the StoreKit purchase, verify after', () => {
  const src = purchaseProductSrc();
  const intent = src.indexOf('/api/subscriptions/purchase-intent');
  const purchase = src.indexOf("nativePromise('StoreKit','purchase'");
  const verify = src.indexOf('/api/subscriptions/verify');
  assert.ok(intent !== -1, 'purchaseProduct must POST purchase-intent');
  assert.ok(purchase !== -1, 'purchaseProduct must call the StoreKit purchase plugin method');
  assert.ok(verify !== -1, 'purchaseProduct must POST the signedTransaction to verify');
  assert.ok(intent < purchase, 'purchase-intent must run BEFORE the StoreKit purchase (binds appAccountToken)');
  assert.ok(purchase < verify, 'verify must run AFTER the StoreKit purchase');
});

test('(b) 402+paywall triggers the inline nudge, not the generic error toast', () => {
  const src = sendChatSrc();
  const branch = src.match(/else if\(isPaywallError\(error\)\)\{([^}]*)\}/);
  assert.ok(branch, 'sendChatMessage must have an isPaywallError(error) branch');
  assert.ok(branch[1].includes('showInlinePaywall()'), 'paywall branch must insert the inline nudge');
  assert.ok(!branch[1].includes('toast('), 'paywall branch must NOT show the generic error toast');
  assert.ok(!paywallSrc().includes('toast('), 'showInlinePaywall itself must never toast');
  assert.ok(!paywallSrc().includes('await refresh()'), 'paywall path must skip refresh() so the nudge is not wiped');
});

test('(c) no modal, dialog, or popup code in the paywall path', () => {
  const src = paywallSrc();
  for (const banned of ['showModal', 'alert(', 'confirm(', 'prompt(', 'window.open(', 'openBlankWindow', 'show(']) {
    assert.ok(!src.includes(banned), `showInlinePaywall must not use ${banned}`);
  }
  assert.ok(src.includes('paywall-nudge'), 'nudge must be an inline message element in the chat');
});

test('(d) every StoreKit call is gated behind the native check', () => {
  assert.ok(SRC.includes('function storeKitAvailable(){return isNativeRuntime(window)&&!!capStoreKitPlugin();}'),
    'storeKitAvailable() must mirror the nativePushAvailable() pattern');
  for (const [name, src] of [
    ['purchaseProduct', purchaseProductSrc()],
    ['restorePurchases', restorePurchasesSrc()],
    ['loadStoreKitProducts', loadProductsSrc()],
  ]) {
    assert.ok(src.includes('storeKitAvailable()'), `${name} must be gated behind storeKitAvailable()`);
  }
  assert.ok(purchaseProductSrc().startsWith('async function purchaseProduct(productId){\n  if(!storeKitAvailable())'),
    'purchaseProduct must bail out first thing when not native');
  assert.ok(restorePurchasesSrc().startsWith('async function restorePurchases(){\n  if(!storeKitAvailable())'),
    'restorePurchases must bail out first thing when not native');
});

test('(e) the signedTransaction / JWS payload is never logged', () => {
  assert.ok(!/console\.\w+\([^)]*signedTransaction/.test(SRC),
    'no console call may print the signedTransaction');
  assert.ok(SRC.includes('// Never log the signedTransaction or any JWS payload'),
    'the verify step must carry the no-logging note');
});
