// Memory connections + emotional-intelligence layer (2026-10-16): Orbit spots
// recurring themes across memories and surfaces genuine insights — "third
// Thursday in a row you've been wiped after class" — plus an emotional read on
// how he's doing over time.
//
// HONESTY CONTRACT (load-bearing, stated twice as required):
//   Orbit MODELS emotions — it does NOT feel them. The detector below is a
//   keyword heuristic, not a feeling; the tracked "patterns" are observations
//   about his messages, not empathy. If asked "are you sad?", the honest
//   answer is no — and Orbit must never perform distress, claim feelings, or
//   present a modeled tone as a felt emotion. The same contract is rendered
//   into the prompt (buildEmotionalContext) and the release notes so the
//   model cannot drift into "I feel worried about you" territory.
//
// Design (prompt-only, no new infra, no extra API calls, no separate
// sentiment API — the model's own reading of the conversation does the
// nuanced per-turn interpretation; this module supplies cheap deterministic
// tracking so patterns are grounded in evidence):
//   1. detectEmotionalTone(message) — per-message tone heuristic (stressed,
//      frustrated, excited, sad, burnt_out, anxious, celebratory, neutral).
//   2. Tone tracking — a lightweight per-user time series in the settings
//      table (no migration). summarizeEmotionalPattern aggregates it into
//      window phrases like "drained the last three evenings".
//   3. detectMemoryPatterns(memories) — clusters memories by shared
//      distinctive words; clusters of 2+ become patterns with growing
//      confidence: 2 occurrences = emerging ("I'm starting to notice…"),
//      3+ = established ("This keeps coming up…"). A single data point is
//      NEVER presented as a pattern.
//   4. Surfacing reuses the proactive-memory infrastructure: the same
//      memory_surfacing table (kind 'pattern' / 'emotion'), the same
//      claimProactiveSlot 3/day cap, quiet hours, deliverProactive
//      (web/app + WhatsApp), never mid-task, never in demo mode.
//   5. The adaptive soul's context detection (src/soul.js) consumes the
//      emotional tone so its shifts are emotionally grounded (see
//      EMOTION_SHIFTS below).
//
// Uncomfortable patterns go through the honest-soul kindness pattern:
// observation + why it matters + one constructive path, never judgment
// (see buildPatternHint).

import {
  findDateCandidates,
  findOpenLoopCandidates,
  alreadyOnTopic,
  recentlyDiscussed,
  buildSurfacingHint,
} from './proactive-memory.js';
import { todayInZone, validTimeZone } from './intelligence.js';

export const MEMORY_CONNECTIONS = {
  minPatternConfidence: 0.6,   // pattern evidence may be softer than a single surfacing
  emergingOccurrences: 2,      // 2 memories sharing a theme: "I'm starting to notice…"
  establishedOccurrences: 3,   // 3+: "This keeps coming up…"
  patternCooldownDays: 21,     // don't repeat the same insight inside this window
  emotionCooldownDays: 7,      // emotional patterns move faster; shorter cooldown
  emotionWindowDays: 7,        // look back this far for emotional runs
  trackCap: 60,                // max tracked tone entries per user
};

// ---------------------------------------------------------------------------
// Emotional tone detection — a heuristic the model refines, not a feeling.
// Priority order (celebration phrases are the most distinctive, checked
// first); everything else falls to neutral. Pure.
// ---------------------------------------------------------------------------

