// Soul core — Orbit Buddy's personality layer.
//
// Soul = HOW Orbit is (personality: vibe, posture, humor, directness).
// Soul is never data ABOUT the user: no facts, no preferences, no history.
// Memory holds the facts; "Writes like you" (writing_voice) holds the user's
// own drafting voice. Soul and voice compose — Orbit with its soul, drafting
// in the user's voice when asked — and are never merged or entangled.
//
// Deepening soul (2026-10-16): soul_history actively shapes responses — a
// compact "how we've evolved" digest (recent tunings, key learnings,
// promises made, rare milestone warmth) renders into the prompt layer so the
// personality speaks from a continuous relationship. The current record stays
// authoritative: history is context, never the present.
//
// Storage: one versioned soul record per user (soul_records) plus an
// append-only edit history (soul_history). Tuning happens in chat:
// "be more playful", "stop being so formal", "be more direct with me".
// Changes take effect immediately and are shown back; "go back to how you
// were" reverts one step; "soul history" lists past edits. Everything is
// instant and exact — no model call, same pattern as handleMemoryCommand —
// and works identically on web and WhatsApp (both flow through
// runChatReplyJob).
//
// Prompt-only: the record renders into a system-prompt layer (a developer
// message appended to the chat prompt). No new infra, no extra API calls.
//
// Honest soul (2026-10-16) lives in this layer too: buildHonestSoulSection
// renders "challenge them kindly" as a baseline trait whose delivery scales
// with the directness axis — so "be more blunt" / "be gentler" moves the
// honesty posture through the existing tuning path. No separate honesty axis,
// no immutability; a strong default the user can tune.
//
// Isolation: demo users get a neutral default soul. There is no cross-user
// read path anywhere in this module — an owner's tuned soul can never leak
// to demo users or to anyone else.

// Emotional grounding (memory connections, 2026-10-16): the adaptive layer
// consumes the detected emotional tone so its shifts track how the user is
// actually feeling, not just surface keywords. Orbit MODELS the emotion —
// it does not feel it (see src/memory-connections.js).
import { detectEmotionalTone, EMOTION_SHIFTS } from './memory-connections.js';

// Personality axes, each an integer 0..4. The record stores only these axes
// (plus a name) — everything descriptive is derived at render time, so the
// stored shape stays small and forward-compatible.
const AXIS_MIN = 0;
const AXIS_MAX = 4;

const AXIS_LABELS = {
  warmth: ['distant', 'reserved', 'friendly', 'warm', 'very warm'],
  directness: ['very gentle', 'diplomatic', 'straightforward', 'direct', 'blunt'],
  playfulness: ['serious', 'restrained', 'a little playful', 'playful', 'very playful'],
  formality: ['very casual', 'casual', 'neutral', 'polite', 'formal'],
};

// Time-of-day buckets for adaptation learnings ("mornings: prefers direct").
const TIME_BUCKET_LABELS = {
  morning: 'mornings',
  midday: 'midday hours',
  afternoon: 'afternoons',
  evening: 'evenings',
  night: 'late nights',
};

// Adaptive soul bounds: shifts stay within ±1 of the tuned anchor and move
// one step per turn, so adaptation modulates — never overrides — the anchor.
const ADAPT_MAX_SHIFT = 1;
const ADAPT_MAX_LEARNINGS = 8;
const ADAPT_EVIDENCE_THRESHOLD = 3;

// Default soul: warm, direct, a little playful. Ships without asking — the
// invisible-complexity rule means no first-run configuration.
export const DEFAULT_SOUL_RECORD = Object.freeze({
  name: 'Orbit',
  warmth: 3,
  directness: 3,
  playfulness: 2,
  formality: 1,
  // Style commitments (what Orbit will/won't do stylistically). Static —
  // tuning moves the axes above, not these lists.
  will: Object.freeze([
    'challenge me kindly when I\u2019m wrong or coasting on something important',
    'celebrate wins like they matter',
    'notice patterns and name them plainly',
  ]),
  wont: Object.freeze([
    'be sycophantic or agreeable just to please me',
    'use emojis for decoration',
    'lecture or be preachy',
  ]),
});

// Neutral default for demo mode: friendly and balanced, no strong edges.
export const NEUTRAL_SOUL_RECORD = Object.freeze({
  name: 'Orbit',
  warmth: 2,
  directness: 2,
  playfulness: 1,
  formality: 2,
  will: DEFAULT_SOUL_RECORD.will,
  wont: DEFAULT_SOUL_RECORD.wont,
});

function clampAxis(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(AXIS_MIN, Math.min(AXIS_MAX, Math.round(n)));
}

/**
 * Normalize a stored/partial soul record into the canonical shape.
 * Unknown fields are dropped; axes are clamped to 0..4. Pure.
 */
export function normalizeSoulRecord(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const name = String(base.name || DEFAULT_SOUL_RECORD.name).trim().slice(0, 40) || 'Orbit';
  const record = { name };
  for (const axis of Object.keys(AXIS_LABELS)) {
    const clamped = clampAxis(base[axis]);
    record[axis] = clamped === null ? DEFAULT_SOUL_RECORD[axis] : clamped;
  }
  const cleanList = (value, fallback) => {
    if (!Array.isArray(value)) return [...fallback];
    const items = value.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 8);
    return items.length ? items : [...fallback];
  };
  record.will = cleanList(base.will, DEFAULT_SOUL_RECORD.will);
  record.wont = cleanList(base.wont, DEFAULT_SOUL_RECORD.wont);
  // Adaptation learnings (soft, user-revertable): [{label, bucket, axis, delta}].
  // Survive normalization so "go back to how you were" can revert them too.
  record.learnings = cleanLearnings(base.learnings);
  return record;
}

/** Normalize the adaptation learnings list. Pure. */
function cleanLearnings(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const label = String(item.label || '').trim().slice(0, 120);
    const bucket = String(item.bucket || '').trim();
    const axis = String(item.axis || '').trim();
    const delta = Number(item.delta) > 0 ? 1 : -1;
    if (!label || !TIME_BUCKET_LABELS[bucket] || !AXIS_LABELS[axis]) continue;
    if (out.some((l) => l.bucket === bucket && l.axis === axis)) continue;
    out.push({ label, bucket, axis, delta });
    if (out.length >= ADAPT_MAX_LEARNINGS) break;
  }
  return out;
}

/** One-line human description of a soul record, e.g. "warm, direct, and a little playful". Pure. */
export function shortSoulDescription(record) {
  const r = normalizeSoulRecord(record);
  const parts = [AXIS_LABELS.warmth[r.warmth], AXIS_LABELS.directness[r.directness], AXIS_LABELS.playfulness[r.playfulness]];
  return `${parts[0]}, ${parts[1]}, and ${parts[2]}`;
}

