import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './src/database.js';
import { createModelClient } from './src/model.js';
import { fetchFeedText, normalizeFeedUrl, parseIcs, dropFeedCache, getBriefingAgenda } from './src/ical.js';
import { createPushService } from './src/push.js';
import { createConnectorService } from './src/connectors.js';
import { writeAutomatedBackup } from './src/backups.js';
import { isQuietHours, localDateTimeParts, normalizeMemoryKind, normalizePriority, todayInZone, validDateString, validTimeString } from './src/intelligence.js';
import { buildRoutinePrompt, dueRoutines } from './src/proactive.js';
import {
  clearSessionCookie, decryptPortable, encryptPortable, hashPassword, hashToken,
  makeRecoveryCodes, parseCookies, randomToken, readEncryptionKey, sessionCookie, verifyPassword
} from './src/security.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(root, 'public');
const mime = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json' };
const now = () => new Date().toISOString();

function json(res,status,body,headers={}) { res.writeHead(status,{ 'Content-Type':'application/json; charset=utf-8',...headers }); res.end(JSON.stringify(body)); }
function cleanText(value,max,field) { if(typeof value!=='string'||!value.trim()) throw Object.assign(new Error(`${field} is required.`),{status:400}); return value.trim().slice(0,max); }
function optionalText(value,max) { return typeof value==='string'&&value.trim()?value.trim().slice(0,max):null; }
function safeEmail(value) { const email=String(value||'').trim().toLowerCase(); if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254) throw Object.assign(new Error('A valid email is required.'),{status:400}); return email; }
// Feed URLs are secrets (anyone holding one can read the calendar): never send
// the full URL to the client, log it, or put it in activity events.
function maskFeedUrl(raw) { try { const url=new URL(String(raw)); const tail=String(url.pathname||'').replace(/\/$/,'').slice(-4); return `${url.protocol}//${url.host}/\u2026${tail}`; } catch { return 'invalid url'; } }
function publicFeed(feed) { return { id:feed.id,label:feed.label,url:maskFeedUrl(feed.url),created_at:feed.created_at }; }
async function readJson(req,limit=1024*1024) { const chunks=[]; let size=0; for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(new Error('Request body is too large.'),{status:413});chunks.push(chunk);} if(!chunks.length)return{}; try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(new Error('Request body must be valid JSON.'),{status:400});} }
function nextRun(recurrence,previous){if(recurrence==='none')return null;const date=previous?new Date(previous):new Date();const days=recurrence==='weekly'?7:1;do{date.setUTCDate(date.getUTCDate()+days);}while(date<=new Date());return date.toISOString();}
function artifactName(title){const base=title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60)||'orbit-result';return `${base}.md`;}
function icsEscape(value){return String(value||'').replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');}
function icsUtc(value){return new Date(value).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');}
export function calendarEventIcs(approval){const event=approval.payload||{};return ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Orbit Buddy//Phase 3A//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH','BEGIN:VEVENT',`UID:${approval.id}@orbit-buddy`,`DTSTAMP:${icsUtc(approval.created_at||new Date().toISOString())}`,`DTSTART:${icsUtc(event.startAt)}`,`DTEND:${icsUtc(event.endAt)}`,`SUMMARY:${icsEscape(event.title)}`,...(event.location?[`LOCATION:${icsEscape(event.location)}`]:[]),...(event.notes?[`DESCRIPTION:${icsEscape(event.notes)}`]:[]),'END:VEVENT','END:VCALENDAR',''].join('\r\n');}

// Legacy marker support for older/custom model prompts. Current models use the
// structured schedule_followup and propose_memory tools instead.
const FOLLOWUP_MARKER_RE = /\[FOLLOWUP:\s*([^\]\n]+?)\s+on\s+(\d{4}-\d{2}-\d{2})\s*\]/gi;
export function parseFollowUpMarkers(text){
  const out=[];if(typeof text!=='string')return out;FOLLOWUP_MARKER_RE.lastIndex=0;let match;
  while((match=FOLLOWUP_MARKER_RE.exec(text))){
    const date=match[2];
    if(date>='2020-01-01'&&date<='2100-12-31')out.push({description:match[1].trim().slice(0,120),date});
  }
  return out;
}
export function stripFollowUpMarkers(text){
  if(typeof text!=='string')return text;
  return text.replace(/\[FOLLOWUP:[^\]\n]*\]/gi,'').replace(/\n{3,}/g,'\n\n').trim();
}
const SUGGEST_MARKER_RE=/\[SUGGEST_MEMORY:\s*([^\]\n]*)\]/gi;
export function parseSuggestMarkers(text){
  const out=[];if(typeof text!=='string')return out;SUGGEST_MARKER_RE.lastIndex=0;let match;
  while((match=SUGGEST_MARKER_RE.exec(text))){
    const content=match[1].trim().slice(0,200);
    if(content)out.push(content);
  }
  return out.slice(0,2);
}
export function stripSuggestMarkers(text){
  if(typeof text!=='string')return text;
  return text.replace(/\[SUGGEST_MEMORY:[^\]\n]*\]/gi,'').replace(/\n{3,}/g,'\n\n').trim();
}
export function stripModelMarkers(text){return stripSuggestMarkers(stripFollowUpMarkers(text));}
// Quiet-nudge timing: idle >48h since the user's last message, and no nudge in the last 7 days.
export function quietNudgeDue(lastActivityAt,lastNudgeAt,nowMs){
  if(!lastActivityAt)return false;
  const idleMs=nowMs-new Date(lastActivityAt).valueOf();
  if(!(idleMs>48*3600_000))return false;
  if(!lastNudgeAt)return true;
  return (nowMs-new Date(lastNudgeAt).valueOf())>7*24*3600_000;
}