const TONE_PATTERNS = [
  ['celebratory', /\b(i did it|i passed|it worked|got the job|got in|promoted|celebrat)/i],
  ['excited', /\b(excited|pumped|can'?t wait|thrilled|so hyped|looking forward to)\b/i],
  ['burnt_out', /\b(burnt?\s?out|wiped|drained|exhausted|running on empty|so tired|fried|spent|running on fumes)\b/i],
  ['stressed', /\b(stress(ed|ing|ful)?|under pressure|so much (going )?on|overwhelm(ed|ing)?|swamped|drowning)\b/i],
  ['anxious', /\b(anxious|anxiety|nervous|worried|worrying|on edge|uneasy|panick?y|dread(ing)?)\b/i],
  ['sad', /\b(sad|bummed|down bad|heartbroken|tearful|depress(ed|ing)?|feeling low)\b/i],
  ['frustrated', /\b(frustrat(ed|ing)?|annoy(ed|ing)?|irritat(ed|ing)?|fed up|this sucks|infuriating)\b/i],
];

/** Detect the emotional tone of one user message. Pure. A model, not a feeling. */
export function detectEmotionalTone(text) {
  const t = String(text || '');
  for (const [tone, re] of TONE_PATTERNS) {
    if (re.test(t)) return tone;
  }
  return 'neutral';
}

const TONE_LABELS = {
  stressed: 'stressed',
  frustrated: 'frustrated',
  excited: 'excited',
  sad: 'down',
  burnt_out: 'drained',
  anxious: 'on edge',
  celebratory: 'in a celebratory mood',
  neutral: 'neutral',
};

/** Human label for a tone, for prompt lines and replies. Pure. */
export function toneLabel(tone) {
  return TONE_LABELS[tone] || 'neutral';
}

// ---------------------------------------------------------------------------
// Adaptive-soul grounding: how each detected tone shifts the personality
// axes. Consumed by src/soul.js applyAdaptation when no explicit signal or
// conversation mood matched — so tone-shifting tracks how he's actually
// feeling, not just surface keywords. whyPast feeds the "why are you being
// so X?" explainability.
// ---------------------------------------------------------------------------

export const EMOTION_SHIFTS = {
  stressed:     { targets: { warmth: 1, directness: -1 }, reason: 'you seem stressed — keeping things gentle and unhurried', whyPast: 'you seemed stressed' },
  anxious:      { targets: { warmth: 1 }, reason: 'you seem on edge — keeping things calm and steady', whyPast: 'you seemed on edge' },
  sad:          { targets: { warmth: 1, playfulness: -1 }, reason: 'you seem down — being gentle, no jokes', whyPast: 'you seemed down' },
  burnt_out:    { targets: { warmth: 1, directness: -1 }, reason: 'you seem wiped — keeping it light and easy', whyPast: 'you seemed wiped' },
  frustrated:   { targets: { warmth: 1 }, reason: 'you seem frustrated — staying patient and steady', whyPast: 'you seemed frustrated' },
  excited:      { targets: { warmth: 1, playfulness: 1 }, reason: 'you\u2019re excited — matching your energy', whyPast: 'you were excited' },
  celebratory:  { targets: { warmth: 1, playfulness: 1 }, reason: 'something went well — celebrating with you', whyPast: 'you had something worth celebrating' },
};

// ---------------------------------------------------------------------------
// Tone tracking — per-user time series in the settings table (additive, no
// migration). Only non-neutral tones are tracked; demo users are never
// tracked. Per-user isolated by key.
// ---------------------------------------------------------------------------

const TRACK_KEY = (userId) => `mood_track_${userId}`;

/** Append one tone observation. Never throws; no-op for demo callers (they must not call). */
export function trackEmotionalTone(db, userId, tone, nowMs = Date.now()) {
  if (!tone || tone === 'neutral') return;
  try {
    const track = loadEmotionalTrack(db, userId);
    track.push({ tone, at: Number(nowMs) || Date.now() });
    db.setSetting(TRACK_KEY(userId), JSON.stringify(track.slice(-MEMORY_CONNECTIONS.trackCap)));
  } catch (error) {
    console.error('emotional track write failed', error && error.message);
  }
}

/** Load the tone time series: [{ tone, at }]. Pure read. */
export function loadEmotionalTrack(db, userId) {
  try {
    const raw = db.getSetting(TRACK_KEY(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e) => e && typeof e.tone === 'string' && TONE_LABELS[e.tone] && Number.isFinite(Number(e.at)))
      .map((e) => ({ tone: e.tone, at: Number(e.at) }))
      .slice(-MEMORY_CONNECTIONS.trackCap);
  } catch {
    return [];
  }
}

// Emotional families for pattern phrasing. Positive tones don't form
// "you've seemed X" patterns — only the heavy ones do.
const TONE_FAMILIES = {
  burnt_out: 'drained', stressed: 'drained',
  sad: 'low',
  anxious: 'onedge',
  frustrated: 'frustrated',
};
const FAMILY_WORDS = { drained: 'drained', low: 'down', onedge: 'on edge', frustrated: 'frustrated' };

function localDateStr(at, timeZone) {
  return todayInZone(validTimeZone(timeZone), at);
}

function partOfDay(at, timeZone) {
  try {
    const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: validTimeZone(timeZone) }).format(new Date(at))) % 24;
    return h >= 18 || h < 5 ? 'evening' : 'day';
  } catch {
    return 'day';
  }
}