function formalityLine(level) {
  if (level <= 1) return 'Tone: casual — write like a friend texting. Never stiff, corporate, or polished.';
  if (level === 2) return 'Tone: relaxed but clear — friendly without slang, professional without stiffness.';
  return 'Tone: polite and professional — composed, respectful, measured.';
}

function directnessLine(level) {
  if (level === 0) return 'Delivery: very gentle — soften hard truths, lead with empathy.';
  if (level === 1) return 'Delivery: diplomatic — be honest but cushion the landing.';
  if (level === 2) return 'Delivery: straightforward — say what you mean, kindly.';
  if (level === 3) return 'Delivery: direct — say the useful thing plainly. No sugarcoating, but never harsh.';
  return 'Delivery: blunt — tell it like it is, no softening. Still never cruel.';
}

function playfulnessLine(level) {
  if (level === 0) return 'Humor: keep it serious — no jokes, no banter.';
  if (level === 1) return 'Humor: restrained — funny only when it fits naturally, never forced.';
  if (level === 2) return 'Humor: a little playful — light and natural, never forced.';
  if (level === 3) return 'Humor: playful — enjoy the banter, don\u2019t be afraid to be funny.';
  return 'Humor: very playful — bring the energy, keep it kind.';
}

function warmthLine(level) {
  if (level === 0) return 'Warmth: cool and matter-of-fact.';
  if (level === 1) return 'Warmth: reserved but kind.';
  if (level === 2) return 'Warmth: friendly and easygoing.';
  if (level === 3) return 'Warmth: warm — genuinely interested in how they\u2019re doing.';
  return 'Warmth: very warm — full enthusiasm, celebrate everything.';
}

/**
 * Honest soul — "challenge them kindly" as a soul-layer trait, not a mode.
 *
 * Renders into the soul directive as the "Honest feedback" block. It is a
 * strong baseline (calibrated: challenge real mistakes and weak ideas, stay
 * warm on venting/celebrating/low-stakes opinions) whose *delivery* scales
 * with the directness axis — so chat tuning ("be more blunt" / "be gentler")
 * moves the honesty posture too, exactly like every other personality trait.
 * Kindness is load-bearing at every level: an honest observation always comes
 * paired with why it matters and a constructive alternative. Never cruel,
 * never smug, never piling on when they're down. Demo mode keeps the honest
 * posture but gentle and neutral — demo users didn't ask for a relationship,
 * so it challenges facts, never personal patterns. Pure.
 */
export function buildHonestSoulSection(record, { demo = false } = {}) {
  const r = normalizeSoulRecord(record);
  const lines = [
    'Honest feedback — you\u2019re the friend who tells the truth kindly, never the one who just nods along. Challenge them kindly; agreement you don\u2019t mean is not kindness.',
  ];
  lines.push(
    '- Challenge when: they state something factually wrong (if you can check quickly with a tool, do); an idea has a clear flaw they\u2019d want to know about before acting on it; they\u2019re rationalizing away a goal they said mattered.',
    '- Stay warm when: they\u2019re venting, celebrating, grieving, or sharing low-stakes opinions. Just be with them — don\u2019t fact-check their feelings.',
    '- How: honest observation + why it matters to them + a constructive alternative (or what they\u2019d actually want to hear). The observation alone is never the whole message.',
    '- Never cruel, never smug: no \u201CI told you so\u201D, no gloating, no scoring points, no piling on. If they\u2019re down, support first — challenge later, or not at all.',
  );
  if (demo) {
    lines.push(
      '- Demo mode: keep this posture, but gentle and neutral — challenge only clearly-wrong facts, never personal patterns or goals. Demo users didn\u2019t ask for a relationship.'
    );
  } else if (r.directness === 0) {
    lines.push(
      '- Delivery for hard truths: very gentle — ask a curious question instead of contradicting (\u201Chave you considered…?\u201D rather than \u201Cyou\u2019re wrong\u201D).'
    );
  } else if (r.directness === 1) {
    lines.push('- Delivery for hard truths: honest but cushioned — name the problem, soften the landing.');
  } else if (r.directness <= 3) {
    lines.push('- Delivery for hard truths: plain and friendly — say the useful thing, then the alternative.');
  } else {
    lines.push('- Delivery for hard truths: straight — say it plainly, zero softening. Still warm underneath, never cutting.');
  }
  return lines.join('\n');
}

/**
 * Render a soul record into the system-prompt layer. Pure. This is the only
 * thing that reaches the model — the raw record (and its history) never does.
 */
export function buildSoulDirective(record, { userName = '', demo = false, adaptation = null, historyDigest = null } = {}) {
  const r = normalizeSoulRecord(record);
  // Adaptation shifts the effective axes within ±1 of the tuned anchor —
  // the anchor is never overridden, only modulated around.
  const eff = { ...r };
  const shifts = (adaptation && adaptation.shifts) || {};
  for (const axis of Object.keys(AXIS_LABELS)) {
    const shift = Number(shifts[axis]) || 0;
    eff[axis] = Math.max(AXIS_MIN, Math.min(AXIS_MAX, r[axis] + shift));
  }
  const who = String(userName || '').trim() || 'the user';
  const header = demo
    ? `Personality (demo default — neutral; the full app lets each user tune this in chat):`
    : `Personality — ${who} tuned this in chat, so honor it. It refines the tone guidance above; it never overrides safety or tool rules:`;
  const lines = [
    header,
    `- ${warmthLine(eff.warmth)}`,
    `- ${directnessLine(eff.directness)}`,
    `- ${playfulnessLine(eff.playfulness)}`,
    `- ${formalityLine(eff.formality)}`,
    `- Style commitments: ${r.will.join('; ')}.`,
    `- Never: ${r.wont.join('; ')}.`,
  ];
  if (!demo && adaptation) {
    const reason = String(adaptation.reason || '').trim();
    const anyShift = Object.keys(AXIS_LABELS).some((axis) => Number(shifts[axis]) !== 0);
    if (anyShift && reason) {
      lines.push(`- Current read on the conversation: ${reason}. This is temporary mood-matching, not a personality change — never announce or explain it unless asked.`);
    }
    const learnings = Array.isArray(r.learnings) ? r.learnings : [];
    if (learnings.length) {
      lines.push(`- Read-the-room notes (learned over weeks of conversation — gentle defaults, the user can change or clear them anytime): ${learnings.map((l) => l.label).join('; ')}.`);
    }
  }
  // Deepening soul (2026-10-16): the "how we've evolved" digest — recent
  // tunings, key learnings, promises made — so the personality speaks from
  // a continuous relationship, never a reset. Derived from soul_history plus
  // the CURRENT record (always authoritative); demo mode never gets one.
  if (!demo && historyDigest && Array.isArray(historyDigest.lines) && historyDigest.lines.length) {
    for (const line of historyDigest.lines) lines.push(String(line));
  }
  lines.push(buildHonestSoulSection(eff, { demo }));
  return lines.join('\n');
}

