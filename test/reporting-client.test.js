import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { createReportingUI, reportPreview } from '../public/reporting.js';

const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const tick=()=>new Promise((resolve)=>setImmediate(resolve));

function fixture(api=async()=>({id:'saved'})){
  const{document,window}=parseHTML(html);
  // linkedom exposes select.value as read-only; browsers provide a setter.
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{
    configurable:true,get(){return this.__testValue??'';},set(value){this.__testValue=String(value);}
  });
  const dialog=document.getElementById('report-dialog');
  dialog.showModal=function(){this.open=true;};
  dialog.close=function(){this.open=false;};
  const form=document.getElementById('report-form');
  form.reset=function(){
    for(const id of ['report-reason','report-description','report-excerpt'])document.getElementById(id).value='';
    for(const id of ['report-include-message','report-consent'])document.getElementById(id).checked=false;
  };
  let conversationId='conversation-one';
  const message={id:'4bf069e5-18fc-4871-a303-f08e340e322d',role:'assistant',content:'A response with secret data'};
  const notifications=[];
  const ui=createReportingUI({document,api,getAccount:()=>({email:'member@example.com'}),getConversationId:()=>conversationId,
    getMessageById:(id)=>id===message.id?message:null,notify:(text)=>notifications.push(text)});
  const $=(id)=>document.getElementById(id);
  const fire=(id,type)=>$(id).dispatchEvent(new window.Event(type,{bubbles:true,cancelable:true}));
  return{document,window,ui,dialog,form,message,notifications,$,fire,setConversation:(id)=>{conversationId=id;}};
}

test('preview excludes chat by default, requires consent, and cancellation sends nothing',()=>{
  const calls=[];const f=fixture(async(...args)=>{calls.push(args);});
  assert.equal(f.ui.openResponse(f.message),true);
  assert.equal(f.$('report-submit').disabled,true);
  assert.doesNotMatch(f.$('report-preview-text').textContent,/secret data/);
  f.$('report-reason').value='incorrect';f.fire('report-reason','change');
  assert.equal(f.$('report-submit').disabled,true);
  f.$('report-consent').checked=true;f.fire('report-consent','change');
  assert.equal(f.$('report-submit').disabled,false);
  f.fire('report-cancel','click');
  assert.equal(f.dialog.open,false);
  assert.equal(calls.length,0);
  assert.match(reportPreview({kind:'problem',reason:'bug',description:'Typing froze',includeMessage:false,messageExcerpt:'',email:'member@example.com'}),/Chat history: none attached/);
});

test('opening Report a Problem leaves the reason picker closed until tapped',()=>{
  const f=fixture();
  let titleFocuses=0,reasonFocuses=0;
  f.$('report-title').focus=()=>{titleFocuses++;};
  f.$('report-reason').focus=()=>{reasonFocuses++;};
  f.fire('report-problem-button','click');
  assert.equal(f.dialog.open,true);
  assert.equal(titleFocuses,1);
  assert.equal(reasonFocuses,0);
});

test('edited excerpt is the only chat content sent; repeated clicks submit once',async()=>{
  const calls=[];let release;
  const f=fixture((url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Promise((resolve)=>{release=resolve;});});
  f.ui.openResponse(f.message);
  f.$('report-reason').value='unsafe';f.fire('report-reason','change');
  f.$('report-include-message').checked=true;f.fire('report-include-message','change');
  assert.match(f.$('report-preview-text').textContent,/secret data/);
  f.$('report-excerpt').value='A response with [redacted]';f.fire('report-excerpt','input');
  assert.doesNotMatch(f.$('report-preview-text').textContent,/secret data/);
  f.$('report-consent').checked=true;f.fire('report-consent','change');
  f.fire('report-form','submit');f.fire('report-form','submit');
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'/api/reports');
  assert.equal(calls[0].body.messageExcerpt,'A response with [redacted]');
  assert.equal(calls[0].body.consent,true);
  assert.equal(calls[0].body.includeMessage,true);
  release({id:'saved'});await tick();
  assert.equal(f.dialog.open,false);
  assert.deepEqual(f.notifications,['Report sent to the owner.']);
});

