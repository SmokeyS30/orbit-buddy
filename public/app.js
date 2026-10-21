import { renderAppleAuthControls } from './signup-ui.js';
import { NATIVE_API_BASE } from './native-config.js';
// Orbit Buddy frontend v2.1 - optimistic chat send
import { isNearBottom, scrollToBottom, settleAtBottom, shouldSettleAtBottom } from './chat-scroll.js';
import { renderAssistantMarkdown } from './chat-markdown.js';
// W7 code-split: voice-mode.js (~13.7KB) and canvas.js (~2.9KB) used to be
// static imports, so they were fetched on every page view. They now load on
// first use through the memoized dynamic imports below — one fetch no matter
// how many callers race for the module (e.g. double-tap on the voice button),
// and a failed load (offline) resets the memo so the next attempt retries.
// The specifiers stay relative module URLs, so they keep resolving under the
// Capacitor native webview (no import.meta tricks).
let voiceModeModulePromise=null;
function loadVoiceMode(){
  if(!voiceModeModulePromise)voiceModeModulePromise=import('./voice-mode.js').catch((err)=>{voiceModeModulePromise=null;throw err;});
  return voiceModeModulePromise;
}
let canvasModulePromise=null;
function loadCanvas(){
  if(!canvasModulePromise)canvasModulePromise=import('./canvas.js').catch((err)=>{canvasModulePromise=null;throw err;});
  return canvasModulePromise;
}
import { briefingLayoutFor } from './briefing-layout.js';
import { parseConversationDeepLink } from './deep-link.js';
import { geoAttemptPlan, markGeoAsked, clearGeoAsked } from './geo-prompt.js';
import { isNativeRuntime, shouldUseWebSpeech } from './native-runtime.js';
// L2 goals/projects v2: SVG progress arcs + kanban/timeline view builders.
import { buildGoalArc, buildKanbanRegion, buildTimelineRegion } from './goals-projects.js';
const state={csrf:null,user:null,status:null,snapshot:null,setup:null,signupVerificationToken:null};
try{
  const signupMatch=location.hash.match(/^#signup-verify=([A-Za-z0-9_-]{20,})$/);
  if(signupMatch){
    state.signupVerificationToken=decodeURIComponent(signupMatch[1]);
    history.replaceState(null,'',location.pathname+location.search);
  }
}catch(_){}
let activeConversationId=null;try{activeConversationId=localStorage.getItem('orbit-convo');}catch(_){}
// W4: notification tap deep-link — ?conversation=<id> opens that thread.
// The snapshot API already treats ?conversation= as the active conversation and
// falls back to the default one for unknown ids (graceful Today fallback), so
// seeding activeConversationId before the first refresh is enough. The param is
// stripped afterwards so later refreshes and thread switches aren't forced back.
try{
  const deepLinkId=parseConversationDeepLink(location.search);
  if(deepLinkId){
    activeConversationId=deepLinkId;
    const params=new URLSearchParams(location.search);
    params.delete('conversation');
    const rest=params.toString();
    history.replaceState(null,'',location.pathname+(rest?'?'+rest:'')+location.hash);
  }
}catch(_){}
let preferencesDirty=false;
const $=(selector)=>document.querySelector(selector);const $$=(selector)=>[...document.querySelectorAll(selector)];
// Native app (Capacitor iOS) detection. The native webview runs on
// capacitor://localhost, so relative /api/* URLs would resolve there instead of
// the server — every API call is prefixed with API_BASE (absolute on native,
// empty string on web, keeping web behavior byte-identical). Cookies on the
// cross-origin native fetch must be sent explicitly ('include').
const IS_NATIVE=isNativeRuntime(window);
const API_BASE=IS_NATIVE?NATIVE_API_BASE:'';
const NATIVE_CREDENTIALS=IS_NATIVE?'include':'same-origin';
// The server can't rely on the Origin header from the WKWebView, so every
// native API request carries X-Orbit-Native: 1 — the server uses it to set
// SameSite=None on the session cookie (without it, login succeeds but the
// session evaporates on the next request).
const NATIVE_API_HEADERS=IS_NATIVE?{'X-Orbit-Native':'1'}:{};
// Bearer token auth for native: WKWebView's Intelligent Tracking Prevention blocks
// cross-site cookies entirely, so the session token is stored locally and sent as
// an Authorization header instead of relying on the cookie.
const NATIVE_TOKEN_KEY=NATIVE_API_BASE==='https://orbitbuddy.app'?'orbit_native_token':'orbit_native_token:'+NATIVE_API_BASE;
function nativeToken(){try{return IS_NATIVE?localStorage.getItem(NATIVE_TOKEN_KEY):null;}catch(_){return null;}}
function setNativeToken(t){try{if(t)localStorage.setItem(NATIVE_TOKEN_KEY,t);else localStorage.removeItem(NATIVE_TOKEN_KEY);}catch(_){}}
function nativeAuthHeaders(){const t=nativeToken();return t?{Authorization:'Bearer '+t}:{};}
function nativeFetch(url,options={}){return fetch(url,{...options,headers:{...NATIVE_API_HEADERS,...nativeAuthHeaders(),...(options.headers||{})}});}
async function api(url,options={}){const isForm=options.body instanceof FormData;const headers={...NATIVE_API_HEADERS,...nativeAuthHeaders(),...(!isForm&&options.body?{'Content-Type':'application/json'}:{}),...(state.csrf?{'X-Orbit-CSRF':state.csrf}:{}),...(options.headers||{})};const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),30000);try{const response=await fetch((String(url).startsWith('/')?API_BASE:'')+url,{credentials:NATIVE_CREDENTIALS,...options,headers,signal:ctrl.signal});const type=response.headers.get('content-type')||'';const body=type.includes('json')?await response.json().catch(()=>({})):null;if(response.status===401)throw Object.assign(new Error(body?.error||'Authentication required.'),{auth:true,status:response.status,body});if(!response.ok)throw Object.assign(new Error(body?.error||`Request failed (${response.status}).`),{status:response.status,body});return body??response;}catch(e){if(e.name==='AbortError')throw new Error('Request timed out. Check your connection and try again.');throw e;}finally{clearTimeout(timer);}}
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('show'),2800);}
function formatDate(value){if(!value)return'Ready now';return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));}
function empty(root,text,tryText){const p=document.createElement('p');p.className='empty';p.textContent=text;root.append(p);if(tryText){const chip=button('Try: '+tryText,'ghost empty-suggest',()=>suggestPrompt(tryText));root.append(chip);}}
// L3: an example prompt chip in an empty state — taps take the user to chat with the prompt prefilled.
function suggestPrompt(text){activateView('today');const input=$('#chat-input');if(input){input.value=text;input.focus();}}
function button(label,className,handler){const value=document.createElement('button');value.type='button';value.className=className;value.textContent=label;value.addEventListener('click',handler);return value;}
function showCodes(codes){$('#codes-output').textContent=codes.join('\n');$('#codes-dialog').showModal();}

let typingActive=false;
function appendTypingBubble(){const root=$('#messages');if(!root||root.querySelector('.typing-bubble'))return;const el=document.createElement('div');el.className='message assistant typing-bubble';el.setAttribute('role','status');const label=document.createElement('span');label.className='typing-label';label.textContent=`${state.status?.buddyName||'Orbit'} is typing`;const dots=document.createElement('span');dots.className='typing-dots';dots.setAttribute('aria-hidden','true');for(let i=0;i<3;i++)dots.append(document.createElement('span'));const stream=document.createElement('span');stream.className='stream-text';el.append(label,dots,stream);root.append(el);}
function setStreamText(text){const el=document.querySelector('#messages .typing-bubble');if(!el)return;const root=$('#messages');const keepAtBottom=isNearBottom(root);const stream=el.querySelector('.stream-text');const label=el.querySelector('.typing-label');const dots=el.querySelector('.typing-dots');if(text){stream.textContent=text;label.style.display='none';dots.style.display='none';if(keepAtBottom)scrollToBottom(root);}else{stream.textContent='';label.style.display='';dots.style.display='';}}
let streamTimer=null,streamTurn=-1,streamSource=null,streamBuffer='';
function syncStreamPoller(){const set=pendingReplies.get(activeConversationId);const want=!!set&&set.size>0;if(want&&!streamTimer&&!streamSource)startChatStream();else if(!want&&(streamTimer||streamSource))stopChatStream();}
function stopChatStream(){if(streamSource){streamSource.close();streamSource=null;}if(streamTimer){clearInterval(streamTimer);streamTimer=null;}}
// True SSE streaming: one long-lived EventSource per reply; deltas append to
// the typing bubble as they arrive instead of 1s polling. Native apps can't
// set the Authorization header on an EventSource, so they (and any SSE
// failure) fall back to the 1s polling path below.
function startChatStream(){
  if(streamSource||streamTimer||!activeConversationId)return;
  if(IS_NATIVE&&nativeToken()){startStreamPollFallback();return;}
  streamTurn=-1;streamBuffer='';
  let source;
  try{source=new EventSource((API_BASE||'')+'/api/chat/stream?conversationId='+encodeURIComponent(activeConversationId),{withCredentials:true});}
  catch(_){startStreamPollFallback();return;}
  const parse=(event)=>{try{return JSON.parse(event.data);}catch(_){return null;}};
  source.addEventListener('sync',(event)=>{const data=parse(event);if(!data)return;if((data.turn??-1)!==streamTurn){streamTurn=data.turn??-1;streamBuffer='';}streamBuffer=String(data.text||'');setStreamText(streamBuffer);});
  source.addEventListener('delta',(event)=>{const data=parse(event);if(!data)return;if((data.turn??-1)!==streamTurn){streamTurn=data.turn??-1;streamBuffer='';}streamBuffer+=String(data.delta||'');setStreamText(streamBuffer);});
  source.addEventListener('done',()=>{stopChatStream();setStreamText('');refresh().catch(()=>{});});
  source.onerror=()=>{if(streamSource){stopChatStream();startStreamPollFallback();}};
  streamSource=source;
}
function startStreamPollFallback(){if(streamTimer||streamSource||!activeConversationId)return;streamTurn=-1;streamTimer=setInterval(pollStream,1000);pollStream();}
// 1s polling fallback (also used by native apps): kept intact so any SSE
// failure degrades gracefully instead of stalling the typing bubble.
async function pollStream(){if(!activeConversationId)return;let data;try{data=await api('/api/chat/stream-state?conversationId='+encodeURIComponent(activeConversationId));}catch(_){return;}if(!data)return;if(data.state==='streaming'){if(data.turn!==streamTurn){streamTurn=data.turn;setStreamText('');}setStreamText(data.text||'');}else if(data.state==='done'){stopChatStream();setStreamText('');refresh().catch(()=>{});}else{setStreamText('');}}
function showTyping(shouldScrollToBottom){typingActive=true;appendTypingBubble();if(shouldScrollToBottom)settleAtBottom($('#messages'));}
function hideTyping(){typingActive=false;const el=document.querySelector('#messages .typing-bubble');if(el)el.remove();}
const pendingReplies=new Map();
const PENDING_TTL=5*60*1000;
function pendingFor(convoId){let set=pendingReplies.get(convoId);if(!set){set=new Map();pendingReplies.set(convoId,set);}return set;}
function settlePendingReplies(messages,convoId){const set=pendingReplies.get(convoId);if(!set||!set.size)return;const now=Date.now();const ids=messages.map((m)=>m.id);for(const [msgId,sentAt] of[...set]){if(now-sentAt>PENDING_TTL){set.delete(msgId);continue;}const idx=ids.indexOf(msgId);if(idx!==-1&&messages.slice(idx+1).some((m)=>m.role==='assistant'))set.delete(msgId);}if(!set.size)pendingReplies.delete(convoId);}
function syncTypingBubble(){const set=pendingReplies.get(activeConversationId);const want=!!set&&set.size>0;if(want&&!typingActive)showTyping(false);else if(!want&&typingActive)hideTyping();}
let lastMessageFingerprint='';
let renderedConversationId=null;
async function renderMessages(items){const root=document.getElementById('messages');const conversationId=state.snapshot?.activeConversation?.id||activeConversationId||'';const fingerprint=conversationId+'|'+(items||[]).map((m)=>m.id+':'+(m.content||'').length).join('|');const conversationChanged=conversationId!==renderedConversationId;if(fingerprint===lastMessageFingerprint&&!typingActive)return;lastMessageFingerprint=fingerprint;// W7: the canvas chunk is fetched on first use — detection runs per
// assistant message, so the render waits for the (memoized) module here and
// never drops or mis-detects. Offline-first-use falls back to plain bubbles.
const canvasApi=await loadCanvas().catch(()=>null);const wasNearBottom=isNearBottom(root);root.replaceChildren();if(!items.length)empty(root,'This is where you talk with Orbit — ask anything, any time.','Say hello and tell me a little about yourself');for(const item of items){const el=document.createElement('div');el.className='message '+item.role;if(item.id){el.id='msg-'+item.id;el.dataset.messageId=item.id;el.dataset.role=item.role;}if(item.role==='assistant'){if(canvasApi&&canvasApi.isCanvasWorthy(item.content))renderCanvasDoc(el,item.id,item.content,canvasApi);else if(!renderAssistantMarkdown(el,item.content))el.textContent=item.content;}else{el.textContent=item.content;}if(el.dataset.messageId)buildMessageActionRow(el);root.append(el);}if(typingActive)appendTypingBubble();renderedConversationId=conversationId;if(shouldSettleAtBottom({conversationChanged,hasMessages:items.length>0,wasNearBottom}))settleAtBottom(root);}

// --- W1: per-message actions (regenerate / copy / delete) ---
// Assistant messages: long-press (touch) or hover (desktop) reveals a small
// action row — Regenerate (re-run the turn), Copy (markdown source), Delete
// (remove the turn). User messages get Copy + Delete. The row stays hidden
// until revealed (Orbit minimalism — no persistent chrome), and deleting a
// turn gets an inline confirm, not a blocking dialog.
function messageById(id){return (state.snapshot&&state.snapshot.messages||[]).find((m)=>m.id===id)||null;}
function hideMessageActionRows(){for(const m of $$('.message.show-actions')){m.classList.remove('show-actions');const row=m.querySelector(':scope > .msg-actions');if(row)row.remove();}}
function msgActionButton(label,kind,handler){const b=document.createElement('button');b.type='button';b.className='msg-action msg-'+kind;b.textContent=label;b.setAttribute('aria-label',label);b.addEventListener('click',(event)=>{event.stopPropagation();handler();});return b;}
async function copyMessageSource(id){
  const msg=messageById(id);
  if(!msg){toast('Could not find that message.');return;}
  try{await navigator.clipboard.writeText(String(msg.content||''));toast('Copied.');}
  catch(_){toast('Copy failed — select the text manually.');}
}
async function deleteMessageTurn(id){
  try{await api(`/api/chat/messages/${encodeURIComponent(id)}`,{method:'DELETE'});await refresh();toast('Turn deleted.');}
  catch(error){toast(error.message);}
}
async function regenerateMessage(id,row){
  row.classList.add('busy');
  try{
    const sent=await api(`/api/chat/messages/${encodeURIComponent(id)}/regenerate`,{method:'POST'});
    // Same client machinery as a fresh send: the typing bubble appears and
    // the stream poller picks up the new turn via stream-state.
    const conversationId=sent.conversationId||activeConversationId;
    pendingFor(conversationId).set(sent.id,Date.now());
    await refresh();
  }catch(error){toast(error.message);}
  finally{row.classList.remove('busy');}
}
function fillMessageActionRow(row,el){
  const id=el.dataset.messageId,role=el.dataset.role;
  row.replaceChildren();
  if(role==='assistant')row.append(msgActionButton('↻ Regenerate','regen',()=>regenerateMessage(id,row)));
  row.append(msgActionButton('⧉ Copy','copy',()=>copyMessageSource(id)));
  row.append(msgActionButton('Delete','delete',()=>{
    row.replaceChildren();
    const label=document.createElement('span');label.className='msg-confirm-label';label.textContent='Delete this turn?';
    row.append(label,
      msgActionButton('Delete','delete',()=>{hideMessageActionRows();deleteMessageTurn(id);}),
      msgActionButton('Keep','keep',()=>fillMessageActionRow(row,el)));
  }));
}
function buildMessageActionRow(el){
  const row=document.createElement('div');row.className='msg-actions';row.setAttribute('role','toolbar');row.setAttribute('aria-label','Message actions');
  fillMessageActionRow(row,el);
  el.append(row);
}
function showMessageActionRow(el){
  hideMessageActionRows();
  el.classList.add('show-actions');
  if(!el.querySelector(':scope > .msg-actions'))buildMessageActionRow(el);
}
(function initMessageActions(){
  const root=$('#messages');
  if(!root)return;
  const actionable=(event)=>{const el=event.target.closest('.message');return el&&el.dataset.messageId&&!el.classList.contains('typing-bubble')?el:null;};
  // Touch: long-press reveals the row. Desktop: CSS :hover reveals it (see
  // styles.css) — no JS needed there.
  let timer=null,pressEl=null,startX=0,startY=0;
  const LONG_PRESS_MS=600;
  const cancel=()=>{clearTimeout(timer);timer=null;pressEl=null;};
  root.addEventListener('pointerdown',(event)=>{
    if(event.pointerType!=='touch')return;
    const el=actionable(event);
    if(!el)return;
    pressEl=el;startX=event.clientX;startY=event.clientY;
    clearTimeout(timer);
    timer=setTimeout(()=>{timer=null;showMessageActionRow(pressEl);},LONG_PRESS_MS);
  });
  root.addEventListener('pointermove',(event)=>{
    if(!timer)return;
    if(Math.hypot(event.clientX-startX,event.clientY-startY)>12)cancel();
  });
  root.addEventListener('pointerup',cancel);
  root.addEventListener('pointercancel',cancel);
  // Long-press on mobile fires a native context menu — suppress it on message
  // bubbles so the action row owns the gesture.
  root.addEventListener('contextmenu',(event)=>{if(actionable(event))event.preventDefault();});
  // Tapping anywhere outside an open row dismisses it.
  document.addEventListener('pointerdown',(event)=>{if(!event.target.closest('.msg-actions'))hideMessageActionRows();},true);
})();

