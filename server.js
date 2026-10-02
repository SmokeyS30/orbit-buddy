import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './src/database.js';
import { createModelClient } from './src/model.js';
import { createPushService } from './src/push.js';
import { createConnectorService } from './src/connectors.js';
import { writeAutomatedBackup } from './src/backups.js';
import {
  clearSessionCookie, decryptPortable, encryptPortable, hashPassword, hashToken,
  makeRecoveryCodes, parseCookies, randomToken, readEncryptionKey, sessionCookie, verifyPassword
} from './src/security.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(root, 'public');
const mime = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json' };
const now = () => new Date().toISOString();

function json(res,status,body,headers={}) { res.writeHead(status,{ 'Content-Type':'application/json; charset=utf-8',...headers }); res.end(JSON.stringify(body)); }
function cleanText(value,max,field) { if(typeof value!=='string'||!value.trim()) throw Object.assign(new Error(`${field} is required.`),{status:400}); return value.trim().slice(0,max); }
function safeEmail(value) { const email=String(value||'').trim().toLowerCase(); if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254) throw Object.assign(new Error('A valid email is required.'),{status:400}); return email; }
async function readJson(req,limit=1024*1024) { const chunks=[]; let size=0; for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(new Error('Request body is too large.'),{status:413});chunks.push(chunk);} if(!chunks.length)return{}; try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(new Error('Request body must be valid JSON.'),{status:400});} }
function nextRun(recurrence,previous){if(recurrence==='none')return null;const date=previous?new Date(previous):new Date();const days=recurrence==='weekly'?7:1;do{date.setUTCDate(date.getUTCDate()+days);}while(date<=new Date());return date.toISOString();}
function artifactName(title){const base=title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60)||'orbit-result';return `${base}.md`;}

