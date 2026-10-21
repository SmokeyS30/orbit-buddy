import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';

const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const start=app.indexOf('function showNotificationSettings()');
const section=app.slice(start,app.indexOf('// --- Subscriptions:',start)).replace(/updatePushButton\(\);\s*$/,'');
function fixture({permission='granted',registered=true,native=true}={}){
  const {document}=parseHTML(html),button=document.getElementById('enable-push');let click;
  button.addEventListener=(_event,handler)=>{click=handler;};
  const calls=[];
  const cap={nativePromise:async(_plugin,method)=>{calls.push(method);return {receive:permission};}};
  const context={window:{PushManager:{}},navigator:{serviceWorker:{ready:Promise.resolve({pushManager:{getSubscription:async()=>registered?{}:null}})}},$:selector=>document.querySelector(selector),isNativeRuntime:()=>native,waitForNativePushPlugin:async()=>cap,apnsRegistered:()=>registered,attachNativePushListeners:()=>{},toast:()=>{},pushRegistrationPending:false,setTimeout:()=>{},api:()=>assert.fail('must not send an API request')};
  vm.createContext(context);vm.runInContext(section,context);
  return {button,label:document.getElementById('notification-settings'),calls,click:()=>click(),update:()=>context.updatePushButton()};
}

test('Safety replaces the test button with a gray non-interactive Notification Settings label',async()=>{
  const f=fixture();await f.update();
  assert.equal(f.label.textContent,'Notification Settings');assert.equal(f.label.tagName,'SPAN');
  assert.equal(f.label.classList.contains('muted'),true);assert.equal(f.label.classList.contains('hidden'),false);
  assert.equal(f.label.hasAttribute('tabindex'),false);assert.equal(f.label.hasAttribute('role'),false);
  assert.equal(f.button.classList.contains('hidden'),true);assert.equal(f.button.disabled,true);
  assert.doesNotMatch(app,/Send test notification/i);
  f.calls.length=0;await f.click();assert.deepEqual(f.calls,[],'even a manually dispatched hidden handler cannot request permission/register/send');
});

test('a stale enabled button rechecks native setup and cannot request a test push',async()=>{
  const f=fixture();f.button.disabled=false;await f.click();
  assert.equal(f.button.disabled,true);assert.ok(f.calls.includes('checkPermissions'));
  assert.ok(!f.calls.includes('requestPermissions'));assert.ok(!f.calls.includes('register'));
});

test('first-time permission and device registration remain available',async()=>{
  const f=fixture({registered:false});await f.update();
  assert.equal(f.button.disabled,false);assert.equal(f.button.textContent,'Enable on this device');assert.equal(f.label.classList.contains('hidden'),true);
  await f.click();assert.ok(f.calls.includes('requestPermissions'));assert.ok(f.calls.includes('register'));
});

test('existing web subscriptions also show the neutral label without a test action',async()=>{
  const f=fixture({native:false});await f.update();
  assert.equal(f.label.classList.contains('hidden'),false);assert.equal(f.button.disabled,true);
  await f.click();assert.deepEqual(f.calls,[]);
});

test('revoked native permission retains a usable setup control instead of a misleading enabled status',async()=>{
  const f=fixture({permission:'prompt'});await f.update();
  assert.equal(f.label.classList.contains('hidden'),true);assert.equal(f.button.disabled,false);
  assert.equal(f.button.textContent,'Enable on this device');
});