function renderTasks(items){const root=$('#tasks-list');root.replaceChildren();$('#task-count').textContent=String(items.filter((task)=>!['completed','cancelled','failed'].includes(task.status)).length);if(!items.length)return empty(root,'Tasks are bigger jobs Orbit works on in the background for you, like research or planning.','Find me the best weekend hiking trails nearby');for(const task of items){const card=document.createElement('article');card.className='item-card';const head=document.createElement('header');const wrap=document.createElement('div');const h=document.createElement('h3');h.textContent=task.title;const prompt=document.createElement('p');prompt.textContent=task.prompt;wrap.append(h,prompt);const status=document.createElement('span');status.className=`badge ${task.status}`;status.textContent=task.status.replaceAll('_',' ');head.append(wrap,status);card.append(head);const meta=document.createElement('div');meta.className='meta';for(const value of [task.risk==='external'?'approval gated':'think only',task.recurrence,formatDate(task.schedule_at)]){const tag=document.createElement('span');tag.className='badge';tag.textContent=value;meta.append(tag);}card.append(meta);if(task.result){const result=document.createElement('p');result.className='result';result.textContent=task.result;card.append(result);}if(task.status==='waiting_approval'){const actions=document.createElement('div');actions.className='mini-actions';actions.append(button('Approve plan','primary',()=>taskAction(task.id,'approve')),button('Cancel','danger',()=>taskAction(task.id,'cancel')));card.append(actions);}else if(!['completed','failed','cancelled'].includes(task.status)){const actions=document.createElement('div');actions.className='mini-actions';actions.append(button('Cancel','danger',()=>taskAction(task.id,'cancel')),button('Delete','danger',()=>taskDelete(task.id)));card.append(actions);}else{const actions=document.createElement('div');actions.className='mini-actions';actions.append(button('Delete','danger',()=>taskDelete(task.id)));card.append(actions);}root.append(card);}}
// --- B1: Today tab morning briefing ---
// Magazine-style generated morning page: weather, calendar, focus goals,
// memory anniversaries, open approvals, and a quiet systems line (B4).
// Data comes from GET /api/today-briefing; cached client-side for 10 minutes
// so the 15s refresh loop doesn't refetch it.
const briefingState={data:null,at:0,coordsKey:''};
// Location-aware weather: browser Geolocation request so briefing weather
// follows the user (works on web and in the iOS webview). Coords are sent
// with the briefing request only — never stored server-side. The prompt gate
// (./geo-prompt.js) asks ONCE per device and remembers while signed in:
// granted -> call freely (no dialog), denied -> never call (home weather),
// prompt -> call only if this device was never asked. Sign-out clears it.
function safeStorage(){try{return localStorage;}catch(_){return null;}}
let geoCoordsPromise=null;
function requestBriefingCoords(){
  if(geoCoordsPromise)return geoCoordsPromise;
  geoCoordsPromise=(async()=>{
    if(typeof navigator==='undefined'||!navigator.geolocation)return null;
    let plan;
    try{plan=await geoAttemptPlan(safeStorage(),navigator);}
    catch(_){plan={attempt:false,countsAsAsk:false};}
    if(!plan.attempt)return null;
    if(plan.countsAsAsk)markGeoAsked(safeStorage());
    return new Promise((resolve)=>{
      const done=(v)=>resolve(v);
      const timer=setTimeout(()=>done(null),10000);
      try{
        navigator.geolocation.getCurrentPosition(
          (pos)=>{clearTimeout(timer);const c=pos&&pos.coords;
            done(c&&Number.isFinite(c.latitude)&&Number.isFinite(c.longitude)&&Math.abs(c.latitude)<=90&&Math.abs(c.longitude)<=180
              ?{lat:c.latitude,lon:c.longitude}:null);},
          ()=>{clearTimeout(timer);done(null);},
          {enableHighAccuracy:false,timeout:9000,maximumAge:600000});
      }catch(_){clearTimeout(timer);done(null);}
    });
  })();
  return geoCoordsPromise;
}
function fetchBriefingData(coords){
  const qs=coords?('?lat='+encodeURIComponent(String(coords.lat))+'&lon='+encodeURIComponent(String(coords.lon))):'';
  return api('/api/today-briefing'+qs);
}
async function loadBriefing(){
  if(briefingState.data&&Date.now()-briefingState.at<10*60_000){renderBriefing(briefingState.data);return;}
  try{
    // Fetch now (fast, home weather) while the one-time geolocation request
    // runs in parallel; if coords arrive, refetch once so weather is local.
    const data=await fetchBriefingData(null);
    briefingState.data=data;briefingState.at=Date.now();briefingState.coordsKey='';
    renderBriefing(data);
    requestBriefingCoords().then(async(coords)=>{
      if(!coords)return;
      const key=coords.lat.toFixed(3)+','+coords.lon.toFixed(3);
      if(briefingState.coordsKey===key)return;
      try{
        const d2=await fetchBriefingData(coords);
        briefingState.data=d2;briefingState.at=Date.now();briefingState.coordsKey=key;
        renderBriefing(d2);
      }catch(_){/* keep the home-weather render; silent */}
    });
  }catch(error){renderBriefingError();}
}
function renderBriefingError(){
  const root=$('#today-briefing');if(!root)return;root.replaceChildren();
  const p=document.createElement('p');p.className='muted';
  p.textContent='Could not load your briefing just now — it will retry on its own.';
  root.append(p);
}
function briefingCard(title){
  const card=document.createElement('article');card.className='briefing-card';
  const h=document.createElement('h3');h.textContent=title;card.append(h);
  return card;
}
function agendaRow(e){
  const row=document.createElement('div');row.className='agenda-row';
  const t=document.createElement('span');t.className='agenda-time';t.textContent=e.allDay?'All day':e.endLabel?`${e.timeLabel} – ${e.endLabel}`:e.timeLabel;
  const title=document.createElement('span');title.className='agenda-title';title.textContent=e.title;
  row.append(t,title);
  if(e.location){const loc=document.createElement('small');loc.className='muted';loc.textContent=e.location;row.append(loc);}
  return row;
}
function agendaSubhead(text){
  const p=document.createElement('p');p.className='muted small block-top';p.textContent=text;return p;
}
function buildWeatherCard(data){
  if(!data.weather)return null;
  const card=briefingCard('Weather');
  const now=document.createElement('div');now.className='weather-now';
  const temp=document.createElement('strong');temp.textContent=`${data.weather.current.tempF}°`;
  const cond=document.createElement('div');
  const c1=document.createElement('p');c1.textContent=data.weather.current.condition;
  const c2=document.createElement('p');c2.className='muted small';
  c2.textContent=`${data.weather.location||''} · wind ${data.weather.current.windMph} mph`.replace(/^ · /,'');
  cond.append(c1,c2);now.append(temp,cond);card.append(now);
  if((data.weather.forecast||[]).length){
    const strip=document.createElement('div');strip.className='forecast-strip';
    for(const f of data.weather.forecast){
      const d=document.createElement('div');d.className='forecast-day';
      const dn=document.createElement('span');dn.className='forecast-name';dn.textContent=f.day;
      const dc=document.createElement('span');dc.className='muted small';dc.textContent=f.condition;
      const dt=document.createElement('span');dt.className='forecast-temps';dt.textContent=`${f.highF}° / ${f.lowF}°`;
      d.append(dn,dc,dt);strip.append(d);
    }
    card.append(strip);
  }
  return card;
}
function buildAgendaCard(data,section){
  const card=briefingCard(section.title||'Today');
  const events=data.agenda||[];
  if(section.splitDay){
    // Afternoon check-in: what's behind you vs still ahead.
    const nowMs=Date.parse(data.generatedAt)||Date.now();
    const past=events.filter((e)=>e.startMs&&e.startMs<nowMs);
    const upcoming=events.filter((e)=>!e.startMs||e.startMs>=nowMs);
    if(!past.length&&!upcoming.length){
      const p=document.createElement('p');p.className='muted';p.textContent=section.emptyText||'Nothing on the calendar today.';
      card.append(p);
    }else{
      if(upcoming.length){card.append(agendaSubhead('Still ahead'));for(const e of upcoming)card.append(agendaRow(e));}
      if(past.length){card.append(agendaSubhead('Behind you'));for(const e of past)card.append(agendaRow(e));}
    }
  }else{
    if(!events.length){
      const p=document.createElement('p');p.className='muted';p.textContent=section.emptyText||'Nothing scheduled — the day is yours.';
      card.append(p);
    }
    for(const e of events)card.append(agendaRow(e));
  }
  if(section.tomorrowLine&&data.tomorrowCount){
    const p=document.createElement('p');p.className='muted small block-top';
    p.textContent=`Plus ${data.tomorrowCount} tomorrow.`;
    card.append(p);
  }
  return card;
}
function buildFocusCard(data,title){
  if(!(data.focusGoals||[]).length)return null;
  const card=briefingCard(title||'Focus');
  for(const g of data.focusGoals){
    const wrap=document.createElement('div');wrap.className='focus-goal';
    const t=document.createElement('strong');t.textContent=g.title;wrap.append(t);
    const bar=document.createElement('progress');bar.className='goal-progress';bar.max=100;bar.value=g.progress;
    bar.setAttribute('aria-label',`${g.title} progress`);wrap.append(bar);
    const detail=document.createElement('p');detail.className='muted small';
    const bits=[`${g.progress}%`];
    if(g.nextStep)bits.push(`next: ${g.nextStep}`);
    else if(g.targetDate)bits.push(`target ${g.targetDate}`);
    if(g.streak>=2)bits.push(`🔥 ${g.streak}-day streak`);
    detail.textContent=bits.join(' · ');wrap.append(detail);
    card.append(wrap);
  }
  return card;
}
function buildLoopsCard(data,title){
  if(!data.openLoopCount)return null;
  const card=briefingCard(title||'Open loops');
  const loops=data.openLoops||{};
  for(const a of loops.approvals||[]){
    const row=document.createElement('button');row.type='button';row.className='loop-row';
    const label=document.createElement('span');label.textContent=`Approval: ${a.title}`;
    const hint=document.createElement('small');hint.className='muted';hint.textContent='review →';
    row.append(label,hint);row.addEventListener('click',()=>activateView('approvals'));card.append(row);
  }
  for(const t of loops.waitingTasks||[]){
    const row=document.createElement('button');row.type='button';row.className='loop-row';
    const label=document.createElement('span');label.textContent=`Task plan: ${t.title}`;
    const hint=document.createElement('small');hint.className='muted';hint.textContent='review →';
    row.append(label,hint);row.addEventListener('click',()=>activateView('approvals'));card.append(row);
  }
  for(const f of loops.followUps||[]){
    const row=document.createElement('div');row.className='loop-row static';
    const label=document.createElement('span');label.textContent=`Follow-up: ${f.description}`;
    const hint=document.createElement('small');hint.className='muted';hint.textContent=f.overdue?`was due ${f.dueDate}`:`due ${f.dueDate}`;
    row.append(label,hint);card.append(row);
  }
  return card;
}
function buildAnniversariesCard(data,title){
  if(!(data.anniversaries||[]).length)return null;
  const card=briefingCard(title||'Coming up');
  for(const a of data.anniversaries){
    const row=document.createElement('div');row.className='agenda-row';
    const icon=document.createElement('span');icon.textContent=a.type==='birthday'?'🎂':a.type==='anniversary'?'💛':'📌';
    const label=document.createElement('span');label.className='agenda-title';
    label.textContent=a.years?`${a.label} — ${a.years} year${a.years===1?'':'s'}`:a.label;
    const when=document.createElement('small');when.className='muted';when.textContent=a.when;
    row.append(icon,label,when);card.append(row);
  }
  return card;
}
function buildTomorrowCard(data,title){
  if(!(data.tomorrowAgenda||[]).length)return null;
  const card=briefingCard(title||'Tomorrow');
  for(const e of data.tomorrowAgenda)card.append(agendaRow(e));
  return card;
}
// X6 project radar: recent repo findings as a quiet card. Null when empty so
// the briefing stays silent when there's nothing worth surfacing. Reuses the
// existing briefing-card / loop-row styles, so it renders the same on desktop
// and in the iOS webview — no new screens.
function buildRadarCard(data){
  const items=data.radar||[];
  if(!items.length)return null;
  const card=briefingCard('Project radar');
  for(const f of items){
    const row=document.createElement('div');row.className='loop-row static';
    const icon=document.createElement('span');icon.textContent=f.signal==='high'?'🔴':'🟢';icon.setAttribute('aria-hidden','true');
    const label=document.createElement('span');label.className='agenda-title';label.textContent=f.title||'Repo update';
    const hint=document.createElement('small');hint.className='muted';hint.textContent=String(f.repo||'').split('/').pop();
    row.append(icon,label,hint);card.append(row);
  }
  return card;
}
// --- "Catch me up" digest card ---
// Inline dismissible card on the Today tab after 6+ hours away (NOT a modal).
// Data: GET /api/catchup-digest?since=<previous app-open>. Dismissing (X)
// records the items server-side so they never reappear. One check per page
// load; the server marks returned items seen.
const catchupCardState={checked:false,loading:false};
function loadCatchupCard(){
  if(catchupCardState.checked||catchupCardState.loading||!state.user)return;
  const since=state.catchupSince;
  if(since===undefined||since===null)return; // snapshot not back yet, or never tracked
  const sinceMs=Date.parse(since);
  if(!Number.isFinite(sinceMs)||Date.now()-sinceMs<6*3600_000){catchupCardState.checked=true;return;}
  catchupCardState.loading=true;
  api('/api/catchup-digest?since='+encodeURIComponent(since)).then((data)=>{
    if(data&&data.away&&(data.items||[]).length)renderCatchupCard(data.items);
  }).catch(()=>{/* silent; the card is a nicety, not an error */})
  .finally(()=>{catchupCardState.loading=false;catchupCardState.checked=true;});
}
function catchupIconFor(kind){
  return {checkin:'💬',radar:'📡',ci:'🔴',calendar:'📅',agenda:'🗓️',task:'✅'}[kind]||'•';
}
function catchupRow(item){
  const row=document.createElement('button');row.type='button';row.className='loop-row catchup-row';
  const icon=document.createElement('span');icon.textContent=catchupIconFor(item.kind);icon.setAttribute('aria-hidden','true');
  const wrap=document.createElement('span');wrap.className='catchup-text';
  const title=document.createElement('span');title.className='agenda-title';title.textContent=item.title||'Update';
  wrap.append(title);
  if(item.detail){const meta=document.createElement('small');meta.className='muted';meta.textContent=item.detail;wrap.append(meta);}
  row.append(icon,wrap);
  row.addEventListener('click',()=>{
    if(item.url){window.open(item.url,'_blank','noopener');return;}
    const view=item.deepLink&&item.deepLink.view;
    if(view)activateView(view);
  });
  return row;
}
function renderCatchupCard(items){
  const root=$('#today-briefing');if(!root||!items.length)return;
  if(root.querySelector('#catchup-card'))return;
  const card=document.createElement('article');
  card.className='briefing-card catchup-card';card.id='catchup-card';
  const head=document.createElement('div');head.className='catchup-head';
  const h=document.createElement('h3');h.textContent='While you were away';head.append(h);
  const x=button('✕','catchup-dismiss',async()=>{
    x.disabled=true;
    try{await api('/api/catchup-digest/dismiss',{method:'POST',body:JSON.stringify({keys:items.map((i)=>i.key)})});}catch(_){}
    card.remove();
  });
  x.setAttribute('aria-label','Dismiss catch-up');
  head.append(x);card.append(head);
  const missed=items.filter((i)=>i.section!=='upcoming');
  const upcoming=items.filter((i)=>i.section==='upcoming');
  if(missed.length&&upcoming.length)card.append(agendaSubhead('Missed'));
  for(const item of missed)card.append(catchupRow(item));
  if(missed.length&&upcoming.length)card.append(agendaSubhead('Coming up'));
  for(const item of upcoming)card.append(catchupRow(item));
  root.prepend(card);
}
function buildSystemsLine(data){
  const sys=data.systems;
  const line=document.createElement('button');line.type='button';
  line.className='systems-line'+(sys&&!sys.ok?' warn':'');
  const dot=document.createElement('span');dot.className='systems-dot';dot.setAttribute('aria-hidden','true');
  const label=document.createElement('span');
  if(!sys)label.textContent='Systems status unavailable';
  else if(sys.ok)label.textContent=`All systems normal${sys.chatSuccessRate!==null&&sys.chatSuccessRate!==undefined?` · ${sys.chatSuccessRate}% chat success (7d)`:''}`;
  else label.textContent=`${sys.failureCount} failure${sys.failureCount===1?'':'s'} in the last 7 days — view Reliability`;
  line.append(dot,label);
  line.addEventListener('click',()=>activateView('reliability'));
  return line;
}
function briefingPhaseId(data){
  const id=data&&data.phase&&data.phase.id;
  return typeof id==='string'&&id?id:'morning';
}
function briefingDek(data,phaseId){
  const parts=[];
  const loopWord=(n)=>`open loop${n===1?'':'s'}`;
  if(phaseId==='afternoon'){
    const nowMs=Date.parse(data.generatedAt)||Date.now();
    const upcoming=(data.agenda||[]).filter((e)=>!e.startMs||e.startMs>=nowMs).length;
    if(upcoming)parts.push(`${upcoming} still on the calendar`);
    if(data.openLoopCount)parts.push(`${data.openLoopCount} ${loopWord(data.openLoopCount)}`);
    if((data.focusGoals||[]).length)parts.push(`${data.focusGoals[0].title} at ${data.focusGoals[0].progress}%`);
    return parts.length?parts.join(' · '):'A quiet afternoon — the rest of the day is yours.';
  }
  if(phaseId==='evening'){
    if((data.agenda||[]).length)parts.push(`${data.agenda.length} on today's calendar`);
    if(data.openLoopCount)parts.push(`${data.openLoopCount} still open`);
    if(data.tomorrowCount)parts.push(`${data.tomorrowCount} tomorrow`);
    return parts.length?parts.join(' · '):'A quiet day — rest up for tomorrow.';
  }
  if((data.agenda||[]).length)parts.push(`${data.agenda.length} on the calendar`);
  if(data.openLoopCount)parts.push(`${data.openLoopCount} ${loopWord(data.openLoopCount)}`);
  const todayAnn=(data.anniversaries||[]).filter((a)=>a.daysUntil===0);
  for(const a of todayAnn)parts.push(`${a.label} today`);
  if(data.tomorrowCount)parts.push(`${data.tomorrowCount} tomorrow`);
  return parts.length?parts.join(' · '):'A clear day — make it count.';
}
function renderBriefing(data){
  const root=$('#today-briefing');if(!root||!data)return;root.replaceChildren();
  // Time-aware briefing: the phase was resolved server-side (boundaries live
  // in src/briefing.js#BRIEFING_PHASES) and rides in on the payload — the UI
  // only reads it, never computes it. Stale payloads fall back to morning.
  const phaseId=briefingPhaseId(data);
  const layout=briefingLayoutFor(phaseId);
  const mast=document.createElement('div');mast.className='briefing-masthead';
  const eyebrow=document.createElement('p');eyebrow.className='eyebrow';
  eyebrow.textContent=`${layout.tabLabel} · ${data.dateLabel||''}`;
  const h=document.createElement('h2');h.textContent=`${data.greeting||'Good morning'}.`;
  mast.append(eyebrow,h);
  const dek=document.createElement('p');dek.className='briefing-dek';
  dek.textContent=briefingDek(data,phaseId);
  mast.append(dek);root.append(mast);
  const grid=document.createElement('div');grid.className='briefing-grid';

  // Phase-ordered sections: order and titles come from the layout config; the
  // phase itself was resolved server-side and rides in on the payload.
  for(const section of layout.sections){
    let card=null;
    if(section.key==='weather')card=buildWeatherCard(data);
    else if(section.key==='agenda')card=buildAgendaCard(data,section);
    else if(section.key==='focus')card=buildFocusCard(data,section.title);
    else if(section.key==='loops')card=buildLoopsCard(data,section.title);
    else if(section.key==='anniversaries')card=buildAnniversariesCard(data,section.title);
    else if(section.key==='tomorrow')card=buildTomorrowCard(data,section.title);
    if(card)grid.append(card);
  }

  // X6 project radar card: quiet when empty, appended after the phase sections.
  const radarCard=buildRadarCard(data);
  if(radarCard)grid.append(radarCard);

  if(grid.children.length)root.append(grid);

  // B4: Reliability is quiet by default — one status line, full tab as drill-down.
  root.append(buildSystemsLine(data));
}
function renderGoals(items){const root=$('#goals-list');if(root.contains(document.activeElement))return;root.replaceChildren();if(!items.length)return empty(root,'Goals are things you’re working toward — Orbit keeps them in view and tracks your progress.','I want to read 12 books this year');for(const goal of items){const card=document.createElement('article');card.className='item-card';const head=document.createElement('header');const wrap=document.createElement('div');const title=document.createElement('h3');title.textContent=goal.title;const description=document.createElement('p');description.textContent=goal.description||goal.next_step||'No details added.';wrap.append(title,description);const status=document.createElement('span');status.className=`badge ${goal.status}`;status.textContent=goal.status;head.append(wrap,status);card.append(head);const meta=document.createElement('div');meta.className='meta';const goalStreak=state.snapshot?.streaks?.goals?.[goal.id]||0;for(const value of [`priority ${goal.priority}`,goal.target_date?`target ${goal.target_date}`:'no target date',`${goal.progress}% complete`]){const tag=document.createElement('span');tag.className='badge';tag.textContent=value;meta.append(tag);}if(goalStreak>=2){const stag=document.createElement('span');stag.className='badge streak';stag.textContent=`🔥 ${goalStreak}-day streak`;meta.append(stag);}card.append(meta);card.append(buildGoalArc(goal));if(goal.next_step){const next=document.createElement('p');next.textContent=`Next: ${goal.next_step}`;card.append(next);}if(goal.status!=='completed'){const editor=document.createElement('div');editor.className='goal-editor';const amount=document.createElement('input');amount.type='number';amount.min='0';amount.max='100';amount.value=String(goal.progress);amount.setAttribute('aria-label','Progress percent');const next=document.createElement('input');next.value=goal.next_step||'';next.maxLength=500;next.placeholder='Next step';const save=button('Update','ghost',()=>updateGoal(goal.id,{progress:Number(amount.value),nextStep:next.value}));editor.append(amount,next,save);card.append(editor);}const actions=document.createElement('div');actions.className='mini-actions';if(goal.status!=='completed')actions.append(button(goal.status==='paused'?'Resume':'Pause','ghost',()=>updateGoal(goal.id,{status:goal.status==='paused'?'active':'paused'})),button('Complete','primary',()=>updateGoal(goal.id,{progress:100,status:'completed'})));actions.append(button('Delete','danger',()=>deleteGoal(goal.id,goal.title)));card.append(actions);root.append(card);}}
function renderRoutines(items){const root=$('#routines-list');root.replaceChildren();if(!items.length)return empty(root,'Routines are things Orbit does for you on a schedule, like a morning briefing.','Give me a briefing every weekday at 8am');const weekdays=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];for(const routine of items){const card=document.createElement('article');card.className='item-card';const head=document.createElement('header');const wrap=document.createElement('div');const title=document.createElement('h3');title.textContent=routine.title;const prompt=document.createElement('p');prompt.textContent=routine.prompt;wrap.append(title,prompt);const status=document.createElement('span');status.className=`badge ${routine.enabled?'active':'paused'}`;status.textContent=routine.enabled?'active':'paused';head.append(wrap,status);card.append(head);const cadence=routine.cadence==='weekly'?`weekly · ${weekdays[routine.day_of_week]}`:routine.cadence;const meta=document.createElement('div');meta.className='meta';const routineStreak=state.snapshot?.streaks?.routines?.[routine.id]||0;for(const value of [routine.kind,cadence,`${routine.time_local} local`,routine.last_run_at?`last ran ${formatDate(routine.last_run_at)}`:'not run yet']){const tag=document.createElement('span');tag.className='badge';tag.textContent=value;meta.append(tag);}if(routineStreak>=2){const stag=document.createElement('span');stag.className='badge streak';stag.textContent=`🔥 ${routineStreak}-day streak`;meta.append(stag);}card.append(meta);if(routine.last_error){const error=document.createElement('p');error.className='routine-error';error.textContent=`Last run: ${routine.last_error}`;card.append(error);}const actions=document.createElement('div');actions.className='mini-actions';actions.append(button(routine.enabled?'Pause':'Enable','ghost',()=>toggleRoutine(routine.id,!routine.enabled)),button('Delete','danger',()=>deleteRoutine(routine.id,routine.title)));card.append(actions);root.append(card);}}
function renderMemories(items,suggestions){const root=$('#memory-list');root.replaceChildren();for(const s of suggestions||[]){const card=document.createElement('article');card.className='item-card suggested';const head=document.createElement('header');const wrap=document.createElement('div');const badge=document.createElement('p');badge.className='hint';badge.textContent=`Suggested ${s.kind||'fact'} — saves automatically shortly unless dismissed`;const text=document.createElement('p');text.textContent=s.content;wrap.append(badge,text);const actions=document.createElement('div');actions.className='mini-actions';actions.append(button('Approve','primary',()=>approveSuggestion(s.id)),button('Dismiss','ghost',()=>dismissSuggestion(s.id)));head.append(wrap,actions);card.append(head);root.append(card);}if(!items.length&&!(suggestions||[]).length)return empty(root,'This is what Orbit remembers about you — new memories save automatically, and you can ask “what do you know about me?” in chat anytime.','Remember that my mom’s birthday is May 3rd');for(const memory of items){const card=document.createElement('article');card.className='item-card';const head=document.createElement('header');const wrap=document.createElement('div');const kind=document.createElement('span');kind.className='badge kind-badge';kind.textContent=memory.kind||'fact';const text=document.createElement('p');text.textContent=memory.content;wrap.append(kind,text);head.append(wrap,button('Delete','danger',()=>deleteMemory(memory.id)));card.append(head);root.append(card);}}const MONTH_NAMES=['January','February','March','April','May','June','July','August','September','October','November','December'];
function nextOccurrence(month,day){const now=new Date();let year=now.getFullYear();let d=new Date(year,month-1,day);if(month===2&&day===29&&!isLeap(year))d=new Date(year,1,28);if(d<startOfDay(now))d=new Date(year+1,month-1,day);return d;}
function isLeap(y){return (y%4===0&&y%100!==0)||y%400===0;}
function startOfDay(d){const c=new Date(d);c.setHours(0,0,0,0);return c;}
function countdownLabel(target){const days=Math.round((startOfDay(target)-startOfDay(new Date()))/864e5);if(days===0)return 'today!';if(days===1)return 'tomorrow';if(days<0)return null;return `in ${days} day${days===1?'':'s'}`;}
function renderPersonalDates(items){const root=$('#personal-dates-list');if(!root)return;root.replaceChildren();if(!items||!items.length)return empty(root,'Birthdays, anniversaries, and other dates worth remembering — Orbit will remind you when they’re coming up.','My anniversary is June 14th');const sorted=[...items].sort((a,b)=>nextOccurrence(a.month,a.day)-nextOccurrence(b.month,b.day));for(const item of sorted){const card=document.createElement('article');card.className='item-card';const head=document.createElement('header');const wrap=document.createElement('div');const title=document.createElement('h3');title.textContent=item.label;const meta=document.createElement('div');meta.className='meta';const typeTag=document.createElement('span');typeTag.className='badge kind-badge';typeTag.textContent=item.type||'other';meta.append(typeTag);const dateTag=document.createElement('span');dateTag.className='badge';let dateStr=`${MONTH_NAMES[item.month-1]} ${item.day}`;if(item.year)dateStr+=`, ${item.year}`;dateTag.textContent=dateStr;meta.append(dateTag);const when=countdownLabel(nextOccurrence(item.month,item.day));if(when){const whenTag=document.createElement('span');whenTag.className='badge'+(when==='today!'?' completed':'');whenTag.textContent=when;meta.append(whenTag);}if(item.gift_nag&&!item.gift_done){const giftTag=document.createElement('span');giftTag.className='badge';giftTag.textContent='\u{1F381} gift';giftTag.title='Orbit is nagging about a gift for this — tell Orbit in chat when it\u2019s handled.';meta.append(giftTag);}if(item.year&&item.type==='anniversary'){const years=new Date().getFullYear()-item.year;if(years>0){const yrTag=document.createElement('span');yrTag.className='badge';yrTag.textContent=`${years} year${years===1?'':'s'}`;meta.append(yrTag);}}wrap.append(title,meta);if(item.notes){const notes=document.createElement('p');notes.textContent=item.notes;wrap.append(notes);}head.append(wrap,button('Delete','danger',()=>deletePersonalDate(item.id,item.label)));card.append(head);root.append(card);}}
async function deletePersonalDate(id,label){if(!window.confirm(`Remove "${label}" from your important dates?`))return;try{await api(`/api/personal-dates/${id}`,{method:'DELETE'});await refresh();toast('Date removed.');}catch(error){toast(error.message);}}
function renderFollowUps(items){const root=$('#followups-list');root.replaceChildren();if(!items.length)return empty(root,'Follow-ups are reminders Orbit sets from your conversations, so nothing slips through the cracks.','Remind me to call the dentist tomorrow at 10am');for(const item of items){const card=document.createElement('article');card.className='item-card';const head=document.createElement('header');const wrap=document.createElement('div');const title=document.createElement('h3');title.textContent=item.description;const date=document.createElement('p');date.textContent=`Check in on ${item.due_date}`;wrap.append(title,date);head.append(wrap,button('Remove','danger',()=>deleteFollowUp(item.id)));card.append(head);root.append(card);}}
// L2 goals/projects v2: project steps view preference (list | kanban |
// timeline). A quiet per-device view preference in localStorage — never
// synced, never a setting; default 'list' changes nothing for existing users.
const PROJECTS_VIEW_KEY='orbit-projects-view';
function currentProjectsView(){try{const v=localStorage.getItem(PROJECTS_VIEW_KEY);return v==='kanban'||v==='timeline'?v:'list';}catch(_){return 'list';}}
function syncProjectsViewToggle(){const view=currentProjectsView();for(const b of document.querySelectorAll('#projects-view-toggle [data-projects-view]')){const active=b.dataset.projectsView===view;b.classList.toggle('active',active);b.setAttribute('aria-selected',active?'true':'false');}}
function setProjectsView(view){try{localStorage.setItem(PROJECTS_VIEW_KEY,view);}catch(_){}syncProjectsViewToggle();renderProjects(state.snapshot?.projects||[]);}
// Step row + actions shared by the list, kanban and timeline views so status
// changes behave identically everywhere (no drag-and-drop).
function projectStepActions(step){const actions=document.createElement('div');actions.className='mini-actions';if(step.status!=='completed')actions.append(button(step.status==='in_progress'?'Mark planned':'Start','ghost',()=>updateProjectStep(step.id,{status:step.status==='in_progress'?'planned':'in_progress'})),button('Complete','primary',()=>updateProjectStep(step.id,{status:'completed'})));else actions.append(button('Reopen','ghost',()=>updateProjectStep(step.id,{status:'planned'})));actions.append(button('Delete','danger',()=>deleteProjectStep(step.id)));return actions;}
function projectStepRow(step){const row=document.createElement('div');row.className='project-step';const text=document.createElement('div');const name=document.createElement('strong');name.textContent=step.title;const detail=document.createElement('small');detail.textContent=[step.status.replaceAll('_',' '),step.due_date?`due ${step.due_date}`:null].filter(Boolean).join(' · ');text.append(name,detail);row.append(text,projectStepActions(step));return row;}
function renderProjectStepsRegion(steps){const view=currentProjectsView();if(view==='kanban')return buildKanbanRegion(steps,projectStepRow);if(view==='timeline')return buildTimelineRegion(steps,projectStepRow,projectStepActions);const list=document.createElement('div');list.className='project-steps';for(const step of steps)list.append(projectStepRow(step));return list;}
function renderProjects(items){const root=$('#projects-list');root.replaceChildren();syncProjectsViewToggle();if(!items.length)return empty(root,'Projects break a big goal into steps you and Orbit can work through together.','Help me plan a weekend trip to Boston');for(const project of items){const card=document.createElement('article');card.className='item-card project-card';const head=document.createElement('header');const wrap=document.createElement('div');const title=document.createElement('h3');title.textContent=project.title;const description=document.createElement('p');description.textContent=project.description||'No description added.';wrap.append(title,description);const badge=document.createElement('span');badge.className=`badge ${project.status}`;badge.textContent=project.status;head.append(wrap,badge);card.append(head);const steps=project.steps||[];const complete=steps.filter((step)=>step.status==='completed').length;const meta=document.createElement('div');meta.className='meta';for(const value of [`priority ${project.priority}`,project.target_date?`target ${project.target_date}`:'no target date',`${complete}/${steps.length} steps complete`]){const tag=document.createElement('span');tag.className='badge';tag.textContent=value;meta.append(tag);}card.append(meta);card.append(renderProjectStepsRegion(steps));if(project.status!=='completed'){const add=document.createElement('div');add.className='inline-form block-top';const input=document.createElement('input');input.maxLength=160;input.placeholder='Add the next step';const addButton=button('Add step','ghost',()=>addProjectStep(project.id,input.value));add.append(input,addButton);card.append(add);}const actions=document.createElement('div');actions.className='mini-actions';if(project.status!=='completed')actions.append(button(project.status==='paused'?'Resume':'Pause','ghost',()=>updateProject(project.id,{status:project.status==='paused'?'active':'paused'})),button('Complete project','primary',()=>updateProject(project.id,{status:'completed'})));else actions.append(button('Reopen','ghost',()=>updateProject(project.id,{status:'active'})));actions.append(button('Delete','danger',()=>deleteProject(project.id,project.title)));card.append(actions);root.append(card);}}
function renderApprovals(items,tasks){const root=$('#approvals-list');root.replaceChildren();const pendingTasks=(tasks||[]).filter((task)=>task.status==='waiting_approval');const pending=(items||[]).filter((item)=>item.status==='pending');$('#approval-count').textContent=String(pending.length+pendingTasks.length);if(!pending.length&&!pendingTasks.length&&!(items||[]).length)return empty(root,'When Orbit wants to do something that affects the outside world — like sending an email — it asks you here first. Nothing is waiting right now.');for(const task of pendingTasks){const card=document.createElement('article');card.className='item-card approval-card';const h=document.createElement('h3');h.textContent=task.title;const p=document.createElement('p');p.textContent=task.prompt;const tag=document.createElement('span');tag.className='badge waiting_approval';tag.textContent='external plan';const actions=document.createElement('div');actions.className='mini-actions';actions.append(button('Approve plan','primary',()=>taskAction(task.id,'approve')),button('Reject','danger',()=>taskAction(task.id,'cancel')));card.append(tag,h,p,actions);root.append(card);}for(const item of items||[]){const card=document.createElement('article');card.className='item-card approval-card';const head=document.createElement('header');const wrap=document.createElement('div');const h=document.createElement('h3');h.textContent=item.title;const p=document.createElement('p');p.textContent=item.summary;wrap.append(h,p);const tag=document.createElement('span');tag.className=`badge ${item.status}`;tag.textContent=item.status;head.append(wrap,tag);card.append(head);if(item.kind==='calendar_event'){const detail=document.createElement('p');detail.className='result';detail.textContent=[item.payload?.location,item.payload?.notes].filter(Boolean).join(' · ')||'Calendar file proposal';card.append(detail);}if(item.kind==='gmail_send'){const detail=document.createElement('p');detail.className='result';const recipients=[`To: ${item.payload?.to||''}`,item.payload?.cc?`CC: ${item.payload.cc}`:null,item.payload?.bcc?`BCC: ${item.payload.bcc}`:null].filter(Boolean).join('\n');detail.textContent=`${recipients}\nSubject: ${item.payload?.subject||''}\n\n${item.payload?.body||''}`;card.append(detail);}if(item.kind==='gmail_delete'){const detail=document.createElement('p');detail.className='result';detail.textContent=`${item.payload?.subject||'Email'}${item.payload?.from?` · From ${item.payload.from}`:''}`;card.append(detail);}if(['delete_goal','delete_task','delete_routine'].includes(item.kind)){const detail=document.createElement('p');detail.className='result';detail.textContent='This cannot be undone. Deleting a goal also removes its progress history.';card.append(detail);}if(item.status==='pending'){const actions=document.createElement('div');actions.className='mini-actions';const label=item.kind==='gmail_send'?'Approve & send':item.kind==='gmail_delete'?'Approve & move to trash':['delete_goal','delete_task','delete_routine'].includes(item.kind)?'Approve & delete':'Approve & create file';actions.append(button(label,'primary',()=>reviewApproval(item.id,'approve')),button('Reject','danger',()=>reviewApproval(item.id,'reject')));card.append(actions);}else if(item.result?.artifactId){const link=document.createElement('a');link.className='primary link-button block-top';link.href=`/api/artifacts/${item.result.artifactId}`;link.textContent='Download calendar file';card.append(link);}root.append(card);}}
function renderReliability(value){const metrics=$('#reliability-metrics'),failures=$('#reliability-failures');metrics.replaceChildren();failures.replaceChildren();if(!value)return empty(metrics,'Reliability data is not available yet.');const model=value.model||{};const cards=[['Model',model.state==='ready'?`Connected · ${model.primaryModel||model.activeModel}`:model.state.replaceAll('_',' ')],['Chat success',value.chat.successRate===null?'No conversations yet':`${value.chat.successRate}% (${value.chat.successful}/${value.chat.successful+value.chat.failed})`],['Background work',`${value.background.successful} completed · ${value.background.failed} failed`],['Needs approval',String(value.pendingApprovals)]];for(const [label,result] of cards){const card=document.createElement('article');card.className='panel metric-card';const small=document.createElement('p');small.className='eyebrow';small.textContent=label;const strong=document.createElement('strong');strong.textContent=result;card.append(small,strong);metrics.append(card);}if(!value.recentFailures.length)return empty(failures,'No failures recorded in the last seven days.');for(const failure of value.recentFailures){const card=document.createElement('article');card.className='item-card';const h=document.createElement('h3');h.textContent=failure.message;const p=document.createElement('p');p.textContent=`${failure.type.replaceAll('_',' ')} · ${formatDate(failure.created_at)}`;card.append(h,p);failures.append(card);}}function renderPreferences(value){if(!value)return;const form=$('#preferences-form');if(preferencesDirty||form.contains(document.activeElement))return;$('#preference-timezone').value=value.time_zone||'America/New_York';$('#preference-quiet-start').value=value.quiet_start||'22:00';$('#preference-quiet-end').value=value.quiet_end||'08:00';$('#preference-proactive').checked=value.proactive_enabled!==0;$('#preference-briefing-tone').value=value.briefing_tone||'motivational';$('#preference-briefing-length').value=value.briefing_length||'quick';}
// X5 "Writes like you": Safety panel for the personal writing voice. The
// profile text itself never reaches the browser — only opt-in/learned state.
function renderWritingVoice(){const statusEl=$('#writing-voice-status');const toggle=$('#writing-voice-optin');if(!statusEl||!toggle)return;const v=state.writingVoice;toggle.checked=!!(v&&v.optIn);if(!v){statusEl.textContent='Could not load the writing voice status.';return;}if(!v.learned){statusEl.textContent='Not learned yet. Say “learn how I write” in chat, or use the button below.';return;}const when=v.updatedAt?new Date(v.updatedAt).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'';const stamp=when?` · last updated ${when}`:'';statusEl.textContent=v.optIn?`Learned${stamp}. Orbit drafts in your voice.`:`Learned${stamp} · turned off (your style is kept).`;}
function renderModelStatus(value){const grid=$('#safety .settings-grid');if(!grid)return;let panel=$('#model-health');if(!panel){panel=document.createElement('section');panel.id='model-health';panel.className='panel';grid.prepend(panel);}panel.replaceChildren();const heading=document.createElement('h2');heading.textContent='AI model connection';const status=document.createElement('p');status.className='muted';const state=value?.state||'demo';const provider=value?.provider==='azure-openai'?'Azure OpenAI':'OpenAI';const labels={demo:'Demo mode — no API key connected.',unverified:`${provider} is configured; checking the connection now…`,ready:`Connected to ${value?.primaryModel||value?.activeModel} through ${provider}.`,fallback:`${value?.primaryModel} is unavailable; safely using ${value?.activeModel} through ${provider}.`,authentication:`The ${provider} credential was rejected or has been revoked.`,quota:`${provider} quota, credits, or the project spending limit need attention.`,rate_limit:'The model is temporarily rate-limited.',model_access:value?.availableTextModelCount===0?`The key works, but ${provider} reports no text-generation models. Check model deployment and quota.`:`The key works, but ${provider} cannot access Orbit’s configured deployments.`,network:`Orbit could not reach ${provider}.`,service:`${provider} is temporarily unavailable.`,request:`${provider} rejected the connection check.`};status.textContent=labels[state]||'Model status is unknown.';panel.append(heading,status);const meta=document.createElement('div');meta.className='meta';for(const label of [`provider: ${provider}`,`primary: ${value?.primaryModel||'not set'}`,`fallback: ${(value?.fallbackModels||[value?.fallbackModel]).filter(Boolean).join(', ')||'not set'}`,`state: ${state.replaceAll('_',' ')}`,value?.availableTextModelCount===null||value?.availableTextModelCount===undefined?null:`available text models: ${value.availableTextModelCount}`,Number.isFinite(value?.connectionLatencyMs)?`connection: ${(value.connectionLatencyMs/1000).toFixed(2)}s`:null,Number.isFinite(value?.lastFirstTokenMs)?`last first response: ${(value.lastFirstTokenMs/1000).toFixed(2)}s`:null].filter(Boolean)){const tag=document.createElement('span');tag.className='badge';tag.textContent=label;meta.append(tag);}panel.append(meta);if(value?.lastError){const detail=document.createElement('p');detail.className='hint block-top';detail.textContent=value.lastError;panel.append(detail);}const check=button('Check connection','ghost block-top',checkModelConnection);check.id='model-check-button';panel.append(check);}
let timelineState={loaded:false,loading:false};
async function renderTimeline(){
  const root=$('#timeline-list');if(!root)return;
  if(!$('#timeline').classList.contains('active'))return;
  if(timelineState.loaded||timelineState.loading)return;
  timelineState.loading=true;
  root.replaceChildren();const loading=document.createElement('p');loading.className='muted';loading.textContent='Writing your story…';root.append(loading);
  try{
    const data=await api('/api/timeline?months=12');
    timelineState.loaded=true;root.replaceChildren();
    if(!data.months.length){empty(root,'Your timeline gathers the highlights of your time with Orbit into chapters. Keep chatting and your first chapter will appear.','Tell me about your day');return;}
    const wrap=document.createElement('div');wrap.className='timeline';
    for(const m of data.months){
      const item=document.createElement('div');item.className='timeline-item';
      const h=document.createElement('h3');h.textContent=m.label;
      const p=document.createElement('p');p.className='timeline-chapter';p.textContent=m.narrative;
      const meta=document.createElement('div');meta.className='meta';
      for(const hl of m.highlights||[]){const tag=document.createElement('span');tag.className='badge';tag.textContent=hl;meta.append(tag);}
      const stats=document.createElement('p');stats.className='muted';stats.textContent=`${m.stats.memories} memories · ${m.stats.conversations} conversations · ${m.stats.goalsCompleted} goals completed`;
      item.append(h,p);if(meta.children.length)item.append(meta);item.append(stats);wrap.append(item);
    }
    root.append(wrap);
  }catch(error){root.replaceChildren();empty(root,'Your timeline couldn’t load right now. Try refreshing the page.');toast(error.message);}
  finally{timelineState.loading=false;}
}
function renderActivity(items){const root=$('#activity-list');root.replaceChildren();if(!items.length)return empty(root,'This is a running log of everything Orbit does for you, so you can always see what happened. Nothing has happened yet.');for(const event of items){const el=document.createElement('div');el.className='timeline-item';const p=document.createElement('p');p.textContent=event.message;const time=document.createElement('time');time.dateTime=event.created_at;time.textContent=formatDate(event.created_at);el.append(p,time);if(event.detail){const detail=document.createElement('p');detail.className='muted small';detail.textContent=event.detail;el.append(detail);}root.append(el);}}
async function deleteFile(id,name){if(!confirm(`Delete "${name}"?`))return;try{await api(`/api/artifacts/${id}`,{method:'DELETE'});state.snapshot.artifacts=(state.snapshot.artifacts||[]).filter(f=>f.id!==id);renderFiles(state.snapshot.artifacts);toast('File deleted.');}catch(e){toast('Could not delete file: '+e.message);}}
// Files-tab document viewer. The old bare <a href> Download link did a top-level
// navigation with no auth headers — on iOS native (Bearer-token auth, no usable
// cookie in WKWebView) the request 401'd and the app page was destroyed (splash
// screen, back to the Today tab). Now everything goes through the authenticated
// api() helper and no navigation happens at all: markdown docs open in an
// in-app viewer with Print, other files go to the share sheet / download.
async function openArtifact(file){
  let res;
  try{res=await api(`/api/artifacts/${file.id}`);}
  catch(e){toast(e&&e.auth?'Please sign in again, then try once more.':'Could not open "'+file.name+'": '+(e&&e.message||e));return;}
  try{
    const type=res.headers.get('content-type')||'';
    if(type.includes('text/html')){openDocViewer(file.name,await res.text(),file.id);return;}
    await shareOrDownloadBlob(await res.blob(),file.name||'orbit-file',type);
  }catch(e){toast('Could not open "'+file.name+'": '+(e&&e.message||e));}
}
async function shareOrDownloadBlob(blob,name,type){
  const f=new File([blob],name,{type:type||blob.type||'application/octet-stream'});
  if(navigator.canShare&&navigator.canShare({files:[f]})){
    try{await navigator.share({files:[f],title:name});return;}
    catch(e){if(e&&e.name==='AbortError')return;} // user dismissed the sheet — done
  }
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),4000);
}
function openDocViewer(name,html,artifactId){
  closeDocViewer();
  const overlay=document.createElement('div');
  overlay.className='doc-overlay';overlay.id='doc-overlay';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-label',name);
  const bar=document.createElement('div');bar.className='doc-bar';
  const title=document.createElement('strong');title.className='doc-title';title.textContent=name;
  const printBtn=document.createElement('button');printBtn.type='button';printBtn.className='primary';printBtn.textContent='Print';
  printBtn.onclick=()=>printArtifact(artifactId,name);
  const closeBtn=document.createElement('button');closeBtn.type='button';closeBtn.className='ghost';closeBtn.textContent='Close';
  closeBtn.onclick=closeDocViewer;
  bar.append(title,printBtn,closeBtn);
  const frame=document.createElement('iframe');frame.className='doc-frame';frame.title=name;
  // The server HTML ships its own toolbar wired for top-level navigation
  // (Done link + Print via relative fetch) — hide it; the viewer bar above
  // is authoritative while the doc lives inside the app.
  frame.srcdoc=String(html).replace('<div class="toolbar">','<div class="toolbar" style="display:none">');
  overlay.append(bar,frame);document.body.append(overlay);
  document.addEventListener('keydown',docViewerKey);
}
function docViewerKey(event){if(event.key==='Escape')closeDocViewer();}
function closeDocViewer(){document.removeEventListener('keydown',docViewerKey);const el=document.getElementById('doc-overlay');if(el)el.remove();}
async function printArtifact(artifactId,name){
  try{
    const res=await api(`/api/artifacts/${artifactId}?format=pdf`);
    const pdfName=String(name||'orbit-result').replace(/\.md$/i,'')+'.pdf';
    await shareOrDownloadBlob(await res.blob(),pdfName,'application/pdf');
  }catch(e){toast('Could not prepare the print file: '+(e&&e.message||e));}
}
function renderFiles(items){const root=$('#files-list');root.replaceChildren();if(!items.length)return empty(root,'Files Orbit makes for you — documents, lists, calendars — show up here.','Make me a packing list for a beach weekend');for(const file of items){const card=document.createElement('article');card.className='item-card';const head=document.createElement('header');const wrap=document.createElement('div');const h=document.createElement('h3');h.textContent=file.name;const p=document.createElement('p');p.textContent=`${Math.max(1,Math.round(file.size_bytes/1024))} KB · ${formatDate(file.created_at)}`;wrap.append(h,p);const actions=document.createElement('div');actions.className='card-actions';const link=document.createElement('button');link.type='button';link.className='primary link-button';link.textContent='Open';link.onclick=()=>openArtifact(file);const del=document.createElement('button');del.className='danger link-button';del.textContent='Delete';del.onclick=()=>deleteFile(file.id,file.name);actions.append(link,del);head.append(wrap,actions);card.append(head);root.append(card);}}
const whatsappUi={status:null,code:null,expiresAt:null,deepLink:null,codeRefreshed:null,loading:false};
async function loadWhatsAppStatus(force){
  if(whatsappUi.loading)return;
  if(whatsappUi.status&&!force)return;
  whatsappUi.loading=true;
  try{whatsappUi.status=await api('/api/whatsapp/link/status');}
  catch(e){whatsappUi.status={error:String(e.message||e)};}
  finally{whatsappUi.loading=false;}
}
function renderWhatsAppCard(root){
  if(!(state.user&&state.user.role==='owner'))return; // WhatsApp is owner-only
  const card=document.createElement('article');card.className='panel connector-card';
  const h=document.createElement('h2');h.textContent='WhatsApp';card.append(h);
  const p=document.createElement('p');p.className='muted';
  const st=whatsappUi.status;
  if(!st){p.textContent='Loading…';card.append(p);root.append(card);loadWhatsAppStatus().then(()=>renderConnections());return;}
  if(st.error){p.textContent='Could not load WhatsApp status.';card.append(p);root.append(card);return;}
  if(!st.configured){p.textContent='WhatsApp is not configured on this server yet.';card.append(p);root.append(card);return;}
  if(st.linked){
    whatsappUi.code=null;whatsappUi.expiresAt=null;whatsappUi.deepLink=null;whatsappUi.codeRefreshed=null;
    p.textContent=`Connected (${st.phone}). Messages you send to Orbit on WhatsApp appear in your chats here too.`;
    card.append(p);
    const actions=document.createElement('div');actions.className='mini-actions';
    actions.append(button('Disconnect','danger',async()=>{try{await api('/api/whatsapp/link',{method:'DELETE'});whatsappUi.status=null;whatsappUi.code=null;whatsappUi.deepLink=null;whatsappUi.codeRefreshed=null;await refresh();toast('WhatsApp disconnected.');}catch(e){toast(e.message);}}));
    card.append(actions);
  }else if(whatsappUi.code){
    p.textContent=whatsappUi.codeRefreshed?'That code expired — here\u2019s a fresh one:':'Linking WhatsApp — almost there:';
    card.append(p);
    const steps=document.createElement('ol');steps.className='muted';steps.style.cssText='margin:.3em 0 .3em 1.2em;padding:0;';
    const s1=document.createElement('li');s1.textContent='Tap the button below — WhatsApp opens with your code ready to go.';
    const s2=document.createElement('li');s2.textContent='Hit send. That\u2019s it — you\u2019re linked.';
    steps.append(s1,s2);card.append(steps);
    if(whatsappUi.deepLink){
      const link=document.createElement('a');
      link.href=whatsappUi.deepLink;link.target='_blank';link.rel='noopener';
      link.className='primary link-button';link.textContent='Open WhatsApp to link →';
      link.style.margin='0.4em 0';
      card.append(link);
    }
    const fallback=document.createElement('p');fallback.className='muted small';
    fallback.textContent=`Prefer to do it by hand? Open a chat with ${st.whatsappNumber} on WhatsApp and send this code:`;
    card.append(fallback);
    const codeEl=document.createElement('p');codeEl.style.cssText='font-size:1.4em;font-weight:800;letter-spacing:.2em;margin:.3em 0;';codeEl.textContent=whatsappUi.code.slice(0,3)+' '+whatsappUi.code.slice(3);card.append(codeEl);
    const hint=document.createElement('p');hint.className='muted small';hint.textContent='One-time code — expires in 10 minutes and can only be used once.';card.append(hint);
    card.append(button('Get a new code','ghost',async()=>{
      try{const r=await api('/api/whatsapp/link/start',{method:'POST'});whatsappUi.code=r.code;whatsappUi.expiresAt=r.expiresAt;whatsappUi.deepLink=r.deepLink||null;whatsappUi.codeRefreshed=true;renderConnections();}
      catch(e){toast(e.message);}
    }));
  }else{
    p.textContent='Chat with Orbit from WhatsApp, as if texting a contact. Your full Orbit — memories, tools, history — works there. Tap Connect and I\u2019ll walk you through linking your number.';
    card.append(p);
    card.append(button('Connect WhatsApp','primary',async()=>{
      try{const r=await api('/api/whatsapp/link/start',{method:'POST'});whatsappUi.code=r.code;whatsappUi.expiresAt=r.expiresAt;whatsappUi.deepLink=r.deepLink||null;whatsappUi.codeRefreshed=false;renderConnections();}
      catch(e){toast(e.message);}
    }));
  }
  root.append(card);
}
function renderConnections(){const root=$('#connections-list');if(!root||!state.snapshot)return;const ae=document.activeElement;if(ae&&ae.tagName==='INPUT'&&root.contains(ae))return;root.replaceChildren();const connected=new Map((state.snapshot.connectors||[]).map((item)=>[item.provider,item]));for(const provider of state.status.connectors||[]){const card=document.createElement('article');card.className='panel connector-card';const h=document.createElement('h2');h.textContent=provider.label;const p=document.createElement('p');p.className='muted';const live=connected.has(provider.id);p.textContent=live?'Connected with encrypted credentials.':provider.configured?'Ready to connect.':'Server administrator must configure OAuth credentials.';card.append(h,p);if(live){const actions=document.createElement('div');actions.className='mini-actions';actions.append(button('Preview access','ghost',()=>previewConnector(provider.id)),button('Disconnect','danger',()=>disconnectConnector(provider.id)));card.append(actions);}else{const connect=button('Connect','primary',()=>beginConnector(provider.id));connect.disabled=!provider.configured;card.append(connect);}root.append(card);}if(state.user&&state.user.role==='owner')renderWhatsAppCard(root);renderCalendarFeeds();}
function renderCalendarFeeds(){const root=$('#connections-list');if(!root||!state.snapshot)return;const feeds=state.snapshot.calendarFeeds||[];const panel=document.createElement('section');panel.className='panel section-gap';const h=document.createElement('h2');h.textContent='Calendar feeds';panel.append(h);const p=document.createElement('p');p.className='muted';p.textContent='Connect iCal feeds (Google, Apple, Outlook) so Orbit can read your schedule. Feed URLs are secret \u2014 only a masked preview is ever shown.';panel.append(p);const list=document.createElement('div');list.className='card-list block-top';if(!feeds.length){const e=document.createElement('p');e.className='muted';e.textContent='No calendars connected yet.';list.append(e);}for(const feed of feeds){const card=document.createElement('article');card.className='item-card';const head=document.createElement('header');const wrap=document.createElement('div');const title=document.createElement('h3');title.textContent=feed.label;const url=document.createElement('p');url.className='muted';url.textContent=feed.url;wrap.append(title,url);head.append(wrap,button('Remove','danger',()=>removeCalendarFeed(feed.id,feed.label)));card.append(head);list.append(card);}panel.append(list);const form=document.createElement('div');form.className='form-grid block-top';const labelWrap=document.createElement('label');labelWrap.textContent='Label';const labelInput=document.createElement('input');labelInput.placeholder='e.g. School';labelInput.maxLength=60;labelWrap.append(labelInput);const urlWrap=document.createElement('label');urlWrap.textContent='iCal feed URL';const urlInput=document.createElement('input');urlInput.placeholder='https://\u2026';urlInput.inputMode='url';urlInput.autocomplete='off';urlWrap.append(urlInput);const addBtn=button('Add calendar','primary',async()=>{const label=labelInput.value.trim(),feedUrl=urlInput.value.trim();if(!label||!feedUrl){toast('A label and feed URL are both required.');return;}addBtn.disabled=true;try{const added=await api('/api/calendar-feeds',{method:'POST',body:JSON.stringify({label,url:feedUrl})});toast(`Connected \u201c${added.feed.label}\u201d \u2014 ${added.eventsFound} events found.`);await refresh();}catch(error){toast(error.message);}finally{addBtn.disabled=false;}});form.append(labelWrap,urlWrap,addBtn);panel.append(form);const hint=document.createElement('p');hint.className='hint';hint.textContent='Google Calendar: Settings \u2192 pick the calendar \u2192 Secret address in iCal format. Apple Calendar: publish/share the calendar and copy its subscription link.';panel.append(hint);root.append(panel);}
async function removeCalendarFeed(id,label){if(!window.confirm(`Remove the \u201c${label}\u201d calendar feed?`))return;try{await api(`/api/calendar-feeds/${id}`,{method:'DELETE'});await refresh();toast('Calendar feed removed.');}catch(error){toast(error.message);}}
function render(){if(!state.snapshot)return;renderThreads();settlePendingReplies(state.snapshot.messages||[],state.snapshot.activeConversation&&state.snapshot.activeConversation.id);renderMessages(state.snapshot.messages);renderFollowUpNudge();syncTypingBubble();syncStreamPoller();renderGoals(state.snapshot.goals||[]);renderRoutines(state.snapshot.routines||[]);renderProjects(state.snapshot.projects||[]);renderApprovals(state.snapshot.approvals||[],state.snapshot.tasks||[]);renderReliability(state.snapshot.reliability);renderTasks(state.snapshot.tasks);renderFiles(state.snapshot.artifacts||[]);renderMemories(state.snapshot.memories,state.snapshot.memorySuggestions);renderFollowUps(state.snapshot.followUps||[]);renderPersonalDates(state.snapshot.personalDates||[]);renderPreferences(state.snapshot.preferences);renderWritingVoice();renderModelStatus(state.status.modelStatus);renderActivity(state.snapshot.events);renderConnections();renderTimeline();const paused=state.status.paused;$('#pause-banner').classList.toggle('hidden',!paused);$('#pause-button').classList.toggle('hidden',paused);$('#resume-button').classList.toggle('hidden',!paused);$('#chat-input').disabled=paused;const isOwner=state.user&&state.user.role==='owner';$('#registration-panel').classList.toggle('hidden',!isOwner);if(isOwner){const open=!!state.setup?.registrationOpen;const automatic=!!state.setup?.automaticSignup;$('#registration-status').textContent=automatic?'Automatic signup is active. Low-risk applicants can join; uncertain signups require verification.':open?'Registration is open. New signups can create accounts.':'Registration is closed. New signups are turned away.';$('#registration-toggle').textContent=automatic?'Managed automatically':open?'Close':'Open';$('#registration-toggle').disabled=automatic;$('#registration-toggle').classList.toggle('danger',open&&!automatic);}$('#access-panel').classList.toggle('hidden',!isOwner);$('#users-panel').classList.toggle('hidden',!isOwner);if(isOwner){renderAccessRequests();renderUserList();}renderSignupSafety();maybeShowIntroCard();}
function renderThreads(){const bar=document.querySelector('#thread-bar');if(!bar||!state.snapshot)return;bar.replaceChildren();for(const c of state.snapshot.conversations||[]){const b=document.createElement('button');b.type='button';b.className='thread-chip'+(c.id===activeConversationId?' active':'');const label=document.createElement('span');label.className='thread-label';label.textContent=c.title;b.append(label);const x=document.createElement('span');x.className='thread-x';x.textContent='\u00d7';x.title='Delete this conversation';x.addEventListener('click',(ev)=>{ev.stopPropagation();deleteThread(c.id,c.title);});b.append(x);b.addEventListener('click',()=>{if(c.id!==activeConversationId){activeConversationId=c.id;try{localStorage.setItem('orbit-convo',c.id);}catch(_){}refresh().catch(()=>{});}});bar.append(b);}const n=document.createElement('button');n.type='button';n.className='thread-chip thread-new';n.textContent='+ New chat';n.addEventListener('click',newThread);bar.append(n);}
async function newThread(){try{const c=await api('/api/conversations',{method:'POST',body:JSON.stringify({})});activeConversationId=c.id;try{localStorage.setItem('orbit-convo',c.id);}catch(_){}await refresh();}catch(error){toast(error.message);}}
async function deleteThread(id,title){if(!window.confirm(`Delete "${title}" and all its messages?`))return;try{await api(`/api/conversations/${id}`,{method:'DELETE'});if(id===activeConversationId){activeConversationId=null;try{localStorage.removeItem('orbit-convo');}catch(_){}}await refresh();toast('Conversation deleted.');}catch(error){toast(error.message);}}
function renderModelPill(){const modelState=state.status.modelStatus?.state;$('#model-pill').textContent=!state.status.modelConfigured?'Demo mode · add an API key':modelState==='fallback'?`${state.status.modelStatus.activeModel} · fallback`:['authentication','quota','rate_limit','model_access','network','service','request'].includes(modelState)?'Model needs attention':state.status.model;}
async function checkModelConnection(quiet){const control=$('#model-check-button');if(control){control.disabled=true;control.textContent='Checking…';}try{const result=await api('/api/model/check',{method:'POST'});state.status.modelStatus=result.modelStatus;renderModelStatus(result.modelStatus);renderModelPill();if(!quiet){const stateName=result.modelStatus.state;toast(stateName==='ready'||stateName==='fallback'?'AI model connection is ready.':'Connection issue identified in Safety.');}}catch(error){if(!quiet)toast(error.message);}finally{const current=$('#model-check-button');if(current){current.disabled=false;current.textContent='Check connection';}}}
let modelCheckInFlight=false;
function maybeAskName(){if(state.justRegistered){state.justRegistered=false;return;}const memories=state.snapshot.memories||[];const known=memories.some((m)=>/my name is/i.test(m.content||''));const d=document.querySelector('#name-dialog');if(!known&&d&&!d.open)d.showModal();}
let lastTypeAt=0;
// L3 multi-user polish: one-time "what can Orbit do" intro card for new users.
// Shown until dismissed; dismissal persists server-side per user, so it never
// nags and never resurfaces on a new device. Not a settings toggle.
const INTRO_CAPABILITIES=[
  'Ask me anything — questions, decisions, plans.',
  'I remember what matters, and you approve every memory before I keep it.',
  'Morning briefings that catch you up on your day.',
  'Tasks, goals, and routines — just tell me what you want done.',
  'Voice mode when you’d rather talk than type.',
];
function maybeShowIntroCard(){
  if(state.user?.isDemo)return;
  if($('#intro-card'))return;
  const prefs=state.snapshot?.preferences;
  if(!prefs||prefs.intro_dismissed)return;
  const panel=$('#today .conversation-panel');
  const messages=$('#messages');
  if(!panel||!messages)return;
  const card=document.createElement('section');
  card.id='intro-card';
  card.className='intro-card';
  const eyebrow=document.createElement('p');eyebrow.className='eyebrow';eyebrow.textContent='NEW HERE?';
  const title=document.createElement('h2');title.textContent='What can Orbit do?';
  const list=document.createElement('ul');
  for(const item of INTRO_CAPABILITIES){const li=document.createElement('li');li.textContent=item;list.append(li);}
  const dismiss=button('Got it','primary',async()=>{dismiss.disabled=true;try{await api('/api/onboarding/intro-dismiss',{method:'POST',body:'{}'});card.remove();}catch(error){toast(error.message);dismiss.disabled=false;}});
  card.append(eyebrow,title,list,dismiss);
  panel.insertBefore(card,messages);
}
function isComposing(){const input=$('#chat-input');if(input&&(document.activeElement===input||input.value.trim()))return true;return Date.now()-lastTypeAt<3000;}
document.addEventListener('input',(e)=>{if(e.target&&e.target.id==='chat-input')lastTypeAt=Date.now();},true);
let refreshInFlight=false;
async function refresh(){if(refreshInFlight)return;refreshInFlight=true;try{state.status=await api('/api/status');try{state.setup=await(await nativeFetch(API_BASE+'/api/auth/setup-status',{credentials:NATIVE_CREDENTIALS})).json();}catch(_){}const qs=activeConversationId?`?conversation=${encodeURIComponent(activeConversationId)}`:'';state.snapshot=await api('/api/snapshot'+qs);// "Catch me up": keep the app-open timestamp from the FIRST snapshot of
// this page load — later refreshes overwrite it with "just now", which would
// erase the 6h+ absence the away card needs to detect.
if(state.catchupSince===undefined)state.catchupSince=state.snapshot.lastAppOpenAt||null;try{state.writingVoice=await api('/api/writing-voice');}catch(_){state.writingVoice=null;}state.accessRequests=[];state.users=[];state.signupRisk=null;state.signupAppeals=[];if(state.user&&state.user.role==='owner'){try{state.signupRisk=await api('/api/admin/signup-risk');state.signupAppeals=(await api('/api/admin/signup-appeals')).appeals||[];}catch(_){}try{state.accessRequests=(await api('/api/admin/access-requests')).requests||[];}catch(_){}try{state.users=(await api('/api/admin/users')).users||[];}catch(_){}}if(state.snapshot.activeConversation){activeConversationId=state.snapshot.activeConversation.id;try{localStorage.setItem('orbit-convo',activeConversationId);}catch(_){}}$('#brand-name').textContent=state.status.buddyName;$('#status-text').textContent=state.status.paused?'Paused':'Online';$('.status').classList.toggle('online',!state.status.paused);const modelState=state.status.modelStatus?.state;renderModelPill();if(state.status.modelConfigured&&modelState==='unverified'&&!modelCheckInFlight){modelCheckInFlight=true;checkModelConnection(true).finally(()=>{modelCheckInFlight=false;});}if(!isComposing())render();else syncTypingBubble();if(state.user&&$('#today').classList.contains('active')){loadBriefing();loadCatchupCard();}}finally{refreshInFlight=false;}}
async function connect(){try{const me=await api('/api/auth/me');state.user=me.user;state.csrf=me.csrf;if(me.user.isDemo){state.isDemo=true;showDemoBanner();}$('#account-button').textContent=state.user.displayName;$('#account-button').classList.remove('hidden');$('#delete-account-panel')?.classList.toggle('hidden',!!me.user.isDemo);$('#owner-delete-warning')?.classList.toggle('hidden',me.user.role!=='owner');await refresh();maybeAskName();$('#hero-signin')?.classList.add('hidden');$('#auth-dialog').close();if(isNativeRuntime(window))setupNativePush();}catch(error){if(error.auth){$('#status-text').textContent='Sign in required';$('#model-pill').textContent='Sign in to connect';state.setup=await nativeFetch(API_BASE+'/api/auth/setup-status',{credentials:NATIVE_CREDENTIALS}).then((r)=>r.json());setAuthMode(state.setup.needsOwner||state.signupVerificationToken?'register':'login');if(IS_NATIVE&&!state.launchSignin){
          const goWelcome=()=>{location.href='welcome.html';};
          if(window.__orbitSplashComplete){goWelcome();return;}
          let splashWaited=false;
          const splashTimeout=setTimeout(()=>{if(!splashWaited){splashWaited=true;goWelcome();}},11000);
          window.addEventListener('orbit-splash-done',()=>{if(!splashWaited){splashWaited=true;clearTimeout(splashTimeout);goWelcome();}},{once:true});
          return;}if(state.launchSignin){const d=$('#auth-dialog');if(d&&!d.open)d.showModal();}else{$('#hero-signin')?.classList.remove('hidden');}}else{$('#status-text').textContent='Connection issue';$('#model-pill').textContent='Retrying connection';toast(error.message);}}}
