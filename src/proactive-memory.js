// Proactive memory (2026-10-16): Orbit volunteers relevant memories at the
// right moment instead of waiting to be asked — upcoming dates embedded in
// memories ("Mom's birthday is October 23") and open loops ("want to try
// that Thai place").
//
// Two delivery paths, both reusing the established proactive infrastructure:
//   1. In-conversation: at most ONE timely memory per turn, offered to the
//      model as a prompt hint it may weave in as a natural aside (or skip
//      silently). Never mid-task (skipped when the turn used tools), never
//      repeated (surfacings are tracked with timestamps).
//   2. Background push: date triggers flow through the shared proactive
//      pipeline (quiet hours, claimProactiveSlot 3/day cap, deliverProactive
//      → web/app + WhatsApp), at most one push per user per day.
//
// Relevance gating: only high-confidence, non-decayed memories surface.
// Explainability: every surfacing records which memory triggered it and why,
// so "why are you telling me this?" gets an exact answer.
// Demo mode: fully off (neutral experience).

import { nextPersonalDateOccurrence, todayInZone, validTimeZone } from './intelligence.js';

export const PROACTIVE_MEMORY = {
  annualWindowDays: 7,      // birthday/anniversary heads-up window (includes the day itself)
  onceWindowDays: 7,        // one-time upcoming dates window
  onceMaxLookaheadDays: 60, // year-less M/D dates further out than this are treated as stale
  minDateConfidence: 0.7,   // date triggers need high confidence
  minOpenLoopConfidence: 0.75,
  minRelevance: 0.5,        // skip memories decayed below this relevance
  openLoopCooldownDays: 14, // an open loop isn't re-volunteered inside this window
  whyLookbackDays: 7,       // "why are you telling me this?" answers recent surfacings
};

const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_RE = 'January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sept|Sep|October|Oct|November|Nov|December|Dec';

// Annual by nature: the same date matters every year.
const ANNUAL_KEYWORDS = ['birthday', 'anniversary'];
// One-time dated things worth a heads-up.
const DATE_KEYWORDS = [
  'appointment', 'deadline', 'interview', 'flight', 'reservation', 'concert',
  'show', 'gig', 'exam', 'dentist', 'doctor', 'trip', 'vacation', 'booking',
  'wedding', 'party', 'dinner', 'reunion', 'ceremony', 'graduation', 'call',
  'meeting', 'visit', 'pickup', 'delivery',
];
const KEYWORD_RE = new RegExp(`\\b(${[...ANNUAL_KEYWORDS, ...DATE_KEYWORDS].join('|')})s?\\b`, 'i');

const OPEN_LOOP_RES = [
  /\bwant(s|ed)?\s+to\s+(try|check out|visit|read|watch|see|go|do|learn|take|plan)/i,
  /\b(should|need to|needs to|have to|has to|must)\s+(try|check out|visit|go|do|get|remember|follow up|look into|book|call|plan)/i,
  /\bremind\s+me\b/i,
  /\bplan(ning)?\s+to\b/i,
  /\binterested\s+in\b/i,
  /\blooking\s+forward\s+to\b/i,
  /\bhaven'?t\s+\w+\s+yet\b/i,
  /\bto-?do\b/i,
];

const STOPWORDS = new Set(('the,a,an,is,are,was,were,be,been,to,for,of,and,in,on,at,my,your,his,her,its,our,their,this,that,these,those,with,from,by,as,or,but,not,no,so,if,then,than,too,very,just,will,would,can,could,should,have,has,had,do,does,did,i,you,we,they,he,she,it,me,him,us,them,what,when,where,which,who,whom,how,why,all,any,each,few,more,most,other,some,such,only,own,same').split(','));

function daysInMonth(month, year) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad2(n) { return String(n).padStart(2, '0'); }

// Nearest trigger keyword around a date match (within radius chars).
// Annual keywords win over generic date keywords.
function nearestKeyword(text, index, radius = 60) {
  const slice = String(text || '').slice(Math.max(0, index - radius), index + radius);
  const annual = new RegExp(`\\b(${ANNUAL_KEYWORDS.join('|')})s?\\b`, 'i').exec(slice);
  if (annual) return annual[1].toLowerCase();
  const m = KEYWORD_RE.exec(slice);
  return m ? m[1].toLowerCase() : null;
}