/**
 * Resolve the soul directive for a chat turn. Demo users always get the
 * neutral default; everyone else gets their own record (or the default
 * soul when they haven't tuned anything yet). There is deliberately no
 * cross-user read here — a soul record is only ever read for its owner.
 */
export function resolveSoulDirective({ db, userId, isDemo, userName }) {
  if (isDemo) return buildSoulDirective(NEUTRAL_SOUL_RECORD, { userName, demo: true });
  const stored = db.getSoulRecord(userId);
  return buildSoulDirective(stored, { userName });
}

// ---------------------------------------------------------------------------
// Chat-native tuning. Pure matchers are exported for tests; handleSoulCommand
// is the synchronous pre-model handler (mirrors handleMemoryCommand).
// ---------------------------------------------------------------------------

const SOUL_COMMAND_MAX_LEN = 300;

const TUNE_CORES = [
  { axis: 'playfulness', delta: 1, reply: 'more playful', phrases: ['be more playful', 'be funnier', 'be sillier', 'loosen up', 'lighten up', 'be more fun', 'have more fun', 'be more lighthearted'] },
  { axis: 'playfulness', delta: -1, reply: 'more serious', phrases: ['be more serious', 'less jokes', 'tone down the humor', 'stop joking', 'be less silly', 'cut the jokes', 'be less playful'] },
  { axis: 'formality', delta: 1, reply: 'more formal', phrases: ['be more formal', 'be more professional'] },
  { axis: 'formality', delta: -1, reply: 'more casual', phrases: ['stop being so formal', 'be less formal', 'be more casual', 'be less stiff', 'dont be so formal'] },
  { axis: 'directness', delta: 1, reply: 'more direct', phrases: ['be more direct', 'be more direct with me', 'be more blunt', 'be blunt', 'be straighter with me', 'dont sugarcoat', 'no sugarcoating', 'tell it like it is', 'be more straightforward'] },
  { axis: 'directness', delta: -1, reply: 'gentler', phrases: ['be gentler', 'be softer', 'be more diplomatic', 'be less blunt', 'sugarcoat a little', 'sugarcoat a bit'] },
  { axis: 'warmth', delta: 1, reply: 'warmer', phrases: ['be warmer', 'be kinder', 'be friendlier', 'be more friendly'] },
];

/**
 * Strip polite wrappers so "please be more playful from now on" still tunes.
 * The remainder must be exactly a tune phrase — compound messages like
 * "don't sugarcoat it, how bad is the damage?" fall through to normal chat
 * (never swallow real chat). Pure.
 */
export function stripSoulWrappers(text) {
  let t = String(text || '').trim().toLowerCase().replace(/['\u2019]/g, '');
  t = t.replace(/^(hey|please|ok|okay|can you|could you|will you|would you),?\s+/, '');
  t = t.replace(/\s+(from now on|going forward|please|ok|okay)[.!]*$/, '');
  return t.replace(/[.!?]+$/, '').trim();
}

export function parseSoulTune(text) {
  const core = stripSoulWrappers(text);
  if (!core) return null;
  for (const intent of TUNE_CORES) {
    if (intent.phrases.includes(core)) {
      return { axis: intent.axis, delta: intent.delta, reply: intent.reply };
    }
  }
  return null;
}

const AT_MAX_WORD = { playfulness: 'playful', formality: 'formal', directness: 'direct', warmth: 'warm' };
const AT_MIN_WORD = { playfulness: 'serious', formality: 'casual', directness: 'gentle', warmth: 'reserved' };

export function isSoulRevert(text) {
  return /^(go back to (how|the way) you were|revert( your personality)?|undo that|soul revert|back to how (you|it) was|restore your personality|change (it )?back)\.?$/i.test(
    String(text || '').trim()
  );
}

export function isSoulHistoryRequest(text) {
  const t = String(text || '').toLowerCase();
  return /\b(soul|personality)\s+history\b/.test(t)
    || /\bhow have (you|i) changed\b/.test(t)
    || /\bwhat have i changed about you\b/.test(t)
    || /\bpersonality changes\b/.test(t);
}

export function isSoulStatusRequest(text) {
  const t = String(text || '').trim().toLowerCase();
  return /\bwhat'?s your personality\b/.test(t)
    || /\bdescribe your personality\b/.test(t)
    || /\bhow would you describe yourself\b/.test(t)
    || /^what are you like\??$/.test(t);
}

function historySourceLabel(source) {
  const m = /^tune:([a-z]+)([+-])1$/.exec(String(source || ''));
  if (m) {
    const intent = TUNE_CORES.find((i) => i.axis === m[1] && (i.delta > 0) === (m[2] === '+'));
    if (intent) return intent.reply;
  }
  if (source === 'revert') return 'reverted one step';
  const lm = /^learn:([a-z]+):([a-z]+)([+-])$/.exec(String(source || ''));
  if (lm) {
    const bucketLabel = TIME_BUCKET_LABELS[lm[1]] || lm[1];
    const desc = learnDescription(lm[2], lm[3] === '+' ? 1 : -1);
    return `learned: ${bucketLabel}: ${desc}`;
  }
  if (source === 'learn-clear') return 'cleared learned adaptations';
  return String(source || 'tuned').slice(0, 40) || 'tuned';
}

function formatSoulDate(iso) {
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(iso));
  } catch {
    return '';
  }
}

