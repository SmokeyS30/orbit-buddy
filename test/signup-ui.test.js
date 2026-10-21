import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {renderAppleAuthControls,renderAppleLinkControl} from '../public/signup-ui.js';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');

test('actual auth DOM shows Apple controls only on native-ready matching auth modes',()=>{
  const {document}=parseHTML(html);
  const visible=id=>!document.getElementById(id).classList.contains('hidden');
  const ready={nativeReady:true,loginReady:true,signupReady:true,registrationAvailable:true};
  renderAppleAuthControls(document,{...ready,mode:'login'});assert.equal(visible('apple-login'),true);assert.equal(visible('apple-signup'),false);
  renderAppleAuthControls(document,{...ready,mode:'register'});assert.equal(visible('apple-login'),false);assert.equal(visible('apple-signup'),true);
  for(const mode of ['forgot','recover']){renderAppleAuthControls(document,{...ready,mode});assert.equal(visible('apple-login'),false);assert.equal(visible('apple-signup'),false);}
  for(const flags of [{nativeReady:false},{loginReady:false,signupReady:false},{registrationAvailable:false}]){
    renderAppleAuthControls(document,{...ready,...flags,mode:'register'});assert.equal(visible('apple-signup'),false);
  }
  renderAppleAuthControls(document,{...ready,nativeReady:false,mode:'login'});assert.equal(visible('apple-login'),false);
});
test('setAuthMode integrates renderer into real DOM transitions and clears stale signup proof',()=>{
  const {document}=parseHTML(html);const state={setup:{appleSignInReady:true,appleSignupReady:true,registrationOpen:true},appleSignupProof:'old'};
  const source=app.match(/^function setAuthMode\(mode\)\{.*$/m)[0];
  const sandbox={document,state,IS_NATIVE:true,signupPlugin:()=>({}),renderAppleAuthControls,$:s=>document.querySelector(s)};
  vm.createContext(sandbox);vm.runInContext(source,sandbox);
  sandbox.setAuthMode('login');assert.equal(state.appleSignupProof,null);assert.equal(document.getElementById('apple-login').classList.contains('hidden'),false);
  sandbox.setAuthMode('recover');assert.equal(document.getElementById('apple-login').classList.contains('hidden'),true);
  sandbox.setAuthMode('register');assert.equal(document.getElementById('apple-signup').classList.contains('hidden'),false);
  state.setup.signupsPaused=true;sandbox.setAuthMode('register');assert.equal(document.getElementById('apple-signup').classList.contains('hidden'),true);
});

test('Apple linking reflects confirmed account state without changing logged-out Apple login',()=>{
  const {document}=parseHTML(html);
  const panel=document.getElementById('apple-link-panel'),button=document.getElementById('apple-link');
  const password=document.getElementById('apple-link-password-label');
  renderAppleAuthControls(document,{nativeReady:true,loginReady:true,mode:'login'});
  renderAppleLinkControl(document,{nativeReady:true,loginReady:true,linked:false});
  assert.equal(panel.classList.contains('hidden'),false);
  assert.equal(button.disabled,false);assert.equal(button.textContent,'Link Apple');
  assert.equal(password.classList.contains('hidden'),false);
  renderAppleLinkControl(document,{nativeReady:true,loginReady:true,linked:false,pending:true});
  assert.equal(button.disabled,true);assert.equal(button.textContent,'Linking Apple…');
  renderAppleLinkControl(document,{nativeReady:true,loginReady:true,linked:true});
  assert.equal(button.disabled,true);assert.equal(button.textContent,'Apple Account Linked');
  assert.equal(password.classList.contains('hidden'),true);
  assert.match(document.getElementById('apple-link-description').textContent,/connected to this account/);
  assert.equal(document.getElementById('apple-login').classList.contains('hidden'),false);
  renderAppleLinkControl(document,{nativeReady:false,loginReady:true,linked:true});
  assert.equal(panel.classList.contains('hidden'),true);
});

test('link button changes only after confirmed Apple completion and restores after failure',async()=>{
  const source=app.slice(app.indexOf('async function appleSignIn(purpose){'),app.indexOf('function renderSignupSafety(){'));
  const {document}=parseHTML(html);const state={user:{id:'owner'},status:{appleLinked:false}};
  const calls=[];let fail=false,releaseChallenge;
  const sandbox={document,state,$:s=>document.querySelector(s),signupPlugin:()=>({signIn:async()=>({identityToken:'test'})}),signupPost:async(path)=>{calls.push(path);if(releaseChallenge&&path.endsWith('challenge'))await new Promise(resolve=>{releaseChallenge=resolve;});if(fail&&path.endsWith('complete'))throw new Error('Rejected');return path.endsWith('challenge')?{nonce:'nonce'}:{ok:true};},renderSignupSafety:()=>renderAppleLinkControl(document,{nativeReady:true,loginReady:true,linked:state.status.appleLinked,pending:state.appleLinkPending}),toast:()=>{},setAuthMode:()=>{},setNativeToken:()=>{},connect:async()=>{}};
  vm.createContext(sandbox);vm.runInContext(source,sandbox);
  document.getElementById('apple-link-password').value='test-only-password';
  fail=true;await assert.rejects(sandbox.appleSignIn('link'),/Rejected/);
  assert.equal(state.status.appleLinked,false);
  assert.equal(document.getElementById('apple-link').disabled,false);
  fail=false;releaseChallenge=true;
  const inFlight=sandbox.appleSignIn('link');
  assert.equal(document.getElementById('apple-link').disabled,true);
  const countWhilePending=calls.length;await sandbox.appleSignIn('link');assert.equal(calls.length,countWhilePending);
  releaseChallenge();await inFlight;
  assert.equal(state.status.appleLinked,true);
  assert.equal(document.getElementById('apple-link').disabled,true);
  assert.equal(document.getElementById('apple-link-password').value,'');
  const count=calls.length;await sandbox.appleSignIn('link');assert.equal(calls.length,count,'already linked account never restarts challenge');
});

test('native welcome waitlist uses the same bundled test backend as authentication',async()=>{
  const source=fs.readFileSync(new URL('../public/welcome.html',import.meta.url),'utf8');
  const {document}=parseHTML(source);let submit;const calls=[];
  document.getElementById('waitlist-form').addEventListener=(_event,handler)=>{submit=handler;};
  const script=source.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/m,'');
  const context={document,window:{Capacitor:{isNativePlatform:()=>true}},NATIVE_API_BASE:'https://approved-test.example',fetch:async(url)=>{calls.push(url);return Response.json({ok:true});}};
  vm.createContext(context);vm.runInContext(script,context);
  await submit({preventDefault(){},target:document.getElementById('waitlist-form')});
  assert.deepEqual(calls,['https://approved-test.example/api/waitlist']);
});