function setAuthMode(mode){if(mode!=='register')state.appleSignupProof=null;renderAppleAuthControls(document,{nativeReady:IS_NATIVE&&!!signupPlugin(),loginReady:!!state.setup?.appleSignInReady,signupReady:!!state.setup?.appleSignupReady,mode,registrationAvailable:!!state.setup?.needsOwner||(!state.setup?.signupsPaused&&(!!state.setup?.registrationOpen||!!state.setup?.automaticSignup))});$('#auth-form').dataset.mode=mode;const register=mode==='register';const recover=mode==='recover';const forgot=mode==='forgot';$('#auth-title').textContent=register?(state.setup?.needsOwner?'Create the owner account':'Create an account'):recover?'Recover your account':forgot?'Reset password':'Sign in';$('#auth-copy').textContent=recover?'Use one of your offline recovery codes.':forgot?'Enter your email and we\'ll send you a password reset link.':register&&state.signupVerificationToken?'Finish email verification by re-entering the account details you just chose.':'Private by design — your conversations stay on your server and never train AI models.';$('#name-label').classList.toggle('hidden',!register);$('#recovery-label').classList.toggle('hidden',!recover);$('#new-password-label').classList.toggle('hidden',!recover);$('#password-label').classList.toggle('hidden',recover||forgot);$('#forgot-row').classList.toggle('hidden',mode!=='login');$('#auth-password').required=!recover&&!forgot;$('#auth-name').required=register;$('#auth-recovery').required=recover;$('#auth-new-password').required=recover;$('#auth-submit').disabled=false;$('#auth-submit').textContent=register?'Create account':recover?'Recover account':forgot?'Send reset link':'Sign in';const doorClosed=register&&state.setup&&!state.setup.needsOwner&&!state.setup.registrationOpen&&!state.setup.automaticSignup;$('#auth-closed').classList.toggle('hidden',!doorClosed);for(const id of['#name-label','#email-label','#password-label','#auth-submit']){const field=$(id);if(field)field.classList.toggle('hidden',!!doorClosed);}if(doorClosed){$('#auth-title').textContent='Registration is closed';$('#auth-copy').textContent='Ask the owner to open registration, then try again.';}$('#auth-error').textContent='';$('#request-form').classList.add('hidden');$('#request-status').textContent='';}
function renderAccessRequests(){const list=$('#access-list');if(!list)return;list.replaceChildren();const pending=(state.accessRequests||[]).filter((r)=>!r.handled_at);if(!pending.length)return empty(list,'Nobody is waiting for access right now.');for(const r of pending){const card=document.createElement('article');card.className='item-card';const head=document.createElement('header');const wrap=document.createElement('div');const h=document.createElement('h3');h.textContent=r.name;const p=document.createElement('p');p.textContent=`${r.email} · asked ${formatDate(r.created_at)}`;wrap.append(h,p);const actions=document.createElement('div');actions.className='mini-actions';actions.append(button('Approve','primary',()=>approveRequest(r.id)),button('Deny','danger',()=>denyRequest(r.id)),button('Dismiss','ghost',()=>dismissRequest(r.id)));head.append(wrap);card.append(head,actions);list.append(card);}}
async function resetUserPassword(email,displayName){if(!window.confirm(`Send a password reset email to ${displayName||email}?`))return;try{const res=await api('/api/admin/reset-password',{method:'POST',body:JSON.stringify({email})});toast(res.emailed?`Reset email sent to ${displayName||email}.`:`Reset link created for ${displayName||email} (email not sent).`);}catch(e){toast('Reset failed: '+e.message);}}
function renderUserList(){const list=$('#user-list');if(!list)return;list.replaceChildren();const users=state.users||[];if(!users.length)return empty(list,'No other people have accounts yet.');for(const u of users){const card=document.createElement('article');card.className='item-card';const head=document.createElement('header');const wrap=document.createElement('div');const h=document.createElement('h3');h.textContent=u.displayName||u.email;const p=document.createElement('p');p.textContent=u.email;wrap.append(h,p);const badges=document.createElement('div');badges.className='meta';const role=document.createElement('span');role.className='badge';role.textContent=u.role;const status=document.createElement('span');status.className='badge '+(u.disabled?'blocked':'completed');status.textContent=u.disabled?'disabled':'active';badges.append(role,status);wrap.append(badges);const actions=document.createElement('div');actions.className='mini-actions';actions.append(button('Reset password','ghost',()=>resetUserPassword(u.email,u.displayName)));head.append(wrap,actions);card.append(head);list.append(card);}}
async function dismissRequest(id){try{await api(`/api/admin/access-requests/${id}`,{method:'POST'});await refresh();toast('Request dismissed.');}catch(error){toast(error.message);}}
async function approveRequest(id){if(!confirm('Approve this user for Orbit access?'))return;try{await api(`/api/admin/access-requests/${id}/approve`,{method:'POST'});await refresh();toast('Access approved.');}catch(error){toast(error.message);}}
async function denyRequest(id){if(!confirm('Deny access? This will block their account.'))return;try{await api(`/api/admin/access-requests/${id}/deny`,{method:'POST'});await refresh();toast('Access denied.');}catch(error){toast(error.message);}}
// --- B3: follow-ups surfaced inline in chat ---
// Follow-ups exist as a data type but live on a tab nobody opens. The next
// due follow-up appears as one gentle suggestion at the bottom of the
// conversation: one tap to engage, easy to ignore (dismiss lasts the session).
function renderFollowUpNudge(){
  const root=$('#followup-nudge');if(!root)return;root.replaceChildren();
  const items=(state.snapshot&&state.snapshot.followUps)||[];
  if(!items.length)return;
  const todayStr=new Date().toLocaleDateString('en-CA');
  const inDays=(d)=>{const ms=new Date(d+'T12:00:00')-new Date(todayStr+'T12:00:00');return Math.round(ms/864e5);};
  const due=items.filter((f)=>f.due_date<=todayStr).sort((a,b)=>a.due_date<b.due_date?-1:1)[0]
    ||items.filter((f)=>inDays(f.due_date)<=3).sort((a,b)=>a.due_date<b.due_date?-1:1)[0];
  if(!due)return;
  try{if(sessionStorage.getItem('orbit-nudge-dismissed-'+due.id)==='1')return;}catch(_){}
  const when=due.due_date<todayStr?`was due ${due.due_date}`:due.due_date===todayStr?'is due today':`is due ${due.due_date}`;
  const card=document.createElement('div');card.className='followup-nudge';
  const text=document.createElement('p');
  const quote=document.createElement('strong');quote.textContent=`\u201c${due.description}\u201d`;
  text.append(document.createTextNode('📌 '),quote,document.createTextNode(` ${when} — want to pick up where you left off?`));
  const actions=document.createElement('div');actions.className='mini-actions';
  actions.append(
    button('Pick it up','primary',()=>sendChatMessage(`Let's pick this back up: ${due.description}`)),
    button('Not now','ghost',()=>{try{sessionStorage.setItem('orbit-nudge-dismissed-'+due.id,'1');}catch(_){}renderFollowUpNudge();})
  );
  card.append(text,actions);root.append(card);
}