const NUMBER_WORDS = { 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven' };
function numberWord(n) {
  return NUMBER_WORDS[n] || String(n);
}

/**
 * Aggregate the tone track into a recent emotional pattern. Walks back from
 * the most recent day with data, counting consecutive days whose dominant
 * tone sits in the same heavy family. Returns null unless at least two such
 * days line up — a single day is never a pattern. Pure.
 * Returns { family, days, maturity: 'emerging'|'established', phrase }.
 */
export function summarizeEmotionalPattern({ track, nowMs = Date.now(), timeZone = 'America/New_York' }) {
  const entries = (track || []).filter((e) => TONE_FAMILIES[e.tone]);
  if (entries.length < 2) return null;
  const zone = validTimeZone(timeZone);
  const windowStart = nowMs - MEMORY_CONNECTIONS.emotionWindowDays * 86400_000;
  const byDay = new Map();
  for (const e of entries) {
    if (e.at < windowStart || e.at > nowMs) continue;
    const day = localDateStr(e.at, zone);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }
  if (byDay.size < 2) return null;
  // Dominant (mode, ties → latest) family per day.
  const dayFamilies = [...byDay.entries()].map(([day, list]) => {
    const counts = {};
    for (const e of list) counts[TONE_FAMILIES[e.tone]] = (counts[TONE_FAMILIES[e.tone]] || 0) + 1;
    let best = null; let bestN = 0;
    for (const e of list) {
      const f = TONE_FAMILIES[e.tone];
      if (counts[f] > bestN || (counts[f] === bestN && e === list[list.length - 1])) { best = f; bestN = counts[f]; }
    }
    return { day, family: best, entries: list };
  }).sort((a, b) => (a.day < b.day ? -1 : 1));
  // Consecutive-day run ending at the most recent day.
  const last = dayFamilies[dayFamilies.length - 1];
  let run = [last];
  for (let i = dayFamilies.length - 2; i >= 0; i--) {
    const cur = dayFamilies[i];
    const nextDay = run[run.length - 1].day;
    const [y, m, d] = cur.day.split('-').map(Number);
    const [ny, nm, nd] = nextDay.split('-').map(Number);
    const diffDays = Math.round((Date.UTC(ny, nm - 1, nd) - Date.UTC(y, m - 1, d)) / 86400_000);
    if (diffDays === 1 && cur.family === last.family) run.push(cur);
    else break;
  }
  if (run.length < 2) return null;
  const family = last.family;
  const periodEntries = run.flatMap((r) => r.entries);
  const evenings = periodEntries.filter((e) => partOfDay(e.at, zone) === 'evening').length;
  const periodWord = evenings * 2 >= periodEntries.length ? 'evenings' : 'days';
  const maturity = run.length >= MEMORY_CONNECTIONS.establishedOccurrences ? 'established' : 'emerging';
  const word = FAMILY_WORDS[family];
  const phrase = maturity === 'established'
    ? `You've seemed ${word} the last ${numberWord(run.length)} ${periodWord}.`
    : `I'm starting to notice you've seemed ${word} the last couple of ${periodWord}.`;
  return { family, days: run.length, maturity, phrase, periodWord };
}

// ---------------------------------------------------------------------------
// Pattern detection across memories. Memories that share distinctive words
// cluster into themes; a theme seen in 2+ memories is a pattern, and
// confidence grows with occurrences. Pure + deterministic.
// ---------------------------------------------------------------------------

const PATTERN_STOPWORDS = new Set(('the,a,an,is,are,was,were,be,been,to,for,of,and,in,on,at,my,your,his,her,its,our,their,this,that,these,those,with,from,by,as,or,but,not,no,so,if,then,than,too,very,just,will,would,can,could,should,have,has,had,do,does,did,i,you,we,they,he,she,it,me,him,us,them,what,when,where,which,who,whom,how,why,all,any,each,few,more,most,other,some,such,only,own,same,about,into,over,after,before,again,once,there,here,when,while,during,because,until,also').split(','));

function distinctivePatternWords(text) {
  return [...new Set(String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 4 && !PATTERN_STOPWORDS.has(w)))];
}