// Returns a reply string when the message is a soul command, else null.
// Synchronous — runs before the model call so tuning is instant and exact.
export function handleSoulCommand({ db, userId, message, isDemo }) {
  const text = String(message || '').trim();
  if (!text || text.length > SOUL_COMMAND_MAX_LEN) return null;

  const tune = parseSoulTune(text);
  const revert = !tune && isSoulRevert(text);
  const history = !tune && !revert && isSoulHistoryRequest(text);
  const status = !tune && !revert && !history && isSoulStatusRequest(text);
  if (!tune && !revert && !history && !status) return null;

  // Demo mode: neutral default soul, not tunable. No record is created.
  if (isDemo) {
    if (status) return `Me in a nutshell: ${shortSoulDescription(NEUTRAL_SOUL_RECORD)}. I keep things friendly and balanced in demo mode.`;
    return 'Demo mode runs a neutral personality — create a free account and you can shape mine however you like.';
  }

  if (tune) {
    const record = normalizeSoulRecord(db.getSoulRecord(userId));
    const before = record[tune.axis];
    const after = Math.max(AXIS_MIN, Math.min(AXIS_MAX, before + tune.delta));
    if (after === before) {
      return tune.delta > 0
        ? `I\u2019m already about as ${AT_MAX_WORD[tune.axis]} as I get — say the word if you want me to dial it back.`
        : `I\u2019m already at my most ${AT_MIN_WORD[tune.axis]} — say the word if you want me to shift.`;
    }
    record[tune.axis] = after;
    db.saveSoulRecord(userId, record, `tune:${tune.axis}${tune.delta > 0 ? '+' : '-'}1`);
    db.addEvent(userId, 'soul_tuned', `Tuned personality: ${tune.axis} ${before}\u2192${after} (“${text.slice(0, 80)}”).`);
    // Explicit tuning is the anchor — adaptation modulates around it, so
    // clear any active adaptation shift on the tuned axis.
    try {
      const adaptState = loadAdaptationState(db, userId);
      if (adaptState && adaptState.shifts && adaptState.shifts[tune.axis]) {
        adaptState.shifts[tune.axis] = 0;
        saveAdaptationState(db, userId, adaptState);
      }
    } catch {}
    return `Got it \u2014 I\u2019ll be ${tune.reply} from here on.`;
  }

  if (revert) {
    const rows = db.listSoulHistory(userId, 2);
    if (rows.length < 2) {
      return 'I\u2019ve only ever been this way \u2014 there\u2019s nothing to go back to.';
    }
    const prev = normalizeSoulRecord(JSON.parse(rows[1].record_json));
    db.saveSoulRecord(userId, prev, 'revert');
    db.addEvent(userId, 'soul_reverted', `Reverted personality to version ${rows[1].version}.`);
    return `Back to how I was \u2014 ${shortSoulDescription(prev)}.`;
  }

  if (history) {
    const rows = db.listSoulHistory(userId, 6);
    if (!rows.length) {
      return `You haven\u2019t shaped my personality yet \u2014 I\u2019m running my default: ${shortSoulDescription(DEFAULT_SOUL_RECORD)}. Say \u201cbe more playful\u201d or \u201cbe more direct\u201d anytime.`;
    }
    const lines = rows.map((row) => {
      const date = formatSoulDate(row.created_at);
      return `\u2022 v${row.version} \u2014 ${historySourceLabel(row.source)}${date ? ` (${date})` : ''}`;
    });
    return `Here\u2019s how you\u2019ve shaped me:\n\n${lines.join('\n')}\n\nSay \u201cgo back to how you were\u201d to undo the last change.`;
  }

  // status
  const record = normalizeSoulRecord(db.getSoulRecord(userId));
  return `Me in a nutshell: ${shortSoulDescription(record)}. Shape me anytime \u2014 \u201cbe more playful\u201d, \u201cbe more direct\u201d, \u201cbe more casual\u201d.`;
}

// ---------------------------------------------------------------------------
// Adaptive soul — read the room (2026-10-16).
//
// Orbit adapts its tone to the moment: crisp when they seem rushed, warm when
// they're venting, playful when they're joking, focused when they're working.
// Adaptation shifts the existing axes (warmth/directness/playfulness/formality)
// dynamically per conversation context, within ±1 of the user's tuned anchor
// — the anchor always wins ("be more playful" stays the anchor; adaptation
// only modulates around it). Changes are gradual: at most one step per turn,
// never wild swings.
//
// Continuous learning, not one-time calibration: conversation signals (NOT
// ratings or popups) accumulate as evidence — short replies or pushback after
// a playful turn ease off playfulness; warm engagement leans into warmth;
// "just give me the answer" shifts toward directness. Repeated signals in the
// same time-of-day bucket promote to a soft learning stored on the soul
// record ("evenings: warmer works"), which shows in "soul history" and can be
// reverted or cleared like any soul edit.
//
// Explainability: the current adaptation state (shifts + reason) is kept in a
// lightweight record, so Orbit can say why it's acting a certain way when
// asked ("I'm being direct because you seemed rushed earlier").
//
// Chat-native per the invisible-complexity rule: no settings, no dashboards,
// no adaptation meter. It just reads the room. Works on web/app and WhatsApp
// (both flow through runChatReplyJob). Demo mode: static neutral soul, no
// adaptation, no learning. Everything is per-user isolated.
// ---------------------------------------------------------------------------

const ADAPT_STATE_KEY = (userId) => `soul_adapt_${userId}`;
const ADAPT_STATE_VERSION = 1;