async function taskAction(id,action){try{await api(`/api/tasks/${id}/${action}`,{method:'POST'});await refresh();toast(action==='approve'?'Task approved.':'Task cancelled.');}catch(error){toast(error.message);}}
async function taskDelete(id){if(!confirm('Delete this task permanently?'))return;try{await api(`/api/tasks/${id}`,{method:'DELETE'});await refresh();toast('Task deleted.');}catch(error){toast(error.message);}}
async function updateGoal(id,patch){try{await api(`/api/goals/${id}`,{method:'PATCH',body:JSON.stringify(patch)});await refresh();toast('Goal updated.');}catch(error){toast(error.message);}}
async function deleteGoal(id,title){if(!window.confirm(`Delete the goal “${title}” and its progress history?`))return;try{await api(`/api/goals/${id}`,{method:'DELETE'});await refresh();toast('Goal deleted.');}catch(error){toast(error.message);}}
async function updateProject(id,patch){try{await api(`/api/projects/${id}`,{method:'PATCH',body:JSON.stringify(patch)});await refresh();toast('Project updated.');}catch(error){toast(error.message);}}
async function deleteProject(id,title){if(!window.confirm(`Delete “${title}” and all of its steps?`))return;try{await api(`/api/projects/${id}`,{method:'DELETE'});await refresh();toast('Project deleted.');}catch(error){toast(error.message);}}
async function addProjectStep(projectId,title){if(!String(title||'').trim())return;try{await api(`/api/projects/${projectId}/steps`,{method:'POST',body:JSON.stringify({title})});await refresh();toast('Step added.');}catch(error){toast(error.message);}}
async function updateProjectStep(id,patch){try{await api(`/api/project-steps/${id}`,{method:'PATCH',body:JSON.stringify(patch)});await refresh();toast('Step updated.');}catch(error){toast(error.message);}}
async function deleteProjectStep(id){try{await api(`/api/project-steps/${id}`,{method:'DELETE'});await refresh();toast('Step deleted.');}catch(error){toast(error.message);}}
async function reviewApproval(id,action){try{const result=await api(`/api/approvals/${id}/${action}`,{method:'POST',body:'{}'});await refresh();toast(action==='approve'?(result.artifact?'Approved. The calendar file is ready to download.':'Approved and completed.'):'Proposal rejected.');if(result.artifact)activateView('approvals');}catch(error){toast(error.message);await refresh();}}
async function toggleRoutine(id,enabled){try{await api(`/api/routines/${id}`,{method:'PATCH',body:JSON.stringify({enabled})});await refresh();toast(enabled?'Routine enabled.':'Routine paused.');}catch(error){toast(error.message);}}
async function deleteRoutine(id,title){if(!window.confirm(`Delete the routine “${title}”?`))return;try{await api(`/api/routines/${id}`,{method:'DELETE'});await refresh();toast('Routine deleted.');}catch(error){toast(error.message);}}
async function deleteMemory(id){try{await api(`/api/memories/${id}`,{method:'DELETE'});await refresh();toast('Memory deleted.');}catch(error){toast(error.message);}}
async function deleteFollowUp(id){try{await api(`/api/follow-ups/${id}`,{method:'DELETE'});await refresh();toast('Follow-up removed.');}catch(error){toast(error.message);}}
async function approveSuggestion(id){try{await api(`/api/memory-suggestions/${id}/approve`,{method:'POST'});await refresh();toast('Memory saved.');}catch(error){toast(error.message);}}
async function dismissSuggestion(id){try{await api(`/api/memory-suggestions/${id}/dismiss`,{method:'POST'});await refresh();toast('Suggestion dismissed.');}catch(error){toast(error.message);}}
async function beginConnector(provider){try{const result=await api(`/api/connectors/${provider}/begin`,{method:'POST'});location.href=result.url;}catch(error){toast(error.message);}}
async function disconnectConnector(provider){try{await api(`/api/connectors/${provider}`,{method:'DELETE'});await refresh();toast('Connector disconnected.');}catch(error){toast(error.message);}}
async function previewConnector(provider){try{const result=await api(`/api/connectors/${provider}/preview`);const items=(result.items||[]).slice(0,5);const summary=items.map((item)=>{const label=item.name||item.start||'Item';return item.from?`${label} — ${item.from.replace(/<.*>/,'').trim().slice(0,40)}`:label;}).join(' · ');toast(summary||'Connected, with no recent items.');}catch(error){toast(error.message);}}