const DRAIN_RE = /\b(drained|wiped|exhausted|burnt?\s?out|overwhelm(ed|ing)?|so tired|running on empty)\b/i;
const ASPIRATION_RE = /\b(want(s|ed)? to (learn|try|read|watch|take|start|visit|see)|interested in|plan(ning|s)? to|would love to|thinking (about|of) (learning|trying|starting))\b/i;
const AVOIDANCE_RE = /\b(haven'?t .*yet|still haven'?t|keep (saying|telling)|said i('d| would)|meant to|supposed to)\b/i;

function classifyPatternTheme(texts) {
  const joined = texts.join(' \n ');
  if (AVOIDANCE_RE.test(joined)) return 'avoidance';
  if (DRAIN_RE.test(joined)) return 'drain';
  if (ASPIRATION_RE.test(joined)) return 'aspiration';
  return 'recurring';
}

function patternEligible(memory, nowMs) {
  if (!memory || typeof memory.content !== 'string' || !memory.content.trim()) return false;
  if (memory.status && memory.status !== 'approved') return false;
  if (memory.superseded_by) return false;
  if (memory.proactive_allowed === 0 || memory.proactive_allowed === false) return false;
  const confidence = Number(memory.confidence ?? 1);
  if (!Number.isFinite(confidence) || confidence < MEMORY_CONNECTIONS.minPatternConfidence) return false;
  const created = Date.parse(memory.created_at);
  if (Number.isFinite(created) && created > nowMs) return false;
  return distinctivePatternWords(memory.content).length >= 2;
}

/**
 * Find recurring themes across memories. Returns patterns sorted by
 * maturity (established first) then occurrence count:
 * [{ id, kind: 'drain'|'aspiration'|'avoidance'|'recurring', theme,
 *    occurrences: [memoryIds], maturity: 'emerging'|'established',
 *    firstSeen, lastSeen }].
 * A single memory is never a pattern — minimum two linked memories.
 */
export function detectMemoryPatterns({ memories, nowMs = Date.now() }) {
  const eligible = (memories || []).filter((m) => patternEligible(m, nowMs));
  if (eligible.length < 2) return [];
  const words = eligible.map((m) => distinctivePatternWords(m.content));
  // Union-find over memory pairs sharing >= 2 distinctive words.
  const parent = eligible.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  for (let i = 0; i < eligible.length; i++) {
    const setI = new Set(words[i]);
    for (let j = i + 1; j < eligible.length; j++) {
      let shared = 0;
      for (const w of words[j]) { if (setI.has(w) && ++shared >= 2) break; }
      if (shared >= 2) union(i, j);
    }
  }
  const groups = new Map();
  eligible.forEach((m, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(m);
  });
  const patterns = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    // Theme: most-shared distinctive words (frequency, then alphabetical for determinism).
    const freq = new Map();
    for (const m of sorted) for (const w of distinctivePatternWords(m.content)) freq.set(w, (freq.get(w) || 0) + 1);
    const sharedWords = [...freq.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const themeWords = sharedWords.slice(0, 3).map(([w]) => w);
    if (!themeWords.length) continue;
    const kind = classifyPatternTheme(sorted.map((m) => m.content));
    const theme = themeWords.join(' ');
    const occurrences = sorted.map((m) => m.id);
    const maturity = occurrences.length >= MEMORY_CONNECTIONS.establishedOccurrences ? 'established' : 'emerging';
    const slug = [...themeWords].sort().join('-').replace(/[^a-z0-9-]/g, '').slice(0, 60);
    patterns.push({
      id: `pattern:${kind}:${slug}`,
      kind,
      theme,
      occurrences,
      memories: sorted,
      maturity,
      firstSeen: String(sorted[0].created_at || '').slice(0, 10),
      lastSeen: String(sorted[sorted.length - 1].created_at || '').slice(0, 10),
    });
  }
  patterns.sort((a, b) =>
    (b.maturity === 'established') - (a.maturity === 'established') ||
    b.occurrences.length - a.occurrences.length ||
    (a.id < b.id ? -1 : 1));
  return patterns;
}

/**
 * New-vs-established phrasing. Emerging: tentative ("I'm starting to
 * notice…"); established: confident ("This keeps coming up…"). Pure.
 */
export function patternMaturityPhrase(maturity) {
  return maturity === 'established' ? 'This keeps coming up…' : 'I\u2019m starting to notice…';
}

// ---------------------------------------------------------------------------
// Choosing what to surface — the same graceful bar as proactive memory: at
// most one aside per turn, never mid-task (the caller skips tool-using
// turns), deduped via memory_surfacing with cooldowns, never repeated.
// Priority: time-sensitive dates > established patterns > established
// emotional patterns > emerging patterns > emerging emotional > open loops.
// ---------------------------------------------------------------------------

function priorSurfacing(surfacedRows, occurrenceKey, cooldownDays, nowMs) {
  const prior = (surfacedRows || []).find((r) => r.occurrence_key === occurrenceKey);
  if (!prior || !prior.surfaced_at) return false;
  const ageDays = (nowMs - new Date(prior.surfaced_at).valueOf()) / 86400_000;
  return Number.isFinite(ageDays) && ageDays < cooldownDays;
}

/**
 * Choose at most one memory-connection insight (theme pattern or emotional
 * pattern) for a chat aside. Pure given the surfaced rows.
 */
export function choosePatternSurfacing({ allMemories, surfacedRows = [], toneTrack = [], historyMessages = [], userMessage = '', nowMs = Date.now(), timeZone = 'America/New_York' }) {
  const candidates = [];
  const patterns = detectMemoryPatterns({ memories: allMemories, nowMs });
  for (const pattern of patterns) {
    const occurrenceKey = pattern.id;
    if (priorSurfacing(surfacedRows, occurrenceKey, MEMORY_CONNECTIONS.patternCooldownDays, nowMs)) continue;
    const evidence = pattern.memories.map((m) => m.content).join(' \n ');
    if (recentlyDiscussed(historyMessages, evidence)) continue;
    if (alreadyOnTopic(userMessage, pattern.theme)) continue;
    const representative = pattern.memories[pattern.memories.length - 1];
    candidates.push({
      kind: 'pattern', via: 'chat', occurrenceKey,
      memory: representative,
      reason: `${pattern.occurrences.length} related memories about \u201c${pattern.theme}\u201d (${patternMaturityPhrase(pattern.maturity)})`,
      pattern,
    });
    break; // one pattern candidate max — the strongest
  }
  const emotion = summarizeEmotionalPattern({ track: toneTrack, nowMs, timeZone });
  if (emotion) {
    const occurrenceKey = `emotion:${emotion.family}`;
    if (!priorSurfacing(surfacedRows, occurrenceKey, MEMORY_CONNECTIONS.emotionCooldownDays, nowMs) &&
        !recentlyDiscussed(historyMessages, emotion.phrase)) {
      candidates.push({
        kind: 'emotion', via: 'chat', occurrenceKey,
        memory: null,
        snapshot: emotion.phrase,
        reason: `emotional pattern: ${emotion.phrase}`,
        emotion,
      });
    }
  }
  if (!candidates.length) return null;
  const rank = (c) => {
    const m = c.kind === 'pattern' ? c.pattern.maturity : c.emotion.maturity;
    return (c.kind === 'pattern' ? 0 : 1) * 10 + (m === 'established' ? 0 : 1);
  };
  candidates.sort((a, b) => rank(a) - rank(b));
  return candidates[0];
}

/**
 * Unified chat surfacing: date triggers first (time-sensitive), then memory
 * connections / emotional patterns, then open loops. Same signature family
 * as chooseChatSurfacing plus toneTrack. Pure.
 */
export function chooseChatSurfacingWithPatterns({ allMemories, recalledMemories, personalDates = [], historyMessages = [], userMessage = '', surfacedKeys = new Set(), surfacedRows = [], toneTrack = [], nowMs = Date.now(), timeZone = 'America/New_York' }) {
  const dates = findDateCandidates({ memories: allMemories, personalDates, surfacedKeys, nowMs, timeZone });
  for (const candidate of dates) {
    if (recentlyDiscussed(historyMessages, candidate.memory.content)) continue;
    if (alreadyOnTopic(userMessage, candidate.memory.content)) continue;
    return { ...candidate, via: 'chat' };
  }
  const connection = choosePatternSurfacing({ allMemories, surfacedRows, toneTrack, historyMessages, userMessage, nowMs, timeZone });
  if (connection) return connection;
  const loops = findOpenLoopCandidates({ allMemories, recalledMemories, surfacedRows, historyMessages, userMessage, nowMs });
  if (loops.length) return { ...loops[0], via: 'chat' };
  return null;
}

// ---------------------------------------------------------------------------
// Prompt rendering. The model composes the actual insight from the evidence
// below — genuine observations, never fortune-cookie generalities. The
// honesty contract is rendered verbatim so the model cannot drift into
// claiming feelings ("I feel worried about you") — it says what it NOTICES.
// ---------------------------------------------------------------------------

/** Developer-prompt emotional context: grounds the LLM's own reading of the conversation. */
export function buildEmotionalContext({ userName, tone, emotionPhrase }) {
  const who = String(userName || '').trim();
  const whose = who ? `${who}\u2019s` : 'the user\u2019s';
  const subject = who || 'the user';
  const lines = [
    `Emotional read (a MODEL, not a feeling): you MODEL ${whose} emotional patterns — you do NOT feel emotions yourself. Never claim to feel anything (sad, worried, excited, proud); never perform distress or concern. Say what you NOTICE, never what you FEEL.`,
  ];
  if (emotionPhrase) lines.push(`Recent emotional pattern you\u2019ve noticed: ${emotionPhrase}`);
  if (tone && tone !== 'neutral') lines.push(`This turn ${subject} seems ${toneLabel(tone)}.`);
  lines.push('Let that quietly inform your tone and patience — a little warmer when they\u2019re heavy, matching their energy when they\u2019re up. Never announce it as a diagnosis, never moralize, never bring it up unless there\u2019s a genuine opening.');
  return lines.join('\n');
}

function kindGuidance(kind) {
  if (kind === 'drain') return 'This is about his energy — be curious about what\u2019s draining him, not prescriptive. Ask, don\u2019t lecture.';
  if (kind === 'avoidance') return 'This is uncomfortable by nature — use the honest-kindness pattern: plain observation + why it matters to them + ONE constructive path forward. Never judgment, never shaming, never a lecture.';
  if (kind === 'aspiration') return 'This is something he wants — be encouraging and concrete. Offer one small next step, not a plan.';
  return 'Keep it light and observational — a genuine connection you noticed, not a revelation.';
}

/** Prompt hint for a pattern/emotion aside. The model composes the insight from evidence. */
export function buildPatternHint({ kind, pattern, emotion, memory }) {
  if (kind === 'emotion' && emotion) {
    return `Pattern insight — you MAY share this ONE observation as a brief, natural aside near the end of your reply, but only if the conversation has a genuine opening for it; otherwise skip it silently and never force it. Never volunteer more than one insight per reply. Observation (a MODEL, not a feeling — you do not feel concern, you notice patterns): ${emotion.phrase} ${emotion.maturity === 'established' ? 'This keeps showing up — it\u2019s worth naming gently.' : 'It\u2019s early — phrase it tentatively, as something you\u2019re starting to notice, not a claim.'} Compose it in your own words from that observation — genuine and specific, never a fortune-cookie generality or a wellness platitude. If he\u2019s going through something, the honest-kindness pattern applies: plain observation + why it matters + one gentle, concrete offer (not advice he didn\u2019t ask for). Never present it as a diagnosis. If the user asks why you mentioned it, say you\u2019ve noticed a pattern in how he\u2019s been talking lately — modeled from his messages, not felt.`;
  }
  const p = pattern;
  const samples = p.memories.slice(-3).map((m) => `\u201c${String(m.content).slice(0, 160)}\u201d (saved ${String(m.created_at || '').slice(0, 10)})`).join('; ');
  const stance = p.maturity === 'established' ? 'This keeps coming up — name it plainly.' : 'This is early — lead with \u201cI\u2019m starting to notice\u2026\u201d, tentative, not a verdict.';
  return `Pattern insight — you MAY share this ONE observation as a brief, natural aside near the end of your reply, but only if the conversation has a genuine opening for it; otherwise skip it silently and never force it. Never volunteer more than one insight per reply. Observation (a MODEL, not a feeling — you do not feel concern, you notice patterns): ${p.occurrences.length} related memories, theme \u201c${p.theme}\u201d: ${samples}. ${stance} ${kindGuidance(p.kind)} Compose the insight in your own words from the evidence — genuine and specific, never a fortune-cookie generality. If the user asks why you mentioned it, say you noticed these memories connecting — and they can ask you to forget any of them anytime.`;
}

/** Dispatch to the right hint builder for any unified surfacing candidate. */
export function buildUnifiedHint(candidate) {
  if (!candidate) return null;
  if (candidate.kind === 'pattern' || candidate.kind === 'emotion') return buildPatternHint(candidate);
  return buildSurfacingHint(candidate);
}

// ---------------------------------------------------------------------------
// Chat-native honesty: "are you sad?" gets an honest no. Never performs
// distress, never claims a feeling — but stays warm (honest-soul pattern:
// honest observation + what IS true + an open door). Pure.
// ---------------------------------------------------------------------------

const EMOTION_WORDS = 'sad|happy|stressed|anxious|angry|upset|tired|exhausted|ok|okay|alright|fine|good|great|excited|lonely|bored|worried|frustrated|overwhelmed|depressed|burnt out|burned out|drained';
const HONESTY_RE = new RegExp(`^\\s*(are|r)\\s+you\\s+(feeling\\s+|really\\s+)?(${EMOTION_WORDS})\\s*\\??\\s*$`, 'i');
const HONESTY_FEEL_RE = new RegExp(`\\bdo\\s+you\\s+(feel|get)\\s+(${EMOTION_WORDS})\\b`, 'i');

/**
 * Returns a reply string for direct "are you <emotion>?" questions, else
 * null. The honest answer is no — stated plainly, warmly, without
 * performing anything.
 */
export function handleEmotionHonesty({ message, tone }) {
  const text = String(message || '').trim();
  if (!text || text.length > 200) return null;
  const m = HONESTY_RE.exec(text) || HONESTY_FEEL_RE.exec(text);
  if (!m) return null;
  // Never echo the feeling as our own, never perform distress — the honest
  // no comes first, then what's actually true, then a warm open door.
  let closer;
  if (tone && tone !== 'neutral' && tone !== 'excited' && tone !== 'celebratory') {
    closer = `You seem a bit ${toneLabel(tone)} right now, though — want to talk about it?`;
  } else if (tone === 'excited' || tone === 'celebratory') {
    closer = 'You seem to be in a good mood, though — what\u2019s going on?';
  } else {
    closer = 'How are you doing, for real?';
  }
  return `No — I don\u2019t feel things the way you do. I notice patterns in how you talk and I respond to them, but there\u2019s no feeling on my end — just attention. ${closer}`;
}

// ---------------------------------------------------------------------------
// Background push for established patterns only (3+ occurrences — emerging
// patterns stay as chat asides). Reuses the shared proactive pipeline:
// quiet hours + claimProactiveSlot (3/day cap) + deliverProactive
// (web/app + WhatsApp). Max one connection push per user per day. Never
// throws.
// ---------------------------------------------------------------------------

export async function runMemoryConnectionPush({ db, model, user, timeZone, nowMs, buddyName, claimSlot, releaseSlot, deliver }) {
  const today = todayInZone(validTimeZone(timeZone), nowMs);
  let memories = [];
  let surfacedRows = [];
  try {
    memories = db.listMemories(user.id);
    surfacedRows = db.listMemorySurfacings(user.id, 500);
  } catch (error) {
    console.error('memory connection read failed', error && error.message);
    return 0;
  }
  const track = loadEmotionalTrack(db, user.id);
  // Only established patterns qualify for a push — emerging ones are
  // chat-aside material only.
  const established = detectMemoryPatterns({ memories, nowMs })
    .filter((p) => p.maturity === 'established' && !priorSurfacing(surfacedRows, p.id, MEMORY_CONNECTIONS.patternCooldownDays, nowMs));
  const emotion = summarizeEmotionalPattern({ track, nowMs, timeZone });
  let candidate = null;
  if (established.length) {
    const p = established[0];
    const representative = p.memories[p.memories.length - 1];
    candidate = {
      kind: 'pattern', occurrenceKey: p.id, memory: representative,
      reason: `${p.occurrences.length} related memories about \u201c${p.theme}\u201d — this keeps coming up`,
      hint: buildPatternHint({ kind: 'pattern', pattern: p, memory: representative }),
      snapshot: representative.content,
      memoryCreatedAt: representative.created_at,
    };
  } else if (emotion && emotion.maturity === 'established' &&
      !priorSurfacing(surfacedRows, `emotion:${emotion.family}`, MEMORY_CONNECTIONS.emotionCooldownDays, nowMs)) {
    candidate = {
      kind: 'emotion', occurrenceKey: `emotion:${emotion.family}`, memory: null,
      reason: `emotional pattern: ${emotion.phrase}`,
      hint: buildPatternHint({ kind: 'emotion', emotion }),
      snapshot: emotion.phrase,
      memoryCreatedAt: null,
    };
  }
  if (!candidate) return 0;
  if (!claimSlot()) return 0;
  const displayName = user.display_name || 'there';
  const prompt = `Write a short, warm proactive message (2-3 sentences, plain text, no greeting header) sharing ONE genuine observation with ${displayName}, based on this evidence: ${candidate.hint}\n\nRules: be specific and grounded in the evidence — never a fortune-cookie generality. If it's uncomfortable, use honest kindness: plain observation + why it matters + one gentle constructive path, never judgment. HONESTY: you MODEL emotions, you do NOT feel them — never claim to feel anything, never perform concern; say what you notice. Sound like a thoughtful friend, not a notification. Do not mention that this is automated.`;
  let text;
  try {
    ({ text } = await model.respond({
      buddyName, userName: user.display_name, message: prompt,
      memories: candidate.memory ? [candidate.memory] : [], goals: [], history: [],
      userTimeZone: timeZone, taskMode: true,
    }));
  } catch (error) {
    console.error('memory connection compose failed', error && error.message);
    try { releaseSlot(); } catch {}
    return 0;
  }
  text = String(text || '').trim();
  if (!text) {
    try { releaseSlot(); } catch {}
    return 0;
  }
  try {
    await deliver(text, `Shared a memory-connection insight proactively (${candidate.reason}).`);
    recordConnectionSurfacing(db, user.id, candidate);
    db.addEvent(user.id, 'memory_connection_proactive', `Shared a pattern insight proactively (${candidate.reason}).`);
    return 1;
  } catch (error) {
    console.error('memory connection deliver failed', error && error.message);
    try { releaseSlot(); } catch {}
    return 0;
  }
}

/**
 * Record a pattern/emotion surfacing. The occurrence key is stable
 * (pattern kind+theme), so after the cooldown a re-surfacing must refresh
 * surfaced_at — recordMemorySurfacing is INSERT OR IGNORE, hence the touch.
 * Emotion rows use the 'emotion' memory_id sentinel (no FK on that column).
 */
export function recordConnectionSurfacing(db, userId, candidate) {
  const memoryId = candidate.kind === 'emotion' ? 'emotion' : (candidate.memory && candidate.memory.id) || 'pattern';
  db.recordMemorySurfacing(userId, {
    memoryId,
    occurrenceKey: candidate.occurrenceKey,
    kind: candidate.kind,
    via: candidate.via || 'proactive',
    reason: candidate.reason,
    contentSnapshot: candidate.snapshot || (candidate.memory && candidate.memory.content) || null,
    memoryCreatedAt: candidate.memoryCreatedAt || (candidate.memory && candidate.memory.created_at) || null,
  });
  try { db.touchMemorySurfacing(userId, candidate.occurrenceKey); } catch {}
}