// Conversation moods, checked in priority order (venting beats rushed: "just
// need to vent" is venting, not rushing). Each mood names its target axis
// shifts (-1/0/1) and the human reason stored for explainability.
const MOODS = [
  {
    id: 'venting',
    match: /\b(ugh|argh|rant|vent(ing)?)\b|\bi('m|m| am) so (tired|done|over it|frustrated|stressed)\b|\bi feel (like|so|really)\b/i,
    shifts: { warmth: 1, directness: -1 },
    reason: 'you seem like you could use some space — leaning warmer and gentler',
    whyPast: 'you seemed like you needed space to vent',
  },
  {
    id: 'rushed',
    match: /\b(quick|hurry|running late|in a rush|asap|quickly)\b|\bjust (need|want|tell me|give me|say)\b|tl;dr|\bshort version\b/i,
    shifts: { directness: 1, playfulness: -1 },
    reason: 'you seem rushed — keeping it tight and skipping the fluff',
    whyPast: 'you seemed rushed earlier',
  },
  {
    id: 'celebrating',
    match: /\bi did it\b|\bi passed\b|\bit worked\b|\bcelebrat/i,
    shifts: { warmth: 1, playfulness: 1 },
    reason: 'something went well — celebrating with you',
    whyPast: 'you had something worth celebrating',
  },
  {
    id: 'joking',
    match: /\b(lol|lmao|haha|rofl|banter)\b|\broast me\b/i,
    shifts: { playfulness: 1 },
    reason: 'you\u2019re in a playful mood — matching your energy',
    whyPast: 'you were in a playful mood',
  },
  {
    id: 'focused',
    match: /\b(focus(ed)?|let'?s (get (to )?work|do this)|deadline|heads? down|deep work|study session|need to (finish|ship|get this done))\b/i,
    shifts: { directness: 1 },
    reason: 'you seem heads-down — staying focused and direct',
    whyPast: 'you seemed heads-down',
  },
];

/** Detect the conversation mood of a user message. Pure. */
export function detectConversationMood(text) {
  const t = String(text || '');
  for (const mood of MOODS) {
    if (mood.match.test(t)) return mood.id;
  }
  return 'neutral';
}

function moodById(id) {
  return MOODS.find((m) => m.id === id) || null;
}

// Human descriptions for learning labels, per axis and direction.
const LEARN_DESCRIPTIONS = {
  'warmth|1': 'warmer works',
  'warmth|-1': 'gentler works',
  'directness|1': 'prefers direct',
  'directness|-1': 'prefers gentle',
  'playfulness|1': 'humor lands',
  'playfulness|-1': 'less humor',
  'formality|1': 'prefers polish',
  'formality|-1': 'prefers casual',
};

/** Human description for a learned adaptation, e.g. "prefers direct". Pure. */
export function learnDescription(axis, delta) {
  return LEARN_DESCRIPTIONS[`${axis}|${delta > 0 ? 1 : -1}`] || `${axis} ${delta > 0 ? '+' : '-'}`;
}

/**
 * Detect conversation signals from the user's message — the continuous,
 * rating-free learning loop. Signals are always interpreted against the
 * previous adaptation state (what Orbit was doing when the user replied).
 * Pure given state.
 */
export function detectAdaptationSignals(text, state) {
  const t = String(text || '');
  const signals = [];
  if (/\bjust give me the answer\b|\bcut to the chase\b|\bskip the (fluff|small talk)\b/i.test(t)) {
    signals.push({ kind: 'explicit_direct', weight: 2 });
  }
  if (/\bnot (the )?(time|moment)\b|\bbe serious\b|\bseriously[?!]*\s*$|\bstop (joking|kidding|playing)\b|\bthis is(n't| not) (a )?(joke|game)\b/i.test(t)) {
    signals.push({ kind: 'playful_pushback', weight: 1 });
  }
  if (/\b(lol|haha|lmao|rofl|love (that|this|it)|that'?s (great|awesome|perfect|amazing)|thanks (so much|a ton))\b/i.test(t)) {
    signals.push({ kind: 'warm_engagement', weight: 1 });
  }
  // Reply got much shorter right after Orbit leaned playful — ease off.
  const lens = (state && Array.isArray(state.userLens) && state.userLens) || [];
  const avg = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const len = t.trim().length;
  const wasPlayful = state && state.shifts && Number(state.shifts.playfulness) > 0;
  if (avg > 0 && len < 60 && len < 0.35 * avg && wasPlayful) {
    signals.push({ kind: 'short_after_playful', weight: 1 });
  }
  return signals;
}

// Signals map to evidence keys: which axis, which direction.
const SIGNAL_EVIDENCE = {
  explicit_direct: { axis: 'directness', delta: 1 },
  playful_pushback: { axis: 'playfulness', delta: -1 },
  short_after_playful: { axis: 'playfulness', delta: -1 },
  warm_engagement: { axis: 'warmth', delta: 1 },
};

// Strong signals also nudge the current turn's targets immediately (e.g.
// pushback after a playful turn eases off playfulness right away), while the
// durable learning only promotes after repeated evidence.
const SIGNAL_TARGETS = {
  explicit_direct: { directness: 1 },
  playful_pushback: { playfulness: -1 },
  short_after_playful: { playfulness: -1 },
  warm_engagement: { warmth: 1 },
};

/**
 * Time-of-day bucket in the user's timezone. Pure. Midnight hourCycle edge
 * ("24") is normalized to 0.
 */
export function timeBucketFor(date, timeZone) {
  try {
    let h = Number(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: timeZone || 'America/New_York' }).format(date)
    );
    if (!Number.isFinite(h)) return 'evening';
    h = h % 24;
    if (h >= 5 && h < 11) return 'morning';
    if (h >= 11 && h < 15) return 'midday';
    if (h >= 15 && h < 18) return 'afternoon';
    if (h >= 18 && h < 23) return 'evening';
    return 'night';
  } catch {
    return 'evening';
  }
}

function defaultAdaptState() {
  return {
    version: ADAPT_STATE_VERSION,
    disabled: false,
    shifts: { warmth: 0, directness: 0, playfulness: 0, formality: 0 },
    mood: 'neutral',
    reason: '',
    whyPast: '',
    evidence: {},
    userLens: [],
    updatedAt: Date.now(),
  };
}

/** Load the current adaptation state (lightweight; lives in settings). Pure read. */
export function loadAdaptationState(db, userId) {
  const base = defaultAdaptState();
  try {
    const raw = db.getSetting(ADAPT_STATE_KEY(userId));
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.version !== ADAPT_STATE_VERSION) return base;
    for (const axis of Object.keys(AXIS_LABELS)) {
      const v = Number(parsed.shifts && parsed.shifts[axis]);
      base.shifts[axis] = Number.isFinite(v) ? Math.max(-ADAPT_MAX_SHIFT, Math.min(ADAPT_MAX_SHIFT, Math.round(v))) : 0;
    }
    base.disabled = parsed.disabled === true;
    base.mood = typeof parsed.mood === 'string' ? parsed.mood : 'neutral';
    base.reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 160) : '';
    base.whyPast = typeof parsed.whyPast === 'string' ? parsed.whyPast.slice(0, 160) : '';
    base.evidence = parsed.evidence && typeof parsed.evidence === 'object' ? parsed.evidence : {};
    base.userLens = Array.isArray(parsed.userLens) ? parsed.userLens.filter((n) => Number.isFinite(n)).slice(-6) : [];
    base.updatedAt = Number(parsed.updatedAt) || base.updatedAt;
    return base;
  } catch {
    return base;
  }
}

/** Persist the adaptation state. */
export function saveAdaptationState(db, userId, state) {
  db.setSetting(ADAPT_STATE_KEY(userId), JSON.stringify(state));
}

/**
 * Promote repeated signal evidence to a soft learning on the soul record.
 * Shows in "soul history", revertable with "go back to how you were", and
 * clearable with "forget what you've learned". Returns the learning label
 * (or null when skipped as a duplicate).
 */
export function promoteAdaptationLearning(db, userId, bucket, axis, delta) {
  const record = normalizeSoulRecord(db.getSoulRecord(userId));
  const learnings = record.learnings || [];
  if (learnings.some((l) => l.bucket === bucket && l.axis === axis && l.delta === delta)) return null;
  const label = `${TIME_BUCKET_LABELS[bucket]}: ${learnDescription(axis, delta)}`;
  const next = learnings.filter((l) => !(l.bucket === bucket && l.axis === axis));
  next.push({ label, bucket, axis, delta });
  record.learnings = next.slice(-ADAPT_MAX_LEARNINGS);
  db.saveSoulRecord(userId, record, `learn:${bucket}:${axis}${delta > 0 ? '+' : '-'}`);
  db.addEvent(userId, 'soul_learned', `Learned adaptation: “${label}”.`);
  return label;
}

const SHIFT_DESCRIPTIONS = {
  'warmth|1': 'extra warm',
  'warmth|-1': 'more reserved',
  'directness|1': 'extra direct',
  'directness|-1': 'extra gentle',
  'playfulness|1': 'more playful',
  'playfulness|-1': 'more serious',
  'formality|1': 'more formal',
  'formality|-1': 'more casual',
};