// Extract dated triggers from free-text memory content. Returns
// [{ kind: 'annual'|'once', month, day, year|null, keyword }].
// Conservative by design: month-name and M/D dates require a nearby trigger
// keyword (so "I run 3/4 mile" or "May flowers" never fire); ISO dates are
// unambiguous and don't need one. Relative dates ("tomorrow", "next week")
// are deliberately unsupported — they decay in meaning.
export function extractDateTriggers(content) {
  const text = String(content || '');
  const triggers = [];
  const seen = new Set();
  const push = (t) => {
    const key = `${t.kind}:${t.month}:${t.day}:${t.year || ''}:${t.keyword}`;
    if (seen.has(key)) return;
    seen.add(key);
    triggers.push(t);
  };
  // 1. ISO dates: unambiguous.
  for (const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) {
    const year = Number(m[1]); const month = Number(m[2]); const day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(month, year)) continue;
    push({ kind: 'once', month, day, year, keyword: nearestKeyword(text, m.index) || 'date' });
  }
  // 2. Month-name dates: need a nearby keyword.
  const monthRe = new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi');
  let m;
  while ((m = monthRe.exec(text)) !== null) {
    const keyword = nearestKeyword(text, m.index);
    if (!keyword) continue;
    const month = MONTHS[m[1].toLowerCase()];
    const day = Number(m[2]);
    if (!month || day < 1 || day > daysInMonth(month, 2024)) continue; // 2024 is leap: allow Feb 29
    push({
      kind: ANNUAL_KEYWORDS.includes(keyword) ? 'annual' : 'once',
      month, day, year: null, keyword,
    });
  }
  // 3. Slashed M/D(/YYYY): need a nearby keyword.
  for (const sm of text.matchAll(/(?<!\d)(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?(?!\d)/g)) {
    const keyword = nearestKeyword(text, sm.index);
    if (!keyword) continue;
    const month = Number(sm[1]); const day = Number(sm[2]);
    const year = sm[3] ? Number(sm[3]) : null;
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(month, year || 2024)) continue;
    push({
      kind: year ? 'once' : (ANNUAL_KEYWORDS.includes(keyword) ? 'annual' : 'once'),
      month, day, year, keyword,
    });
  }
  return triggers;
}

// Open loops: things he said he wants/needs/plans to do — the "unfinished
// business" memories worth volunteering when the topic comes up.
export function isOpenLoop(content) {
  const text = String(content || '');
  if (text.length < 12) return false;
  return OPEN_LOOP_RES.some((re) => re.test(text));
}

function prettyDate(month, day) {
  return `${MONTH_NAMES[month - 1]} ${day}`;
}

function daysBetween(aStr, bStr) {
  const [ay, am, ad] = aStr.split('-').map(Number);
  const [by, bm, bd] = bStr.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400_000);
}