test('navigation closes a draft; failure preserves the same submission for retry',async()=>{
  const calls=[];let fail=true;
  const f=fixture(async(url,options)=>{calls.push(JSON.parse(options.body));if(fail){fail=false;throw new Error('Offline');}return{id:'saved'};});
  f.ui.openResponse(f.message);
  f.setConversation('conversation-two');f.ui.onNavigation();
  assert.equal(f.dialog.open,false);
  f.fire('report-form','submit');assert.equal(calls.length,0);
  f.setConversation('conversation-one');f.ui.openResponse(f.message);
  f.$('report-reason').value='bug';f.fire('report-reason','change');
  f.$('report-consent').checked=true;f.fire('report-consent','change');
  f.fire('report-form','submit');f.setConversation('conversation-two');f.ui.onNavigation();await tick();
  assert.equal(f.dialog.open,true);
  assert.match(f.$('report-error').textContent,/Offline/);
  assert.equal(f.$('report-consent').checked,true);
  f.fire('report-form','submit');await tick();
  assert.equal(calls.length,2);
  assert.equal(calls[0].submissionId,calls[1].submissionId);
  assert.equal(f.dialog.open,false);
});

test('owner inbox renders untrusted text safely and offers status tracking only to owner',async()=>{
  const calls=[];const f=fixture(async(url,options)=>{calls.push({url,options});return{status:'resolved',ownerNote:'Reviewed.'};});
  const report={id:'5d99f22b-ffb1-429d-8ef5-a25570cffc88',kind:'problem',reason:'bug',description:'<img src=x onerror=alert(1)>',message_excerpt:null,reporter_name:'Member',created_at:new Date().toISOString(),status:'new'};
  f.ui.renderInbox([report],false);
  assert.equal(f.$('reports-inbox-panel').classList.contains('hidden'),true);
  f.ui.renderInbox([report],true,[{status:'new',count:1,oldest_at:report.created_at}]);
  assert.equal(f.$('reports-inbox-panel').classList.contains('hidden'),false);
  assert.match(f.$('reports-summary').textContent,/1 new/);
  assert.equal(f.$('reports-inbox').querySelector('img'),null);
  assert.match(f.$('reports-inbox').textContent,/onerror=alert/);
  const ownerNote=f.$('reports-inbox').querySelector('textarea');ownerNote.value='Reviewed.';
  const select=f.$('reports-inbox').querySelector('select');select.value='resolved';
  f.$('reports-inbox').querySelector('button').dispatchEvent(new f.window.Event('click'));
  await tick();
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,`/api/admin/reports/${report.id}`);
  assert.equal(JSON.parse(calls[0].options.body).status,'resolved');
  assert.equal(JSON.parse(calls[0].options.body).ownerNote,'Reviewed.');
  f.ui.renderMine([{...report,owner_note:'<img src=x onerror=alert(1)>'}]);
  assert.equal(f.$('reports-mine').querySelector('img'),null);
  assert.match(f.$('reports-mine').textContent,/onerror=alert/);
});

test('failed owner review keeps the response and status available for retry',async()=>{
  let attempts=0;
  const f=fixture(async()=>{attempts++;if(attempts===1)throw new Error('Offline');return{status:'reviewing',ownerNote:'I am looking into it.'};});
  const report={id:'5d99f22b-ffb1-429d-8ef5-a25570cffc88',kind:'problem',reason:'bug',created_at:new Date().toISOString(),status:'new'};
  f.ui.renderInbox([report],true);
  const note=f.$('reports-inbox').querySelector('textarea');
  const select=f.$('reports-inbox').querySelector('select');
  const save=f.$('reports-inbox').querySelector('button');
  note.value='I am looking into it.';select.value='reviewing';
  save.dispatchEvent(new f.window.Event('click'));await tick();
  assert.equal(note.value,'I am looking into it.');
  assert.equal(select.value,'reviewing');
  assert.equal(save.disabled,false);
  save.dispatchEvent(new f.window.Event('click'));await tick();
  assert.equal(attempts,2);
  assert.equal(report.status,'reviewing');
});
