import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {renderAppleAuthControls} from '../public/signup-ui.js';
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
