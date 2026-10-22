import test from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORT_RETURN_KEY, returnToSafety } from '../public/support-navigation.js';

function fixture({referrer='capacitor://localhost/#safety',historyLength=2}={}){
  const stored=new Map();
  const calls=[];
  const windowLike={
    history:{length:historyLength,back:()=>calls.push('back')},
    location:{protocol:'capacitor:',host:'localhost',replace:(url)=>calls.push(['replace',url])},
    sessionStorage:{setItem:(key,value)=>stored.set(key,value)},
  };
  return{windowLike,documentLike:{referrer},stored,calls};
}

test('Support back returns through WKWebView history and marks Safety for restoration',()=>{
  const f=fixture();
  assert.equal(returnToSafety(f.windowLike,f.documentLike),'back');
  assert.equal(f.stored.get(SUPPORT_RETURN_KEY),'safety');
  assert.deepEqual(f.calls,['back']);
});

test('direct Support visits safely fall back to the Safety URL',()=>{
  const f=fixture({referrer:'',historyLength:1});
  assert.equal(returnToSafety(f.windowLike,f.documentLike),'replace');
  assert.equal(f.stored.get(SUPPORT_RETURN_KEY),'safety');
  assert.deepEqual(f.calls,[['replace','/#safety']]);
});

test('Support never navigates back to an unrelated origin',()=>{
  const f=fixture({referrer:'https://example.com/'});
  assert.equal(returnToSafety(f.windowLike,f.documentLike),'replace');
  assert.deepEqual(f.calls,[['replace','/#safety']]);
});