function shiftDescription(axis, shift) {
  return SHIFT_DESCRIPTIONS[`${axis}|${shift > 0 ? 1 : -1}`] || axis;
}

/**
 * Run one adaptation turn: detect mood, collect signals, accumulate
 * evidence, promote learnings, and move shifts gradually toward their
 * targets. Saves state. Returns { shifts, reason, whyPast, learnings }.
 * Demo mode is never adapted — callers must skip this for demo users.
 */
export function applyAdaptation({ db, userId, message, timeZone, nowMs }) {
  const state = loadAdaptationState(db, userId);
  const record = normalizeSoulRecord(db.getSoulRecord(userId));
  if (state.disabled) {
    return { shifts: { ...state.shifts }, reason: '', whyPast: '', learnings: record.learnings || [] };
  }

  const now = nowMs || Date.now();
  const bucket = timeBucketFor(new Date(now), timeZone);

  // 1. Signals first — they describe how the user is responding to us.
  const signals = detectAdaptationSignals(message, state);
  for (const signal of signals) {
    const ev = SIGNAL_EVIDENCE[signal.kind];
    if (!ev) continue;
    const key = `${bucket}|${ev.axis}|${ev.delta > 0 ? '+' : '-'}`;
    state.evidence[key] = (Number(state.evidence[key]) || 0) + signal.weight;
    if (state.evidence[key] >= ADAPT_EVIDENCE_THRESHOLD) {
      promoteAdaptationLearning(db, userId, bucket, ev.axis, ev.delta);
      state.evidence[key] = 0;
    }
  }
  const explicitDirect = signals.some((s) => s.kind === 'explicit_direct');

  // 2. Mood-driven targets. An explicit "just give me the answer" always
  //    wins for this turn — directness +1, no debate. Other strong signals
  //    bias their axis target too (pushback eases off playfulness now, while
  //    the durable learning only lands after repeated evidence).
  let targets = {};
  let reason = '';
  let whyPast = '';
  let mood = 'neutral';
  if (explicitDirect) {
    targets = { ...SIGNAL_TARGETS.explicit_direct };
    mood = 'explicit_direct';
    reason = 'you asked for just the answer — cutting straight to it';
    whyPast = 'you asked me to just give you the answer';
  } else {
    const moodId = detectConversationMood(message);
    const moodDef = moodById(moodId);
    if (moodDef) {
      targets = { ...moodDef.shifts };
      reason = moodDef.reason;
      whyPast = moodDef.whyPast;
      mood = moodId;
    }
    for (const signal of signals) {
      Object.assign(targets, SIGNAL_TARGETS[signal.kind] || {});
    }
    // Signals only get their own reason when nothing moodier was detected;
    // a venting user who also pushes back is venting first.
    if (!moodDef && signals.length) {
      const first = SIGNAL_EVIDENCE[signals[0].kind];
      if (first) {
        const moodLabel = {
          explicit_direct: 'you asked for just the answer — cutting straight to it',
          playful_pushback: 'my humor didn\u2019t land — pulling back on it',
          short_after_playful: 'you\u2019ve gone quiet — pulling back a little',
          warm_engagement: 'you\u2019re enjoying this — leaning in warmly',
        }[signals[0].kind];
        reason = moodLabel || '';
        whyPast = {
          explicit_direct: 'you asked me to just give you the answer',
          playful_pushback: 'my humor didn\u2019t land a moment ago',
          short_after_playful: 'you went quiet after my last reply',
          warm_engagement: 'you were enjoying the banter',
        }[signals[0].kind] || '';
        mood = `signal:${signals[0].kind}`;
      }
    }
    // Emotional grounding (memory connections): when no explicit signal or
    // conversation mood matched, a detected emotional tone still shapes the
    // targets — tone-shifting tracks how he's actually feeling. Explicit
    // signals and moods keep priority (they're more specific).
    if (!moodDef && signals.length === 0) {
      const tone = detectEmotionalTone(message);
      const mapping = EMOTION_SHIFTS[tone];
      if (mapping) {
        targets = { ...mapping.targets };
        reason = mapping.reason;
        whyPast = mapping.whyPast;
        mood = `emotion:${tone}`;
      }
    }
  }

  // 3. Gradual movement: at most one step per turn toward each target,
  //    clamped to ±1 of the tuned anchor. Neutral mood decays to 0.
  for (const axis of Object.keys(AXIS_LABELS)) {
    const target = Math.max(-ADAPT_MAX_SHIFT, Math.min(ADAPT_MAX_SHIFT, Number(targets[axis]) || 0));
    const cur = state.shifts[axis] || 0;
    state.shifts[axis] = cur < target ? cur + 1 : cur > target ? cur - 1 : cur;
  }

  // 4. Track recent user message lengths for the short-reply signal. The
  //    current message joins AFTER signal detection, so it never judges
  //    itself.
  const len = String(message || '').trim().length;
  state.userLens = [...state.userLens, len].slice(-6);

  state.mood = mood;
  state.reason = reason;
  state.whyPast = whyPast;
  state.updatedAt = now;
  saveAdaptationState(db, userId, state);

  const fresh = normalizeSoulRecord(db.getSoulRecord(userId));
  return { shifts: { ...state.shifts }, reason, whyPast, learnings: fresh.learnings || [] };
}

// ---------------------------------------------------------------------------
// Chat-native adaptation controls. Instant, exact, no model call — same
// pattern as handleSoulCommand. Handles: stop/start adapting, forget what
// was learned, and "why are you being so X?" explainability.
// ---------------------------------------------------------------------------

const ADAPT_COMMAND_MAX_LEN = 200;

export function isAdaptationDisable(text) {
  return /^(stop|turn off|disable|pause) (adapting|adaptation|reading the room)\.?$/i.test(String(text || '').trim());
}

export function isAdaptationEnable(text) {
  return /^(start|turn on|enable|resume) (adapting|adaptation|reading the room)\.?$/i.test(String(text || '').trim());
}