function activateView(name,{updateHash=true}={}){if(name==='more')return true;const tab=document.querySelector(`.tab[data-view="${CSS.escape(name)}"]`);if(!tab)return false;$$('.tab').forEach((item)=>item.classList.toggle('active',item===tab));$$('.view').forEach((view)=>view.classList.toggle('active',view.id===name));if(updateHash&&location.hash!==`#${name}`)history.replaceState(null,'',`#${name}`);if(name==='today')requestAnimationFrame(()=>settleAtBottom($('#messages')));if(name==='today'&&state.user){loadBriefing();loadCatchupCard();}return true;}
$$('.tab').forEach((tab)=>{if(tab.dataset.view==='more')return;tab.addEventListener('click',()=>activateView(tab.dataset.view));});

// --- In-chat search UI (Q3) ---
// Wired to the existing GET /api/search/messages endpoint. One input, a
// results list, and tapping a result jumps to that message in its
// conversation. No server changes.
async function jumpToSearchResult(item){
  const resultsEl=$('#chat-search-results');
  if(resultsEl)resultsEl.classList.add('hidden');
  try{
    if(item.conversationId&&item.conversationId!==activeConversationId){
      activeConversationId=item.conversationId;
      try{localStorage.setItem('orbit-convo',item.conversationId);}catch(_){}
      await refresh();
    }
    const el=document.getElementById('msg-'+item.id);
    if(!el){toast('That message is outside the visible window of its conversation.');return;}
    el.scrollIntoView({block:'center',behavior:'smooth'});
    el.classList.add('search-hit');
    setTimeout(()=>el.classList.remove('search-hit'),2600);
  }catch(error){toast(error.message);}
}
(function initChatSearch(){
  const input=$('#chat-search-input'),resultsEl=$('#chat-search-results');
  if(!input||!resultsEl)return;
  // L4: search v2 filters — session-only (not persisted), hidden until needed.
  const filtersEl=$('#chat-search-filters'),toggleBtn=$('#chat-search-filters-toggle');
  const fromEl=$('#chat-search-from'),toEl=$('#chat-search-to'),convoEl=$('#chat-search-conversation');
  const typeBtns=filtersEl?Array.from(filtersEl.querySelectorAll('.search-type-btn')):[];
  const clearBtn=$('#chat-search-clear');
  const filters={from:'',to:'',conversationId:'',type:'all'};
  const hasActiveFilters=()=>!!(filters.from||filters.to||filters.conversationId||filters.type!=='all');
  let timer=null;
  const hide=()=>{resultsEl.classList.add('hidden');resultsEl.replaceChildren();};
  const conversationTitle=(id)=>{const c=(state.snapshot?.conversations||[]).find((x)=>x.id===id);return c?.title||'Conversation';};
  const formatWhen=(iso)=>{try{return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(iso));}catch(_){return'';}};
  function syncConversationOptions(){
    if(!convoEl)return;
    const keep=convoEl.value;
    convoEl.replaceChildren();
    const all=document.createElement('option');all.value='';all.textContent='All conversations';convoEl.append(all);
    for(const c of (state.snapshot?.conversations||[])){
      const o=document.createElement('option');o.value=c.id;o.textContent=c.title||'Conversation';convoEl.append(o);
    }
    if(keep&&[...convoEl.options].some((o)=>o.value===keep)){convoEl.value=keep;filters.conversationId=keep;}
  }
  function syncTypeButtons(){
    for(const b of typeBtns)b.classList.toggle('active',b.dataset.type===filters.type);
    if(toggleBtn)toggleBtn.classList.toggle('has-filters',hasActiveFilters());
  }
  function syncFilterInputs(){if(fromEl)fromEl.value=filters.from;if(toEl)toEl.value=filters.to;syncTypeButtons();}
  function clearFilters(silent){
    filters.from='';filters.to='';filters.conversationId='';filters.type='all';
    if(convoEl)convoEl.value='';
    syncFilterInputs();
    if(!silent&&input.value.trim().length>=2)run(input.value.trim());
  }
  function activeFilterLabels(){
    const labels=[];
    if(filters.from)labels.push(`from ${filters.from}`);
    if(filters.to)labels.push(`to ${filters.to}`);
    if(filters.conversationId)labels.push(`in “${conversationTitle(filters.conversationId)}”`);
    if(filters.type!=='all')labels.push(filters.type==='code'?'code only':'prose only');
    return labels;
  }
  function renderChips(){
    const labels=activeFilterLabels();
    if(!labels.length)return null;
    const row=document.createElement('div');row.className='search-filter-chips';
    for(const label of labels){
      const chip=document.createElement('span');chip.className='search-filter-chip';chip.textContent=label;row.append(chip);
    }
    const clear=document.createElement('button');clear.type='button';clear.className='search-filter-chip clear';clear.textContent='Clear filters';
    clear.addEventListener('click',()=>clearFilters());
    row.append(clear);
    return row;
  }
  async function run(query){
    let items=[];
    try{
      const p=new URLSearchParams({q:query});
      if(filters.from)p.set('from',filters.from);
      if(filters.to)p.set('to',filters.to);
      if(filters.conversationId)p.set('conversationId',filters.conversationId);
      if(filters.type!=='all')p.set('type',filters.type);
      const data=await api('/api/search/messages?'+p.toString());items=data.items||[];
    }
    catch(error){
      resultsEl.replaceChildren();
      const p=document.createElement('p');p.className='search-empty';p.textContent=error.message||'Search is unavailable right now.';
      resultsEl.append(p);resultsEl.classList.remove('hidden');return;
    }
    resultsEl.replaceChildren();
    const chips=renderChips();if(chips)resultsEl.append(chips);
    if(!items.length){
      const p=document.createElement('p');p.className='search-empty';p.textContent='No messages found.';
      resultsEl.append(p);
    }
    for(const item of items.slice(0,20)){
      const b=document.createElement('button');b.type='button';b.className='search-result';b.setAttribute('role','option');
      const title=document.createElement('strong');title.className='search-result-title';title.textContent=conversationTitle(item.conversationId);
      const meta=document.createElement('span');meta.className='search-result-meta';meta.textContent=`${item.role==='assistant'?'Orbit':'You'} · ${formatWhen(item.createdAt)}`;
      const excerpt=document.createElement('span');excerpt.className='search-result-excerpt';excerpt.textContent=item.excerpt;
      b.append(title,meta,excerpt);
      b.addEventListener('click',()=>jumpToSearchResult(item));
      resultsEl.append(b);
    }
    resultsEl.classList.remove('hidden');
  }
  input.addEventListener('input',()=>{clearTimeout(timer);const q=input.value.trim();if(q.length<2){hide();return;}timer=setTimeout(()=>run(q),350);});
  input.addEventListener('keydown',(event)=>{if(event.key==='Escape'){input.value='';hide();input.blur();}});
  input.addEventListener('focus',()=>{if(input.value.trim().length>=2&&resultsEl.children.length)resultsEl.classList.remove('hidden');});
  document.addEventListener('click',(event)=>{if(!event.target.closest('.chat-search')){hide();if(filtersEl)filtersEl.classList.add('hidden');if(toggleBtn)toggleBtn.setAttribute('aria-expanded','false');}});
  if(toggleBtn&&filtersEl){
    toggleBtn.addEventListener('click',(event)=>{
      event.stopPropagation();
      syncConversationOptions();
      const open=filtersEl.classList.toggle('hidden');
      toggleBtn.setAttribute('aria-expanded',String(!open));
    });
  }
  if(fromEl)fromEl.addEventListener('change',()=>{filters.from=fromEl.value||'';syncTypeButtons();if(input.value.trim().length>=2)run(input.value.trim());});
  if(toEl)toEl.addEventListener('change',()=>{filters.to=toEl.value||'';syncTypeButtons();if(input.value.trim().length>=2)run(input.value.trim());});
  if(convoEl)convoEl.addEventListener('change',()=>{filters.conversationId=convoEl.value||'';syncTypeButtons();if(input.value.trim().length>=2)run(input.value.trim());});
  for(const b of typeBtns)b.addEventListener('click',()=>{filters.type=b.dataset.type;syncTypeButtons();if(input.value.trim().length>=2)run(input.value.trim());});
  if(clearBtn)clearBtn.addEventListener('click',()=>clearFilters());
})();

// --- Tab bar triage (Q6) ---
// On narrow screens, low-traffic tabs (Reliability, Activity, Safety) move
// under a single "More" overflow; chat-adjacent tabs stay prominent.
// Pure DOM relocation + CSS — no feature changes.
(function initTabTriage(){
  const wrap=$('#more-wrap'),menu=$('#more-menu'),moreTab=document.querySelector('.more-tab');
  if(!wrap||!menu||!moreTab)return;
  const ORDER=['reliability','activity','safety'];
  const mq=window.matchMedia('(max-width: 760px)');
  const tabsNav=document.querySelector('.tabs');
  function closeMenu(){menu.classList.add('hidden');moreTab.setAttribute('aria-expanded','false');}
  function openMenu(){
    if(menu.parentElement!==document.body)document.body.appendChild(menu); // escape the sticky tab bar's stacking context
    const r=moreTab.getBoundingClientRect(); // position:fixed escapes the tabs' overflow:auto
    menu.style.top=(r.bottom+6)+'px';
    menu.style.right=Math.max(8,window.innerWidth-r.right)+'px';
    menu.classList.remove('hidden');
    moreTab.setAttribute('aria-expanded','true');
  }
  function placeTabs(){
    const narrow=mq.matches;
    for(const view of ORDER){
      const tab=document.querySelector(`.tab[data-view="${CSS.escape(view)}"]`);
      if(!tab)continue;
      if(narrow){if(tab.parentElement!==menu)menu.append(tab);}
      else if(tab.parentElement!==tabsNav)tabsNav.insertBefore(tab,wrap);
    }
    wrap.classList.toggle('hidden',!narrow);
    if(!narrow)closeMenu();
  }
  moreTab.addEventListener('click',(event)=>{event.stopPropagation();if(menu.classList.contains('hidden'))openMenu();else closeMenu();});
  menu.addEventListener('click',(event)=>{if(event.target.closest('.tab'))closeMenu();});
  document.addEventListener('click',(event)=>{if(!event.target.closest('#more-wrap')&&!event.target.closest('#more-menu'))closeMenu();});
  window.addEventListener('resize',closeMenu);
  if(mq.addEventListener)mq.addEventListener('change',placeTabs);else if(mq.addListener)mq.addListener(placeTabs);
  placeTabs();
})();
window.addEventListener('hashchange',()=>activateView(location.hash.slice(1),{updateHash:false}));
$('#model-check-button')?.addEventListener('click',checkModelConnection);
$('#auth-form').addEventListener('submit',async(event)=>{event.preventDefault();const mode=event.target.dataset.mode;try{if(mode==='forgot'){const response=await nativeFetch(API_BASE+'/api/auth/forgot-password',{method:'POST',credentials:NATIVE_CREDENTIALS,headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('#auth-email').value})});const body=await response.json();if(!response.ok)throw new Error(body.error);$('#auth-error').textContent='';$('#auth-copy').textContent='If that email has an account, a password reset link is on its way.';$('#auth-submit').disabled=true;return;}if(mode==='recover'){const response=await nativeFetch(API_BASE+'/api/auth/recover',{method:'POST',credentials:NATIVE_CREDENTIALS,headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('#auth-email').value,recoveryCode:$('#auth-recovery').value,newPassword:$('#auth-new-password').value})});const body=await response.json();if(!response.ok)throw new Error(body.error);showCodes(body.recoveryCodes);setAuthMode('login');return;}const endpoint=mode==='register'?'/api/auth/register':'/api/auth/login';const payload=mode==='register'?{email:$('#auth-email').value,password:$('#auth-password').value,displayName:$('#auth-name').value,...(state.signupVerificationToken?{verificationToken:state.signupVerificationToken}:{})}:{email:$('#auth-email').value,password:$('#auth-password').value};if(mode==='register'){payload.attestationProof=await signupAttestation(payload.email);if(state.appleSignupProof)payload.appleSignupProof=state.appleSignupProof;}const response=await nativeFetch(API_BASE+endpoint,{method:'POST',credentials:NATIVE_CREDENTIALS,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const body=await response.json();if(body.verificationRequired){state.signupVerificationToken=null;$('#auth-error').textContent='';$('#auth-copy').textContent=body.error;$('#auth-submit').disabled=body.verificationSent===true;return;}if(!response.ok)throw new Error(body.error);state.user=body.user;state.csrf=body.csrf;state.signupVerificationToken=null;state.appleSignupProof=null;if(body.sessionToken)setNativeToken(body.sessionToken);if(body.recoveryCodes)showCodes(body.recoveryCodes);if(mode==='register')state.justRegistered=true;await connect();}catch(error){$('#auth-error').textContent=error.message;}});
$('#show-login').addEventListener('click',()=>setAuthMode('login'));$('#show-register').addEventListener('click',()=>setAuthMode('register'));$('#show-recover').addEventListener('click',()=>setAuthMode('recover'));$('#show-forgot')?.addEventListener('click',()=>setAuthMode('forgot'));
$('#hero-signin')?.addEventListener('click',()=>{const d=$('#auth-dialog');if(d&&!d.open)d.showModal();});
$('#try-demo').addEventListener('click',async()=>{try{$('#try-demo').disabled=true;$('#try-demo').textContent='Loading demo...';const response=await nativeFetch(API_BASE+'/api/demo/start',{method:'POST',credentials:NATIVE_CREDENTIALS,headers:{'Content-Type':'application/json'}});const body=await response.json();if(!response.ok)throw new Error(body.error);state.user=body.user;state.csrf=body.csrf;state.isDemo=true;state.demoCap=body.demoCap;if(body.sessionToken)setNativeToken(body.sessionToken);await connect();showDemoBanner();}catch(error){toast(error.message||'Could not start demo.');$('#try-demo').disabled=false;$('#try-demo').textContent='Try the demo — no signup needed';}});
function showDemoBanner(){if($('#demo-banner'))return;const banner=document.createElement('div');banner.id='demo-banner';banner.style.cssText='background:#fff3cd;color:#856404;text-align:center;padding:10px;font-size:.9em;border-bottom:1px solid #ffeaa7;position:sticky;top:0;z-index:1000;';banner.innerHTML='🎪 <strong>DEMO MODE</strong> — exploring with sample data. <a href="#" id="demo-signup" style="color:#856404;font-weight:bold;">Create a free account</a> to save your stuff.';document.body.prepend(banner);$('#demo-signup').addEventListener('click',(e)=>{e.preventDefault();document.querySelector('[data-view="safety"]').click();toast('Demo is read-only for account creation — sign up from the login page!');});}
$('#close-codes').addEventListener('click',()=>$('#codes-dialog').close());$('#copy-codes').addEventListener('click',()=>navigator.clipboard.writeText($('#codes-output').textContent).then(()=>toast('Recovery codes copied.')));
$('#account-button').addEventListener('click',()=>document.querySelector('[data-view="safety"]').click());$('#logout-button').addEventListener('click',async()=>{try{clearGeoAsked(safeStorage());}catch(_){}try{await api('/api/auth/logout',{method:'POST'});}catch(_){}setNativeToken(null);location.reload();});
$('#delete-account-button')?.addEventListener('click',async()=>{
  const password=$('#delete-account-password')?.value||'';
  if(!password){toast('Enter your current password first.');return;}
  const confirmation=window.prompt('This permanently deletes your Orbit account and data. Type DELETE to continue.');
  if(confirmation!=='DELETE')return;
  if(!window.confirm('Delete this account permanently? This cannot be undone.'))return;
  const btn=$('#delete-account-button');btn.disabled=true;btn.textContent='Deleting…';
  try{
    await api('/api/account',{method:'DELETE',body:JSON.stringify({password,confirm:'DELETE'})});
    setNativeToken(null);
    try{localStorage.clear();sessionStorage.clear();}catch(_){}
    location.replace('/welcome.html');
  }catch(error){toast(error.message||'Account deletion failed.');btn.disabled=false;btn.textContent='Delete my account';}
});
// --- Offline message queue (Q5) ---
// Typed messages queue locally when the network drops and send automatically
// when connectivity returns — no error, no lost message, no extra UI.
const CHAT_QUEUE_KEY='orbit-chat-queue';
function loadChatQueue(){try{const q=JSON.parse(localStorage.getItem(CHAT_QUEUE_KEY));return Array.isArray(q)?q:[];}catch(_){return[];}}
function saveChatQueue(queue){try{localStorage.setItem(CHAT_QUEUE_KEY,JSON.stringify(queue));}catch(_){}}
function isNetworkError(error){return !navigator.onLine||/failed to fetch|load failed|network error|networkerror/i.test(String(error&&error.message||''));}
function markQueued(el){if(!el||el.classList.contains('queued'))return;el.classList.add('queued');const note=document.createElement('span');note.className='queued-note';note.textContent='queued — will send when online';el.append(note);}
function queueOfflineMessage(text,element){const queue=loadChatQueue();const entry={id:'q'+Date.now().toString(36)+Math.random().toString(36).slice(2,8),text,conversationId:activeConversationId,queuedAt:new Date().toISOString()};queue.push(entry);saveChatQueue(queue);markQueued(element||appendOptimisticMessage(text));}
let flushingQueue=false;
async function flushChatQueue(){
  if(flushingQueue)return;flushingQueue=true;
  try{
    let queue=loadChatQueue();
    while(queue.length){
      if(!navigator.onLine)break; // still offline — stop, keep the rest queued
      const entry=queue[0];
      try{
        const sent=await api('/api/chat',{method:'POST',body:JSON.stringify({message:entry.text,conversationId:entry.conversationId||activeConversationId})});
        pendingFor(sent.conversationId||entry.conversationId||activeConversationId).set(sent.id,Date.now());
      }catch(error){
        if(isNetworkError(error))break; // connection dropped mid-flush — retry later
        if(isPaywallError(error))showInlinePaywall(); // daily limit: inline nudge, never a generic toast
        else toast(`A queued message failed: ${error.message}`); // non-network error — drop this one
      }
      queue=queue.slice(1);saveChatQueue(queue);
    }
    await refresh().catch(()=>{});
  }finally{flushingQueue=false;}
}
window.addEventListener('online',()=>{flushChatQueue().catch(()=>{});});

// --- D1: image attachments ---
// The composer attach button (file picker incl. iPhone camera roll via
// accept="image/*"), clipboard paste, and drag-drop onto the composer all
// funnel here. Files upload immediately to POST /api/chat/attachments; the
// returned id rides along with the next /api/chat send and is consumed
// server-side in the same turn (single-use, expires after 10 minutes).
const pendingAttachments=[]; // {id, mimeType, file} — staged server-side; sent with the next chat turn
const MAX_ATTACH_BYTES=10*1024*1024;
async function uploadAttachment(file){
  if(!file||!String(file.type||'').startsWith('image/')){toast('Only image files can be attached.');return;}
  if(file.size>MAX_ATTACH_BYTES){toast('That image is too large (10MB max).');return;}
  const form=new FormData();form.append('image',file,file.name||'image');
  try{
    const data=await api('/api/chat/attachments',{method:'POST',body:form});
    pendingAttachments.push({id:data.id,mimeType:data.mimeType,file});
    renderAttachPreview();
  }catch(error){toast(error.message||'Could not upload that image.');}
}
function renderAttachPreview(){
  const root=$('#attach-preview');if(!root)return;
  root.replaceChildren();
  root.classList.toggle('hidden',!pendingAttachments.length);
  pendingAttachments.forEach((att,index)=>{
    const chip=document.createElement('div');chip.className='attach-chip';
    const remove=document.createElement('button');remove.type='button';remove.className='attach-remove';remove.textContent='✕';remove.setAttribute('aria-label','Remove attached image');
    remove.addEventListener('click',()=>{pendingAttachments.splice(index,1);renderAttachPreview();});
    // Thumbnail: decode the file and draw it into a small canvas. No URL
    // strings ever touch the DOM (no tainted-string sinks), the preview is
    // downscaled to thumbnail size, and iPhone EXIF orientation is honored.
    // Undecodable files fall back to a generic icon instead of failing.
    const canvas=document.createElement('canvas');canvas.width=144;canvas.height=144;canvas.className='attach-thumb';canvas.setAttribute('aria-label','Attached image');
    const draw=async()=>{
      try{
        const bitmap=await createImageBitmap(att.file,{imageOrientation:'from-image'});
        try{
          if(!bitmap.width||!bitmap.height)throw new Error('empty image');
          const ctx=canvas.getContext('2d');
          if(!ctx)throw new Error('no 2d context');
          const scale=Math.max(canvas.width/bitmap.width,canvas.height/bitmap.height);
          const w=bitmap.width*scale,h=bitmap.height*scale;
          ctx.drawImage(bitmap,(canvas.width-w)/2,(canvas.height-h)/2,w,h);
        }finally{bitmap.close();}
      }catch(_){
        const fallback=document.createElement('div');fallback.className='attach-thumb attach-thumb-fallback';fallback.textContent='🖼';
        canvas.replaceWith(fallback);
      }
    };
    draw();
    chip.append(canvas,remove);root.append(chip);
  });
  // X4: nudge the user to ask about the image they just captured/attached.
  const chatInput=$('#chat-input');
  if(chatInput)chatInput.placeholder=pendingAttachments.length?'Ask about this image…':(chatInput.dataset.defaultPlaceholder||chatInput.placeholder);
}
function clearAttachments(){pendingAttachments.length=0;renderAttachPreview();}
function acceptImageFiles(files){for(const file of(files||[]))uploadAttachment(file);}
// --- X4: Look at this (camera + screen capture) ---
// The attach button opens a small menu instead of going straight to the file
// picker: take a photo (native camera input on mobile, live getUserMedia
// preview on desktop), share the screen (desktop getDisplayMedia; the option
// is hidden where the API is unavailable, e.g. mobile web), or pick an image
// from the library. Captured frames are downscaled to a JPEG and uploaded
// through the same POST /api/chat/attachments endpoint D1 uses, so no second
// upload path exists. Camera/screen permissions are requested only when the
// action is tapped, never on load; denial gets a plain-language hint.
function buildAttachMenu(){
  const menu=$('#attach-menu');if(!menu)return;
  menu.replaceChildren();
  const canDisplayMedia=!!(navigator.mediaDevices&&navigator.mediaDevices.getDisplayMedia);
  const defs=[
    {icon:'📷',label:'Take photo',run:x4TakePhoto},
    {icon:'🖥️',label:'Share screen',run:x4ShareScreen,show:canDisplayMedia},
    {icon:'🖼️',label:'Choose from library',run:()=>{const p=$('#attach-picker');if(p)p.click();}},
  ];
  for(const def of defs){
    if(def.show===false)continue;
    const b=document.createElement('button');b.type='button';b.setAttribute('role','menuitem');
    b.append(def.icon+'  ',document.createTextNode(def.label));
    b.addEventListener('click',()=>{hideAttachMenu();def.run();});
    menu.append(b);
  }
}
function showAttachMenu(){
  const menu=$('#attach-menu');if(!menu)return;
  if(!menu.children.length)buildAttachMenu();
  if(!menu.children.length){const p=$('#attach-picker');if(p)p.click();return;}
  menu.classList.toggle('hidden');
  if(menu.classList.contains('hidden')){x4MenuTeardown();return;}
  setTimeout(()=>document.addEventListener('click',x4DocClick),0);
  document.addEventListener('keydown',x4MenuKey);
}
function hideAttachMenu(){const m=$('#attach-menu');if(m)m.classList.add('hidden');x4MenuTeardown();}
function x4MenuTeardown(){document.removeEventListener('click',x4DocClick);document.removeEventListener('keydown',x4MenuKey);}
function x4DocClick(event){const m=$('#attach-menu');if(m&&!m.contains(event.target)&&event.target.id!=='attach-button')hideAttachMenu();}
function x4MenuKey(event){if(event.key==='Escape')hideAttachMenu();}
function x4TakePhoto(){
  const coarse=window.matchMedia&&matchMedia('(pointer:coarse)').matches;
  const cameraPicker=$('#camera-picker');
  if(coarse&&cameraPicker){cameraPicker.click();return;} // native camera sheet on mobile
  x4CameraPreview(); // desktop: live preview with a capture button
}
function x4MediaHint(err,kind){
  const name=err&&err.name;
  if(name==='NotAllowedError'||name==='SecurityError')return `${kind} access was denied — allow it in your browser's site settings, then try again.`;
  if(name==='NotFoundError'||name==='OverconstrainedError')return `No ${kind.toLowerCase()} was found on this device.`;
  if(name==='NotReadableError')return `The ${kind.toLowerCase()} is busy in another app — close that and try again.`;
  return `Could not start the ${kind.toLowerCase()} — try again.`;
}
let x4CameraStream=null;
async function x4CameraPreview(){
  if(!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia)){toast('This browser cannot open the camera — use “Choose from library” instead.');return;}
  const overlay=document.createElement('div');
  overlay.className='camera-overlay';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-label','Take a photo');
  const video=document.createElement('video');video.className='camera-video';video.autoplay=true;video.playsInline=true;video.muted=true;
  const actions=document.createElement('div');actions.className='camera-actions';
  const cancel=document.createElement('button');cancel.type='button';cancel.className='ghost';cancel.textContent='Cancel';
  const capture=document.createElement('button');capture.type='button';capture.className='primary';capture.textContent='Capture';
  const hint=document.createElement('p');hint.className='camera-hint hidden';
  actions.append(cancel,capture);overlay.append(video,actions,hint);document.body.append(overlay);
  const close=()=>{if(x4CameraStream){x4CameraStream.getTracks().forEach((t)=>t.stop());x4CameraStream=null;}document.removeEventListener('keydown',onKey);overlay.remove();};
  const onKey=(event)=>{if(event.key==='Escape')close();};
  document.addEventListener('keydown',onKey);
  cancel.addEventListener('click',close);
  try{
    x4CameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});
  }catch(err){
    hint.textContent=x4MediaHint(err,'Camera');hint.classList.remove('hidden');capture.disabled=true;return;
  }
  video.srcObject=x4CameraStream;
  capture.addEventListener('click',async()=>{
    const file=await x4GrabFrame(video,'photo.jpg');
    close();
    if(file)uploadAttachment(file);else toast('Could not capture that photo — try again.');
  });
}
// Draw one frame from a live video element into a downscaled JPEG File.
// Caps the long edge at 1920px so captures stay well under the 10MB upload
// limit while keeping vision detail.
async function x4GrabFrame(video,name){
  try{
    const vw=video.videoWidth||0,vh=video.videoHeight||0;
    if(!vw||!vh)return null;
    const scale=Math.min(1,1920/Math.max(vw,vh));
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(vw*scale));canvas.height=Math.max(1,Math.round(vh*scale));
    const ctx=canvas.getContext('2d');if(!ctx)return null;
    ctx.drawImage(video,0,0,canvas.width,canvas.height);
    const blob=await new Promise((res)=>canvas.toBlob(res,'image/jpeg',0.92));
    if(!blob)return null;
    return new File([blob],name,{type:'image/jpeg'});
  }catch(_){return null;}
}
async function x4ShareScreen(){
  if(!(navigator.mediaDevices&&navigator.mediaDevices.getDisplayMedia)){toast('Screen sharing is not available on this device.');return;}
  let stream=null;
  try{stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});}
  catch(err){toast(x4MediaHint(err,'Screen sharing'));return;}
  const video=document.createElement('video');video.muted=true;video.playsInline=true;
  try{
    video.srcObject=stream;
    await video.play();
    const file=await x4GrabFrame(video,'screenshot.jpg');
    if(file)uploadAttachment(file);else toast('Could not capture that frame — try again.');
  }catch(_){toast('Could not capture that frame — try again.');}
  finally{if(stream)stream.getTracks().forEach((t)=>t.stop());}
}
// Attach affordance: quiet icon button (Orbit minimalism), picker, paste, drop.
(function(){
  const attachBtn=$('#attach-button'),picker=$('#attach-picker'),cameraPicker=$('#camera-picker'),input=$('#chat-input'),form=$('#chat-form');
  if(!attachBtn||!picker||!input||!form)return;
  input.dataset.defaultPlaceholder=input.placeholder||'';
  attachBtn.addEventListener('click',showAttachMenu);
  picker.addEventListener('change',()=>{acceptImageFiles(picker.files);picker.value='';});
  if(cameraPicker)cameraPicker.addEventListener('change',()=>{acceptImageFiles(cameraPicker.files);cameraPicker.value='';});
  input.addEventListener('paste',(event)=>{
    const files=[];const items=event.clipboardData&&event.clipboardData.items;
    if(items)for(const item of items)if(item.kind==='file'&&String(item.type||'').startsWith('image/')){const f=item.getAsFile();if(f)files.push(f);}
    if(files.length){event.preventDefault();acceptImageFiles(files);}
  });
  form.addEventListener('dragover',(event)=>{event.preventDefault();form.classList.add('dragging');});
  form.addEventListener('dragleave',()=>form.classList.remove('dragging'));
  form.addEventListener('drop',(event)=>{event.preventDefault();form.classList.remove('dragging');acceptImageFiles(event.dataTransfer&&event.dataTransfer.files);});
})();