// Next future occurrence of a year-less month/day; null when it's further
// out than maxLookaheadDays (treated as stale, not a trigger).
function nextMonthDay(month, day, todayStr, maxLookaheadDays) {
  const [ty, tm, td] = todayStr.split('-').map(Number);
  for (let y = ty; y <= ty + 1; y++) {
    if (month === 2 && day === 29 && !((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) continue;
    const candidate = `${y}-${pad2(month)}-${pad2(day)}`;
    const diff = daysBetween(todayStr, candidate);
    if (diff >= 0) return diff <= maxLookaheadDays ? { dateStr: candidate, daysUntil: diff } : null;
  }
  return null;
}

function whenPhrase(daysUntil) {
  if (daysUntil === 0) return 'is today';
  if (daysUntil === 1) return 'is tomorrow';
  return `is in ${daysUntil} days`;
}

function memoryEligible(memory, todayStr) {
  if (!memory || typeof memory.content !== 'string' || !memory.content.trim()) return false;
  if (memory.status && memory.status !== 'approved') return false;
  if (memory.superseded_by) return false;
  if (memory.proactive_allowed === 0 || memory.proactive_allowed === false) return false;
  const confidence = Number(memory.confidence ?? 1);
  if (!Number.isFinite(confidence)) return false;
  const relevance = Number(memory.relevance_score ?? 1);
  if (!Number.isFinite(relevance) || relevance < PROACTIVE_MEMORY.minRelevance) return false;
  // Conservative: don't surface something he literally just told us today.
  if (String(memory.created_at || '').slice(0, 10) === todayStr) return false;
  return { confidence, relevance };
}

// Due date candidates from memories, fully gated. Pure + sync: the caller
// passes surfacedKeys (already-recorded occurrence keys) for dedup.
// Returns [{ memory, kind:'date', daysUntil, nextDate, reason, occurrenceKey }]
// sorted by daysUntil ascending.
export function findDateCandidates({ memories, personalDates = [], surfacedKeys = new Set(), nowMs = Date.now(), timeZone = 'America/New_York' }) {
  const zone = validTimeZone(timeZone);
  const todayStr = todayInZone(zone, nowMs);
  const out = [];
  for (const memory of memories || []) {
    const eligible = memoryEligible(memory, todayStr);
    if (!eligible || eligible.confidence < PROACTIVE_MEMORY.minDateConfidence) continue;
    for (const trigger of extractDateTriggers(memory.content)) {
      let daysUntil, nextDate, reason;
      const occurrenceBase = `date:${memory.id}`;
      if (trigger.kind === 'annual') {
        // The morning briefing already nudges personal_dates rows — don't
        // double-fire on the same month/day.
        if ((personalDates || []).some((pd) => Number(pd.month) === trigger.month && Number(pd.day) === trigger.day)) continue;
        const occ = nextPersonalDateOccurrence(trigger.month, trigger.day, zone, nowMs);
        if (occ.daysUntil < 0 || occ.daysUntil > PROACTIVE_MEMORY.annualWindowDays) continue;
        daysUntil = occ.daysUntil;
        nextDate = occ.nextDate;
        reason = `${trigger.keyword} ${whenPhrase(daysUntil)} (${prettyDate(trigger.month, trigger.day)})`;
      } else {
        if (trigger.year) {
          nextDate = `${trigger.year}-${pad2(trigger.month)}-${pad2(trigger.day)}`;
          daysUntil = daysBetween(todayStr, nextDate);
        } else {
          const next = nextMonthDay(trigger.month, trigger.day, todayStr, PROACTIVE_MEMORY.onceMaxLookaheadDays);
          if (!next) continue;
          nextDate = next.dateStr;
          daysUntil = next.daysUntil;
        }
        if (daysUntil < 0 || daysUntil > PROACTIVE_MEMORY.onceWindowDays) continue;
        reason = `${trigger.keyword} ${whenPhrase(daysUntil)} (${prettyDate(trigger.month, trigger.day)})`;
      }
      const occurrenceKey = `${occurrenceBase}:${nextDate}`;
      if (surfacedKeys.has(occurrenceKey)) continue; // already surfaced for this occurrence
      out.push({ memory, kind: 'date', daysUntil, nextDate, reason, occurrenceKey });
    }
  }
  out.sort((a, b) => a.daysUntil - b.daysUntil || b.memory.confidence - a.memory.confidence);
  return out;
}

// Distinctive words of a text, for the already-on-topic check.
function distinctiveWords(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 4 && !STOPWORDS.has(w));
}

// True when the user is already talking about this memory's topic — then the
// model has it in context and will use it; volunteering would be redundant
// (and must NOT burn the occurrence key).
export function alreadyOnTopic(userMessage, memoryContent) {
  const words = distinctiveWords(memoryContent);
  if (words.length < 2) return false;
  const msg = String(userMessage || '').trim();
  const msgWords = new Set(msg.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/));
  const hits = words.filter((w) => msgWords.has(w)).length;
  if (hits === 0) return false;
  // A direct question about the topic: the model answers from context.
  if (/\?\s*$/.test(msg)) return true;
  return hits / words.length >= 0.4;
}

// True when the conversation already covered this memory recently.
export function recentlyDiscussed(historyMessages, memoryContent) {
  const snippet = String(memoryContent || '').slice(0, 40).toLowerCase();
  if (snippet.length < 20) return false;
  return (historyMessages || []).slice(-12).some((m) => String(m.content || '').toLowerCase().includes(snippet));
}

