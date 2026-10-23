const WORD_RE = /[a-z0-9][a-z0-9'-]{1,}/gi;

const SECRET_PATTERNS = [
  { category: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i },
  { category: 'API key', pattern: /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/ },
  { category: 'access token', pattern: /\b(?:bearer\s+)?eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/i },
  { category: 'password', pattern: /\b(?:password|passwd|passcode|login code)\s*(?:is|=|:)\s*["']?[^\s"']{6,}["']?/i },
  { category: 'verification code', pattern: /\b(?:2fa|mfa|one[- ]time|verification|security)\s+(?:code|pin)\s*(?:is|=|:)?\s*\d{4,10}\b/i },
  { category: 'Social Security number', pattern: /\b(?:ssn|social security(?: number)?)\s*(?:is|=|:)?\s*\d{3}[- ]?\d{2}[- ]?\d{4}\b/i },
];

const SUPPORT_SIGNALS = {
  celebration: /\b(?:great news|good news|i did it|it worked|passed|approved|got the job|finished|finally|celebrat(?:e|ing)|proud of myself)\b/i,
  venting: /\b(?:i need to vent|let me vent|so frustrated|fed up|this sucks|i hate this|everything is going wrong|nothing works)\b/i,
  heavy: /\b(?:overwhelmed|stressed out|burnt? out|exhausted|lonely|upset|scared|worried|having a hard time|rough day)\b/i,
  decision: /\b(?:should i|help me decide|which (?:one|option)|pros and cons|choose between|what would you do)\b/i,
  planning: /\b(?:make a plan|plan (?:this|my|our)|roadmap|steps to|how do (?:i|we)|what should (?:i|we) do next)\b/i,
  reflection: /\b(?:why do i|patterns?|keep doing|what have you noticed|reflect|understand myself|what does this say about me)\b/i,
  action: /\b(?:remind me|schedule|create|add|save|remember|update|change|delete|send|build|fix|deploy|check)\b/i,
};

function words(value) {
  return String(value || '').toLowerCase().match(WORD_RE) || [];
}

function hasPaymentCard(value) {
  const candidates = String(value || '').match(/(?:\d[ -]*?){13,19}/g) || [];
  return candidates.some((candidate) => {
    const digits = candidate.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
    let sum = 0;
    let double = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      let digit = Number(digits[index]);
      if (double) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      double = !double;
    }
    return sum % 10 === 0;
  });
}

export function memoryPrivacyDecision(content) {
  const text = String(content || '').trim();
  if (!text) return { allowed: false, category: 'empty content' };
  for (const rule of SECRET_PATTERNS) {
    if (rule.pattern.test(text)) return { allowed: false, category: rule.category };
  }
  if (hasPaymentCard(text)) return { allowed: false, category: 'payment card number' };
  return { allowed: true, category: null };
}

export function assertMemorySafe(content) {
  const decision = memoryPrivacyDecision(content);
  if (decision.allowed) return String(content || '').trim();
  const error = new Error(`Orbit will not store ${decision.category} in memory. Keep credentials and identity numbers in a password manager instead.`);
  error.code = 'memory_sensitive_content';
  error.status = 400;
  throw error;
}

export function isProactiveMemoryAllowed(memory) {
  return memory?.proactive_allowed !== 0 && memory?.proactive_allowed !== false;
}

export function classifyRelationalTurn(message) {
  const text = String(message || '').trim();
  const length = text.length;
  const clauses = (text.match(/[.!?;:\n]/g) || []).length;
  const cognitiveLoad = length > 800 || clauses > 8 ? 'high' : length > 280 || clauses > 4 ? 'medium' : 'low';
  let intent = 'conversation';
  let supportMode = 'connect';
  if (SUPPORT_SIGNALS.celebration.test(text)) {
    intent = 'celebration'; supportMode = 'celebrate';
  } else if (SUPPORT_SIGNALS.venting.test(text)) {
    intent = 'venting'; supportMode = 'listen_then_offer';
  } else if (SUPPORT_SIGNALS.heavy.test(text)) {
    intent = 'emotional_support'; supportMode = 'validate_then_help';
  } else if (SUPPORT_SIGNALS.decision.test(text)) {
    intent = 'decision'; supportMode = 'clarify_then_compare';
  } else if (SUPPORT_SIGNALS.planning.test(text)) {
    intent = 'planning'; supportMode = 'make_one_clear_plan';
  } else if (SUPPORT_SIGNALS.reflection.test(text)) {
    intent = 'reflection'; supportMode = 'reflect_with_evidence';
  } else if (SUPPORT_SIGNALS.action.test(text)) {
    intent = 'action'; supportMode = 'act_then_confirm';
  } else if (/\?|^(?:what|when|where|why|how|who|which)\b/i.test(text)) {
    intent = 'information'; supportMode = 'answer_first';
  }
  return { intent, supportMode, cognitiveLoad };
}