// Shared send path: the composer submit handler and the B3 follow-up nudge
// ("Pick it up") both go through here.
async function postChatMessage(text,attachmentIds=[]){
  const message=String(text||'').trim();
  if(!message&&!attachmentIds.length)throw new Error('Nothing to send.');
  if(!navigator.onLine)throw Object.assign(new Error('offline'),{offline:true});
  const sent=await api('/api/chat',{method:'POST',body:JSON.stringify({message,attachmentIds,conversationId:activeConversationId})});
  const conversationId=sent.conversationId||activeConversationId;
  pendingFor(conversationId).set(sent.id,Date.now());
  await refresh();
  return {id:sent.id,conversationId};
}
async function waitForAssistantReply(conversationId,userMessageId,timeoutMs=180000){
  const start=Date.now();
  for(;;){
    let data=null;
    try{data=await api('/api/chat/stream-state?conversationId='+encodeURIComponent(conversationId));}catch(_){}
    if(data&&(data.state==='done'||data.state==='idle'))break;
    if(Date.now()-start>timeoutMs)break;
    await new Promise((resolve)=>setTimeout(resolve,1200));
  }
  await refresh();
  const msgs=(state.snapshot&&state.snapshot.messages)||[];
  const idx=msgs.findIndex((m)=>m.id===userMessageId);
  let reply='';
  for(let i=(idx===-1?0:idx+1);i<msgs.length;i++){
    if(msgs[i].role==='assistant'&&msgs[i].content)reply=msgs[i].content;
  }
  return reply;
}
// R1 voice mode: one spoken turn through the normal chat pipeline.
async function sendVoiceTurn(text){
  const sent=await postChatMessage(text);
  return waitForAssistantReply(sent.conversationId,sent.id);
}
async function transcribeAudio(blob){
  const bytes=new Uint8Array(await blob.arrayBuffer());
  let binary='';
  const CHUNK=0x8000;
  for(let i=0;i<bytes.length;i+=CHUNK)binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+CHUNK));
  const data=await api('/api/voice/transcribe',{method:'POST',body:JSON.stringify({audio:btoa(binary),mimeType:blob.type||'audio/webm'})});
  return String(data.text||'');
}
let voiceMode=null;
async function openVoiceMode(){
  // W7: the voice chunk loads when voice mode is first entered. The memoized
  // loader means a double-tap shares one fetch; the !voiceMode guard below
  // runs synchronously after the await, so the controller is built exactly once.
  let voiceModeApi;try{voiceModeApi=await loadVoiceMode();}catch(_){toast('Voice mode needs a connection to load.');return;}
  if(!voiceMode){
    voiceMode=voiceModeApi.createVoiceMode({buddyName:()=>state.status?.buddyName||'Orbit',sendTurn:sendVoiceTurn,transcribeAudio,isNative:()=>isNativeRuntime(window)});
    voiceMode.wire();
  }
  if(!voiceMode.isOpen())voiceMode.open();
}
// R2 Canvas: substantial assistant responses render as document panels
// instead of chat bubbles. Detection is automatic from the response shape.
function renderCanvasDoc(el,messageId,content,canvasApi){
  el.classList.add('canvas-doc');
  const head=document.createElement('header');head.className='canvas-head';
  const eyebrow=document.createElement('p');eyebrow.className='eyebrow';eyebrow.textContent='Document';
  const title=document.createElement('h3');title.textContent=canvasApi.canvasTitle(content);
  head.append(eyebrow,title);
  // L1 Canvas v2: a subtle history affordance — no permanent chrome beyond a
  // single icon. Opens the revisions sheet for this document.
  if(messageId&&canvasApi.lineDiff){
    const hist=document.createElement('button');hist.type='button';hist.className='canvas-history-btn';
    hist.textContent='🕘';hist.title='Revision history';hist.setAttribute('aria-label','Revision history');
    hist.addEventListener('click',(e)=>{e.stopPropagation();openCanvasRevisions(messageId,canvasApi,el);});
    head.append(hist);
  }
  const body=document.createElement('div');body.className='canvas-body';
  if(!renderAssistantMarkdown(body,content))body.textContent=content;
  el.append(head,body);
}
// L1 Canvas v2: refresh the canvas panel after a restore, marking which
// version is displayed.
function updateCanvasPanel(panelEl,content,canvasApi,restoredVersion){
  if(!panelEl)return;
  const head=panelEl.querySelector('.canvas-head');
  if(head){
    const t=head.querySelector('h3');if(t)t.textContent=canvasApi.canvasTitle(content);
    let note=head.querySelector('.canvas-restored-note');
    if(!note){note=document.createElement('p');note.className='canvas-restored-note';head.append(note);}
    note.textContent='Showing version '+restoredVersion+' (restored).';
  }
  const bodyEl=panelEl.querySelector('.canvas-body');
  if(bodyEl){bodyEl.replaceChildren();if(!renderAssistantMarkdown(bodyEl,content))bodyEl.textContent=content;}
}
// L1 Canvas v2: revision history sheet — version list, side-by-side diff,
// one-tap restore (inline confirm; restore is itself versioned server-side).
async function openCanvasRevisions(messageId,canvasApi,panelEl){
  const backdrop=document.createElement('div');backdrop.className='rev-sheet-backdrop';
  const sheet=document.createElement('div');sheet.className='rev-sheet';sheet.setAttribute('role','dialog');sheet.setAttribute('aria-label','Revision history');
  const head=document.createElement('div');head.className='rev-sheet-head';
  const h2=document.createElement('h2');h2.textContent='History';
  const close=button('×','rev-sheet-close',()=>backdrop.remove());close.setAttribute('aria-label','Close history');
  head.append(h2,close);
  const body=document.createElement('div');body.className='rev-sheet-body';
  sheet.append(head,body);backdrop.append(sheet);document.body.append(backdrop);
  backdrop.addEventListener('click',(e)=>{if(e.target===backdrop)backdrop.remove();});
  const onKey=(e)=>{if(e.key==='Escape'){backdrop.remove();document.removeEventListener('keydown',onKey);}};
  document.addEventListener('keydown',onKey);
  let data=null;
  async function loadList(){
    data=await api('/api/canvas/'+encodeURIComponent(messageId)+'/revisions');
  }
  function renderRevList(note){
    body.replaceChildren();
    if(note){const n=document.createElement('p');n.className='rev-note';n.textContent=note;body.append(n);}
    const cur=document.createElement('div');cur.className='rev-row current';
    const curL=document.createElement('div');const s=document.createElement('strong');s.textContent='Current version';
    const sm=document.createElement('small');sm.textContent=formatDate(data.current.created_at);curL.append(s,sm);
    const tag=document.createElement('span');tag.className='rev-tag';tag.textContent='current';
    cur.append(curL,tag);body.append(cur);
    for(const r of data.revisions){
      const row=document.createElement('button');row.type='button';row.className='rev-row';
      const l=document.createElement('div');const st=document.createElement('strong');st.textContent='Version '+r.version;
      const p=document.createElement('small');p.textContent=formatDate(r.created_at)+(r.preview?' — '+r.preview:'');l.append(st,p);
      row.append(l);
      row.addEventListener('click',()=>renderRevDetail(r));
      body.append(row);
    }
    if(!data.revisions.length){
      const p=document.createElement('p');p.className='muted';
      p.textContent='No earlier versions yet. Each revision of this document is kept here.';
      body.append(p);
    }
  }
  async function renderRevDetail(rev){
    body.replaceChildren();
    body.append(button('← All versions','rev-back',()=>renderRevList()));
    const title=document.createElement('h3');title.textContent='Version '+rev.version+' vs current';title.style.margin='0 0 4px';body.append(title);
    const sub=document.createElement('p');sub.className='muted';sub.textContent=formatDate(rev.created_at);body.append(sub);
    const loading=document.createElement('p');loading.className='muted';loading.textContent='Loading diff…';body.append(loading);
    let full;
    try{full=await api('/api/canvas/'+encodeURIComponent(messageId)+'/revisions/'+rev.version);}
    catch(e){loading.textContent='Could not load this version.';return;}
    loading.remove();
    const cols=document.createElement('div');cols.className='rev-diff-cols';
    const oldPane=document.createElement('div');oldPane.className='rev-diff-pane';
    const newPane=document.createElement('div');newPane.className='rev-diff-pane';
    const oh=document.createElement('h4');oh.textContent='Version '+rev.version;
    const nh=document.createElement('h4');nh.textContent='Current';
    oldPane.append(oh);newPane.append(nh);
    for(const op of canvasApi.lineDiff(full.content,data.current.content)){
      const left=document.createElement('div');left.className='diff-line';
      const right=document.createElement('div');right.className='diff-line';
      if(op.type==='del'){left.classList.add('diff-del');left.textContent=op.text;right.classList.add('blank');}
      else if(op.type==='add'){left.classList.add('blank');right.classList.add('diff-add');right.textContent=op.text;}
      else{left.classList.add('diff-same');right.classList.add('diff-same');left.textContent=op.text;right.textContent=op.text;}
      oldPane.append(left);newPane.append(right);
    }
    cols.append(oldPane,newPane);body.append(cols);
    const restoreBtn=button('Restore this version','rev-restore',()=>renderRestoreConfirm(rev,restoreBtn));
    body.append(restoreBtn);
  }
  function renderRestoreConfirm(rev,restoreBtn){
    const box=document.createElement('div');box.className='rev-restore-confirm';
    const nextVersion=data.revisions.reduce((m,r)=>Math.max(m,Number(r.version)||0),0)+1;
    const p=document.createElement('p');
    p.textContent='Restore version '+rev.version+'? Your current version will be kept as v'+nextVersion+'.';
    const actions=document.createElement('div');actions.className='actions';
    actions.append(button('Keep current','ghost',()=>{box.replaceWith(restoreBtn);}));
    const go=button('Restore','rev-restore',async()=>{
      go.disabled=true;go.textContent='Restoring…';
      try{
        const out=await api('/api/canvas/'+encodeURIComponent(messageId)+'/revisions/'+rev.version+'/restore',{method:'POST'});
        await loadList();
        updateCanvasPanel(panelEl,out.content,canvasApi,rev.version);
        renderRevList(out.keptAsVersion
          ?'Restored v'+rev.version+' — your previous version is kept as v'+out.keptAsVersion+'.'
          :'Already showing v'+rev.version+'.');
        toast('Version '+rev.version+' restored.');
      }catch(e){toast('Restore failed.');go.disabled=false;go.textContent='Restore';}
    });
    actions.append(go);box.append(p,actions);
    restoreBtn.replaceWith(box);
  }
  body.innerHTML='<p class="muted">Loading history…</p>';
  try{await loadList();renderRevList();}
  catch(e){body.replaceChildren();const p=document.createElement('p');p.className='error';p.textContent='Could not load history.';body.append(p);}
}
// R2 Canvas: "print this" / "share this" open the printable page for the
// latest canvas document in the active conversation.
async function openCanvasRender(){
  const canvasApi=await loadCanvas().catch(()=>null);
  const doc=canvasApi?canvasApi.findLatestCanvasMessage(state.snapshot&&state.snapshot.messages):null;
  if(!doc){toast('No document in this conversation yet — ask Orbit for a plan, itinerary, or comparison first.');return;}
  try{
    const res=await api('/api/canvas/render',{method:'POST',body:JSON.stringify({title:doc.title,markdown:doc.content})});
    if(res&&res.token)window.open(API_BASE+'/api/canvas/render/'+encodeURIComponent(res.token),'_blank','noopener');
    else toast('Could not prepare the document.');
  }catch(error){toast(error.message);}
}

// --- W3: conversation share/export ---
// Entry point is a chat command ("share this conversation" / "export this
// chat", optional "as markdown|pdf"), matching the established Canvas
// command pattern (isCanvasCommand / "print this" / "share this"). Rationale
// for the choice: the command already routes through sendChatMessage before
// anything hits the server, it's a hidden affordance (Orbit minimalism —
// no persistent buttons), it needs no pointing device, and it behaves
// identically on desktop and mobile. (Long-pressing a thread chip was the
// alternative; it would need a second gesture pipeline on both viewports.)
// Flow: choose format -> generate -> download (markdown) or print-preview
// (PDF). PDF reuses the Canvas print flow: the thread's markdown is minted
// as a short-lived /api/canvas/render and opened on the printable page,
// whose toolbar already offers Done / Share / PDF / Print.
const SHARE_CONVO_RE=/^(share|export|download)\s+(this|it|the)\s+(conversation|chat)(?:\s+(?:as\s+)?(markdown|md|pdf))?[\s.!?]*$/i;
function parseShareConversationCommand(text){
  const m=SHARE_CONVO_RE.exec(String(text||'').trim());
  if(!m)return null;
  const fmt=(m[4]||'').toLowerCase();
  return {format:fmt==='md'?'markdown':(fmt||null)};
}
function shareExportConversationId(){
  return activeConversationId||(state.snapshot&&state.snapshot.activeConversation&&state.snapshot.activeConversation.id)||null;
}
function shareExportTitle(convoId){
  const c=((state.snapshot&&state.snapshot.conversations)||[]).find((item)=>item.id===convoId);
  return (c&&c.title)||'Conversation';
}
function safeExportFilename(title){
  const t=String(title||'conversation').replace(/[^\w\-. ]+/g,'').trim().slice(0,60);
  return t||'conversation';
}
function openBlankWindow(){try{return window.open('about:blank','_blank','noopener');}catch(_){return null;}}
async function fetchConversationMarkdown(convoId){
  const response=await nativeFetch(API_BASE+`/api/chat/conversations/${encodeURIComponent(convoId)}/export?format=markdown`,{credentials:NATIVE_CREDENTIALS,headers:{...(state.csrf?{'X-Orbit-CSRF':state.csrf}:{})}});
  if(!response.ok){const err=await response.json().catch(()=>null);throw new Error((err&&err.error)||`Export failed (${response.status}).`);}
  return response.text();
}
async function downloadConversationMarkdown(convoId,title){
  // Download pattern mirrors the encrypted backup download (#export-backup).
  try{
    const response=await nativeFetch(API_BASE+`/api/chat/conversations/${encodeURIComponent(convoId)}/export?format=markdown`,{credentials:NATIVE_CREDENTIALS,headers:{...(state.csrf?{'X-Orbit-CSRF':state.csrf}:{})}});
    if(!response.ok){const err=await response.json().catch(()=>null);throw new Error((err&&err.error)||`Export failed (${response.status}).`);}
    const blob=await response.blob();
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');link.href=url;link.download=safeExportFilename(title)+'.md';
    document.body.append(link);link.click();link.remove();URL.revokeObjectURL(url);
    toast('Conversation downloaded.');
  }catch(error){toast(error.message);}
}
async function printPreviewConversation(convoId,title){
  // Opened synchronously (before any await) so popup blockers leave it alone.
  const popup=openBlankWindow();
  try{
    const markdown=await fetchConversationMarkdown(convoId);
    const res=await api('/api/canvas/render',{method:'POST',body:JSON.stringify({title:title||'Conversation',markdown})});
    if(!res||!res.token)throw new Error('Could not prepare the document.');
    const url=API_BASE+'/api/canvas/render/'+encodeURIComponent(res.token);
    if(popup)popup.location.href=url;else window.open(url,'_blank','noopener');
  }catch(error){if(popup){try{popup.close();}catch(_){}}toast(error.message);}
}
async function runShareExport(format){
  const convoId=shareExportConversationId();
  if(!convoId){toast('Open a conversation first.');return;}
  const title=shareExportTitle(convoId);
  if(format==='pdf')await printPreviewConversation(convoId,title);
  else await downloadConversationMarkdown(convoId,title);
}
function showSharePicker(){
  if($('#share-picker')||!$('#chat-form'))return;
  const card=document.createElement('div');card.id='share-picker';card.className='followup-nudge';
  const text=document.createElement('p');text.textContent='How do you want this conversation?';
  const actions=document.createElement('div');actions.className='mini-actions';
  actions.append(
    button('Markdown','primary',()=>{card.remove();runShareExport('markdown');}),
    button('PDF / Print','ghost',()=>{card.remove();runShareExport('pdf');}),
    button('Cancel','ghost',()=>card.remove())
  );
  card.append(text,actions);
  $('#chat-form').before(card);
}
function handleShareConversationCommand(cmd){
  if(cmd.format)runShareExport(cmd.format);
  else showSharePicker();
}
let sendInFlight=false; // sweep fix: blocks double-tap sends during chunk fetch
async function sendChatMessage(text){
  const input=$('#chat-input');
  const submit=document.querySelector('#chat-form button[type="submit"]');
  const message=String(text||'').trim();
  const attachmentIds=pendingAttachments.map((att)=>att.id);
  if(!message&&!attachmentIds.length){toast('Type a message or attach an image.');return;}
  if(!state.user){const d=$('#auth-dialog');if(d&&!d.open)d.showModal();toast('Sign in to chat with Orbit.');return;}
  // Guard against double-tap: chunk fetch latency below means the send path
  // is async before any submit state changes. Reset in finally.
  if(sendInFlight)return;
  sendInFlight=true;
  if(submit)submit.disabled=true;
  // W7: command matchers live in the lazily-loaded chunks — fetch both in
  // parallel once (memoized) so no command fails before its module loads. A
  // failed load (offline) falls through to the normal send path, preserving
  // the offline queue below.
  let voiceModeApi=null,canvasApi=null;
  try{[voiceModeApi,canvasApi]=await Promise.all([loadVoiceMode(),loadCanvas()]);}catch(_){}
  const releaseSend=()=>{sendInFlight=false;if(submit)submit.disabled=false;};
  if(voiceModeApi&&voiceModeApi.isVoiceModeCommand(message)){releaseSend();openVoiceMode();return;}
  if(canvasApi&&canvasApi.isCanvasCommand(message)){releaseSend();openCanvasRender();return;}
  const shareCmd=parseShareConversationCommand(message);
  if(shareCmd){releaseSend();handleShareConversationCommand(shareCmd);return;}
  try{
  if(!navigator.onLine){
    // The offline text queue can't carry staged images — keep the thumbnails
    // so the user can send once they're back online.
    if(attachmentIds.length)toast('Attachments need a connection — they’ll stay ready to send.');
    else queueOfflineMessage(message);
    if(submit)submit.disabled=false;return;
  }
  const el=appendOptimisticMessage(message||'[Image attached]');
  try{
    await postChatMessage(message,attachmentIds);
    clearAttachments(); // ids are single-use; drop thumbnails once the turn is accepted
  }catch(error){
    if(isNetworkError(error)){
      if(attachmentIds.length)toast('Connection lost — your image is staged and ready to resend.');
      else queueOfflineMessage(message,el);
    }
    // Daily free limit hit: inline paywall nudge in the conversation, never
    // the generic error toast. No refresh() here — it would re-render the
    // message list and wipe the nudge.
    else if(isPaywallError(error)){input.value=message;if(el)el.remove();showInlinePaywall(error.body&&error.body.quota);}
    else{input.value=message;if(el)el.remove();toast(error.message);await refresh();}
  }finally{if(submit)submit.disabled=false;}
  }finally{releaseSend();}
}
$('#chat-form').addEventListener('submit',(event)=>{event.preventDefault();const input=$('#chat-input');const text=input.value;input.value='';sendChatMessage(text);});
function appendOptimisticMessage(text){const root=$('#messages');if(!root)return null;const el=document.createElement('div');el.className='message user';el.dataset.optimistic='1';const body=document.createElement('span');body.textContent=text;el.append(body);root.append(el);scrollToBottom(root);return el;}