// Open-loop candidates: high-confidence "want/need/plan" memories that rank
// in the top-3 recalled for this message (topical = timely) and weren't
// volunteered recently. Returns [{ memory, kind:'open_loop', reason, occurrenceKey }].
export function findOpenLoopCandidates({ allMemories, recalledMemories, surfacedRows = [], historyMessages = [], userMessage = '', nowMs = Date.now() }) {
  const topIds = new Set((recalledMemories || []).slice(0, 3).map((m) => m.id));
  const surfacedByKey = new Map((surfacedRows || []).map((r) => [r.occurrence_key, r]));
  const out = [];
  for (const memory of allMemories || []) {
    if (!topIds.has(memory.id)) continue;
    const todayStr = new Date(nowMs).toISOString().slice(0, 10);
    const eligible = memoryEligible(memory, todayStr);
    if (!eligible || eligible.confidence < PROACTIVE_MEMORY.minOpenLoopConfidence) continue;
    if (!isOpenLoop(memory.content)) continue;
    if (alreadyOnTopic(userMessage, memory.content)) continue;
    if (recentlyDiscussed(historyMessages, memory.content)) continue;
    const occurrenceKey = `loop:${memory.id}`;
    const prior = surfacedByKey.get(occurrenceKey);
    if (prior) {
      const ageDays = (nowMs - new Date(prior.surfaced_at).valueOf()) / 86400_000;
      if (ageDays < PROACTIVE_MEMORY.openLoopCooldownDays) continue;
    }
    out.push({ memory, kind: 'open_loop', reason: 'an open loop you mentioned before', occurrenceKey });
  }
  // Prefer the highest-ranked recall.
  const rank = new Map((recalledMemories || []).map((m, i) => [m.id, i]));
  out.sort((a, b) => (rank.get(a.memory.id) ?? 99) - (rank.get(b.memory.id) ?? 99));
  return out;
}

// Choose at most ONE memory to volunteer this turn. Date triggers win over
// open loops (a due date is more time-sensitive than a standing intention).
export function chooseChatSurfacing({ allMemories, recalledMemories, personalDates = [], historyMessages = [], userMessage = '', surfacedKeys = new Set(), surfacedRows = [], nowMs = Date.now(), timeZone = 'America/New_York' }) {
  const dates = findDateCandidates({ memories: allMemories, personalDates, surfacedKeys, nowMs, timeZone });
  for (const candidate of dates) {
    if (recentlyDiscussed(historyMessages, candidate.memory.content)) continue;
    if (alreadyOnTopic(userMessage, candidate.memory.content)) continue;
    return { ...candidate, via: 'chat' };
  }
  const loops = findOpenLoopCandidates({ allMemories, recalledMemories, surfacedRows, historyMessages, userMessage, nowMs });
  if (loops.length) return { ...loops[0], via: 'chat' };
  return null;
}

// Prompt hint granting the model permission to volunteer the chosen memory
// as a natural aside — or skip it silently when there's no opening. Includes
// the explainability line so "why did you mention that?" gets an honest answer.
export function buildSurfacingHint({ memory, reason }) {
  const saved = String(memory.created_at || '').slice(0, 10);
  return `Proactive memory — you MAY volunteer this ONE memory as a brief, natural aside near the end of your reply, but only if the conversation has a genuine opening for it; otherwise skip it silently and never force it. Never volunteer more than one memory per reply. Memory: "${memory.content}" — timely because ${reason}. If the user asks why you mentioned it, say it came from something they asked you to remember${saved ? ` (saved ${saved})` : ''}.`;
}

