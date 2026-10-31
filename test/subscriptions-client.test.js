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
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

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

test('Plans are reachable after sign-in without a quota error or entitlement check',()=>{
  assert.match(INDEX,/id="plans-button"[^>]*>Plans<\/button>/);
  assert.match(SRC,/\$\('#plans-button'\)\?\.addEventListener\('click',\(\)=>openMembershipExperience\(\)\)/);
  assert.match(SRC,/\$\('#plans-button'\)\.classList\.remove\('hidden'\)/);
  assert.ok(SRC.includes('const MEMBERSHIP_PLANS='));
});

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
  const finish = src.indexOf("nativePromise('StoreKit','finish'");
  assert.ok(finish > verify, 'transaction.finish must run only AFTER backend verification');
  assert.ok(src.includes('JSON.stringify({productId})'), 'purchase intent must bind the exact product on the server');
  assert.ok(src.includes('JSON.stringify({signedTransaction,appAccountToken,productId})'), 'purchase verification must include the server-issued binding token and product');
});

test('(b) 402+paywall preserves an inline return point and opens the membership page', () => {
  const src = sendChatSrc();
  const branch = src.match(/else if\(isPaywallError\(error\)\)\{([^}]*)\}/);
  assert.ok(branch, 'sendChatMessage must have an isPaywallError(error) branch');
  assert.ok(branch[1].includes('showInlinePaywall('), 'paywall branch must insert the inline return point');
  assert.ok(!branch[1].includes('toast('), 'paywall branch must NOT show the generic error toast');
  assert.ok(!paywallSrc().includes('toast('), 'showInlinePaywall itself must never toast');
  assert.ok(!paywallSrc().includes('await refresh()'), 'paywall path must skip refresh() so the nudge is not wiped');
});

test('(c) paywall uses a closable full-screen app page, never a system modal', () => {
  const src = paywallSrc();
  for (const banned of ['showModal', 'alert(', 'confirm(', 'prompt(', 'window.open(', 'openBlankWindow', 'show(']) {
    assert.ok(!src.includes(banned), `showInlinePaywall must not use ${banned}`);
  }
  assert.ok(src.includes('paywall-nudge'), 'nudge must be an inline message element in the chat');
  assert.ok(src.includes('openMembershipExperience()'), 'nudge must transition to the dedicated membership page');
  const openSrc = fnSource("function openMembershipExperience(");
  assert.ok(openSrc.includes("setAttribute('role','region')"));
  assert.ok(!openSrc.includes("setAttribute('role','dialog')"));
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

test('(f) native plugin sends the real StoreKit JWS and is compiled/registered', () => {
  const swift = fs.readFileSync(path.join(ROOT, 'ios', 'App', 'App', 'StoreKitPlugin.swift'), 'utf8');
  const bridge = fs.readFileSync(path.join(ROOT, 'ios', 'App', 'App', 'OrbitBridgeViewController.swift'), 'utf8');
  const project = fs.readFileSync(path.join(ROOT, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'), 'utf8');
  assert.match(swift, /CAPPlugin, CAPBridgedPlugin/);
  assert.match(swift, /verification\.jwsRepresentation/);
  assert.match(swift, /update\.jwsRepresentation/);
  assert.doesNotMatch(swift, /transaction\.jsonRepresentation/);
  assert.match(swift, /CAPPluginMethod\(name: "finish"/);
  assert.match(bridge, /registerPluginInstance\(StoreKitPlugin\(\)\)/);
  assert.match(project, /StoreKitPlugin\.swift in Sources/);
  assert.match(project, /OrbitBridgeViewController\.swift in Sources/);
});

test('(g) subscription plans include Apple renewal disclosure and account links', () => {
  assert.ok(SRC.includes('Subscriptions renew automatically unless canceled at least 24 hours before the current period ends.'));
  const disclosureStart = SRC.indexOf('function appendSubscriptionDisclosure');
  const disclosureEnd = SRC.indexOf('let subProductsCache', disclosureStart);
  const disclosure = SRC.slice(disclosureStart, disclosureEnd);
  const links = [...disclosure.matchAll(/\['([^']+)','([^']+)'\]/g)].map((match) => match.slice(1));
  assert.deepEqual(links, [
    ['Manage subscriptions', 'https://apps.apple.com/account/subscriptions'],
    ['Terms', 'https://orbitbuddy.app/terms'],
    ['Privacy', 'https://orbitbuddy.app/privacy'],
  ]);
  const footer = fnSource('function membershipFooter(');
  assert.ok(footer.includes('appendSubscriptionDisclosure(root)'));
});

test('(h) membership chooser is paid-only and subscriptions are removed from Safety', () => {
  const catalogStart = SRC.indexOf('const MEMBERSHIP_PLANS=');
  const catalogEnd = SRC.indexOf('function formatStoreKitPrice', catalogStart);
  const catalog = SRC.slice(catalogStart, catalogEnd);
  for (const name of ["name:'Basic'", "name:'Plus'", "name:'Unlimited'"]) assert.ok(catalog.includes(name));
  assert.ok(!catalog.includes("name:'Free'"));
  assert.ok(catalog.includes('com.smokeys30.orbitbuddy.basic.monthly'));
  assert.ok(!INDEX.includes('id="subscriptions-button"'));
  assert.ok(!INDEX.includes('<h2>Subscriptions</h2>'));
});