const PLANNING_CONTEXT_INTENTS = new Set(['decision', 'planning', 'action', 'reflection']);
const PLANNING_CONTEXT_TERMS = /\b(?:goal|goals|project|projects|task|tasks|deadline|deadlines|progress|plan|plans|follow[ -]?up|check[ -]?in|commitment|commitments|due|schedule|scheduled|roadmap|milestone|milestones)\b/i;
const PLANNING_CONTEXT_PHRASES = /\b(?:where (?:do )?(?:things|we|i) stand|what(?:'s| is) next|what (?:am i|are we) working on|to[- ]?do|agenda|priorit(?:y|ies|ize)|schoolwork|homework|assignments?|classwork)\b/i;
const EMOTIONAL_HISTORY_INTENTS = new Set(['celebration', 'venting', 'emotional_support', 'reflection']);

// Keep costly relationship-context reads off ordinary turns without hiding
// that context when the user actually asks about plans, work, or patterns.
export function shouldLoadPlanningContext({ message, plan = null } = {}) {
  const resolved = plan || classifyRelationalTurn(message);
  const text = String(message || '');
  return PLANNING_CONTEXT_INTENTS.has(resolved.intent) || PLANNING_CONTEXT_TERMS.test(text) || PLANNING_CONTEXT_PHRASES.test(text);
}

export function shouldLoadEmotionalHistory({ message, plan = null } = {}) {
  const resolved = plan || classifyRelationalTurn(message);
  return EMOTIONAL_HISTORY_INTENTS.has(resolved.intent);
}

function relationshipMemories(memories) {
  return (memories || [])
    .filter((memory) => ['relationship', 'preference', 'decision'].includes(memory?.kind))
    .filter((memory) => memory?.content)
    .slice(0, 3)
    .map((memory) => String(memory.content).slice(0, 220));
}

function relevantCommitments(commitments, message) {
  const wanted = new Set(words(message).filter((word) => word.length > 3));
  const scored = (commitments || []).map((commitment) => {
    const text = String(commitment?.description || commitment?.title || '');
    const overlap = words(text).filter((word) => wanted.has(word)).length;
    return { commitment, text, overlap };
  }).filter((item) => item.text);
  scored.sort((a, b) => b.overlap - a.overlap || String(a.commitment.due_date || a.commitment.schedule_at || '').localeCompare(String(b.commitment.due_date || b.commitment.schedule_at || '')));
  return scored.filter((item, index) => item.overlap > 0 || index === 0).slice(0, 3).map((item) => item.commitment);
}

const SUPPORT_GUIDANCE = {
  celebrate: 'Celebrate the specific win with them before moving to next steps. Do not immediately turn the moment into a checklist.',
  listen_then_offer: 'Let them be heard first. Reflect the core frustration briefly, then ask whether they want listening or problem-solving unless they already requested a fix.',
  validate_then_help: 'Acknowledge what seems hard without diagnosing them. Offer one manageable next step, not a pile of advice.',
  clarify_then_compare: 'Name the decision and its main tradeoff, then give a grounded recommendation. Ask one question only if a missing fact would materially change it.',
  make_one_clear_plan: 'Give one coherent plan with the smallest useful next step. Keep alternatives secondary.',
  reflect_with_evidence: 'Reflect only patterns supported by the supplied conversation or memories. Phrase uncertainty plainly and invite correction.',
  act_then_confirm: 'Use an available tool when authorized and required. Claim completion only after the tool confirms it.',
  answer_first: 'Lead with the direct answer, then add only the context that helps.',
  connect: 'Respond naturally and stay with the user rather than forcing advice or a memory reference.',
};

export function buildRelationalDirective({ message, memories = [], commitments = [], plan = null } = {}) {
  const resolvedPlan = plan || classifyRelationalTurn(message);
  const continuity = relationshipMemories(memories);
  const open = relevantCommitments(commitments, message);
  const lines = [
    'Relational response plan (silent guidance; never describe this analysis to the user):',
    `- Primary intent: ${resolvedPlan.intent}; support mode: ${resolvedPlan.supportMode}; cognitive load: ${resolvedPlan.cognitiveLoad}.`,
    `- ${SUPPORT_GUIDANCE[resolvedPlan.supportMode]}`,
    '- Relate warmly without claiming consciousness or feelings. Say what you notice, understand, remember, or can do—not what you feel.',
    '- Before answering, silently check: answer the actual request; do not repeat the previous reply; do not invent memories; use at most one personal reference unless the user asks for a recap.',
  ];
  if (continuity.length) lines.push(`- Potential continuity cues (use only if directly relevant; never recite): ${continuity.map((item) => `“${item}”`).join('; ')}`);
  if (open.length) lines.push(`- Existing open commitments (do not duplicate or claim completion): ${open.map((item) => `${String(item.description || item.title).slice(0, 160)}${item.due_date || item.schedule_at ? ` (${item.due_date || item.schedule_at})` : ''}`).join('; ')}`);
  return lines.join('\n');
}

function tokenSet(value) {
  return new Set(words(value).filter((word) => word.length > 2));
}

function similarity(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / Math.max(left.size, right.size);
}

export function auditRelationalResponse({ response, history = [] } = {}) {
  const text = String(response || '').trim();
  const flags = [];
  if (/\b(?:i feel|i'm feeling|i am feeling|i'm worried|i am worried|i'm proud|i am proud|i'm sad|i am sad)\b/i.test(text)) flags.push('claimed_feeling');
  const previous = [...(history || [])].reverse().find((entry) => entry?.role === 'assistant' && entry?.content)?.content || '';
  if (text.length >= 80 && previous.length >= 80 && similarity(text, previous) >= 0.82) flags.push('near_duplicate');
  if (/\b(?:as you (?:always|usually) do|you always|you never)\b/i.test(text) && !history.length) flags.push('unsupported_pattern_claim');
  return { passed: flags.length === 0, flags };
}