// Buddy-initiative helpers: the model flags upcoming events with [FOLLOWUP: <desc> on YYYY-MM-DD]
// markers; the server turns them into memories and later checks in unprompted.
const FOLLOWUP_MARKER_RE = /\[FOLLOWUP:\s*([^\]\n]+?)\s+on\s+(\d{4}-\d{2}-\d{2})\s*\]/gi;
const FOLLOWUP_MEMORY_RE = /^follow up:\s*(.+?)\s+on\s+(\d{4}-\d{2}-\d{2})\s*$/i;
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
  const db=openDatabase(options.dbPath||path.join(dataDir,'orbit.sqlite'));
  const model=createModelClient(env);
  const encryptionKey=readEncryptionKey(env.CONNECTOR_ENCRYPTION_KEY);
  const push=createPushService(env,db);
  const connectors=createConnectorService(env,db,encryptionKey);
  const production=env.NODE_ENV==='production';
  const openRegistration=env.OPEN_REGISTRATION==='true';
  const publicBase=env.PUBLIC_BASE_URL?.replace(/\/$/,'')||null;
  if(publicBase && !/^https:\/\//.test(publicBase) && production) throw new Error('PUBLIC_BASE_URL must use HTTPS in production.');

  const requestLog=new Map();
  function rateLimited(req,limit=240,scope='global'){const key=`${scope}:${req.socket.remoteAddress||'unknown'}`;const current=Date.now();const recent=(requestLog.get(key)||[]).filter((time)=>current-time<60_000);recent.push(current);requestLog.set(key,recent);return recent.length>limit;}
  const userLog=new Map();
  function userRateLimited(userId,scope,limit=30,windowMs=5*60_000){const key=`${userId}:${scope}`;const current=Date.now();const recent=(userLog.get(key)||[]).filter((time)=>current-time<windowMs);recent.push(current);userLog.set(key,recent);return recent.length>limit;}
  const paused=()=>db.getSetting('system_paused','false')==='true';
  const setPaused=(value)=>db.setSetting('system_paused',value?'true':'false');

  function originFor(req){if(publicBase)return publicBase;const protocol=req.headers['x-forwarded-proto']==='https'?'https':production?'https':'http';return `${protocol}://${req.headers.host}`;}
  function sessionUser(req){const token=parseCookies(req.headers.cookie).orbit_session;if(!token)return null;return db.getSession(hashToken(token));}
  function automationUser(req){const token=req.headers.authorization?.match(/^Bearer\s+(orbit_[A-Za-z0-9_-]+)$/)?.[1];if(!token)return null;const row=db.getAutomationToken(hashToken(token));if(!row)return null;const user=db.getUserById(row.user_id);return user&&!user.disabled?{...user,automation:true,scopes:row.scopes}:null;}
  function authenticate(req){const session=sessionUser(req);if(session&&!session.disabled)return{...session,automation:false};return automationUser(req);}
  function requireCsrf(req,user){if(user.automation)return; if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.headers['x-orbit-csrf']!==user.csrf_token)throw Object.assign(new Error('Security token is missing or expired.'),{status:403});}
  function requireOwner(user){if(user.role!=='owner')throw Object.assign(new Error('Owner access is required.'),{status:403});}
  function createSession(user,req,res){const token=randomToken();const csrf=randomToken(24);const expiresAt=new Date(Date.now()+30*24*60*60_000).toISOString();db.createSession({tokenHash:hashToken(token),userId:user.id,csrfToken:csrf,expiresAt,userAgent:String(req.headers['user-agent']||'').slice(0,300)});res.setHeader('Set-Cookie',sessionCookie(token,{secure:production}));return csrf;}
  function publicUser(user){return{id:user.user_id||user.id,email:user.email,displayName:user.display_name,role:user.role};}

  let workerBusy=false;
  async function runDueTasks(){if(workerBusy||paused())return;workerBusy=true;try{for(const task of db.dueTasks()){db.setTaskStatus(task.user_id,task.id,'running');db.addEvent(task.user_id,'task_started',`Started “${task.title}”.`);try{const taskUser=db.getUserById(task.user_id);const result=await model.respond({buddyName,userName:taskUser?.display_name,message:task.prompt,memories:db.listMemories(task.user_id),history:[],taskMode:true});const following=nextRun(task.recurrence,task.schedule_at);const isNudge=/^\[nudge\]/i.test(task.title);db.completeTask(task.user_id,task.id,result,following?'scheduled':'completed',following);if(!isNudge)db.addArtifact(task.user_id,{taskId:task.id,name:artifactName(task.title),content:`# ${task.title}\n\n${result}\n`});db.addEvent(task.user_id,'task_completed',`Completed “${task.title}”.`);await push.notify(task.user_id,isNudge?buddyName:`${buddyName} finished a task`,isNudge?result:task.title,isNudge?{view:'today'}:{view:'tasks',taskId:task.id});}catch(error){db.completeTask(task.user_id,task.id,'Task failed safely.','failed',null);db.addEvent(task.user_id,'task_failed',`Could not complete “${task.title}”.`,error.message);await push.notify(task.user_id,`${buddyName} needs attention`,`${task.title} could not be completed.`,{view:'tasks'});}}}finally{workerBusy=false;}}

  // A proactive message lands in the default conversation AND as a push notification,
  // so the buddy reaches out even on devices without push enabled.
  async function deliverProactive(user,text,eventType,eventMessage){
    const conversation=db.ensureDefaultConversation(user.id);
    db.addMessage(user.id,conversation.id,'assistant',text);
    db.touchConversation(user.id,conversation.id);
    db.addEvent(user.id,eventType,eventMessage);
    await push.notify(user.id,buddyName,text,{view:'today'});
  }
  async function runFollowUps(today){
    for(const user of db.listUsers()){
      if(user.disabled)continue;
      for(const memory of db.listMemories(user.id)){
        const match=FOLLOWUP_MEMORY_RE.exec(memory.content);
        if(!match||match[2]>today)continue;
        const prompt=`Write a short, warm check-in message (1-2 sentences, plain text, no greeting header) asking how "${match[1]}" went. Sound like a caring friend dropping by, not a notification. Do not mention that this is automated.`;
        try{
          const text=await model.respond({buddyName,userName:user.display_name,message:prompt,memories:db.listMemories(user.id),history:[],taskMode:true});
          await deliverProactive(user,text,'followup_sent',`Checked in about “${match[1]}”.`);
          db.deleteMemory(user.id,memory.id);
        }catch(error){db.addEvent(user.id,'followup_failed',`Could not check in about “${match[1]}”.`,error.message);}
      }
    }
  }
  async function runQuietNudges(nowMs){
    for(const user of db.listUsers()){
      if(user.disabled)continue;
      if(!quietNudgeDue(db.lastUserMessageAt(user.id),db.getLastQuietNudgeAt(user.id),nowMs))continue;
      const prompt=`Write a short, warm check-in (1-2 sentences, plain text) for someone you have not heard from in a couple of days. Sound like a friend popping by, not a notification. You may gently reference something from their memories if one fits naturally; otherwise keep it simple. Do not mention that this is automated.`;
      try{
        const text=await model.respond({buddyName,userName:user.display_name,message:prompt,memories:db.listMemories(user.id),history:[],taskMode:true});
        db.setLastQuietNudgeAt(user.id,new Date(nowMs).toISOString());
        await deliverProactive(user,text,'quiet_nudge_sent','Sent a quiet check-in nudge.');
      }catch(error){db.addEvent(user.id,'quiet_nudge_failed','Could not send a quiet check-in.',error.message);}
    }
  }
  let proactiveBusy=false;
  async function runProactiveChecks(nowMs=Date.now()){
    if(proactiveBusy||paused())return;proactiveBusy=true;
    try{await runFollowUps(new Date(nowMs).toISOString().slice(0,10));await runQuietNudges(nowMs);}
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
    if(url.pathname==='/healthz')return json(res,200,{ok:true,service:'orbit-buddy',paused:paused()});

    try {
      if(req.method==='GET'&&url.pathname==='/api/auth/setup-status'){const needsOwner=db.countUsers()===0;return json(res,200,{needsOwner,registrationOpen:needsOwner||openRegistration});}
      if(req.method==='POST'&&url.pathname==='/api/auth/register'){
        if(rateLimited(req,30,'register'))throw Object.assign(new Error('Too many registration attempts.'),{status:429});
        const body=await readJson(req);const email=safeEmail(body.email);const displayName=cleanText(body.displayName,80,'displayName');
        if(db.getUserByEmail(email))throw Object.assign(new Error('Account already exists.'),{status:409});
        const password=await hashPassword(body.password);const count=db.countUsers();
        if(count>0&&!openRegistration)throw Object.assign(new Error('Registration is currently closed.'),{status:403});
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

      const callback=url.pathname.match(/^\/api\/connectors\/(github|google|slack)\/callback$/);
      if(req.method==='GET'&&callback){const code=url.searchParams.get('code');const state=url.searchParams.get('state');if(!code||!state)throw Object.assign(new Error('OAuth callback is incomplete.'),{status:400});const result=await connectors.complete(callback[1],code,state);db.addEvent(result.userId,'connector_connected',`Connected ${connectors.providers[result.provider].label}.`);res.writeHead(302,{Location:`/?connector=${encodeURIComponent(result.provider)}`});return res.end();}

      if(url.pathname.startsWith('/api/')){
        const user=authenticate(req);if(!user)return json(res,401,{error:'Authentication required.'});requireCsrf(req,user);
        if(req.method==='GET'&&url.pathname==='/api/auth/me')return json(res,200,{user:publicUser(user),csrf:user.csrf_token||null});
        if(req.method==='POST'&&url.pathname==='/api/auth/logout'){if(!user.automation){const token=parseCookies(req.headers.cookie).orbit_session;if(token)db.deleteSession(hashToken(token));res.setHeader('Set-Cookie',clearSessionCookie({secure:production}));}return json(res,200,{ok:true});}
        if(req.method==='GET'&&url.pathname==='/api/status')return json(res,200,{buddyName,model:model.model,modelConfigured:model.configured,version:'0.2.0',paused:paused(),pushConfigured:push.configured,connectors:connectors.available(),role:user.role});
        if(req.method==='GET'&&url.pathname==='/api/snapshot'){const me=user.user_id||user.id;const requested=url.searchParams.get('conversation');let active=requested?db.getConversation(me,requested):null;if(!active)active=db.ensureDefaultConversation(me);return json(res,200,{conversations:db.listConversations(me),activeConversation:active,messages:db.listConversationMessages(me,active.id),memories:db.listMemories(me),tasks:db.listTasks(me),events:db.listEvents(me),artifacts:db.listArtifacts(me),connectors:db.listConnectors(me),automationTokens:db.listAutomationTokens(me)});}
        const userId=user.user_id||user.id;
        if(req.method==='POST'&&url.pathname==='/api/chat'){if(paused())throw Object.assign(new Error('Orbit is paused. Resume it before starting new AI work.'),{status:423});if(user.automation)throw Object.assign(new Error('Automation tokens cannot use chat.'),{status:403});if(userRateLimited(userId,'chat'))throw Object.assign(new Error('Too many chat requests. Try again shortly.'),{status:429});const body=await readJson(req);const message=cleanText(body.message,6000,'message');let conversation;if(body.conversationId){conversation=db.getConversation(userId,String(body.conversationId));if(!conversation)throw Object.assign(new Error('Conversation not found.'),{status:404});}else conversation=db.ensureDefaultConversation(userId);const history=db.listConversationMessages(userId,conversation.id,20);db.addMessage(userId,conversation.id,'user',message);const rawAnswer=await model.respond({buddyName,userName:user.display_name,message,memories:db.listMemories(userId),history});for(const followUp of parseFollowUpMarkers(rawAnswer)){db.addMemory(userId,`Follow up: ${followUp.description} on ${followUp.date}`);db.addEvent(userId,'followup_noted',`Will check in about “${followUp.description}” after ${followUp.date}.`);}const answer=stripFollowUpMarkers(rawAnswer)||'Noted — I’ll check in about that afterwards.';const saved=db.addMessage(userId,conversation.id,'assistant',answer);db.touchConversation(userId,conversation.id);db.addEvent(userId,'chat','Orbit replied to a message.');return json(res,201,saved);}
        if(req.method==='GET'&&url.pathname==='/api/conversations')return json(res,200,{conversations:db.listConversations(userId)});
        if(req.method==='POST'&&url.pathname==='/api/conversations'){const body=await readJson(req);const raw=String(body.title||'').trim();const title=raw?cleanText(raw,80,'title'):'New chat';return json(res,201,db.createConversation(userId,title));}
        const convoMatch=url.pathname.match(/^\/api\/conversations\/([0-9a-f-]+)$/);if(req.method==='DELETE'&&convoMatch){if(!db.deleteConversation(userId,convoMatch[1]))throw Object.assign(new Error('Conversation not found.'),{status:404});return json(res,200,{ok:true});}
        if(req.method==='POST'&&url.pathname==='/api/memories'){const body=await readJson(req);const memory=db.addMemory(userId,cleanText(body.content,2000,'content'));db.addEvent(userId,'memory_added','Saved a user-approved memory.');return json(res,201,memory);}
        const memoryMatch=url.pathname.match(/^\/api\/memories\/([0-9a-f-]+)$/);if(req.method==='DELETE'&&memoryMatch){if(!db.deleteMemory(userId,memoryMatch[1]))throw Object.assign(new Error('Memory not found.'),{status:404});db.addEvent(userId,'memory_deleted','Deleted a memory.');return json(res,200,{ok:true});}
        if(req.method==='POST'&&url.pathname==='/api/tasks'){if(paused())throw Object.assign(new Error('Orbit is paused.'),{status:423});if(userRateLimited(userId,'tasks'))throw Object.assign(new Error('Too many task requests. Try again shortly.'),{status:429});const body=await readJson(req);const risk=body.risk==='external'?'external':'internal';const recurrence=['daily','weekly'].includes(body.recurrence)?body.recurrence:'none';let scheduleAt=null;if(body.scheduleAt){const date=new Date(body.scheduleAt);if(Number.isNaN(date.valueOf()))throw Object.assign(new Error('scheduleAt must be valid.'),{status:400});scheduleAt=date.toISOString();}const task=db.addTask(userId,{title:cleanText(body.title,120,'title'),prompt:cleanText(body.prompt,6000,'prompt'),risk,scheduleAt,recurrence});db.addEvent(userId,'task_created',`Created “${task.title}”.`,risk==='external'?'Waiting for approval.':null);setImmediate(runDueTasks);return json(res,201,task);}
        const taskMatch=url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/(approve|cancel)$/);if(req.method==='POST'&&taskMatch){const task=db.getTask(userId,taskMatch[1]);if(!task)throw Object.assign(new Error('Task not found.'),{status:404});const action=taskMatch[2];const status=action==='approve'?(task.schedule_at?'scheduled':'queued'):'cancelled';db.setTaskStatus(userId,task.id,status);db.addEvent(userId,`task_${action}d`,`${action==='approve'?'Approved':'Cancelled'} “${task.title}”.`);if(action==='approve')setImmediate(runDueTasks);return json(res,200,{...task,status});}
        const artifactMatch=url.pathname.match(/^\/api\/artifacts\/([0-9a-f-]+)$/);if(req.method==='GET'&&artifactMatch){const artifact=db.getArtifact(userId,artifactMatch[1]);if(!artifact)throw Object.assign(new Error('Artifact not found.'),{status:404});res.writeHead(200,{'Content-Type':artifact.mime_type,'Content-Disposition':`attachment; filename="${artifact.name.replace(/["\r\n]/g,'')}"`,'Cache-Control':'no-store'});return res.end(artifact.content);}
        if(req.method==='GET'&&url.pathname==='/api/push/public-key')return json(res,200,{configured:push.configured,publicKey:push.publicKey});
        if(req.method==='POST'&&url.pathname==='/api/push/subscribe'){if(!push.configured)throw Object.assign(new Error('Push is not configured.'),{status:503});const body=await readJson(req);if(!body.endpoint||!body.keys?.p256dh||!body.keys?.auth)throw Object.assign(new Error('Push subscription is incomplete.'),{status:400});db.savePush(userId,body);db.addEvent(userId,'push_enabled','Enabled push notifications on a device.');return json(res,201,{ok:true});}
        if(req.method==='POST'&&url.pathname==='/api/push/unsubscribe'){const body=await readJson(req);db.deletePush(userId,String(body.endpoint||''));return json(res,200,{ok:true});}
        const connectBegin=url.pathname.match(/^\/api\/connectors\/(github|google|slack)\/begin$/);if(req.method==='POST'&&connectBegin){if(paused())throw Object.assign(new Error('Orbit is paused.'),{status:423});return json(res,200,{url:connectors.begin(userId,connectBegin[1],originFor(req))});}
        const connectorMatch=url.pathname.match(/^\/api\/connectors\/(github|google|slack)$/);if(req.method==='DELETE'&&connectorMatch){db.deleteConnector(userId,connectorMatch[1]);db.addEvent(userId,'connector_disconnected',`Disconnected ${connectors.providers[connectorMatch[1]].label}.`);return json(res,200,{ok:true});}
        const connectorPreview=url.pathname.match(/^\/api\/connectors\/(github|google|slack)\/preview$/);if(req.method==='GET'&&connectorPreview){if(paused())throw Object.assign(new Error('Orbit is paused.'),{status:423});return json(res,200,{items:await connectors.preview(userId,connectorPreview[1])});}
        if(req.method==='POST'&&url.pathname==='/api/recovery-codes/rotate'){const body=await readJson(req);const account=db.getUserById(userId);if(!await verifyPassword(body.password,account.password_hash,account.password_salt))throw Object.assign(new Error('Password was not accepted.'),{status:401});const codes=makeRecoveryCodes();db.replaceRecoveryCodes(userId,codes.map(hashToken));db.addEvent(userId,'recovery_codes_rotated','Rotated account recovery codes.');return json(res,200,{recoveryCodes:codes});}
        if(req.method==='POST'&&url.pathname==='/api/backups/export'){const body=await readJson(req);const payload=await encryptPortable(db.exportUser(userId),body.passphrase);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="orbit-backup.orbitbackup"','Cache-Control':'no-store'});return res.end(payload);}
        if(req.method==='POST'&&url.pathname==='/api/backups/restore'){requireOwner(user);const body=await readJson(req,12*1024*1024);if(body.confirm!=='RESTORE')throw Object.assign(new Error('Type RESTORE to confirm.'),{status:400});const bundle=await decryptPortable(body.payload,body.passphrase);setPaused(true);db.restoreUser(userId,bundle);db.addEvent(userId,'backup_restored','Merged an encrypted backup. Orbit remains paused for review.');return json(res,200,{ok:true,paused:true});}
        if(req.method==='POST'&&url.pathname==='/api/automation-tokens'){const body=await readJson(req);const token=`orbit_${randomToken(32)}`;const saved=db.addAutomationToken(userId,{label:cleanText(body.label,80,'label'),tokenHash:hashToken(token),scopes:'tasks:create'});db.addEvent(userId,'automation_token_created',`Created automation token “${saved.label}”.`);return json(res,201,{...saved,token});}
        const autoMatch=url.pathname.match(/^\/api\/automation-tokens\/([0-9a-f-]+)$/);if(req.method==='DELETE'&&autoMatch){db.revokeAutomationToken(userId,autoMatch[1]);return json(res,200,{ok:true});}
        if(req.method==='POST'&&url.pathname==='/api/automation/tasks'){if(!user.automation||!user.scopes.split(/\s+/).includes('tasks:create'))throw Object.assign(new Error('Automation token lacks tasks:create.'),{status:403});if(paused())throw Object.assign(new Error('Orbit is paused.'),{status:423});const body=await readJson(req);const task=db.addTask(userId,{title:cleanText(body.title,120,'title'),prompt:cleanText(body.prompt,6000,'prompt'),risk:'internal',scheduleAt:body.scheduleAt?new Date(body.scheduleAt).toISOString():null,recurrence:'none'});db.addEvent(userId,'automation_task_created',`Automation created “${task.title}”.`);setImmediate(runDueTasks);return json(res,201,task);}
        if(req.method==='POST'&&url.pathname==='/api/admin/pause'){requireOwner(user);setPaused(true);for(const account of db.listUsers()){db.addEvent(account.id,'emergency_pause','Emergency pause enabled.');await push.notify(account.id,`${buddyName} paused`,'Background work and connectors are paused.',{view:'activity'});}return json(res,200,{paused:true});}
        if(req.method==='POST'&&url.pathname==='/api/admin/resume'){requireOwner(user);const body=await readJson(req);if(body.confirm!=='RESUME')throw Object.assign(new Error('Type RESUME to continue.'),{status:400});setPaused(false);db.addEvent(userId,'emergency_resume','Emergency pause cleared.');setImmediate(runDueTasks);return json(res,200,{paused:false});}
        return json(res,404,{error:'API route not found.'});
      }
    } catch(error) { return json(res,error.status||500,{error:error.status?error.message:'Request failed safely.'}); }

    if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'Method not allowed.'});const requestPath=url.pathname==='/'?'/index.html':url.pathname;let resolved;try{resolved=path.resolve(publicRoot,`.${decodeURIComponent(requestPath)}`);}catch{return json(res,404,{error:'Not found.'});}if(!resolved.startsWith(`${publicRoot}${path.sep}`))return json(res,404,{error:'Not found.'});
    try{const stat=fs.statSync(resolved);if(!stat.isFile())throw new Error();res.writeHead(200,{'Content-Type':mime[path.extname(resolved)]||'application/octet-stream','Cache-Control':path.basename(resolved)==='index.html'?'no-cache':'public, max-age=3600'});if(req.method==='HEAD')return res.end();fs.createReadStream(resolved).pipe(res);}catch{return json(res,404,{error:'Not found.'});}
  });

  const workerMs=Math.max(Number(env.TASK_POLL_MS)||15_000,5_000);let workerTimer;let backupTimer;
  return {server,db,runDueTasks,runProactiveChecks,
    startWorker(){workerTimer=setInterval(()=>{runDueTasks();runProactiveChecks();},workerMs);workerTimer.unref();backupTimer=setInterval(runBackups,60*60_000);backupTimer.unref();setImmediate(runDueTasks);setImmediate(runProactiveChecks);setImmediate(runBackups);},
    async close(){if(workerTimer)clearInterval(workerTimer);if(backupTimer)clearInterval(backupTimer);if(server.listening)await new Promise((resolve)=>server.close(resolve));db.close();}
  };
}

if(process.argv[1]===fileURLToPath(import.meta.url)){const app=createOrbitServer();const port=Number(process.env.PORT)||3000;const host=process.env.HOST||'127.0.0.1';app.server.listen(port,host,()=>{app.startWorker();console.log(`Orbit Buddy is ready at http://${host}:${port}`);});}
