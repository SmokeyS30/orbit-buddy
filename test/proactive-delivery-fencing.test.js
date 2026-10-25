import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {createOrbitServer} from '../server.js';
import {createModelClient} from '../src/model.js';

const nowMs=Date.UTC(2026,9,28,15,0,0);

function fixture(t,respond,serverOptions={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-proactive-fence-'));
  const dbPath=path.join(dir,'shared.sqlite');
  const model=createModelClient({NODE_ENV:'test'});
  if(respond)model.respond=respond;
  const app=createOrbitServer({dataDir:dir,dbPath,env:{NODE_ENV:'test'},modelClient:model,...serverOptions});
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const user=app.db.createUser({email:'proactive-fence@example.test',displayName:'Synthetic',
    passwordHash:'x',passwordSalt:'y',role:'member'});
  return{app,user,dbPath};
}

function deferredModel(){
  let release,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  return{started,release:()=>release?.(),respond:async()=>{
    await new Promise(resolve=>{release=resolve;entered();});
    return{text:'Synthetic check-in',toolCalls:[]};
  }};
}

function twoDeviceSendBarrier(t,service){
  let releaseFirst,enteredFirst,sends=0;
  const firstSent=new Promise(resolve=>{enteredFirst=resolve;});
  service.notify=async (...args)=>{
    const canDeliver=args[4]||(()=>true);
    sends++;
    await new Promise(resolve=>{releaseFirst=resolve;enteredFirst();});
    if(canDeliver())sends++;
    return{sent:sends,failed:0};
  };
  t.after(()=>releaseFirst?.());
  return{firstSent,release:()=>releaseFirst?.(),sent:()=>sends};
}

test('moderation blocked account cannot persist a proactive check-in',async t=>{
  const {app,user}=fixture(t);
  assert.equal(app.db.setModerationBlocked(user.id,true),true);
  const result=await app.deliverProactive(user,'Private synthetic check-in','test','Synthetic test');
  assert.equal(result,false);
  assert.equal(app.db.listMessages(user.id,10).length,0);
});

test('pause while push is in flight prevents a new APNs send',async t=>{
  const {app,user}=fixture(t);
  let releasePush,enteredPush,apnsCalls=0;
  const started=new Promise(resolve=>{enteredPush=resolve;});
  app.push.notify=async()=>{await new Promise(resolve=>{releasePush=resolve;enteredPush();});return{sent:1};};
  app.apns.notify=async()=>{apnsCalls++;return{sent:1};};
  const delivering=app.deliverProactive(user,'Synthetic check-in','test','Synthetic test');
  try{await started;app.db.setSetting('system_paused','true');}
  finally{releasePush?.();}
  await delivering;
  assert.equal(apnsCalls,0);
});

test('pausing during the first proactive web push stops the second device',async t=>{
  const {app,user}=fixture(t);
  const delivery=twoDeviceSendBarrier(t,app.push);
  let apnsCalls=0;
  app.apns.notify=async()=>{apnsCalls++;return{sent:1};};
  const running=app.deliverProactive(user,'Synthetic check-in','test','Synthetic test');
  try{await delivery.firstSent;app.db.setSetting('system_paused','true');}
  finally{delivery.release();}
  const result=await running;
  assert.equal(result.recorded,true);
  assert.equal(delivery.sent(),1,'the paused worker must not start the second web device');
  assert.equal(apnsCalls,0,'the paused worker must not start another channel');
});

test('reclaimed proactive lease during the first APNs push stops the second device',async t=>{
  const {app,user,dbPath}=fixture(t,async()=>({text:'Synthetic check-in',toolCalls:[]}));
  app.db.addFollowUp(user.id,{description:'synthetic appointment',dueDate:'2026-10-28'});
  app.push.notify=async()=>({sent:0,failed:0});
  const delivery=twoDeviceSendBarrier(t,app.apns);
  const running=app.runProactiveChecks(nowMs);
  try{
    await delivery.firstSent;
    const raw=new DatabaseSync(dbPath);
    try{raw.prepare("UPDATE worker_leases SET expires_at='2020-01-01T00:00:00.000Z' WHERE name='proactive'").run();}
    finally{raw.close();}
    assert.equal(app.db.claimWorkerLease('proactive','replacement'),true);
  }finally{delivery.release();}
  await running;
  assert.equal(delivery.sent(),1,'the old worker must not start the second APNs device');
});

test('moderation change while push is in flight prevents a new APNs send',async t=>{
  const {app,user}=fixture(t);
  let apnsCalls=0;
  app.push.notify=async()=>{app.db.setModerationBlocked(user.id,true);return{sent:1};};
  app.apns.notify=async()=>{apnsCalls++;return{sent:1};};
  const outcome=await app.deliverProactive(user,'Synthetic check-in','test','Synthetic test');
  assert.equal(outcome.recorded,true);
  assert.equal(apnsCalls,0);
});

test('pause during a follow-up model call leaves the item due and refunds its unused slot',async t=>{
  const pending=deferredModel();
  const {app,user}=fixture(t,pending.respond);
  const followUp=app.db.addFollowUp(user.id,{description:'synthetic appointment',dueDate:'2026-10-28'});
  const running=app.runProactiveChecks(nowMs);
  try{await pending.started;app.db.setSetting('system_paused','true');}
  finally{pending.release();}
  await running;
  assert.ok(app.db.listFollowUps(user.id).some(row=>row.id===followUp.id),'follow-up remains scheduled');
  assert.equal(app.db.listEvents(user.id).filter(row=>row.type==='followup_sent').length,0);
  for(let i=0;i<3;i++)
    assert.equal(app.db.claimProactiveSlot(user.id,'2026-10-28'),true,`unused slot ${i+1} remains available`);
  assert.equal(app.db.claimProactiveSlot(user.id,'2026-10-28'),false,'the daily cap still holds');
});

test('disable during a routine model call leaves the routine due',async t=>{
  const pending=deferredModel();
  const {app,user}=fixture(t,pending.respond);
  const routine=app.db.addRoutine(user.id,{title:'Synthetic routine',prompt:'Check in',kind:'custom',cadence:'daily',timeLocal:'09:00'});
  const running=app.runProactiveChecks(nowMs);
  try{await pending.started;app.db.setUserDisabled(user.id,true);}
  finally{pending.release();}
  await running;
  assert.equal(app.db.getRoutine(user.id,routine.id).last_run_date,null);
  assert.equal(app.db.listEvents(user.id).filter(row=>row.type==='routine_sent').length,0);
});

test('a pause after message persistence keeps the slot spent and the follow-up complete',async t=>{
  const {app,user}=fixture(t,async()=>({text:'Synthetic check-in',toolCalls:[]}));
  const followUp=app.db.addFollowUp(user.id,{description:'synthetic appointment',dueDate:'2026-10-28'});
  app.push.notify=async()=>{app.db.setSetting('system_paused','true');return{sent:1};};
  await app.runProactiveChecks(nowMs);
  assert.equal(app.db.listFollowUps(user.id).some(row=>row.id===followUp.id),false);
  assert.equal(app.db.listEvents(user.id).filter(row=>row.type==='followup_sent').length,1);
  assert.equal(app.db.claimProactiveSlot(user.id,'2026-10-28'),true);
  assert.equal(app.db.claimProactiveSlot(user.id,'2026-10-28'),true);
  assert.equal(app.db.claimProactiveSlot(user.id,'2026-10-28'),false,'recorded message consumed one of three slots');
});

test('model retry guard rejects new model work after account disable',async t=>{
  let release,started;
  const entered=new Promise(resolve=>{started=resolve;});
  let attempts=0;
  const {app,user}=fixture(t,async options=>{
    attempts++;
    await new Promise(resolve=>{release=resolve;started();});
    await options.assertActive();
    attempts++;
    return{text:'Synthetic check-in',toolCalls:[]};
  });
  app.db.addFollowUp(user.id,{description:'synthetic appointment',dueDate:'2026-10-28'});
  const running=app.runProactiveChecks(nowMs);
  try{await entered;app.db.setUserDisabled(user.id,true);}finally{release?.();}
  await running;
  assert.equal(attempts,1,'the model may finish its in-flight call but cannot start a retry');
  assert.equal(app.db.listEvents(user.id).filter(row=>row.type==='followup_sent').length,0);
});

test('pause during background learning does not write failure events or advance its period',async t=>{
  const pending=deferredModel();
  const {app,user}=fixture(t,pending.respond);
  const conversation=app.db.ensureDefaultConversation(user.id);
  for(let i=0;i<3;i++)app.db.addMessage(user.id,conversation.id,'user',`Synthetic preference and recent activity ${i}`);
  const running=app.runProactiveChecks(Date.now());
  try{await pending.started;app.db.setSetting('system_paused','true');}
  finally{pending.release();}
  await running;
  assert.equal(app.db.getSetting(`last_learning_${user.id}`),null);
  assert.equal(app.db.getSetting(`deep_learning_last_${user.id}`),null);
  assert.equal(app.db.listEvents(user.id).filter(row=>row.type==='auto_learn_failed').length,0);
});

test('expired and reclaimed proactive lease fences old follow-up state changes',async t=>{
  const pending=deferredModel();
  const {app,user,dbPath}=fixture(t,pending.respond);
  const followUp=app.db.addFollowUp(user.id,{description:'synthetic appointment',dueDate:'2026-10-28'});
  const running=app.runProactiveChecks(nowMs);
  try{
    await pending.started;
    const raw=new DatabaseSync(dbPath);
    try{raw.prepare("UPDATE worker_leases SET expires_at='2020-01-01T00:00:00.000Z' WHERE name='proactive'").run();}
    finally{raw.close();}
    assert.equal(app.db.claimWorkerLease('proactive','replacement'),true);
  }finally{pending.release();}
  await running;
  const row=app.db.listFollowUps(user.id).find(item=>item.id===followUp.id);
  assert.equal(row.status,'scheduled');
  assert.equal(row.attempt_count,0,'stale callback must not record a failure or completion');
  assert.equal(app.db.listEvents(user.id).filter(event=>event.type==='followup_sent').length,0);
});

test('failed lease heartbeat fences an in-flight model result',async t=>{
  const pending=deferredModel();
  const {app,user}=fixture(t,pending.respond,{proactiveHeartbeatMs:10});
  const followUp=app.db.addFollowUp(user.id,{description:'synthetic appointment',dueDate:'2026-10-28'});
  let heartbeatSeen;
  const heartbeat=new Promise(resolve=>{heartbeatSeen=resolve;});
  app.db.renewWorkerLease=()=>{heartbeatSeen();return false;};
  const running=app.runProactiveChecks(nowMs);
  try{await pending.started;await heartbeat;}finally{pending.release();}
  await running;
  assert.ok(app.db.listFollowUps(user.id).some(row=>row.id===followUp.id));
  assert.equal(app.db.listEvents(user.id).filter(row=>row.type==='followup_sent').length,0);
});