export function createOrbitServer(options={}) {
  const env=options.env||process.env;
  const buddyName=env.BUDDY_NAME?.trim().slice(0,40)||'Orbit';
  const dataDir=path.resolve(options.dataDir||env.DATA_DIR||path.join(root,'data'));
  const encryptionKey=readEncryptionKey(env.DATA_ENCRYPTION_KEY||env.CONNECTOR_ENCRYPTION_KEY);
  const db=openDatabase(options.dbPath||path.join(dataDir,'orbit.sqlite'),{encryptionKey});
  const model=createModelClient(env);
  const push=createPushService(env,db);
  const connectors=createConnectorService(env,db,encryptionKey);
  const production=env.NODE_ENV==='production';
  const publicBase=env.PUBLIC_BASE_URL?.replace(/\/$/,'')||null;
  if(publicBase && !/^https:\/\//.test(publicBase) && production) throw new Error('PUBLIC_BASE_URL must use HTTPS in production.');

  function reliabilityFor(userId){
    const events=db.listEvents(userId,200);const since=Date.now()-7*24*60*60_000;const recent=events.filter((event)=>new Date(event.created_at).valueOf()>=since);
    const count=(type)=>recent.filter((event)=>event.type===type).length;const chats={successful:count('chat'),failed:count('chat_failed')};const tasks={successful:count('task_completed'),failed:count('task_failed')};
    const attempts=chats.successful+chats.failed;return {windowDays:7,model:model.diagnostics(),chat:{...chats,successRate:attempts?Math.round(chats.successful/attempts*100):null},background:tasks,pendingApprovals:db.listApprovals(userId).filter((item)=>item.status==='pending').length+db.listTasks(userId).filter((task)=>task.status==='waiting_approval').length,recentFailures:recent.filter((event)=>event.type.endsWith('_failed')).slice(0,8).map(({id,type,message,created_at})=>({id,type,message,created_at}))};
  }

  const requestLog=new Map();
  function rateLimited(req,limit=240,scope='global'){const key=`${scope}:${req.socket.remoteAddress||'unknown'}`;const current=Date.now();const recent=(requestLog.get(key)||[]).filter((time)=>current-time<60_000);recent.push(current);requestLog.set(key,recent);return recent.length>limit;}
  const hourLog=new Map();
  function hourlyLimited(req,limit,scope){const key=`${scope}:${req.socket.remoteAddress||'unknown'}`;const current=Date.now();const recent=(hourLog.get(key)||[]).filter((time)=>current-time<3_600_000);recent.push(current);hourLog.set(key,recent);return recent.length>limit;}
  const userLog=new Map();
  function userRateLimited(userId,scope,limit=30,windowMs=5*60_000){const key=`${userId}:${scope}`;const current=Date.now();const recent=(userLog.get(key)||[]).filter((time)=>current-time<windowMs);recent.push(current);userLog.set(key,recent);return recent.length>limit;}
  const paused=()=>db.getSetting('system_paused','false')==='true';
  const setPaused=(value)=>db.setSetting('system_paused',value?'true':'false');
  const registrationOpen=()=>db.getSetting('registration_open','false')==='true';
  async function checkDoorLeftOpen(){
    db.pruneDoorTokens();
    if(!registrationOpen())return;
    const openedAt=db.getSetting('registration_opened_at');
    if(!openedAt||Date.now()-new Date(openedAt).valueOf()<60*60_000)return;
    const lastNudge=db.getSetting('registration_nudge_at');
    if(lastNudge&&new Date(lastNudge).valueOf()>=new Date(openedAt).valueOf())return;
    const owner=db.listUsers().find((u)=>u.role==='owner');
    if(!owner)return;
    db.setSetting('registration_nudge_at',new Date().toISOString());
    db.addEvent(owner.id,'registration_nudge','Registration has been open for over an hour.');
    await push.notify(owner.id,'Registration still open','The Orbit registration door has been open for over an hour.',{view:'safety'});
  }

  function originFor(req){if(publicBase)return publicBase;const protocol=req.headers['x-forwarded-proto']==='https'?'https':production?'https':'http';return `${protocol}://${req.headers.host}`;}
  function sessionUser(req){const token=parseCookies(req.headers.cookie).orbit_session;if(!token)return null;return db.getSession(hashToken(token));}
  function authenticate(req){const session=sessionUser(req);if(session&&!session.disabled)return session;return null;}
  function requireCsrf(req,user){if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.headers['x-orbit-csrf']!==user.csrf_token)throw Object.assign(new Error('Security token is missing or expired.'),{status:403});}
  function requireOwner(user){if(user.role!=='owner')throw Object.assign(new Error('Owner access is required.'),{status:403});}
  function createSession(user,req,res){const token=randomToken();const csrf=randomToken(24);const expiresAt=new Date(Date.now()+30*24*60*60_000).toISOString();db.createSession({tokenHash:hashToken(token),userId:user.id,csrfToken:csrf,expiresAt,userAgent:String(req.headers['user-agent']||'').slice(0,300)});res.setHeader('Set-Cookie',sessionCookie(token,{secure:production}));return csrf;}
  function publicUser(user){return{id:user.user_id||user.id,email:user.email,displayName:user.display_name,role:user.role};}

  let workerBusy=false;
  const chatQueues=new Map();
  const pendingStreams=new Map(); // conversationId -> {turn, text, done} for live reply streaming
  function enqueueChatReply(conversationId,job){const prev=chatQueues.get(conversationId)||Promise.resolve();const next=prev.then(async()=>{try{await job();}catch(error){console.error('chat job failed',conversationId,error&&error.message);}});chatQueues.set(conversationId,next);next.finally(()=>{if(chatQueues.get(conversationId)===next)chatQueues.delete(conversationId);});return next;}
  async function runDueTasks(){
    if(workerBusy||paused())return;workerBusy=true;
    try{
      db.recoverStaleTasks();
      for(const task of db.dueTasks()){
        if(!db.startTask(task.user_id,task.id))continue;
        db.addEvent(task.user_id,'task_started',`Started “${task.title}”.`);
        try{
          const taskUser=db.getUserById(task.user_id);const preferences=db.getPreferences(task.user_id);
          let taskMessage=task.prompt;
          if(/^\[nudge\]\s*morning briefing/i.test(task.title||'')){
            try{const agenda=await getBriefingAgenda(db,task.user_id,2,preferences.time_zone);if(agenda)taskMessage+=`\n\nThe user's calendar agenda for today and tomorrow (${preferences.time_zone}, from their connected iCal feeds):\n${agenda}\nWeave today's events into the briefing naturally with their times; give tomorrow only as a brief preview. Do not paste this as a raw list.`;}catch(error){console.error('briefing agenda failed',error&&error.message);}
          }
          const { text: result }=await model.respond({buddyName,userName:taskUser?.display_name,message:taskMessage,memories:db.listRelevantMemories(task.user_id,task.prompt),goals:db.listActiveGoals(task.user_id),history:[],userTimeZone:preferences.time_zone,taskMode:true});
          const following=nextRun(task.recurrence,task.schedule_at);const isNudge=/^\[nudge\]/i.test(task.title);
          db.completeTask(task.user_id,task.id,result,following?'scheduled':'completed',following);
          if(!isNudge)db.addArtifact(task.user_id,{taskId:task.id,name:artifactName(task.title),content:`# ${task.title}\n\n${result}\n`});
          db.addEvent(task.user_id,'task_completed',`Completed “${task.title}”.`);
          await push.notify(task.user_id,isNudge?buddyName:`${buddyName} finished a task`,isNudge?result:task.title,isNudge?{view:'today'}:{view:'tasks',taskId:task.id});
        }catch(error){db.failTask(task.user_id,task.id,'Task failed safely.',error.message);db.addEvent(task.user_id,'task_failed',`Could not complete “${task.title}”.`,error.message);await push.notify(task.user_id,`${buddyName} needs attention`,`${task.title} could not be completed.`,{view:'tasks'});}
      }
    }finally{workerBusy=false;}
  }

  // A proactive message lands in the default conversation AND as a push notification,
  // so the buddy reaches out even on devices without push enabled.
  async function deliverProactive(user,text,eventType,eventMessage){
    const conversation=db.ensureDefaultConversation(user.id);
    db.addMessage(user.id,conversation.id,'assistant',text);
    db.touchConversation(user.id,conversation.id);
    db.addEvent(user.id,eventType,eventMessage);
    db.markOutreach(user.id);
    await push.notify(user.id,buddyName,text,{view:'today'});
  }
  async function maybeRefreshConversationSummary(user,conversation){
    const userId=user.user_id||user.id;
    if(!model.configured||!db.getConversation(userId,conversation.id))return;
    const messageCount=db.countConversationMessages(userId,conversation.id);const existing=db.getConversationSummary(userId,conversation.id);
    if(messageCount<32||(existing&&messageCount-existing.message_count<20))return;
    const messages=db.listConversationMessages(userId,conversation.id,160);const older=messages.slice(0,-12);
    if(older.length<20)return;
    const transcript=older.map((entry)=>`${entry.role==='user'?'User':'Orbit'}: ${entry.content}`).join('\n').slice(-24000);
    const prompt=`Summarize the earlier part of this conversation for future continuity. Preserve decisions, open questions, goals, preferences, names, dates, and commitments. Do not add facts or advice. Use concise plain text.\n\n${existing?.summary?`Previous summary:\n${existing.summary}\n\n`:''}Conversation:\n${transcript}`;
    try{const preferences=db.getPreferences(userId);const {text}=await model.respond({buddyName,userName:user.display_name,message:prompt,memories:[],history:[],userTimeZone:preferences.time_zone,taskMode:true});db.setConversationSummary(userId,conversation.id,text,messageCount);db.addEvent(userId,'conversation_summarized',`Refreshed context for “${conversation.title}”.`);}catch(error){db.addEvent(userId,'conversation_summary_failed',`Could not refresh context for “${conversation.title}”.`,error.message);}
  }
  async function runFollowUps(nowMs){
    for(const user of db.listUsers()){
      if(user.disabled)continue;
      const preferences=db.getPreferences(user.id);if(isQuietHours(preferences,nowMs))continue;
      const today=todayInZone(preferences.time_zone,nowMs);
      for(const followUp of db.dueFollowUps(user.id,today)){
        if(!db.claimProactiveSlot(user.id,today))break;
        const prompt=`Write a short, warm check-in message (1-2 sentences, plain text, no greeting header) asking how "${followUp.description}" went. Sound like a caring friend dropping by, not a notification. Do not mention that this is automated.`;
        try{
          const { text }=await model.respond({buddyName,userName:user.display_name,message:prompt,memories:db.listRelevantMemories(user.id,followUp.description),goals:db.listActiveGoals(user.id),history:[],userTimeZone:preferences.time_zone,taskMode:true});
          await deliverProactive(user,text,'followup_sent',`Checked in about “${followUp.description}”.`);
          db.completeFollowUp(user.id,followUp.id);
        }catch(error){db.failFollowUp(user.id,followUp.id,error.message);db.releaseProactiveSlot(user.id,today);db.addEvent(user.id,'followup_failed',`Could not check in about “${followUp.description}”.`,error.message);}
      }
    }
  }
  async function runRoutines(nowMs){
    for(const user of db.listUsers()){
      if(user.disabled)continue;
      const preferences=db.getPreferences(user.id);if(isQuietHours(preferences,nowMs))continue;
      const local=localDateTimeParts(preferences.time_zone,nowMs);
      for(const routine of dueRoutines(db.listRoutines(user.id),preferences.time_zone,nowMs)){
        if(!db.claimProactiveSlot(user.id,local.date))break;
        if(!db.claimRoutine(user.id,routine.id,local.date)){db.releaseProactiveSlot(user.id,local.date);continue;}
        try{
          const agenda=routine.kind==='briefing'?await getBriefingAgenda(db,user.id,2,preferences.time_zone):'';
          const prompt=buildRoutinePrompt({routine,timeZone:preferences.time_zone,agenda,goals:db.listGoals(user.id),tasks:db.listTasks(user.id),followUps:db.listFollowUps(user.id),nowMs});
          const {text}=await model.respond({buddyName,userName:user.display_name,message:prompt,memories:db.listRelevantMemories(user.id,routine.prompt),goals:db.listActiveGoals(user.id),history:[],userTimeZone:preferences.time_zone,taskMode:true});
          await deliverProactive(user,text,'routine_sent',`Ran routine “${routine.title}”.`);
          db.completeRoutine(user.id,routine.id,local.date);
        }catch(error){db.failRoutine(user.id,routine.id,local.date,error.message);db.releaseProactiveSlot(user.id,local.date);db.addEvent(user.id,'routine_failed',`Could not run routine “${routine.title}”.`,error.message);}
      }
    }
  }
  async function runQuietNudges(nowMs){
    for(const user of db.listUsers()){
      if(user.disabled)continue;
      const preferences=db.getPreferences(user.id);if(isQuietHours(preferences,nowMs))continue;
      if(!quietNudgeDue(db.lastUserMessageAt(user.id),db.getLastQuietNudgeAt(user.id),nowMs))continue;
      const lastOutreach=db.getLastOutreachAt(user.id);if(lastOutreach&&nowMs-new Date(lastOutreach).valueOf()<24*3600_000)continue;
      const today=todayInZone(preferences.time_zone,nowMs);if(!db.claimProactiveSlot(user.id,today))continue;
      const prompt=`Write a short, warm check-in (1-2 sentences, plain text) for someone you have not heard from in a couple of days. Sound like a friend popping by, not a notification. You may gently reference something from their memories if one fits naturally; otherwise keep it simple. Do not mention that this is automated.`;
      try{
        const { text }=await model.respond({buddyName,userName:user.display_name,message:prompt,memories:db.listRelevantMemories(user.id,prompt),goals:db.listActiveGoals(user.id),history:[],userTimeZone:preferences.time_zone,taskMode:true});
        db.setLastQuietNudgeAt(user.id,new Date(nowMs).toISOString());
        await deliverProactive(user,text,'quiet_nudge_sent','Sent a quiet check-in nudge.');
      }catch(error){db.releaseProactiveSlot(user.id,today);db.addEvent(user.id,'quiet_nudge_failed','Could not send a quiet check-in.',error.message);}
    }
  }
  let proactiveBusy=false;
  async function runProactiveChecks(nowMs=Date.now()){
    if(proactiveBusy||paused())return;proactiveBusy=true;
    try{await runFollowUps(nowMs);await runRoutines(nowMs);await runQuietNudges(nowMs);}
    finally{proactiveBusy=false;}
  }

  let backupBusy=false;
  async function runBackups(){if(backupBusy||!env.BACKUP_ENCRYPTION_KEY)return;const today=new Date().toISOString().slice(0,10);if(db.getSetting('last_automatic_backup')===today)return;backupBusy=true;try{for(const user of db.listUsers())await writeAutomatedBackup({db,userId:user.id,dataDir,passphrase:env.BACKUP_ENCRYPTION_KEY});db.setSetting('last_automatic_backup',today);}finally{backupBusy=false;}}

  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if(production)res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
    if(rateLimited(req))return json(res,429,{error:'Too many requests. Try again shortly.'});
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/healthz'){const modelStatus=model.diagnostics();return json(res,200,{ok:true,service:'orbit-buddy',paused:paused(),ai:{configured:model.configured,state:modelStatus.state,primaryModel:modelStatus.primaryModel,activeModel:modelStatus.activeModel,availableTextModelCount:modelStatus.availableTextModelCount}});}

    try {
      if(req.method==='GET'&&url.pathname==='/api/auth/setup-status')return json(res,200,{needsOwner:db.countUsers()===0,registrationOpen:registrationOpen()});
      if(req.method==='POST'&&url.pathname==='/api/registration-request'){
        if(hourlyLimited(req,3,'reg-request'))throw Object.assign(new Error('Too many requests. Try again later.'),{status:429});
        const body=await readJson(req);const name=cleanText(body.name,80,'name');const email=safeEmail(body.email);
        const note=body.note&&String(body.note).trim()?cleanText(body.note,500,'note'):null;
        const saved=db.addAccessRequest({name,email,note});
        const owner=db.listUsers().find((u)=>u.role==='owner');
        if(owner){
          const doorToken='door_'+randomToken(24);
          db.addDoorToken(hashToken(doorToken),new Date(Date.now()+24*60*60_000).toISOString());
          db.addEvent(owner.id,'access_request',`${name} (${email}) asked for Orbit access.`);
          await push.notify(owner.id,'Access request',`${name} asked for Orbit access.`,{view:'safety',doorAction:true,doorToken});
        }
        return json(res,201,{ok:true,id:saved.id});
      }
      if(req.method==='POST'&&url.pathname==='/api/registration/door-token'){
        if(hourlyLimited(req,10,'door-token'))throw Object.assign(new Error('Too many requests. Try again later.'),{status:429});
        const body=await readJson(req);const token=String(body.token||'');
        if(!db.consumeDoorToken(hashToken(token)))throw Object.assign(new Error('This link has expired or was already used.'),{status:403});
        db.setSetting('registration_open','true');db.setSetting('registration_opened_at',new Date().toISOString());
        const owner=db.listUsers().find((u)=>u.role==='owner');
        if(owner)db.addEvent(owner.id,'registration_opened','Opened registration from a push action.');
        return json(res,200,{open:true});
      }
      if(req.method==='GET'&&url.pathname==='/api/public/usage'){
        if(hourlyLimited(req,60,'public-usage'))throw Object.assign(new Error('Too many requests. Try again later.'),{status:429});
        const now=new Date();const monthStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString();
        return json(res,200,{month:monthStart.slice(0,7),braveConfigured:!!env.BRAVE_SEARCH_API_KEY?.trim(),webSearches:db.countToolUseSince('web_search',monthStart)});
      }
      if(req.method==='POST'&&url.pathname==='/api/auth/register'){
        if(rateLimited(req,30,'register'))throw Object.assign(new Error('Too many registration attempts.'),{status:429});
        const body=await readJson(req);const email=safeEmail(body.email);const displayName=cleanText(body.displayName,80,'displayName');
        if(db.getUserByEmail(email))throw Object.assign(new Error('Account already exists.'),{status:409});
        const password=await hashPassword(body.password);const count=db.countUsers();
        if(count>0&&!registrationOpen())throw Object.assign(new Error('Registration is closed. Ask the owner for access.'),{status:403});
        if(db.getUserByEmail(email))throw Object.assign(new Error('Account already exists.'),{status:409});
        const user=db.createUser({email,displayName,passwordHash:password.hash,passwordSalt:password.salt,role:count===0?'owner':'member'});
        if(count===0)db.claimOrphans(user.id);const codes=makeRecoveryCodes();db.replaceRecoveryCodes(user.id,codes.map(hashToken));const csrf=createSession(user,req,res);db.addEvent(user.id,'account_created','Created an Orbit account.');
        return json(res,201,{user:publicUser(user),csrf,recoveryCodes:codes});
      }
      if(req.method==='POST'&&url.pathname==='/api/auth/login'){
        if(rateLimited(req,40,'login'))throw Object.assign(new Error('Too many login attempts.'),{status:429});
        const body=await readJson(req);const user=db.getUserByEmail(safeEmail(body.email));const valid=user&&!user.disabled&&await verifyPassword(body.password,user.password_hash,user.password_salt);
        if(!valid)throw Object.assign(new Error('Email or password was not accepted.'),{status:401});const csrf=createSession(user,req,res);db.addEvent(user.id,'login','Signed in to Orbit.');return json(res,200,{user:publicUser(user),csrf});
      }
      if(req.method==='POST'&&url.pathname==='/api/auth/recover'){
        if(rateLimited(req,25,'recover'))throw Object.assign(new Error('Too many recovery attempts.'),{status:429});
        const body=await readJson(req);const user=db.getUserByEmail(safeEmail(body.email));const recovered=user&&db.consumeRecoveryCode(hashToken(String(body.recoveryCode||'').trim().toUpperCase()));
        if(!recovered||recovered.user_id!==user.id)throw Object.assign(new Error('Recovery information was not accepted.'),{status:401});const password=await hashPassword(body.newPassword);db.updatePassword(user.id,password.hash,password.salt);db.deleteUserSessions(user.id);const codes=makeRecoveryCodes();db.replaceRecoveryCodes(user.id,codes.map(hashToken));db.addEvent(user.id,'account_recovered','Recovered the account and revoked existing sessions.');return json(res,200,{ok:true,recoveryCodes:codes});
      }

      const callback=url.pathname.match(/^\/api\/connectors\/(github|slack)\/callback$/);
      if(req.method==='GET'&&callback){const code=url.searchParams.get('code');const state=url.searchParams.get('state');if(!code||!state)throw Object.assign(new Error('OAuth callback is incomplete.'),{status:400});const result=await connectors.complete(callback[1],code,state);db.addEvent(result.userId,'connector_connected',`Connected ${connectors.providers[result.provider].label}.`);res.writeHead(302,{Location:`/?connector=${encodeURIComponent(result.provider)}`});return res.end();}

      if(url.pathname.startsWith('/api/')){
        const user=authenticate(req);if(!user)return json(res,401,{error:'Authentication required.'});requireCsrf(req,user);
        if(req.method==='GET'&&url.pathname==='/api/auth/me')return json(res,200,{user:publicUser(user),csrf:user.csrf_token||null});
        if(req.method==='POST'&&url.pathname==='/api/auth/logout'){const token=parseCookies(req.headers.cookie).orbit_session;if(token)db.deleteSession(hashToken(token));res.setHeader('Set-Cookie',clearSessionCookie({secure:production}));return json(res,200,{ok:true});}
        if(req.method==='GET'&&url.pathname==='/api/status')return json(res,200,{buddyName,model:model.model,fallbackModel:model.fallbackModel,modelConfigured:model.configured,modelStatus:model.diagnostics(),version:'0.5.1',paused:paused(),pushConfigured:push.configured,connectors:connectors.available(),role:user.role});
        if(req.method==='POST'&&url.pathname==='/api/model/check'){const modelUserId=user.user_id||user.id;if(userRateLimited(modelUserId,'model-check',6,60_000))throw Object.assign(new Error('Too many connection checks. Try again in a minute.'),{status:429});const modelStatus=await model.checkConnection();db.addEvent(modelUserId,'model_connection_checked',`AI model connection: ${modelStatus.state.replaceAll('_',' ')}${modelStatus.activeModel?` (${modelStatus.activeModel})`:''}.`);return json(res,200,{modelStatus});}
        if(req.method==='GET'&&url.pathname==='/api/snapshot'){const me=user.user_id||user.id;const requested=url.searchParams.get('conversation');let active=requested?db.getConversation(me,requested):null;if(!active)active=db.ensureDefaultConversation(me);const summary=db.getConversationSummary(me,active.id);return json(res,200,{conversations:db.listConversations(me),activeConversation:active,messages:db.listConversationMessages(me,active.id),memories:db.listMemories(me),memorySuggestions:db.listMemorySuggestions(me),followUps:db.listFollowUps(me),goals:db.listGoals(me),routines:db.listRoutines(me),projects:db.listProjects(me),approvals:db.listApprovals(me),reliability:reliabilityFor(me),preferences:db.getPreferences(me),contextSummaryUpdatedAt:summary?.updated_at||null,tasks:db.listTasks(me),events:db.listEvents(me),artifacts:db.listArtifacts(me),connectors:db.listConnectors(me),calendarFeeds:db.listCalendarFeeds(me).map(publicFeed)});}
        const userId=user.user_id||user.id;
        if(req.method==='GET'&&url.pathname==='/api/chat/stream-state'){if(userRateLimited(userId,'stream',600))throw Object.assign(new Error('Too many requests. Try again shortly.'),{status:429});const conversationId=url.searchParams.get('conversationId');if(conversationId&&!db.getConversation(userId,conversationId))throw Object.assign(new Error('Conversation not found.'),{status:404});const stream=conversationId?pendingStreams.get(conversationId):null;if(!stream)return json(res,200,{state:'idle'});if(stream.done){pendingStreams.delete(conversationId);return json(res,200,{state:'done'});}return json(res,200,{state:'streaming',turn:stream.turn,text:stripModelMarkers(stream.text)});}
        if(req.method==='GET'&&url.pathname==='/api/calendar-feeds')return json(res,200,{feeds:db.listCalendarFeeds(userId).map(publicFeed)});
        if(req.method==='POST'&&url.pathname==='/api/calendar-feeds'){const body=await readJson(req);const label=cleanText(body.label,60,'label');const feedUrl=normalizeFeedUrl(cleanText(body.url,2000,'url'));let text;try{text=await fetchFeedText(feedUrl);}catch(error){throw Object.assign(new Error(`Could not read that calendar: ${error.message}`),{status:400});}const vevents=parseIcs(text);if(!vevents.length)throw Object.assign(new Error('That URL did not return a readable calendar (no events found).'),{status:400});const feed=db.addCalendarFeed(userId,{label,url:feedUrl});db.addEvent(userId,'calendar_feed_added',`Connected calendar \u201c${label}\u201d (${vevents.length} events found).`);return json(res,201,{feed:publicFeed(feed),eventsFound:vevents.length});}
        const feedMatch=url.pathname.match(/^\/api\/calendar-feeds\/([0-9a-f-]+)$/);if(req.method==='DELETE'&&feedMatch){if(!db.deleteCalendarFeed(userId,feedMatch[1]))throw Object.assign(new Error('Calendar feed not found.'),{status:404});dropFeedCache(feedMatch[1]);db.addEvent(userId,'calendar_feed_removed','Removed a calendar feed.');return json(res,200,{ok:true});}
        if(req.method==='POST'&&url.pathname==='/api/chat'){
          if(paused())throw Object.assign(new Error('Orbit is paused. Resume it before starting new AI work.'),{status:423});
          if(userRateLimited(userId,'chat'))throw Object.assign(new Error('Too many chat requests. Try again shortly.'),{status:429});
          const body=await readJson(req);const message=cleanText(body.message,6000,'message');let conversation;
          if(body.conversationId){conversation=db.getConversation(userId,String(body.conversationId));if(!conversation)throw Object.assign(new Error('Conversation not found.'),{status:404});}else conversation=db.ensureDefaultConversation(userId);
          const userMsg=db.addMessage(userId,conversation.id,'user',message);db.touchConversation(userId,conversation.id);
          enqueueChatReply(conversation.id,async()=>{
            if(!db.getConversation(userId,conversation.id))return;
            const streamState={turn:-1,text:'',done:false};pendingStreams.set(conversation.id,streamState);
            try{
              const history=db.listConversationMessages(userId,conversation.id,24).filter((m)=>m.id!==userMsg.id);
              const preferences=db.getPreferences(userId);const summary=db.getConversationSummary(userId,conversation.id);
              const { text: rawAnswer, toolCalls }=await model.respond({buddyName,userName:user.display_name,message,
                memories:db.listRelevantMemories(userId,message),goals:db.listActiveGoals(userId),projects:db.listProjects(userId).filter((project)=>project.status!=='completed'),history,conversationSummary:summary?.summary||'',userTimeZone:preferences.time_zone,
                tools:true,toolContext:{db,userId,timeZone:preferences.time_zone,messageId:userMsg.id},
                onTurn:(turn)=>{streamState.turn=turn;streamState.text='';},onToken:(delta)=>{streamState.text+=delta;}});
              for(const toolCall of toolCalls)db.addEvent(userId,'tool_use',`Used ${toolCall.name}${toolCall.detail?` (${toolCall.detail})`:''}.`);
              // Backward compatibility for replies from older/custom models that still emit legacy markers.
              for(const followUp of parseFollowUpMarkers(rawAnswer)){db.addFollowUp(userId,{description:followUp.description,dueDate:followUp.date,sourceMessageId:userMsg.id});db.addEvent(userId,'followup_noted',`Will check in about “${followUp.description}” after ${followUp.date}.`);}
              for(const suggestion of parseSuggestMarkers(rawAnswer)){db.addMemorySuggestion(userId,suggestion,{kind:'fact'});db.addEvent(userId,'memory_suggested',`Suggested a memory: “${suggestion}”.`);}
              const answer=stripModelMarkers(rawAnswer)||'Noted — I’ll check in about that afterwards.';
              db.addMessage(userId,conversation.id,'assistant',answer);db.addEvent(userId,'chat','Orbit replied to a message.');
            }catch(error){console.error('chat reply failed',conversation.id,error&&error.message);db.addEvent(userId,'chat_failed','Orbit could not finish a reply.',error&&error.message);const connectionIssue=['authentication','quota','rate_limit','model_access','network','service'].includes(error?.classification);db.addMessage(userId,conversation.id,'assistant',connectionIssue?'My model connection needs attention. Check the AI model connection card in Safety for the exact next step.':'I ran into trouble with that one — mind trying again?');}
            streamState.done=true;const cleanup=setTimeout(()=>{if(pendingStreams.get(conversation.id)===streamState)pendingStreams.delete(conversation.id);},60_000);cleanup.unref();
            await maybeRefreshConversationSummary(user,conversation);
          });
          return json(res,202,{id:userMsg.id,conversationId:conversation.id,status:'working'});
        }
        if(req.method==='GET'&&url.pathname==='/api/conversations')return json(res,200,{conversations:db.listConversations(userId)});
        if(req.method==='POST'&&url.pathname==='/api/conversations'){const body=await readJson(req);const raw=String(body.title||'').trim();const title=raw?cleanText(raw,80,'title'):'New chat';return json(res,201,db.createConversation(userId,title));}
        const convoMatch=url.pathname.match(/^\/api\/conversations\/([0-9a-f-]+)$/);if(req.method==='DELETE'&&convoMatch){if(!db.deleteConversation(userId,convoMatch[1]))throw Object.assign(new Error('Conversation not found.'),{status:404});return json(res,200,{ok:true});}
        if(req.method==='POST'&&url.pathname==='/api/memories'){const body=await readJson(req);const memory=db.addMemory(userId,cleanText(body.content,2000,'content'),{kind:normalizeMemoryKind(body.kind),source:'user'});db.addEvent(userId,'memory_added',`Saved a user-approved ${memory.kind} memory.`);return json(res,201,memory);}
        const memoryMatch=url.pathname.match(/^\/api\/memories\/([0-9a-f-]+)$/);if(req.method==='DELETE'&&memoryMatch){if(!db.deleteMemory(userId,memoryMatch[1]))throw Object.assign(new Error('Memory not found.'),{status:404});db.addEvent(userId,'memory_deleted','Deleted a memory.');return json(res,200,{ok:true});}
        const suggestMatch=url.pathname.match(/^\/api\/memory-suggestions\/([0-9a-f-]+)\/(approve|dismiss)$/);if(req.method==='POST'&&suggestMatch){const action=suggestMatch[2];const row=action==='approve'?db.approveMemorySuggestion(userId,suggestMatch[1]):(db.dismissMemorySuggestion(userId,suggestMatch[1])?{id:suggestMatch[1]}:null);if(!row)throw Object.assign(new Error('Suggestion not found.'),{status:404});db.addEvent(userId,action==='approve'?'memory_added':'memory_suggestion_dismissed',action==='approve'?`Saved a suggested memory: “${row.content}”.`:'Dismissed a memory suggestion.');return json(res,200,{ok:true});}
        const followUpMatch=url.pathname.match(/^\/api\/follow-ups\/([0-9a-f-]+)$/);if(req.method==='DELETE'&&followUpMatch){if(!db.deleteFollowUp(userId,followUpMatch[1]))throw Object.assign(new Error('Follow-up not found.'),{status:404});db.addEvent(userId,'followup_deleted','Removed a scheduled follow-up.');return json(res,200,{ok:true});}
        if(req.method==='GET'&&url.pathname==='/api/preferences')return json(res,200,{preferences:db.getPreferences(userId)});
        if(req.method==='POST'&&url.pathname==='/api/preferences'){const body=await readJson(req);const preferences=db.setPreferences(userId,body);db.addEvent(userId,'preferences_updated','Updated timezone, quiet hours, or proactive check-in preferences.');return json(res,200,{preferences});}
        if(req.method==='POST'&&url.pathname==='/api/goals'){const body=await readJson(req);const targetDate=body.targetDate?validDateString(body.targetDate):null;if(body.targetDate&&!targetDate)throw Object.assign(new Error('targetDate must be YYYY-MM-DD.'),{status:400});const goal=db.addGoal(userId,{title:cleanText(body.title,120,'title'),description:optionalText(body.description,1000),priority:normalizePriority(body.priority),targetDate,nextStep:optionalText(body.nextStep,500)});db.addEvent(userId,'goal_created',`Started tracking goal “${goal.title}”.`);return json(res,201,goal);}
        const goalMatch=url.pathname.match(/^\/api\/goals\/([0-9a-f-]+)$/);if(goalMatch&&req.method==='PATCH'){const body=await readJson(req);if(body.progress!==undefined&&(!Number.isFinite(Number(body.progress))||Number(body.progress)<0||Number(body.progress)>100))throw Object.assign(new Error('progress must be from 0 to 100.'),{status:400});if(body.status!==undefined&&!['active','paused','completed'].includes(body.status))throw Object.assign(new Error('status is not valid.'),{status:400});const goal=db.updateGoal(userId,goalMatch[1],{progress:body.progress,status:body.status,nextStep:body.nextStep===undefined?undefined:optionalText(body.nextStep,500),note:optionalText(body.note,1000)});if(!goal)throw Object.assign(new Error('Goal not found.'),{status:404});db.addEvent(userId,'goal_updated',`Updated “${goal.title}” to ${goal.progress}% (${goal.status}).`);return json(res,200,goal);}
        if(goalMatch&&req.method==='DELETE'){if(!db.deleteGoal(userId,goalMatch[1]))throw Object.assign(new Error('Goal not found.'),{status:404});db.addEvent(userId,'goal_deleted','Deleted a goal and its check-ins.');return json(res,200,{ok:true});}
        if(req.method==='POST'&&url.pathname==='/api/routines'){const body=await readJson(req);const kind=['briefing','reflection','custom'].includes(body.kind)?body.kind:'custom';const cadence=['daily','weekdays','weekly'].includes(body.cadence)?body.cadence:'daily';const timeLocal=validTimeString(body.timeLocal);if(!timeLocal)throw Object.assign(new Error('timeLocal must be HH:MM.'),{status:400});const dayOfWeek=Number(body.dayOfWeek);if(cadence==='weekly'&&(!Number.isInteger(dayOfWeek)||dayOfWeek<0||dayOfWeek>6))throw Object.assign(new Error('dayOfWeek must be an integer from 0 through 6.'),{status:400});const routine=db.addRoutine(userId,{title:cleanText(body.title,120,'title'),prompt:cleanText(body.prompt,2000,'prompt'),kind,cadence,timeLocal,dayOfWeek:cadence==='weekly'?dayOfWeek:null});db.addEvent(userId,'routine_created',`Created ${cadence} routine “${routine.title}” at ${timeLocal}.`);setImmediate(runProactiveChecks);return json(res,201,routine);}
        const routineMatch=url.pathname.match(/^\/api\/routines\/([0-9a-f-]+)$/);if(routineMatch&&req.method==='PATCH'){const body=await readJson(req);if(typeof body.enabled!=='boolean')throw Object.assign(new Error('enabled must be true or false.'),{status:400});if(!db.setRoutineEnabled(userId,routineMatch[1],body.enabled))throw Object.assign(new Error('Routine not found.'),{status:404});db.addEvent(userId,body.enabled?'routine_enabled':'routine_paused',`${body.enabled?'Enabled':'Paused'} a routine.`);if(body.enabled)setImmediate(runProactiveChecks);return json(res,200,db.getRoutine(userId,routineMatch[1]));}
        if(routineMatch&&req.method==='DELETE'){if(!db.deleteRoutine(userId,routineMatch[1]))throw Object.assign(new Error('Routine not found.'),{status:404});db.addEvent(userId,'routine_deleted','Deleted a routine.');return json(res,200,{ok:true});}
        if(req.method==='POST'&&url.pathname==='/api/projects'){const body=await readJson(req);const targetDate=body.targetDate?validDateString(body.targetDate):null;if(body.targetDate&&!targetDate)throw Object.assign(new Error('targetDate must be YYYY-MM-DD.'),{status:400});const steps=Array.isArray(body.steps)?body.steps.slice(0,50).map((step)=>{const dueDate=step?.dueDate?validDateString(step.dueDate):null;if(step?.dueDate&&!dueDate)throw Object.assign(new Error('step dueDate must be YYYY-MM-DD.'),{status:400});return {title:cleanText(typeof step==='string'?step:step?.title,160,'step title'),details:optionalText(step?.details,1000),dueDate};}):[];const project=db.addProject(userId,{title:cleanText(body.title,120,'title'),description:optionalText(body.description,1000),priority:normalizePriority(body.priority),targetDate,steps});db.addEvent(userId,'project_created',`Created project “${project.title}” with ${project.steps.length} steps.`);return json(res,201,project);}
        const projectMatch=url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)$/);if(projectMatch&&req.method==='PATCH'){const body=await readJson(req);if(body.status!==undefined&&!['active','paused','completed'].includes(body.status))throw Object.assign(new Error('status is not valid.'),{status:400});if(body.targetDate&&!validDateString(body.targetDate))throw Object.assign(new Error('targetDate must be YYYY-MM-DD.'),{status:400});const project=db.updateProject(userId,projectMatch[1],{title:body.title===undefined?undefined:cleanText(body.title,120,'title'),description:body.description===undefined?undefined:optionalText(body.description,1000),status:body.status,priority:body.priority,targetDate:body.targetDate});if(!project)throw Object.assign(new Error('Project not found.'),{status:404});db.addEvent(userId,'project_updated',`Updated project “${project.title}” (${project.status}).`);return json(res,200,project);}
        if(projectMatch&&req.method==='DELETE'){if(!db.deleteProject(userId,projectMatch[1]))throw Object.assign(new Error('Project not found.'),{status:404});db.addEvent(userId,'project_deleted','Deleted a project and its steps.');return json(res,200,{ok:true});}
        const projectStepsMatch=url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/steps$/);if(projectStepsMatch&&req.method==='POST'){const body=await readJson(req);const dueDate=body.dueDate?validDateString(body.dueDate):null;if(body.dueDate&&!dueDate)throw Object.assign(new Error('dueDate must be YYYY-MM-DD.'),{status:400});const step=db.addProjectStep(userId,projectStepsMatch[1],{title:cleanText(body.title,160,'title'),details:optionalText(body.details,1000),dueDate});if(!step)throw Object.assign(new Error('Project not found.'),{status:404});db.addEvent(userId,'project_step_added',`Added project step “${step.title}”.`);return json(res,201,step);}
        const projectStepMatch=url.pathname.match(/^\/api\/project-steps\/([0-9a-f-]+)$/);if(projectStepMatch&&req.method==='PATCH'){const body=await readJson(req);if(body.status!==undefined&&!['planned','in_progress','blocked','completed'].includes(body.status))throw Object.assign(new Error('status is not valid.'),{status:400});if(body.dueDate&&!validDateString(body.dueDate))throw Object.assign(new Error('dueDate must be YYYY-MM-DD.'),{status:400});const step=db.updateProjectStep(userId,projectStepMatch[1],{title:body.title===undefined?undefined:cleanText(body.title,160,'title'),details:body.details===undefined?undefined:optionalText(body.details,1000),status:body.status,dueDate:body.dueDate});if(!step)throw Object.assign(new Error('Project step not found.'),{status:404});db.addEvent(userId,'project_step_updated',`Updated “${step.title}” (${step.status}).`);return json(res,200,step);}
        if(projectStepMatch&&req.method==='DELETE'){if(!db.deleteProjectStep(userId,projectStepMatch[1]))throw Object.assign(new Error('Project step not found.'),{status:404});db.addEvent(userId,'project_step_deleted','Deleted a project step.');return json(res,200,{ok:true});}
        const approvalMatch=url.pathname.match(/^\/api\/approvals\/([0-9a-f-]+)\/(approve|reject)$/);if(approvalMatch&&req.method==='POST'){const approval=db.getApproval(userId,approvalMatch[1]);if(!approval)throw Object.assign(new Error('Approval item not found.'),{status:404});if(approval.status!=='pending')throw Object.assign(new Error('Approval item was already reviewed.'),{status:409});if(approvalMatch[2]==='reject'){const rejected=db.resolveApproval(userId,approval.id,'rejected');db.addEvent(userId,'approval_rejected',`Rejected “${approval.title}”.`);return json(res,200,rejected);}if(approval.kind!=='calendar_event')throw Object.assign(new Error('This approval type is not supported.'),{status:400});const content=calendarEventIcs(approval);const artifact=db.addArtifact(userId,{name:`${artifactName(approval.payload.title).replace(/\.md$/,'.ics')}`,mimeType:'text/calendar; charset=utf-8',content});const executed=db.resolveApproval(userId,approval.id,'executed',{result:{artifactId:artifact.id}});db.addEvent(userId,'approval_executed',`Approved calendar file “${approval.payload.title}”.`);return json(res,200,{approval:executed,artifact});}
        if(req.method==='POST'&&url.pathname==='/api/tasks'){if(paused())throw Object.assign(new Error('Orbit is paused.'),{status:423});if(userRateLimited(userId,'tasks'))throw Object.assign(new Error('Too many task requests. Try again shortly.'),{status:429});const body=await readJson(req);const risk=body.risk==='external'?'external':'internal';const recurrence=['daily','weekly'].includes(body.recurrence)?body.recurrence:'none';let scheduleAt=null;if(body.scheduleAt){const date=new Date(body.scheduleAt);if(Number.isNaN(date.valueOf()))throw Object.assign(new Error('scheduleAt must be valid.'),{status:400});scheduleAt=date.toISOString();}const task=db.addTask(userId,{title:cleanText(body.title,120,'title'),prompt:cleanText(body.prompt,6000,'prompt'),risk,scheduleAt,recurrence});db.addEvent(userId,'task_created',`Created “${task.title}”.`,risk==='external'?'Waiting for approval.':null);setImmediate(runDueTasks);return json(res,201,task);}
        const taskMatch=url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/(approve|cancel)$/);if(req.method==='POST'&&taskMatch){const task=db.getTask(userId,taskMatch[1]);if(!task)throw Object.assign(new Error('Task not found.'),{status:404});const action=taskMatch[2];const status=action==='approve'?(task.schedule_at?'scheduled':'queued'):'cancelled';db.setTaskStatus(userId,task.id,status);db.addEvent(userId,`task_${action}d`,`${action==='approve'?'Approved':'Cancelled'} “${task.title}”.`);if(action==='approve')setImmediate(runDueTasks);return json(res,200,{...task,status});}
        const artifactMatch=url.pathname.match(/^\/api\/artifacts\/([0-9a-f-]+)$/);if(req.method==='GET'&&artifactMatch){const artifact=db.getArtifact(userId,artifactMatch[1]);if(!artifact)throw Object.assign(new Error('Artifact not found.'),{status:404});res.writeHead(200,{'Content-Type':artifact.mime_type,'Content-Disposition':`attachment; filename="${artifact.name.replace(/["\r\n]/g,'')}"`,'Cache-Control':'no-store'});return res.end(artifact.content);}
        if(req.method==='GET'&&url.pathname==='/api/push/public-key')return json(res,200,{configured:push.configured,publicKey:push.publicKey});
        if(req.method==='POST'&&url.pathname==='/api/push/subscribe'){if(!push.configured)throw Object.assign(new Error('Push is not configured.'),{status:503});const body=await readJson(req);if(!body.endpoint||!body.keys?.p256dh||!body.keys?.auth)throw Object.assign(new Error('Push subscription is incomplete.'),{status:400});db.savePush(userId,body);db.addEvent(userId,'push_enabled','Enabled push notifications on a device.');return json(res,201,{ok:true});}
        if(req.method==='POST'&&url.pathname==='/api/push/unsubscribe'){const body=await readJson(req);db.deletePush(userId,String(body.endpoint||''));return json(res,200,{ok:true});}
        const connectBegin=url.pathname.match(/^\/api\/connectors\/(github|slack)\/begin$/);if(req.method==='POST'&&connectBegin){if(paused())throw Object.assign(new Error('Orbit is paused.'),{status:423});return json(res,200,{url:connectors.begin(userId,connectBegin[1],originFor(req))});}
        const connectorMatch=url.pathname.match(/^\/api\/connectors\/(github|slack)$/);if(req.method==='DELETE'&&connectorMatch){db.deleteConnector(userId,connectorMatch[1]);db.addEvent(userId,'connector_disconnected',`Disconnected ${connectors.providers[connectorMatch[1]].label}.`);return json(res,200,{ok:true});}
        const connectorPreview=url.pathname.match(/^\/api\/connectors\/(github|slack)\/preview$/);if(req.method==='GET'&&connectorPreview){if(paused())throw Object.assign(new Error('Orbit is paused.'),{status:423});return json(res,200,{items:await connectors.preview(userId,connectorPreview[1])});}
        if(req.method==='POST'&&url.pathname==='/api/recovery-codes/rotate'){const body=await readJson(req);const account=db.getUserById(userId);if(!await verifyPassword(body.password,account.password_hash,account.password_salt))throw Object.assign(new Error('Password was not accepted.'),{status:401});const codes=makeRecoveryCodes();db.replaceRecoveryCodes(userId,codes.map(hashToken));db.addEvent(userId,'recovery_codes_rotated','Rotated account recovery codes.');return json(res,200,{recoveryCodes:codes});}
        if(req.method==='POST'&&url.pathname==='/api/backups/export'){const body=await readJson(req);const payload=await encryptPortable(db.exportUser(userId),body.passphrase);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="orbit-backup.orbitbackup"','Cache-Control':'no-store'});return res.end(payload);}
        if(req.method==='POST'&&url.pathname==='/api/backups/restore'){requireOwner(user);const body=await readJson(req,12*1024*1024);if(body.confirm!=='RESTORE')throw Object.assign(new Error('Type RESTORE to confirm.'),{status:400});const bundle=await decryptPortable(body.payload,body.passphrase);setPaused(true);db.restoreUser(userId,bundle);db.addEvent(userId,'backup_restored','Merged an encrypted backup. Orbit remains paused for review.');return json(res,200,{ok:true,paused:true});}
        if(req.method==='POST'&&url.pathname==='/api/admin/pause'){requireOwner(user);setPaused(true);for(const account of db.listUsers()){db.addEvent(account.id,'emergency_pause','Emergency pause enabled.');await push.notify(account.id,`${buddyName} paused`,'Background work and connectors are paused.',{view:'activity'});}return json(res,200,{paused:true});}
        if(req.method==='POST'&&url.pathname==='/api/admin/resume'){requireOwner(user);const body=await readJson(req);if(body.confirm!=='RESUME')throw Object.assign(new Error('Type RESUME to continue.'),{status:400});setPaused(false);db.addEvent(userId,'emergency_resume','Emergency pause cleared.');setImmediate(runDueTasks);return json(res,200,{paused:false});}
        if(req.method==='GET'&&url.pathname==='/api/admin/registration'){requireOwner(user);return json(res,200,{open:registrationOpen()});}
        if(req.method==='POST'&&url.pathname==='/api/admin/registration'){requireOwner(user);const body=await readJson(req);const open=body.open===true;db.setSetting('registration_open',open?'true':'false');db.setSetting('registration_opened_at',open?new Date().toISOString():'');db.addEvent(userId,open?'registration_opened':'registration_closed',open?'Opened registration.':'Closed registration.');return json(res,200,{open});}
        if(req.method==='GET'&&url.pathname==='/api/admin/access-requests'){requireOwner(user);return json(res,200,{requests:db.listAccessRequests()});}
        const accessDismiss=url.pathname.match(/^\/api\/admin\/access-requests\/([0-9a-f-]+)$/);if(req.method==='POST'&&accessDismiss){requireOwner(user);db.dismissAccessRequest(accessDismiss[1]);return json(res,200,{ok:true});}
        return json(res,404,{error:'API route not found.'});
      }
    } catch(error) { console.error('request failed',req.method,url.pathname,error&&error.message);const modelIssue=['authentication','quota','rate_limit','model_access','network','service'].includes(error?.classification);const message=error.status?error.message:modelIssue?'The AI model connection needs attention. Open Safety and run Check connection.':'Orbit encountered an internal server error. Please retry once.';return json(res,error.status||500,{error:message}); }

    if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'Method not allowed.'});const requestPath=url.pathname==='/'?'/index.html':url.pathname;let resolved;try{resolved=path.resolve(publicRoot,`.${decodeURIComponent(requestPath)}`);}catch{return json(res,404,{error:'Not found.'});}if(!resolved.startsWith(`${publicRoot}${path.sep}`))return json(res,404,{error:'Not found.'});
    try{const stat=fs.statSync(resolved);if(!stat.isFile())throw new Error();const shellAsset=['index.html','app.js','sw.js'].includes(path.basename(resolved));res.writeHead(200,{'Content-Type':mime[path.extname(resolved)]||'application/octet-stream','Cache-Control':shellAsset?'no-cache':'public, max-age=3600'});if(req.method==='HEAD')return res.end();fs.createReadStream(resolved).pipe(res);}catch{return json(res,404,{error:'Not found.'});}
  });

  const workerMs=Math.max(Number(env.TASK_POLL_MS)||15_000,5_000);let workerTimer;let backupTimer;
  return {server,db,runDueTasks,runProactiveChecks,checkDoorLeftOpen,
    startWorker(){workerTimer=setInterval(()=>{runDueTasks();runProactiveChecks();checkDoorLeftOpen().catch(()=>{});},workerMs);workerTimer.unref();backupTimer=setInterval(runBackups,60*60_000);backupTimer.unref();setImmediate(()=>model.checkConnection().catch(()=>{}));setImmediate(runDueTasks);setImmediate(runProactiveChecks);setImmediate(runBackups);},
    async close(){if(workerTimer)clearInterval(workerTimer);if(backupTimer)clearInterval(backupTimer);if(server.listening)await new Promise((resolve)=>server.close(resolve));db.close();}
  };
}

if(process.argv[1]===fileURLToPath(import.meta.url)){const app=createOrbitServer();const port=Number(process.env.PORT)||3000;const host=process.env.HOST||'127.0.0.1';app.server.listen(port,host,()=>{app.startWorker();console.log(`Orbit Buddy is ready at http://${host}:${port}`);});}