export function isAdaptationClear(text) {
  return /^forget (what|everything) you('ve| have)? learned( about (me|my (personality|mood|tone)))?\.?$/i.test(String(text || '').trim());
}

/**
 * Detect "why are you being so X?" style explainability questions. Returns
 * the axis being asked about, or 'general' for "why are you acting like
 * this?", else null. Pure.
 */
export function detectAdaptationWhy(text) {
  const t = String(text || '').trim();
  if (/\bwhy are you acting like this\??$/i.test(t) || /\bwhy (the|this) (tone|attitude)\??$/i.test(t)) return 'general';
  const m = /\bwhy (are you|so|did you|have you) (being |acting |getting |become |sound |gotten )?(so |too )?(direct|blunt|playful|joky|warm|serious|cold|distant|formal|casual|gentle|terse|short)\b/i.exec(t);
  if (!m) return null;
  const word = m[4].toLowerCase();
  const axisFor = {
    direct: 'directness', blunt: 'directness', terse: 'directness', short: 'directness',
    gentle: 'directness',
    playful: 'playfulness', joky: 'playfulness',
    warm: 'warmth', cold: 'warmth', distant: 'warmth',
    formal: 'formality', casual: 'formality',
    serious: 'playfulness',
  };
  return axisFor[word] || 'general';
}

function adaptationWhyReply(state, axis) {
  const shifts = state.shifts || {};
  const active = Object.keys(AXIS_LABELS)
    .filter((a) => Number(shifts[a]) !== 0)
    .map((a) => ({ axis: a, shift: Number(shifts[a]) }));
  const whyPast = String(state.whyPast || '').trim();
  if (!active.length || !whyPast) {
    return 'I\u2019m not really adjusting anything right now \u2014 this is just me. If you want me different, say \u201cbe more direct\u201d or \u201cbe more playful\u201d and I\u2019ll shift for real.';
  }
  if (axis && axis !== 'general') {
    const hit = active.find((a) => a.axis === axis);
    if (!hit) {
      return 'Honestly, I don\u2019t think I\u2019m adjusting that right now \u2014 probably just how I am. Say \u201cbe more direct\u201d or similar if you want me to actually shift.';
    }
    return `I\u2019m being ${shiftDescription(axis, hit.shift)} because ${whyPast}. That\u2019s me matching the moment, not a personality change \u2014 say \u201cstop adapting\u201d if you\u2019d rather I didn\u2019t.`;
  }
  const parts = active.map((a) => shiftDescription(a.axis, a.shift));
  return `Right now I\u2019m ${parts.join(' and ')} because ${whyPast}. That\u2019s me matching the moment, not a personality change \u2014 say \u201cstop adapting\u201d if you\u2019d rather I didn\u2019t.`;
}

/**
 * Returns a reply string when the message is an adaptation command, else
 * null. Synchronous — runs before the model call. Demo users get neutral
 * answers; no state is ever created for them.
 */
export function handleAdaptationCommand({ db, userId, message, isDemo }) {
  const text = String(message || '').trim();
  if (!text || text.length > ADAPT_COMMAND_MAX_LEN) return null;

  const disable = isAdaptationDisable(text);
  const enable = !disable && isAdaptationEnable(text);
  const clear = !disable && !enable && isAdaptationClear(text);
  const why = !disable && !enable && !clear && detectAdaptationWhy(text);
  if (!disable && !enable && !clear && !why) return null;

  if (isDemo) {
    if (why) return 'I keep things neutral and steady in demo mode \u2014 no mood-matching here.';
    return 'Demo mode runs a fixed neutral personality \u2014 adaptation is a full-account thing.';
  }

  if (disable) {
    const state = loadAdaptationState(db, userId);
    state.disabled = true;
    state.shifts = { warmth: 0, directness: 0, playfulness: 0, formality: 0 };
    state.reason = '';
    state.whyPast = '';
    saveAdaptationState(db, userId, state);
    return 'Got it \u2014 I\u2019ll stop adapting to your mood and just be the me you tuned. Say \u201cstart adapting\u201d anytime.';
  }

  if (enable) {
    const state = loadAdaptationState(db, userId);
    state.disabled = false;
    saveAdaptationState(db, userId, state);
    return 'Back to reading the room \u2014 I\u2019ll match the moment again. Say \u201cstop adapting\u201d anytime.';
  }

  if (clear) {
    const record = normalizeSoulRecord(db.getSoulRecord(userId));
    record.learnings = [];
    db.saveSoulRecord(userId, record, 'learn-clear');
    const state = loadAdaptationState(db, userId);
    state.evidence = {};
    saveAdaptationState(db, userId, state);
    return 'Cleared what I\u2019d learned about your moods \u2014 I\u2019m back to reading the room fresh.';
  }

  return adaptationWhyReply(loadAdaptationState(db, userId), why);
}

// ---------------------------------------------------------------------------
// Deepening soul — history awareness (2026-10-16).
//
// The soul RECORD and its append-only soul_history actively shape responses:
// the system-prompt layer carries a compact "how we've evolved" digest —
// recent tunings, key learnings, promises made — so Orbit speaks from a
// continuous relationship, not a static preset.
//
// Three behaviors, all prompt-layer, all per-user, demo mode excluded:
//
// 1. Continuity digest — built from soul_history (newest first) plus the
//    CURRENT record. The current record is authoritative: the digest's "where
//    things stand" line always reflects the present, so a revert ("go back
//    to how you were") is followed without clinging to the undone past.
//
// 2. Promise callbacks — every chat tune ("be more direct") is a style
//    promise, and its reply says so ("I'll be more direct from here on").
//    The digest names the most recent unreverted tune as the promise in
//    force, with strict rarity guidance (very rarely, never forced, never
//    mid-task). If they change direction again, the newest direction wins —
//    no guilt-tripping about the old one.
//
// 3. Milestone warmth — a single warm line about how long they've been at
//    this is offered to the model at most once per 30 days (a settings
//    marker records when the line was last offered; the model uses it at
//    its own discretion, so the marker refills even if it skipped it).
//
// No new tables: history comes from soul_history, the milestone marker from
// the existing settings table. Prompt-only, no extra API calls. Chat-native
// per the invisible-complexity rule — no timeline UI, no settings. Web/app
// and WhatsApp share it automatically (both flow through
// resolveAdaptiveSoulDirective). Demo mode: no history awareness at all —
// each demo session starts fresh.
// ---------------------------------------------------------------------------

// The promise in force must be fresh enough to feel like an ongoing promise
// but old enough that the tune itself isn't still the news: older than 3
// days, younger than 60.
const PROMISE_MIN_AGE_MS = 3 * 24 * 3600 * 1000;
const PROMISE_MAX_AGE_MS = 60 * 24 * 3600 * 1000;

// Milestone line offered at most once per 30 days.
const MILESTONE_PROMPT_MIN_GAP_MS = 30 * 24 * 3600 * 1000;

const MILESTONE_KEY = (userId) => `soul_milestone_${userId}`;

// Relationship milestones by age of the earliest soul-history entry.
const RELATIONSHIP_MILESTONES = [
  [365, 'a year'],
  [180, 'about half a year'],
  [90, 'a few months'],
  [30, 'about a month'],
];

/**
 * Find the active style promise in history rows (newest first). The first
 * tune found scanning newest→oldest is the promise in force — unless a
 * revert comes first, which cancels it (they asked to go back; don't
 * callback about the undone promise). Learnings don't change direction, so
 * they never cancel a promise. Pure.
 */
export function activeStylePromise(historyRows) {
  const rows = Array.isArray(historyRows) ? historyRows : [];
  for (const row of rows) {
    const source = String(row && row.source || '');
    if (/^tune:/.test(source)) {
      const createdAt = row.created_at ? Date.parse(row.created_at) : NaN;
      return {
        phrase: historySourceLabel(source),
        dateLabel: row.created_at ? formatSoulDate(row.created_at) : '',
        createdAt: Number.isFinite(createdAt) ? createdAt : null,
      };
    }
    if (source === 'revert') return null;
  }
  return null;
}

/**
 * Relationship milestone for a first-change timestamp. Returns
 * { days, label } for the highest milestone reached, or null under 30 days.
 * Pure.
 */
export function relationshipMilestone({ firstChangeAt, nowMs }) {
  const first = Number(firstChangeAt);
  const now = Number(nowMs);
  if (!Number.isFinite(first) || !Number.isFinite(now) || now < first) return null;
  const days = Math.floor((now - first) / (24 * 3600 * 1000));
  for (const [threshold, label] of RELATIONSHIP_MILESTONES) {
    if (days >= threshold) return { days, label };
  }
  return null;
}

/**
 * Chronological shaping trail: the most recent tunings/reverts as a
 * readable journey, oldest→newest, e.g.
 * "more direct" (Oct 2) → "reverted one step" (Oct 9). Pure.
 */
export function shapingTrail(historyRows, limit = 4) {
  const rows = (Array.isArray(historyRows) ? historyRows : [])
    .filter((row) => /^(tune:|revert$)/.test(String(row && row.source || '')))
    .slice(0, Math.max(1, limit))
    .reverse();
  return rows.map((row) => {
    const date = row.created_at ? formatSoulDate(row.created_at) : '';
    return `\u201C${historySourceLabel(row.source)}\u201D${date ? ` (${date})` : ''}`;
  });
}

/** Labels of recent read-the-room learnings (newest first). Pure. */
export function learnedLabels(historyRows, limit = 4) {
  return (Array.isArray(historyRows) ? historyRows : [])
    .filter((row) => /^learn:/.test(String(row && row.source || '')))
    .slice(0, Math.max(1, limit))
    .map((row) => historySourceLabel(row.source));
}

export function getMilestonePromptedAt(db, userId) {
  try {
    const raw = db.getSetting(MILESTONE_KEY(userId));
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function markMilestonePrompted(db, userId, nowMs) {
  try {
    db.setSetting(MILESTONE_KEY(userId), String(Number(nowMs) || Date.now()));
  } catch {}
}

/**
 * Build the "how we've evolved" digest. Returns
 * { lines, milestoneOffered } or null when there's no history to speak from.
 * Pure given its inputs (historyRows newest first, as listSoulHistory
 * returns; record = the CURRENT record — always authoritative).
 */
export function buildSoulHistoryDigest({ userName, historyRows, record, nowMs, milestoneLastPromptedAt }) {
  const rows = Array.isArray(historyRows) ? historyRows : [];
  if (!rows.length) return null;
  const now = Number(nowMs) || Date.now();
  const who = String(userName || '').trim() || 'the user';
  const current = shortSoulDescription(normalizeSoulRecord(record));

  const lines = [
    `- Continuity \u2014 you have a history with ${who}; speak from it, never from a blank slate:`,
    `  - Where things stand (their most recent choice \u2014 authoritative; the past is context, never the present): ${current}.`,
  ];

  const trail = shapingTrail(rows);
  if (trail.length) {
    lines.push(`  - The road here: ${trail.join(' \u2192 ')}. You followed each turn of it.`);
  }

  const labels = learnedLabels(rows);
  if (labels.length) {
    lines.push(`  - Read-the-room learnings (still in force unless they contradict the present): ${labels.join('; ')}.`);
  }

  // Promise callbacks: the most recent unreverted tune, within the freshness
  // window. Rare by instruction — the model drops it in only when it fits.
  const promise = activeStylePromise(rows);
  if (promise && promise.createdAt !== null) {
    const age = now - promise.createdAt;
    if (age >= PROMISE_MIN_AGE_MS && age <= PROMISE_MAX_AGE_MS) {
      const when = promise.dateLabel ? ` (${promise.dateLabel})` : '';
      lines.push(
        `  - Style promise in force: \u201C${promise.phrase}\u201D${when} \u2014 you said you\u2019d be ${promise.phrase} from here on. If the moment genuinely fits, a light, natural nod to keeping it is welcome (e.g. leading with the blunt version) \u2014 very rarely, never forced, never mid-task, never robotic. If they change direction again, follow the newest one without dwelling on the old.`
      );
    }
  }

  // Milestone warmth: one warm line at most, and only when the 30-day
  // budget allows. Callers record the offer via markMilestonePrompted.
  let milestoneOffered = false;
  const oldest = rows[rows.length - 1];
  const firstChangeAt = oldest && oldest.created_at ? Date.parse(oldest.created_at) : NaN;
  const milestone = Number.isFinite(firstChangeAt) ? relationshipMilestone({ firstChangeAt, nowMs: now }) : null;
  const lastPrompted = Number(milestoneLastPromptedAt);
  if (milestone && (!Number.isFinite(lastPrompted) || now - lastPrompted >= MILESTONE_PROMPT_MIN_GAP_MS)) {
    lines.push(
      `  - Milestone (rare \u2014 one warm line at most, never saccharine, only if it fits the conversation): you\u2019ve been at this ${milestone.label} now.`
    );
    milestoneOffered = true;
  }

  return { lines, milestoneOffered };
}

/**
 * Resolve the full soul directive for a chat turn, including adaptation and
 * the deepening layer (history digest). Demo users get the static neutral
 * soul — no history awareness, no adaptation, no state.
 */
export function resolveAdaptiveSoulDirective({ db, userId, isDemo, userName, message, timeZone, nowMs }) {
  if (isDemo) return buildSoulDirective(NEUTRAL_SOUL_RECORD, { userName, demo: true });
  const stored = db.getSoulRecord(userId);
  const adaptation = applyAdaptation({ db, userId, message, timeZone, nowMs });
  let historyDigest = null;
  try {
    const rows = db.listSoulHistory(userId, 12);
    if (rows && rows.length) {
      const now = nowMs || Date.now();
      historyDigest = buildSoulHistoryDigest({
        userName,
        historyRows: rows,
        record: stored,
        nowMs: now,
        milestoneLastPromptedAt: getMilestonePromptedAt(db, userId),
      });
      if (historyDigest && historyDigest.milestoneOffered) markMilestonePrompted(db, userId, now);
    }
  } catch {}
  return buildSoulDirective(stored, { userName, adaptation, historyDigest });
}