// Voice input via Web Speech API, plus R1 voice conversation mode ("call Orbit").
// Tap the mic: dictate into the composer (needs Web Speech API).
// Long-press the mic — or type "call Orbit" — for a full spoken conversation.
// Where Web Speech API is missing entirely, the mic opens voice mode directly
// (it falls back to server-side Whisper transcription).
(function(){
  const voiceBtn=$('#voice-button');
  const input=$('#chat-input');
  if(!voiceBtn||!input)return;
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  // Resolve the runtime again at tap time. The classifier also recognizes the
  // capacitor: scheme and iOS itself, so a missing/late bridge can never route
  // a native iPhone into its blocked Web Speech implementation.
  let longPressTimer=null,longPressFired=false;
  voiceBtn.addEventListener('pointerdown',()=>{
    longPressFired=false;
    clearTimeout(longPressTimer);
    longPressTimer=setTimeout(()=>{longPressFired=true;openVoiceMode();},650);
  });
  const cancelLongPress=()=>{clearTimeout(longPressTimer);longPressTimer=null;};
  voiceBtn.addEventListener('pointerup',cancelLongPress);
  voiceBtn.addEventListener('pointerleave',cancelLongPress);
  voiceBtn.addEventListener('pointercancel',cancelLongPress);
  voiceBtn.addEventListener('contextmenu',(event)=>event.preventDefault());
  if(!SR){
    voiceBtn.title='Voice conversation';
    voiceBtn.setAttribute('aria-label','Voice conversation');
    voiceBtn.addEventListener('click',()=>{if(longPressFired){longPressFired=false;return;}openVoiceMode();});
    return;
  }
  let recognizing=false;
  let recognition=null;
  voiceBtn.addEventListener('click',()=>{
    if(longPressFired){longPressFired=false;return;} // long-press already opened voice mode
    if(!shouldUseWebSpeech(window)){openVoiceMode();return;} // native/iOS: MediaRecorder + server transcription
    if(recognizing&&recognition){recognition.stop();return;}
    recognition=new SR();
    recognition.lang='en-US';
    recognition.interimResults=true;
    recognition.maxAlternatives=1;
    let finalTranscript='';
    recognition.onresult=(event)=>{
      let interim='';
      for(let i=event.resultIndex;i<event.results.length;i++){
        const transcript=event.results[i][0].transcript;
        if(event.results[i].isFinal)finalTranscript+=transcript+' ';
        else interim+=transcript;
      }
      input.value=(finalTranscript+interim).trim();
    };
    recognition.onend=()=>{recognizing=false;voiceBtn.textContent='🎤';voiceBtn.classList.remove('listening');};
    recognition.onerror=(event)=>{
      recognizing=false;voiceBtn.textContent='🎤';voiceBtn.classList.remove('listening');
      // Blocked speech service (iOS WKWebView): fall through to voice mode,
      // which falls back to tap-to-record + Whisper on its own.
      if(event.error==='service-not-allowed'||event.error==='not-allowed'){openVoiceMode();return;}
      if(event.error!=='aborted'&&event.error!=='no-speech')toast('Voice input: '+event.error);
    };
    recognition.start();
    recognizing=true;
    voiceBtn.textContent='🔴';
    voiceBtn.classList.add('listening');
  });
})();
$('#new-task-button').addEventListener('click',()=>$('#task-form').classList.remove('hidden'));$('#cancel-task').addEventListener('click',()=>$('#task-form').classList.add('hidden'));$('#task-form').addEventListener('submit',async(event)=>{event.preventDefault();try{const date=$('#task-date').value;await api('/api/tasks',{method:'POST',body:JSON.stringify({title:$('#task-title').value,prompt:$('#task-prompt').value,recurrence:$('#task-recurrence').value,risk:$('#task-risk').value,scheduleAt:date?new Date(date).toISOString():null})});event.target.reset();event.target.classList.add('hidden');await refresh();toast('Task created.');}catch(error){toast(error.message);}});
$('#new-goal-button').addEventListener('click',()=>$('#goal-form').classList.remove('hidden'));$('#cancel-goal').addEventListener('click',()=>$('#goal-form').classList.add('hidden'));$('#goal-form').addEventListener('submit',async(event)=>{event.preventDefault();try{await api('/api/goals',{method:'POST',body:JSON.stringify({title:$('#goal-title').value,description:$('#goal-description').value,targetDate:$('#goal-target').value||null,priority:Number($('#goal-priority').value),nextStep:$('#goal-next-step').value})});event.target.reset();$('#goal-priority').value='2';event.target.classList.add('hidden');await refresh();toast('Goal created.');}catch(error){toast(error.message);}});
$('#new-routine-button').addEventListener('click',()=>$('#routine-form').classList.remove('hidden'));$('#cancel-routine').addEventListener('click',()=>$('#routine-form').classList.add('hidden'));$('#routine-cadence').addEventListener('change',()=>$('#routine-day-label').classList.toggle('hidden',$('#routine-cadence').value!=='weekly'));$('#routine-form').addEventListener('submit',async(event)=>{event.preventDefault();try{await api('/api/routines',{method:'POST',body:JSON.stringify({title:$('#routine-title').value,prompt:$('#routine-prompt').value,kind:$('#routine-kind').value,cadence:$('#routine-cadence').value,timeLocal:$('#routine-time').value,dayOfWeek:Number($('#routine-day').value)})});event.target.reset();$('#routine-time').value='08:00';$('#routine-day-label').classList.add('hidden');event.target.classList.add('hidden');await refresh();toast('Routine created.');}catch(error){toast(error.message);}});
$('#new-project-button').addEventListener('click',()=>$('#project-form').classList.remove('hidden'));
// L2: projects view toggle (List | Kanban | Timeline) — quiet preference.
for(const toggle of document.querySelectorAll('#projects-view-toggle [data-projects-view]'))toggle.addEventListener('click',()=>setProjectsView(toggle.dataset.projectsView));
syncProjectsViewToggle();$('#cancel-project').addEventListener('click',()=>$('#project-form').classList.add('hidden'));$('#project-form').addEventListener('submit',async(event)=>{event.preventDefault();try{const steps=$('#project-steps').value.split('\n').map((title)=>title.trim()).filter(Boolean).map((title)=>({title}));await api('/api/projects',{method:'POST',body:JSON.stringify({title:$('#project-title').value,description:$('#project-description').value,priority:Number($('#project-priority').value),targetDate:$('#project-target').value||null,steps})});event.target.reset();$('#project-priority').value='2';event.target.classList.add('hidden');await refresh();toast('Project created.');}catch(error){toast(error.message);}});
$('#name-form').addEventListener('submit',async(event)=>{event.preventDefault();const name=$('#name-input').value.trim();if(!name)return;try{await api('/api/memories',{method:'POST',body:JSON.stringify({content:`My name is ${name}.`})});$('#name-dialog').close();await refresh();toast(`Nice to meet you, ${name}.`);}catch(error){toast(error.message);}});
$('#memory-form').addEventListener('submit',async(event)=>{event.preventDefault();try{await api('/api/memories',{method:'POST',body:JSON.stringify({content:$('#memory-input').value,kind:$('#memory-kind').value})});event.target.reset();await refresh();toast('Memory saved.');}catch(error){toast(error.message);}});
let importPollTimer=null;
async function pollImportStatus(){
  try{
    const {jobs}=await api('/api/import/status');
    const job=(jobs||[])[0];
    const el=$('#import-status');
    if(!el)return;
    if(!job){el.textContent='';return;}
    if(job.status==='processing'){
      const total=job.total_chunks||'?';
      el.textContent=`Analyzing… ${job.done_chunks}/${total} chunks, ${job.suggestions_added} suggestions so far.`;
    }else if(job.status==='done'){
      el.textContent=`Done — ${job.suggestions_added} suggestion${job.suggestions_added===1?'':'s'} ready for review below.`;
      if(importPollTimer){clearInterval(importPollTimer);importPollTimer=null;}
      await refresh();
    }else if(job.status==='failed'){
      el.textContent=`Import failed: ${job.error||'unknown error'}`;
      if(importPollTimer){clearInterval(importPollTimer);importPollTimer=null;}
    }
  }catch(_){}
}
$('#import-upload').addEventListener('click',async()=>{
  const input=$('#import-file');
  const file=input.files&&input.files[0];
  const el=$('#import-status');
  if(!file){toast('Choose a JSON export file first.');return;}
  if(file.size>10*1024*1024){toast('File is too large (10MB max).');return;}
  el.textContent='Reading file…';
  try{
    const text=await file.text();
    const data=JSON.parse(text);
    el.textContent='Uploading…';
    const res=await api('/api/import/conversations',{method:'POST',body:JSON.stringify({filename:file.name,data})});
    el.textContent=`Analyzing ${res.messages} messages…`;
    if(importPollTimer)clearInterval(importPollTimer);
    importPollTimer=setInterval(pollImportStatus,3000);
    pollImportStatus();
  }catch(error){el.textContent='';toast(error.message);}
});
$('#personal-date-form').addEventListener('submit',async(event)=>{event.preventDefault();const label=$('#pdate-label').value.trim();const month=Number($('#pdate-month').value);const day=Number($('#pdate-day').value);const yearRaw=$('#pdate-year').value.trim();const year=yearRaw?Number(yearRaw):null;if(!label){toast('A label is required.');return;}if(!(month>=1&&month<=12)){toast('Pick a valid month.');return;}if(!(day>=1&&day<=31)){toast('Day must be between 1 and 31.');return;}try{await api('/api/personal-dates',{method:'POST',body:JSON.stringify({label,month,day,year,type:$('#pdate-type').value,notes:$('#pdate-notes').value.trim()||null})});event.target.reset();await refresh();toast('Date saved.');}catch(error){toast(error.message);}});
$('#preferences-form').addEventListener('input',()=>{preferencesDirty=true;});$('#preferences-form').addEventListener('submit',async(event)=>{event.preventDefault();try{await api('/api/preferences',{method:'POST',body:JSON.stringify({timeZone:$('#preference-timezone').value,quietStart:$('#preference-quiet-start').value,quietEnd:$('#preference-quiet-end').value,proactiveEnabled:$('#preference-proactive').checked,briefingTone:$('#preference-briefing-tone').value,briefingLength:$('#preference-briefing-length').value})});preferencesDirty=false;await refresh();toast('Preferences saved.');}catch(error){toast(error.message);}});
// X5 "Writes like you": learn / toggle / forget controls in the Safety panel.
$('#writing-voice-learn').addEventListener('click',async()=>{const btn=$('#writing-voice-learn');btn.disabled=true;btn.textContent='Learning…';try{const result=await api('/api/writing-voice/learn',{method:'POST'});await refresh();toast(`Learned your writing voice from ${result.sampleCount} sent emails.`);}catch(error){toast(error.message);}finally{btn.disabled=false;btn.textContent='Learn how I write';}});
$('#writing-voice-optin').addEventListener('change',async(event)=>{try{await api('/api/writing-voice/opt-in',{method:'POST',body:JSON.stringify({optIn:event.target.checked})});await refresh();toast(event.target.checked?'Writing voice on for drafts.':'Writing voice off — your style is kept.');}catch(error){event.target.checked=!event.target.checked;toast(error.message);}});
$('#writing-voice-forget').addEventListener('click',async()=>{if(!confirm('Delete your learned writing voice? This also turns the feature off.'))return;try{await api('/api/writing-voice',{method:'DELETE'});await refresh();toast('Forgot how you write. It’s gone.');}catch(error){toast(error.message);}});
// B1: native iOS push via the Capacitor PushNotifications plugin, driven
// through the low-level window.Capacitor bridge APIs (no bundler needed):
// nativePromise('PushNotifications', method) for calls and
// addListener('PushNotifications', event, cb) for the registration event.
const APNS_REGISTERED_KEY='orbit_apns_registered';
let nativePushListenersAttached=false;
function capPushPlugin(){
  const cap=window.Capacitor;
  if(!cap||typeof cap.isPluginAvailable!=='function')return null;
  try{return cap.isPluginAvailable('PushNotifications')?cap:null;}catch(_){return null;}
}
async function waitForNativePushPlugin(timeoutMs=8000){
  const deadline=Date.now()+timeoutMs;
  do{
    const cap=capPushPlugin();
    if(cap)return cap;
    await new Promise((resolve)=>setTimeout(resolve,200));
  }while(Date.now()<deadline);
  return null;
}
function apnsRegistered(){try{return localStorage.getItem(APNS_REGISTERED_KEY)==='1';}catch(_){return false;}}
async function postApnsToken(token,verifyDelivery=false){
  await api('/api/push/token',{method:'POST',body:JSON.stringify({token,verifyDelivery})});
  try{localStorage.setItem(APNS_REGISTERED_KEY,'1');}catch(_){}
}
let pushRegistrationPending=false;
function attachNativePushListeners(){
  const cap=capPushPlugin();
  if(!cap||nativePushListenersAttached)return;
  nativePushListenersAttached=true;
  cap.addListener('PushNotifications','registration',(info)=>{
    const verifyDelivery=pushRegistrationPending;
    pushRegistrationPending=false;
    const token=info&&info.value;
    if(!token||typeof token!=='string'){toast('Push setup failed: no device token from Apple.');return;}
    postApnsToken(token,verifyDelivery).then(()=>{toast(verifyDelivery?'Push notifications enabled — test sent.':'Push notifications enabled.');updatePushButton();}).catch((error)=>{try{localStorage.removeItem(APNS_REGISTERED_KEY);}catch(_){}toast('Push setup failed: '+(error&&error.message||error));updatePushButton();});
  });
  cap.addListener('PushNotifications','registrationError',(info)=>{pushRegistrationPending=false;toast('Push registration failed: '+((info&&info.error)||'unknown error'));});
  cap.addListener('PushNotifications','pushNotificationReceived',(notification)=>{const title=notification&&notification.title;toast(title?`Notification received: ${title}`:'Notification received from Orbit.');});
}
async function setupNativePush(){
  // Physical iPhones can load app.js before Capacitor has finished exposing
  // native plugins. Wait for the bridge, and only register after connect()
  // has restored the authenticated bearer token used by postApnsToken().
  const cap=await waitForNativePushPlugin();
  if(!cap)return;
  attachNativePushListeners();
  try{
    const perm=await cap.nativePromise('PushNotifications','checkPermissions',{});
    // Re-register on launch when already allowed: refreshes the APNs device
    // token, and the registration listener uploads it to the server.
    if(perm&&perm.receive==='granted')await cap.nativePromise('PushNotifications','register',{});
  }catch(error){toast('Notification setup needs attention: '+(error&&error.message||error));updatePushButton();}
}
async function updatePushButton(){const btn=$('#enable-push');if(!btn)return;try{
if(isNativeRuntime(window)){
const cap=await waitForNativePushPlugin(1500);
if(!cap){btn.disabled=false;btn.textContent='Retry notification setup';btn.classList.add('primary');return;}
let permission='prompt';
try{const perm=await cap.nativePromise('PushNotifications','checkPermissions',{});permission=(perm&&perm.receive)||'prompt';}catch(_){}
if(permission==='granted'&&apnsRegistered()){btn.disabled=false;btn.textContent='Send test notification';btn.classList.add('primary');}
else{btn.disabled=false;btn.textContent='Enable on this device';btn.classList.add('primary');}
return;
}
if(!('serviceWorker'in navigator)||!('PushManager'in window)){btn.disabled=true;btn.textContent='Not supported on this device';return;}const registration=await navigator.serviceWorker.ready;const subscription=await registration.pushManager.getSubscription();if(subscription){btn.disabled=true;btn.textContent='Notifications enabled';btn.classList.remove('primary');}else{btn.disabled=false;btn.textContent='Enable on this device';btn.classList.add('primary');}}catch{}}
$('#enable-push').addEventListener('click',async()=>{try{
if(isNativeRuntime(window)){
const cap=await waitForNativePushPlugin();
if(!cap)throw new Error('The iPhone notification bridge did not load. Close and reopen Orbit, then try again.');
attachNativePushListeners();
const perm=await cap.nativePromise('PushNotifications','requestPermissions',{});
if(!perm||perm.receive!=='granted')throw new Error('Notification permission was not granted.');
pushRegistrationPending=true;
await cap.nativePromise('PushNotifications','register',{});
setTimeout(()=>{if(pushRegistrationPending){pushRegistrationPending=false;toast('Push setup timed out: no response from Apple. Check the build includes the Push Notifications capability, then try again.');}},12000);
updatePushButton();return;
}
if(!('serviceWorker'in navigator)||!('PushManager'in window))throw new Error('Push is not supported on this browser.');const key=await api('/api/push/public-key');if(!key.configured)throw new Error('Push keys are not configured on the server.');const permission=await Notification.requestPermission();if(permission!=='granted')throw new Error('Notification permission was not granted.');const registration=await navigator.serviceWorker.ready;const bytes=Uint8Array.from(atob(key.publicKey.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));const subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});await api('/api/push/subscribe',{method:'POST',body:JSON.stringify(subscription)});toast('Push notifications enabled.');updatePushButton();}catch(error){toast(error.message);}});
updatePushButton();
// --- Subscriptions: StoreKit 2 via the native iOS plugin ---
// Same bridge pattern as native push above: low-level window.Capacitor APIs,
// nativePromise('StoreKit', method) for calls and addListener('StoreKit',
// event, cb) for transaction updates. Everything here is gated behind
// storeKitAvailable() so web/desktop never touch the plugin. Server
// confirmation (POST /api/subscriptions/verify) is the purchase record —
// the JWS (signedTransaction) is sent to the server and never logged.
function capStoreKitPlugin(){
  const cap=window.Capacitor;
  if(!cap||typeof cap.isPluginAvailable!=='function')return null;
  try{return cap.isPluginAvailable('StoreKit')?cap:null;}catch(_){return null;}
}
function storeKitAvailable(){return isNativeRuntime(window)&&!!capStoreKitPlugin();}
// Static fallback catalog mirroring src/subscriptions.js PRODUCTS, used when
// the native product lookup fails or returns nothing. Server truth lives in
// /api/subscriptions/status; these are display-only fallbacks.
const SUB_PRODUCT_FALLBACK=[
  {id:'com.smokeys30.orbitbuddy.basic.monthly',title:'Basic Monthly',fallbackPrice:'$2.99/month'},
  {id:'com.smokeys30.orbitbuddy.standard.monthly',title:'Plus Monthly',fallbackPrice:'$5.99/month'},
  {id:'com.smokeys30.orbitbuddy.standard.yearly',title:'Plus Yearly',fallbackPrice:'$59.99/year'},
  {id:'com.smokeys30.orbitbuddy.pro.monthly',title:'Unlimited Monthly',fallbackPrice:'$19.99/month'},
];
const MEMBERSHIP_PLANS=[
  {id:'basic',name:'Basic',kicker:'More room for everyday conversations',summary:'A low-cost step up when 25 included messages are not enough.',productIds:['com.smokeys30.orbitbuddy.basic.monthly'],benefits:['100 messages every day','Memory across conversations','Voice conversations','Goals, reminders, and routines','Secure sync across devices']},
  {id:'plus',name:'Plus',kicker:'Your everyday Orbit, without limits',summary:'Unlimited conversations and the complete everyday Orbit experience.',badge:'Most popular',productIds:['com.smokeys30.orbitbuddy.standard.monthly','com.smokeys30.orbitbuddy.standard.yearly'],benefits:['Unlimited conversations','Persistent memory and history','Goals, reminders, and routines','Voice conversations','Secure sync across devices']},
  {id:'unlimited',name:'Unlimited',kicker:'Orbit at its most capable',summary:'The strongest model and longest live context for demanding work.',productIds:['com.smokeys30.orbitbuddy.pro.monthly'],benefits:['Everything in Plus','Strongest AI model for every message','Longer live conversation context','Expanded response capacity','Built for complex projects']},
];
function formatStoreKitPrice(p){
  const n=Number(p&&p.price);
  if(Number.isFinite(n)){try{return new Intl.NumberFormat(undefined,{style:'currency',currency:p.currencyCode||'USD'}).format(n);}catch(_){}}
  return String(p.price);
}
function productPriceLine(p){
  const price=(p.price!=null)?formatStoreKitPrice(p):(p.fallbackPrice||null);
  return price?(p.title+' — '+price):p.title;
}
function appendSubscriptionDisclosure(root){
  if(!root||root.querySelector('.subscription-disclosure'))return;
  const disclosure=document.createElement('div');disclosure.className='subscription-disclosure';
  const renewal=document.createElement('p');renewal.textContent='Payment is charged to your Apple ID at confirmation. Subscriptions renew automatically unless canceled at least 24 hours before the current period ends.';
  const links=document.createElement('p');
  for(const [label,href] of [
    ['Manage subscriptions','https://apps.apple.com/account/subscriptions'],
    ['Terms','https://orbitbuddy.app/terms'],
    ['Privacy','https://orbitbuddy.app/privacy'],
  ]){
    if(links.childNodes.length)links.append(document.createTextNode(' · '));
    const link=document.createElement('a');link.textContent=label;link.href=href;link.target='_blank';link.rel='noopener';links.append(link);
  }
  disclosure.append(renewal,links);root.append(disclosure);
}
function fallbackStoreKitProducts(){
  return SUB_PRODUCT_FALLBACK.map((p)=>({id:p.id,title:p.title,description:'',price:null,currencyCode:null,fallbackPrice:p.fallbackPrice}));
}
function membershipPlan(planId){return MEMBERSHIP_PLANS.find((plan)=>plan.id===planId)||null;}
function membershipProductsFor(plan,products){return plan.productIds.map((id)=>products.find((p)=>p.id===id)||SUB_PRODUCT_FALLBACK.find((p)=>p.id===id)).filter(Boolean);}
function membershipPrice(product){
  if(!product)return '';
  const price=product.price!=null?formatStoreKitPrice(product):String(product.fallbackPrice||'');
  return price.replace('/month',' / month').replace('/year',' / year');
}
function orbitMembershipMark(){
  const mark=document.createElement('span');mark.className='membership-orbit-mark';mark.setAttribute('aria-hidden','true');mark.append(document.createElement('span'));return mark;
}
function membershipButton(label,className,onClick){
  const el=document.createElement('button');el.type='button';el.className=className;el.textContent=label;el.addEventListener('click',onClick);return el;
}
let membershipReturnFocus=null;
function closeMembershipExperience(){
  const overlay=$('#membership-experience');if(!overlay)return;
  overlay.remove();document.body.classList.remove('membership-open');
  document.removeEventListener('keydown',membershipEscapeHandler);
  if(membershipReturnFocus&&typeof membershipReturnFocus.focus==='function')membershipReturnFocus.focus();
  membershipReturnFocus=null;
}
function membershipEscapeHandler(event){if(event.key==='Escape')closeMembershipExperience();}
function membershipHeader({detail=false}={}){
  const header=document.createElement('header');header.className='membership-header';
  header.append(membershipButton(detail?'Back':'Close','membership-back',detail?()=>renderMembershipExperience('chooser'):closeMembershipExperience));
  const brand=document.createElement('div');brand.className='membership-brand';brand.append(orbitMembershipMark());
  const label=document.createElement('span');label.textContent='ORBIT BUDDY';brand.append(label);header.append(brand);
  const spacer=document.createElement('span');spacer.className='membership-header-spacer';spacer.setAttribute('aria-hidden','true');header.append(spacer);
  return header;
}
function membershipFooter(root){
  const restore=membershipButton('Restore purchases','membership-link',restorePurchases);root.append(restore);appendSubscriptionDisclosure(root);
}
function renderMembershipChooser(shell,products){
  shell.append(membershipHeader());
  const intro=document.createElement('div');intro.className='membership-intro';
  const eyebrow=document.createElement('p');eyebrow.className='membership-eyebrow';eyebrow.textContent='MEMBERSHIPS';
  const title=document.createElement('h1');title.textContent='Choose your Orbit';
  const copy=document.createElement('p');copy.textContent='Pick the level that fits how you want Orbit beside you. Every choice stays private and secure.';
  intro.append(eyebrow,title,copy);shell.append(intro);
  const grid=document.createElement('div');grid.className='membership-grid';
  for(const plan of MEMBERSHIP_PLANS){
    const card=document.createElement('button');card.type='button';card.className=`membership-choice membership-choice-${plan.id}`;card.addEventListener('click',()=>renderMembershipExperience(plan.id));
    const top=document.createElement('span');top.className='membership-choice-top';
    const name=document.createElement('strong');name.textContent=plan.name;top.append(name);
    if(plan.badge){const badge=document.createElement('span');badge.className='membership-badge';badge.textContent=plan.badge;top.append(badge);}
    const summary=document.createElement('span');summary.className='membership-choice-summary';summary.textContent=plan.summary;
    const prices=membershipProductsFor(plan,products);const price=document.createElement('span');price.className='membership-choice-price';
    price.textContent=plan.id==='plus'?`From ${membershipPrice(prices[0])}`:membershipPrice(prices[0]);
    const arrow=document.createElement('span');arrow.className='membership-choice-arrow';arrow.textContent='View details →';
    card.append(top,summary,price,arrow);grid.append(card);
  }
  shell.append(grid);
  const note=document.createElement('p');note.className='membership-included-note';note.textContent='Every account includes 25 messages each day before a paid membership is needed.';shell.append(note);
  membershipFooter(shell);
}
function renderMembershipDetail(shell,plan,products){
  shell.append(membershipHeader({detail:true}));
  const hero=document.createElement('div');hero.className='membership-detail-hero';hero.append(orbitMembershipMark());
  const eyebrow=document.createElement('p');eyebrow.className='membership-eyebrow';eyebrow.textContent='ORBIT BUDDY';
  const title=document.createElement('h1');title.textContent=plan.name;
  const kicker=document.createElement('p');kicker.className='membership-kicker';kicker.textContent=plan.kicker;
  hero.append(eyebrow,title,kicker);shell.append(hero);
  const available=membershipProductsFor(plan,products);let selected=available[0]||null;
  const price=document.createElement('p');price.className='membership-detail-price';price.textContent=membershipPrice(selected);shell.append(price);
  let choiceRow=null;
  if(available.length>1){
    choiceRow=document.createElement('div');choiceRow.className='membership-billing';choiceRow.setAttribute('role','group');choiceRow.setAttribute('aria-label','Billing period');
    const syncSelection=()=>{
      for(const child of choiceRow.children)child.classList.toggle('selected',child.dataset.productId===selected.id);
      price.textContent=membershipPrice(selected);
    };
    for(const product of available){
      const isYear=product.id.endsWith('.yearly');const option=membershipButton(isYear?'Yearly · save $11.89':'Monthly','membership-billing-option',()=>{selected=product;syncSelection();});option.dataset.productId=product.id;choiceRow.append(option);
    }
    shell.append(choiceRow);syncSelection();
  }
  const benefits=document.createElement('ul');benefits.className='membership-benefits';
  for(const item of plan.benefits){const row=document.createElement('li');const check=document.createElement('span');check.textContent='✓';const text=document.createElement('span');text.textContent=item;row.append(check,text);benefits.append(row);}shell.append(benefits);
  const choose=membershipButton(`Choose ${plan.name}`,'membership-choose',()=>{if(selected)purchaseProduct(selected.id);});
  if(!storeKitAvailable()){choose.textContent='Open Orbit on iPhone to subscribe';choose.disabled=true;}
  shell.append(choose,membershipButton('Compare all memberships','membership-link',()=>renderMembershipExperience('chooser')));
  membershipFooter(shell);
}
async function renderMembershipExperience(view='chooser'){
  const overlay=$('#membership-experience');if(!overlay)return;
  const shell=document.createElement('section');shell.className='membership-shell';shell.setAttribute('aria-live','polite');
  const loading=document.createElement('p');loading.className='membership-loading';loading.textContent='Loading memberships…';shell.append(loading);overlay.replaceChildren(shell);
  let products=fallbackStoreKitProducts();
  if(storeKitAvailable()){try{products=await loadStoreKitProducts();}catch(_){/* Apple prices can retry at purchase time; keep the known catalog visible. */}}
  shell.replaceChildren();
  const plan=membershipPlan(view);
  if(plan)renderMembershipDetail(shell,plan,products);else renderMembershipChooser(shell,products);
  const focusTarget=shell.querySelector('button');if(focusTarget)focusTarget.focus();
}
function openMembershipExperience(planId='chooser'){
  let overlay=$('#membership-experience');
  if(!overlay){
    membershipReturnFocus=document.activeElement;
    overlay=document.createElement('div');overlay.id='membership-experience';overlay.className='membership-experience';overlay.setAttribute('role','region');overlay.setAttribute('aria-label','Orbit Buddy memberships');document.body.append(overlay);
    document.body.classList.add('membership-open');document.addEventListener('keydown',membershipEscapeHandler);
  }
  renderMembershipExperience(planId);
}
let subProductsCache=null,subProductsPromise=null;
const STOREKIT_PENDING_KEY='orbit_storekit_pending_v1';
function setPendingStoreKitPurchase(value){try{if(value)localStorage.setItem(STOREKIT_PENDING_KEY,JSON.stringify(value));else localStorage.removeItem(STOREKIT_PENDING_KEY);}catch(_){}}
function pendingStoreKitPurchase(){try{return JSON.parse(localStorage.getItem(STOREKIT_PENDING_KEY)||'null');}catch(_){return null;}}
async function loadStoreKitProducts(){
  if(!storeKitAvailable())throw new Error('Subscriptions are managed in the Orbit iOS app.');
  if(subProductsCache)return subProductsCache;
  if(subProductsPromise)return subProductsPromise;
  subProductsPromise=(async()=>{
    const status=await api('/api/subscriptions/status');
    const ids=(status&&status.products)||[];
    const nativeById={};
    try{
      const cap=capStoreKitPlugin();
      const res=await cap.nativePromise('StoreKit','getProducts',{productIds:ids});
      for(const p of((res&&res.products)||[]))nativeById[p.id]=p;
    }catch(_){/* fall through to the static fallback catalog */}
    const catalog=(ids.length?ids:SUB_PRODUCT_FALLBACK.map((f)=>f.id)).map((id)=>{
      const n=nativeById[id]||{};
      const fb=SUB_PRODUCT_FALLBACK.find((f)=>f.id===id)||{};
      return {id,title:n.title||fb.title||id,description:n.description||'',
        price:(n.price!=null?n.price:null),currencyCode:n.currencyCode||null,
        fallbackPrice:fb.fallbackPrice||null};
    });
    subProductsCache=catalog;
    return catalog;
  })();
  try{return await subProductsPromise;}catch(error){subProductsPromise=null;throw error;}
}
async function refreshSubscriptionState(){
  try{const status=await api('/api/subscriptions/status');state.subscription=status&&status.entitlement||null;}catch(_){}
}
async function purchaseProduct(productId){
  if(!storeKitAvailable()){toast('Subscriptions are managed in the Orbit iOS app.');return;}
  try{
    const status=await api('/api/subscriptions/status');
    if(!(status&&status.ready))throw new Error('Subscriptions aren’t ready yet — please try again in a moment.');
    // The server creates (or reuses) the account UUID and records the exact
    // product before StoreKit starts. The client cannot choose another user's
    // binding token.
    const intent=await api('/api/subscriptions/purchase-intent',{method:'POST',body:JSON.stringify({productId})});
    const appAccountToken=intent&&intent.appAccountToken;
    if(!appAccountToken)throw new Error('The server could not prepare this purchase.');
    setPendingStoreKitPurchase({appAccountToken,productId,expiresAt:intent.expiresAt});
    const cap=capStoreKitPlugin();
    let result;
    try{result=await cap.nativePromise('StoreKit','purchase',{productId,appAccountToken});}
    catch(err){if(err&&err.code==='cancelled'){setPendingStoreKitPurchase(null);toast('Purchase cancelled.');return;}throw err;}
    if(result&&result.pending){toast('Waiting for approval — finish the purchase in the App Store to unlock unlimited chat.');return;}
    const signedTransaction=result&&result.signedTransaction;
    if(!signedTransaction)throw new Error('The App Store didn’t return a transaction. Please try again.');
    // Never log the signedTransaction or any JWS payload — only the outcome.
    const verified=await api('/api/subscriptions/verify',{method:'POST',body:JSON.stringify({signedTransaction,appAccountToken,productId})});
    if(!(verified&&verified.ok))throw new Error('The App Store couldn’t confirm that purchase. If you were charged, tap Restore purchases.');
    // Acknowledge only after the server has cryptographically verified and
    // persisted the entitlement. If this fails, StoreKit keeps it unfinished
    // and the transaction listener retries later.
    await cap.nativePromise('StoreKit','finish',{transactionId:verified.transactionId});
    setPendingStoreKitPurchase(null);
    await refreshSubscriptionState();
    closeMembershipExperience();
    toast('Your Orbit membership is active — enjoy.');
  }catch(error){toast(error.message||'Purchase failed. Please try again.');}
}
async function restorePurchases(){
  if(!storeKitAvailable()){toast('Subscriptions are managed in the Orbit iOS app.');return;}
  try{
    const cap=capStoreKitPlugin();
    const restored=await cap.nativePromise('StoreKit','restore',{});
    const txns=(restored&&restored.transactions)||[];
    if(!txns.length){toast('No past purchases found on this Apple ID.');return;}
    let confirmed=0;
    for(const t of txns){
      const signedTransaction=t&&t.signedTransaction;
      if(!signedTransaction)continue; // never logged
      try{const v=await api('/api/subscriptions/verify',{method:'POST',body:JSON.stringify({signedTransaction})});if(v&&v.ok){await cap.nativePromise('StoreKit','finish',{transactionId:v.transactionId});confirmed++;}}
      catch(_){/* one unverifiable receipt must not kill the batch */}
    }
    if(confirmed){await refreshSubscriptionState();closeMembershipExperience();toast('Your Orbit membership is restored.');}
    else toast('Couldn’t restore any purchases. If you bought Orbit in the App Store, try again.');
  }catch(error){toast(error.message||'Restore failed. Please try again.');}
}
let storeKitListenerAttached=false;
function attachStoreKitListener(){
  const cap=capStoreKitPlugin();
  if(!cap||storeKitListenerAttached)return;
  storeKitListenerAttached=true;
  // Handles renewals: any transaction the App Store surfaces later is
  // re-verified with the server, which keeps the entitlement current.
  cap.addListener('StoreKit','transactionUpdated',async(info)=>{
    const signedTransaction=info&&info.signedTransaction;
    if(!signedTransaction)return; // never logged
    const pending=pendingStoreKitPurchase();
    const binding=pending&&pending.productId===info.productId?{appAccountToken:pending.appAccountToken,productId:pending.productId}:{};
    try{const v=await api('/api/subscriptions/verify',{method:'POST',body:JSON.stringify({signedTransaction,...binding})});if(v&&v.ok){await cap.nativePromise('StoreKit','finish',{transactionId:v.transactionId});if(binding.appAccountToken)setPendingStoreKitPurchase(null);await refreshSubscriptionState();}}
    catch(error){console.warn('[storekit] renewal verify failed',error&&error.message);}
  });
}
// 402 + paywall:true from POST /api/chat: the daily free limit is hit.
function isPaywallError(error){return !!(error&&error.status===402&&error.body&&error.body.paywall===true);}
// Keep a return point in the conversation, then transition to the dedicated
// full-screen membership experience. The screen is an app page (with Close
// and Back navigation), not a blocking system alert.
function showInlinePaywall(quota=null){
  const root=$('#messages');if(!root)return;
  if(root.querySelector('.message.paywall-nudge')){scrollToBottom(root);openMembershipExperience();return;}
  const el=document.createElement('div');el.className='message assistant paywall-nudge';
  const isBasic=quota&&quota.plan==='basic';
  const title=document.createElement('p');title.className='paywall-title';title.textContent=isBasic?'You’ve used today’s Basic messages':'Today’s included messages are used';
  const copy=document.createElement('p');copy.textContent='Choose a membership to keep the conversation going. Your messages reset at midnight Eastern.';
  const actions=document.createElement('div');actions.className='mini-actions';actions.append(button('View memberships','primary',()=>openMembershipExperience()));
  el.append(title,copy,actions);root.append(el);scrollToBottom(root);openMembershipExperience();
}
if(isNativeRuntime(window))attachStoreKitListener();
$('#export-backup').addEventListener('click',async()=>{try{const passphrase=$('#backup-passphrase').value;const response=await nativeFetch(API_BASE+'/api/backups/export',{method:'POST',credentials:NATIVE_CREDENTIALS,headers:{'Content-Type':'application/json','X-Orbit-CSRF':state.csrf},body:JSON.stringify({passphrase})});if(!response.ok)throw new Error((await response.json()).error);const blob=await response.blob();const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`orbit-backup-${new Date().toISOString().slice(0,10)}.orbitbackup`;link.click();URL.revokeObjectURL(url);toast('Encrypted backup downloaded.');}catch(error){toast(error.message);}});
$('#restore-backup').addEventListener('click',async()=>{try{const file=$('#restore-file').files[0];if(!file)throw new Error('Choose an Orbit backup first.');if(file.size>10*1024*1024)throw new Error('Backup is too large.');if(prompt('Restoring merges data and pauses Orbit. Type RESTORE to continue:')!=='RESTORE')return;const payload=await file.text();await api('/api/backups/restore',{method:'POST',body:JSON.stringify({payload,passphrase:$('#backup-passphrase').value,confirm:'RESTORE'})});await refresh();toast('Backup restored. Orbit remains paused for review.');}catch(error){toast(error.message);}});
$('#rotate-recovery').addEventListener('click',async()=>{try{const result=await api('/api/recovery-codes/rotate',{method:'POST',body:JSON.stringify({password:$('#recovery-password').value})});showCodes(result.recoveryCodes);$('#recovery-password').value='';}catch(error){toast(error.message);}});
$('#pause-button').addEventListener('click',async()=>{try{await api('/api/admin/pause',{method:'POST'});await refresh();toast('Emergency pause enabled.');}catch(error){toast(error.message);}});$('#show-request').addEventListener('click',()=>{$('#request-form').classList.toggle('hidden');$('#request-status').textContent='';});
$('#send-request').addEventListener('click',async()=>{const status=$('#request-status');status.textContent='';try{const email=$('#request-email').value;const response=await nativeFetch(API_BASE+'/api/registration-request',{method:'POST',credentials:NATIVE_CREDENTIALS,headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('#request-name').value,email})});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||`Request failed (${response.status}).`);status.textContent='Request sent! Waiting for approval…';$('#request-name').value='';$('#request-email').value='';pollAccessStatus(email);}catch(error){status.textContent=error.message;}});
let accessPollTimer=null;
async function pollAccessStatus(email){
  if(accessPollTimer)clearInterval(accessPollTimer);
  const status=$('#request-status');
  const check=async()=>{
    try{
      const res=await nativeFetch(API_BASE+`/api/access-status?email=${encodeURIComponent(email)}`,{credentials:NATIVE_CREDENTIALS});
      const data=await res.json();
      if(data.status==='approved'){
        clearInterval(accessPollTimer);accessPollTimer=null;
        status.textContent='Approved. Use the email recovery link to set your password securely.';
        const send=button('Send secure email link','primary',async()=>{
          try{await signupPost('/api/auth/forgot-password',{email});status.textContent='If your account is approved, a secure link is on its way. Check your email.';}
          catch(e){toast(e.message);}
        });status.append(send);
      }else if(data.status==='denied'){
        clearInterval(accessPollTimer);accessPollTimer=null;
        status.textContent='Sorry, your request was not approved.';
      }
      // else still pending, keep polling
    }catch(_){}
  };
  await check();
  accessPollTimer=setInterval(check,30000); // Poll every 30s
}
$('#registration-toggle').addEventListener('click',async()=>{try{const open=!state.setup?.registrationOpen;await api('/api/admin/registration',{method:'POST',body:JSON.stringify({open})});await refresh();toast(open?'Registration is open.':'Registration is closed.');}catch(error){toast(error.message);}});$('#resume-button').addEventListener('click',async()=>{if(prompt('Type RESUME to restart Orbit work:')!=='RESUME')return;try{await api('/api/admin/resume',{method:'POST',body:JSON.stringify({confirm:'RESUME'})});await refresh();toast('Orbit resumed.');}catch(error){toast(error.message);}});
$('#auth-dialog')?.addEventListener('close',()=>{if(accessPollTimer){clearInterval(accessPollTimer);accessPollTimer=null;}});
// Launch always lands on the welcome screen (Today view with the Orbit hero),
// ignoring any stale hash from a previous session. In-app hash navigation still works.
state.launchSignin=location.hash==='#signin'||Boolean(state.signupVerificationToken);
if(location.hash)history.replaceState(null,'',location.pathname+location.search);
activateView('today',{updateHash:false});
if('serviceWorker'in navigator){let reloading=false;navigator.serviceWorker.addEventListener('controllerchange',()=>{if(reloading)return;reloading=true;location.reload();});navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).catch(()=>{});
  // Auto-reload when a new app version activates
  navigator.serviceWorker.addEventListener('message',(event)=>{
    if(event.data&&event.data.type==='SW_UPDATED'){
      // Don't yank the screen while they're typing — wait for a pause
      const doReload=()=>{try{if(typeof toast==='function')toast('Updating Orbit…');}catch(_){}setTimeout(()=>location.reload(),1200);};
      if(typeof isComposing==='function'&&isComposing()){setTimeout(()=>{if(!isComposing())doReload();else setTimeout(doReload,10000);},5000);}
      else doReload();
    }
  });
  // Proactively check for updates every 5 min and when the app becomes visible
  const checkSWUpdate=()=>{navigator.serviceWorker.ready.then((reg)=>reg.update().catch(()=>{})).catch(()=>{});};
  setInterval(checkSWUpdate,5*60*1000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkSWUpdate();});
}// PWA: launch fade + offline indicator
(function(){
  const banner=document.getElementById('offline-banner');
  const sync=()=>{if(banner)banner.classList.toggle('hidden',navigator.onLine);};
  window.addEventListener('online',sync);window.addEventListener('offline',sync);sync();
})();
connect();setInterval(()=>{if(state.user&&!document.hidden)refresh().catch(()=>{});},15000);

