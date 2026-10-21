import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const section=app.slice(app.indexOf('let nativePushListenersAttached='),app.indexOf('// --- Subscriptions:')).replace(/updatePushButton\(\);\s*$/,'');
function fixture({native=true,permission='prompt',requested='granted',configured=true,uploadFails=false,subscribed=false}={}){
  const {document}=parseHTML(html),button=document.getElementById('enable-push'),status=document.getElementById('push-setup-status');
  const calls=[],requests=[],events={},timers=[];let click,visibility,subscription=subscribed?{endpoint:'https://push.example/id',keys:{}}:null;
  button.addEventListener=(_event,fn)=>{click=fn;};document.addEventListener=(_event,fn)=>{visibility=fn;};
  const cap={isPluginAvailable:()=>true,addListener:(_plugin,event,fn)=>{events[event]=fn;},nativePromise:async(_plugin,method)=>{calls.push(method);if(method==='requestPermissions')permission=requested;return {receive:permission};}};
  const state={user:{id:'user-1'}};
  const context={document,window:{Capacitor:cap,PushManager:{}},navigator:{serviceWorker:{ready:Promise.resolve({pushManager:{getSubscription:async()=>subscription,subscribe:async()=>{calls.push('subscribe');return subscription={endpoint:'https://push.example/id',keys:{}};}}})}},Notification:{get permission(){return permission;},requestPermission:async()=>{permission=requested;return permission;}},state,$:selector=>document.querySelector(selector),isNativeRuntime:()=>native,toast:()=>{},setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout:()=>{},atob,
    api:async(url,options)=>{requests.push({url,body:options?.body?JSON.parse(options.body):null});if(url==='/api/push/public-key')return {configured,publicKey:'AA'};if(uploadFails)throw new Error('Upload failed');return {ok:true,configured};}};
  vm.createContext(context);vm.runInContext(section,context);
  return {button,status,calls,requests,events,timers,state,context,click:()=>click(),update:()=>context.updatePushButton(),resume:async()=>{visibility();await new Promise(r=>setImmediate(r));},permission:value=>{permission=value;}};
}
const enabled=f=>{assert.equal(f.button.textContent,'Notifications Enabled');assert.equal(f.button.disabled,true);};
const available=f=>{assert.equal(f.button.textContent,'Enable Notifications');assert.equal(f.button.disabled,false);};

test('initial enable control is actionable; permission alone does not claim success; verified registration disables it without sending a test',async()=>{
  const f=fixture();await f.update();available(f);
  await f.click();assert.equal(f.button.disabled,true);assert.equal(f.button.textContent,'Enabling Notifications…');
  assert.deepEqual(f.calls.slice(-2),['requestPermissions','register']);assert.equal(f.requests.length,0);
  await f.events.registration({value:'a'.repeat(64)});enabled(f);
  assert.deepEqual(f.requests[0].body,{token:'a'.repeat(64),verifyDelivery:false});
  const count=f.calls.length;await f.click();assert.equal(f.calls.length,count);
  assert.equal(f.button.getAttribute('aria-describedby'),'push-setup-status');
  const css=fs.readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');assert.match(css,/#enable-push:disabled\{[^}]*background:var\(--panel2\)[^}]*color:var\(--muted\)/);
  assert.doesNotMatch(section,/Send test notification|verifyDelivery:true|test sent/i);
});

test('denied native permission gives settings guidance without registering or claiming enabled',async()=>{
  const f=fixture({requested:'denied'});await f.click();available(f);assert.match(f.status.textContent,/Settings/);assert.ok(!f.calls.includes('register'));assert.equal(f.requests.length,0);
});

test('native registration failures, missing token, server failure and missing configuration stay retryable',async()=>{
  for(const options of [{error:true},{empty:true},{uploadFails:true},{configured:false}]){
    const f=fixture(options);await f.click();
    if(options.error)f.events.registrationError({error:'Apple rejected registration'});
    else await f.events.registration({value:options.empty?'':'b'.repeat(64)});
    available(f);assert.ok(f.status.textContent.length>0);
  }
});

test('repeated clicks do not duplicate registration; timeout never reports success',async()=>{
  const f=fixture();const first=f.click();await f.click();await first;
  assert.equal(f.calls.filter(x=>x==='register').length,1);f.timers.at(-1)();available(f);assert.match(f.status.textContent,/timed out/);
  await f.events.registration({value:'a'.repeat(64)});assert.equal(f.requests.length,0,'late callback after timeout is ignored');
});

test('reload re-registers an already-permitted device without a permission prompt; resume detects revocation',async()=>{
  const f=fixture({permission:'granted'});await f.update();available(f);
  await f.context.setupNativePush();assert.ok(f.calls.includes('register'));assert.ok(!f.calls.includes('requestPermissions'));
  await f.events.registration({value:'a'.repeat(64)});enabled(f);
  f.permission('denied');await f.resume();available(f);assert.match(f.status.textContent,/Settings/);
});

test('account changes before registration or during upload cannot mark the new account enabled',async()=>{
  const f=fixture();await f.click();f.state.user={id:'other-user'};
  await f.events.registration({value:'a'.repeat(64)});assert.equal(f.requests.length,0);
  f.timers.at(-1)();available(f);
  const uploading=fixture();await uploading.click();let finish;
  uploading.context.api=()=>new Promise(resolve=>{finish=resolve;});
  const pending=uploading.events.registration({value:'a'.repeat(64)});
  uploading.state.user={id:'other-user'};finish({ok:true,configured:true});await pending;
  uploading.timers.at(-1)();available(uploading);
});

test('web setup confirms server subscription before enabled; denied or failed upload stays retryable',async()=>{
  const f=fixture({native:false});await f.update();available(f);await f.click();enabled(f);
  assert.ok(f.requests.some(r=>r.url==='/api/push/subscribe'));
  for(const options of [{requested:'denied'},{uploadFails:true}]){const failed=fixture({native:false,...options});await failed.click();available(failed);await failed.update();available(failed);}
});

test('existing web subscription is refreshed on authenticated reload; revoked permission clears enabled state',async()=>{
  const f=fixture({native:false,permission:'granted',subscribed:true});await f.update();available(f);
  await f.context.setupWebPush();enabled(f);assert.equal(f.requests.length,1);
  f.permission('denied');await f.resume();available(f);assert.match(f.status.textContent,/browser settings/);
});

test('foreground notifications remain visible and native setup remains tied to authenticated connect',async()=>{
  const f=fixture();await f.context.setupNativePush();assert.equal(typeof f.events.pushNotificationReceived,'function');
  assert.match(app,/if\(isNativeRuntime\(window\)\)setupNativePush\(\);else setupWebPush\(\);/);
});
