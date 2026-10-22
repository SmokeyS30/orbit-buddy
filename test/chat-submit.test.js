import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const handler=source.slice(source.indexOf("$('#chat-form').addEventListener('submit'"),source.indexOf('function appendOptimisticMessage(',source.indexOf("$('#chat-form').addEventListener('submit'")));
function fixture(){
  const input={value:'second draft'};let submit;const sends=[];
  const form={addEventListener(_event,callback){submit=callback;}};
  const context=vm.createContext({$:selector=>selector==='#chat-form'?form:input,sendChatMessage:text=>sends.push(text),state:{user:{id:'user'}},sendInFlight:false,pendingAttachments:[],lastTypeAt:Date.now()});
  vm.runInContext(handler,context);
  return{context,input,sends,submit:()=>submit({preventDefault(){}})};
}

test('a second submit during a pending send preserves the draft',()=>{
  const f=fixture();f.context.sendInFlight=true;f.submit();
  assert.equal(f.input.value,'second draft');assert.deepEqual(f.sends,[]);
});

test('an unauthenticated submit leaves text available after the sign-in prompt',()=>{
  const f=fixture();f.context.state.user=null;f.submit();
  assert.equal(f.input.value,'second draft');assert.deepEqual(f.sends,['second draft']);
});

test('an accepted submit clears only that draft and allows server rendering',()=>{
  const f=fixture();f.submit();
  assert.equal(f.input.value,'');assert.deepEqual(f.sends,['second draft']);
  assert.equal(f.context.lastTypeAt,0);
});

test('empty focused composer is idle while a real draft or recent typing is protected',()=>{
  const input={value:''};const context=vm.createContext({$:()=>input,Date,lastTypeAt:0});
  const compose=source.slice(source.indexOf('function isComposing(){'),source.indexOf("document.addEventListener('input'",source.indexOf('function isComposing(){')));
  vm.runInContext(compose,context);
  assert.equal(context.isComposing(),false);
  input.value='new draft';assert.equal(context.isComposing(),true);
  input.value='';context.lastTypeAt=Date.now();assert.equal(context.isComposing(),true);
});