// Password reset via email link (?token= on /reset-password)
(function initPasswordReset(){
  const params=new URLSearchParams(location.search);
  const token=params.get('token');
  if(!token) return;
  const dialog=document.getElementById('reset-dialog');
  if(!dialog) return;
  history.replaceState(null,'','/reset-password');
  if(typeof dialog.showModal==='function') dialog.showModal();
  document.getElementById('reset-form').addEventListener('submit',async(e)=>{
    e.preventDefault();
    const pw=document.getElementById('reset-password').value;
    const confirm=document.getElementById('reset-confirm').value;
    document.getElementById('reset-error').textContent='';
    if(pw.length<8){ document.getElementById('reset-error').textContent='Password must be at least 8 characters.'; return; }
    if(pw!==confirm){ document.getElementById('reset-error').textContent='Passwords do not match.'; return; }
    try{
      const res=await nativeFetch(API_BASE+'/api/auth/reset-password',{method:'POST',credentials:NATIVE_CREDENTIALS,headers:{'Content-Type':'application/json'},body:JSON.stringify({token,newPassword:pw})});
      const body=await res.json();
      if(!res.ok) throw new Error(body.error||'Reset failed.');
      document.getElementById('reset-success').classList.remove('hidden');
      document.getElementById('reset-submit').disabled=true;
      document.getElementById('reset-password').disabled=true;
      document.getElementById('reset-confirm').disabled=true;
    }catch(err){ document.getElementById('reset-error').textContent=err.message; }
  });
  document.getElementById('reset-goto-login')?.addEventListener('click',()=>{ dialog.close(); location.href='/'; });
})();

// Signup security: all native proofs remain in memory. Unsupported devices use
// the existing password/email flow; client flags never count as attestation.
function signupPlugin(){return window.Capacitor?.Plugins?.SignupSecurity||null;}
async function signupPost(path,body){
  const response=await nativeFetch(API_BASE+path,{method:'POST',credentials:NATIVE_CREDENTIALS,headers:{'Content-Type':'application/json',...(state.csrf?{'X-Orbit-CSRF':state.csrf}:{}),...(nativeToken()?{Authorization:'Bearer '+nativeToken()}:{})},body:JSON.stringify(body)});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'Please try again.');return result;
}
async function signupAttestation(email){
  const plugin=signupPlugin();if(!plugin||!state.setup?.appAttestReady)return null;
  try{
    const key=await plugin.getKey({namespace:API_BASE});if(!key.supported)return null;
    email=email.trim().toLowerCase();const keyId=key.keyId;
    if(!key.registered){
      const challenge=await signupPost('/api/auth/attest/challenge',{email,keyId,purpose:'attest'});
      const proof=await plugin.attest({keyId,challenge:challenge.challenge});
      await signupPost('/api/auth/attest/complete',{email,keyId,purpose:'attest',challenge:challenge.challenge,...proof});
      await plugin.markRegistered({namespace:API_BASE,keyId});
    }
    const challenge=await signupPost('/api/auth/attest/challenge',{email,keyId,purpose:'assert'});
    const proof=await plugin.assert({keyId,payload:challenge.payload});
    return (await signupPost('/api/auth/attest/complete',{email,keyId,purpose:'assert',challenge:challenge.challenge,...proof})).proof;
  }catch{return null;}
}
async function appleSignIn(purpose){
  const plugin=signupPlugin();if(!plugin)throw new Error('Apple sign-in requires the iPhone app.');
  const password=purpose==='link'?$('#apple-link-password').value:undefined;
  try{
    const challenge=await signupPost('/api/auth/apple/challenge',{purpose});
    const credentials=await plugin.signIn({nonce:challenge.nonce});
    const result=await signupPost('/api/auth/apple/complete',{...credentials,nonce:challenge.nonce,purpose,password});
    if(purpose==='signup'){state.appleSignupProof=result.appleSignupProof;setAuthMode('register');$('#auth-email').value=result.email;$('#auth-password').required=false;$('#auth-copy').textContent='Apple verified your email. Enter your name to finish creating your account. A password is optional; recovery codes will be provided.';return;}
    if(purpose==='link'){toast('Apple linked. Your password still works.');return;}
    state.user=result.user;state.csrf=result.csrf;if(result.sessionToken)setNativeToken(result.sessionToken);await connect();
  }finally{if(purpose==='link')$('#apple-link-password').value='';}
}
function renderSignupSafety(){
  const owner=state.user?.role==='owner',risk=state.signupRisk;
  $('#signup-risk-panel')?.classList.toggle('hidden',!owner);
  $('#apple-link-panel')?.classList.toggle('hidden',!signupPlugin()||!state.setup?.appleSignInReady);
  if(!owner||!risk)return;
  $('#signup-risk-status').textContent=`Mode: ${risk.mode}. New signups ${risk.paused?'paused':'not paused'}. Existing logins remain available.`;
  $('#signup-risk-counts').textContent=`Latest ${risk.total} recorded attempts: ${risk.decisions.allow} allow, ${risk.decisions.verify} verify, ${risk.decisions.deny} deny. Observations are not admission decisions.`;
  $('#signup-pause-toggle').textContent=risk.paused?'Resume new signups':'Pause new signups';
  $('#signup-pause-toggle').disabled=risk.environmentPaused;
  const root=$('#signup-appeals');root.replaceChildren();
  for(const appeal of state.signupAppeals||[]){const card=document.createElement('article');card.className='item-card';const text=document.createElement('p');text.textContent=`${appeal.email}: ${appeal.note} (${appeal.status})`;card.append(text);
    if(appeal.status==='pending')card.append(button('Mark reviewed','ghost',async()=>{try{await api('/api/admin/signup-appeals',{method:'POST',body:JSON.stringify({id:appeal.id,status:'reviewed'})});await refresh();}catch(e){toast(e.message);}}));root.append(card);}
}
$('#signup-pause-toggle')?.addEventListener('click',async()=>{try{await api('/api/admin/signup-pause',{method:'POST',body:JSON.stringify({paused:!state.signupRisk?.paused})});await refresh();}catch(e){toast(e.message);}});
$('#apple-login')?.addEventListener('click',()=>appleSignIn('login').catch(e=>{$('#auth-error').textContent=e.message;}));
$('#apple-link')?.addEventListener('click',()=>appleSignIn('link').catch(e=>toast(e.message)));
$('#signup-appeal-send')?.addEventListener('click',async()=>{try{const result=await signupPost('/api/auth/signup-appeal',{email:$('#auth-email').value,note:$('#signup-appeal-note').value});$('#auth-error').textContent=result.message;}catch(e){$('#auth-error').textContent=e.message;}});

$('#apple-signup')?.addEventListener('click',()=>appleSignIn('signup').catch(e=>{$('#auth-error').textContent=e.message;}));
