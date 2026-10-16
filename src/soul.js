// Soul core — Orbit Buddy's personality layer.
//
// Soul = HOW Orbit is (personality: vibe, posture, humor, directness).
// Soul is never data ABOUT the user: no facts, no preferences, no history.
// Memory holds the facts; "Writes like you" (writing_voice) holds the user's
// own drafting voice. Soul and voice compose — Orbit with its soul, drafting
// in the user's voice when asked — and are never merged or entangled.
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
// Isolation: demo users get a neutral default soul. There is no cross-user
// read path anywhere in this module — an owner's tuned soul can never leak
// to demo users or to anyone else.

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
  return record;
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
 * Render a soul record into the system-prompt layer. Pure. This is the only
 * thing that reaches the model — the raw record (and its history) never does.
 */
export function buildSoulDirective(record, { userName = '', demo = false } = {}) {
  const r = normalizeSoulRecord(record);
  const who = String(userName || '').trim() || 'the user';
  const header = demo
    ? `Personality (demo default — neutral; the full app lets each user tune this in chat):`
    : `Personality — ${who} tuned this in chat, so honor it. It refines the tone guidance above; it never overrides safety or tool rules:`;
  return [
    header,
    `- ${warmthLine(r.warmth)}`,
    `- ${directnessLine(r.directness)}`,
    `- ${playfulnessLine(r.playfulness)}`,
    `- ${formalityLine(r.formality)}`,
    `- Style commitments: ${r.will.join('; ')}.`,
    `- Never: ${r.wont.join('; ')}.`,
  ].join('\n');
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