// Background push: the workhorse for date triggers. Reuses the shared
// proactive pipeline via injected claimSlot/deliver. Never throws; returns
// the number of pushes sent (0 or 1 — graceful, never a burst).
export async function runProactiveMemoryPush({ db, model, user, timeZone, nowMs, buddyName, claimSlot, releaseSlot, deliver }) {
  const today = todayInZone(validTimeZone(timeZone), nowMs);
  let memories = [];
  let personalDates = [];
  let surfacedRows = [];
  try {
    memories = db.listMemories(user.id);
    personalDates = db.listPersonalDates(user.id);
    surfacedRows = db.listMemorySurfacings(user.id, 500);
  } catch (error) {
    console.error('proactive memory read failed', error && error.message);
    return 0;
  }
  const surfacedKeys = new Set(surfacedRows.map((r) => r.occurrence_key));
  const candidates = findDateCandidates({ memories, personalDates, surfacedKeys, nowMs, timeZone });
  if (!candidates.length) return 0;
  const top = candidates[0];
  if (!claimSlot()) return 0;
  const displayName = user.display_name || 'there';
  const prompt = `Write a short, warm proactive message (1-2 sentences, plain text, no greeting header) reminding ${displayName} about this timely note from what they've told you: "${top.memory.content}" — ${top.reason}. Sound like a thoughtful friend who remembered, not a notification. Do not mention that this is automated. If it's a birthday or anniversary, you may briefly offer to help with gift ideas.`;
  let text;
  try {
    ({ text } = await model.respond({
      buddyName, userName: user.display_name, message: prompt,
      memories: [top.memory], goals: [], history: [],
      userTimeZone: timeZone, taskMode: true,
    }));
  } catch (error) {
    console.error('proactive memory compose failed', error && error.message);
    try { releaseSlot(); } catch {}
    return 0;
  }
  text = String(text || '').trim();
  if (!text) {
    try { releaseSlot(); } catch {}
    return 0;
  }
  try {
    const outcome=await deliver(text, `Proactively surfaced a timely memory (${top.reason}).`);
    if(outcome===false||outcome?.recorded===false){try{releaseSlot();}catch{}return 0;}
    db.recordMemorySurfacing(user.id, {
      memoryId: top.memory.id,
      occurrenceKey: top.occurrenceKey,
      kind: 'date',
      via: 'proactive',
      reason: top.reason,
      contentSnapshot: top.memory.content,
      memoryCreatedAt: top.memory.created_at,
    });
    db.addEvent(user.id, 'memory_surfaced_proactive', `Volunteered a timely memory proactively (${top.reason}).`);
    return 1;
  } catch (error) {
    console.error('proactive memory deliver failed', error && error.message);
    try { releaseSlot(); } catch {}
    return 0;
  }
}

const WHY_RE = /^\s*why\s+(did|do|are)\s+you\s+(tell(ing)?|mention(ing)?|bring(ing)?(\s+up)?|remind(ing)?|say(ing)?)\b/i;

// Chat-native explainability: "why are you telling me this?" → exact answer
// naming the memory, when it was saved, and why it felt timely. Returns null
// when nothing was surfaced recently (the model then answers naturally).
export function handleProactiveMemoryWhy({ db, userId, message }) {
  const text = String(message || '').trim();
  if (!text || text.length > 300 || !WHY_RE.test(text)) return null;
  let last = null;
  try { last = db.getLastMemorySurfacing(userId); } catch { return null; }
  if (!last || !last.surfaced_at) return null;
  const ageMs = Date.now() - new Date(last.surfaced_at).valueOf();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > PROACTIVE_MEMORY.whyLookbackDays * 86400_000) return null;
  // Memory connections (2026-10-16): emotional patterns aren't "in my notes" —
  // they're modeled from how they've been talking. Say so, honestly.
  if (last.kind === 'emotion') {
    const observed = String(last.content_snapshot || 'a pattern in how you\u2019ve been talking lately');
    // Lowercase a leading "You've…"/"They've…" so it reads after "because"
    // ("I mentioned it because you've seemed drained…"); keep "I'm starting
    // to notice…" as-is.
    const said = /^(I'?m|I’m)\b/.test(observed) ? observed : observed.charAt(0).toLowerCase() + observed.slice(1);
    return `I mentioned it because ${said} — that\u2019s a pattern I\u2019m modeling from your messages, not something I feel. Tell me if I\u2019m reading it wrong.`;
  }
  const content = last.content_snapshot || 'something you asked me to remember';
  const saved = String(last.memory_created_at || '').slice(0, 10);
  const timely = last.reason ? ` It felt timely because ${last.reason}.` : '';
  return `I brought it up because it's in my notes — “${content}”${saved ? ` (you told me that on ${saved})` : ''}.${timely} You can ask me to forget anything, anytime — just say “forget …”.`;
}
