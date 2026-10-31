import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const part=source.slice(source.indexOf('let refreshInFlight=null;'),source.indexOf('async function connect(){'));
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};}
function harness(snapshotFor,consentFor=()=>Promise.resolve({accepted:false})){
  const commits=[];
  const state={user:{id:'member',role:'member'},status:null,snapshot:null,aiSharing:null};
  const element={textContent:'',classList:{toggle(){},contains(){return false;}}};
  const context=vm.createContext({
    state,activeConversationId:'a',renderedConversationId:'a',conversationLoadingId:null,
    modelCheckInFlight:false,reportingUI:{onNavigation(){}},localStorage:{setItem(){}},
    $:()=>element,api:(url)=>url.startsWith('/api/snapshot')?snapshotFor(url):url==='/api/ai-sharing-consent'?consentFor():Promise.resolve(url==='/api/status'?{buddyName:'Orbit',paused:false,modelConfigured:false}:{}),
    render:()=>commits.push(state.snapshot?.activeConversation?.id),renderModelPill(){},renderAiSharingChoice(){},
    isComposing:()=>false,loadBriefing(){},loadCatchupCard(){},renderThreads(){},renderMessages(){},syncTypingBubble(){},syncStreamPoller(){}
  });
  vm.runInContext('let aiChoiceVersion=0;'+part,context);
  return{context,state,commits};
}

test('a slow old thread refresh cannot replace a newly selected thread',async()=>{
  const old=deferred();
  const h=harness((url)=>url.endsWith('a')?old.promise:Promise.resolve({activeConversation:{id:'b'},messages:[{content:'new'}]}));
  const first=h.context.refresh();
  h.context.activeConversationId='b';
  const second=h.context.refresh();
  old.resolve({activeConversation:{id:'a'},messages:[{content:'old'}]});
  await Promise.all([first,second]);
  assert.equal(h.state.snapshot.activeConversation.id,'b');
  assert.deepEqual(h.commits,['b']);
});

test('a concurrent same-thread refresh eventually uses the latest snapshot',async()=>{
  const old=deferred();let reads=0;
  const h=harness(()=>++reads===1?old.promise:Promise.resolve({activeConversation:{id:'a'},messages:[{content:'latest'}]}));
  const first=h.context.refresh();const next=h.context.refresh();
  old.resolve({activeConversation:{id:'a'},messages:[{content:'old'}]});
  await Promise.all([first,next]);
  assert.equal(reads,2);
  assert.equal(h.state.snapshot.messages[0].content,'latest');
});

test('an auth transition discards the previous account refresh',async()=>{
  const old=deferred();
  const h=harness(()=>old.promise);
  const pending=h.context.refresh();
  h.state.user={id:'other',role:'member'};
  old.resolve({activeConversation:{id:'a'},messages:[{content:'private'}]});
  await pending;
  assert.equal(h.state.snapshot,null);
  assert.deepEqual(h.commits,[]);
});

test('a slow consent read cannot overwrite a newer withdrawal',async()=>{
  const oldConsent=deferred();
  const h=harness(()=>Promise.resolve({activeConversation:{id:'a'},messages:[]}),()=>oldConsent.promise);
  h.state.aiSharing={accepted:true};
  const pending=h.context.refresh();
  h.state.aiSharing={accepted:false};
  vm.runInContext('aiChoiceVersion++',h.context);
  oldConsent.resolve({accepted:true});
  await pending;
  assert.equal(h.state.aiSharing.accepted,false);
});
