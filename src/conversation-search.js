export function searchMessages(messages, query, limit = 20, filters = null) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const results = [];
  const terms = q.split(/\s+/).filter((t) => t.length > 1);
  for (const message of applySearchFilters(messages, filters)) {
    const content = String(message?.content || '');
    const lower = content.toLowerCase();
    let matchCount = 0;
    for (const term of terms) {
      let idx = lower.indexOf(term);
      while (idx !== -1) {
        matchCount++;
        idx = lower.indexOf(term, idx + term.length);
      }
    }
    if (matchCount === 0) continue;
    const firstIdx = lower.indexOf(terms[0]);
    const start = Math.max(0, firstIdx - 60);
    const end = Math.min(content.length, firstIdx + 90);
    let excerpt = content.slice(start, end);
    if (start > 0) excerpt = '...' + excerpt;
    if (end < content.length) excerpt = excerpt + '...';
    const created = new Date(message?.created_at || 0).valueOf();
    const ageDays = Math.max(0, (Date.now() - created) / 86400000);
    const recencyBoost = 1 / (1 + ageDays / 30);
    const score = matchCount + recencyBoost;
    results.push({ message, excerpt, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, Math.max(1, limit));
}

export function formatSearchResults(results) {
  return (results || []).map(({ message, excerpt }) => {
    const d = new Date(message?.created_at || 0);
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `${ts} — ${excerpt}`;
  });
}

// Structured companion to formatSearchResults: the fields the web app needs
// to jump to a result's message in its conversation. Purely additive — the
// string format above is unchanged.
export function formatSearchItems(results) {
  return (results || []).map(({ message, excerpt }) => ({
    id: message?.id || null,
    conversationId: message?.conversation_id || null,
    role: message?.role || null,
    createdAt: message?.created_at || null,
    excerpt,
  }));
}

// --- L4 search v2: content-type classifier + filter plumbing ---

// Pure classifier: 'code' for messages that carry fenced code blocks or
// strong code signals, 'prose' for everything else.
export function classifyContentType(content) {
  const text = String(content || '');
  if (!text.trim()) return 'prose';
  // Fenced code blocks: a matched pair of ``` markers.
  const fences = text.match(/```/g);
  if (fences && fences.length >= 2) return 'code';
  // Indented code blocks: 2+ lines starting with 4 spaces or a tab.
  const indented = text.split('\n').filter((line) => /^( {4,}|\t+)/.test(line));
  if (indented.length >= 2) return 'code';
  // Inline code heavy: 3+ `spans` means the message is code-forward.
  const spans = text.match(/`[^`\n]+`/g);
  if (spans && spans.length >= 3) return 'code';
  // Strong code signals: declaration/arrow/semicolon lines.
  const signalLines = text.split('\n').filter((line) => (
    /^\s*(function\s+\w|const\s+[\w$]+\s*=|let\s+[\w$]+\s*=|var\s+[\w$]+\s*=|def\s+\w+\s*\(|class\s+\w+|import\s+[\w{*] |from\s+\S+\s+import|#include\s*<)/.test(line)
    || (/(=>|;\s*$)/.test(line) && /[{}()[\]=;]/.test(line))
  ));
  if (signalLines.length >= 2) return 'code';
  return 'prose';
}

// Strict YYYY-MM-DD validation (calendar-aware, same semantics as
// validDateString in intelligence.js; kept dependency-free and pure).
export function isValidSearchDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return false;
  const [, year, month, day] = match;
  const check = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return check.getUTCFullYear() === Number(year)
    && check.getUTCMonth() === Number(month) - 1
    && check.getUTCDate() === Number(day);
}

// Parse + validate the optional filter params for GET /api/search/messages.
// Throws {status:400} on garbage, {status:404} when conversationId is not
// one of this user's conversations. Returns a filters object ({} when none).
export function parseSearchFilterParams(params, { conversationExists } = {}) {
  const get = typeof params?.get === 'function' ? (k) => params.get(k) : (k) => params?.[k] ?? null;
  const raw = (k) => {
    const v = get(k);
    return v === null || v === undefined || v === '' ? null : String(v).trim();
  };
  const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
  const from = raw('from');
  const to = raw('to');
  if (from && !isValidSearchDate(from)) throw badRequest('Invalid "from": expected YYYY-MM-DD.');
  if (to && !isValidSearchDate(to)) throw badRequest('Invalid "to": expected YYYY-MM-DD.');
  if (from && to && from > to) throw badRequest('Invalid range: "from" must not be after "to".');
  const type = (raw('type') || 'all').toLowerCase();
  if (!['all', 'code', 'prose'].includes(type)) {
    throw badRequest('Invalid "type": expected all, code, or prose.');
  }
  const conversationId = raw('conversationId');
  if (conversationId && conversationExists && !conversationExists(conversationId)) {
    throw Object.assign(new Error('Conversation not found.'), { status: 404 });
  }
  const filters = {};
  if (from) filters.from = from;
  if (to) filters.to = to;
  if (conversationId) filters.conversationId = conversationId;
  if (type !== 'all') filters.type = type;
  return filters;
}

// Apply parsed filters to a message list BEFORE scoring. Empty/null filters
// return the list untouched, so the unfiltered search behaves exactly as before.
export function applySearchFilters(messages, filters = null) {
  const list = messages || [];
  if (!filters || (!filters.from && !filters.to && !filters.conversationId && !filters.type)) return list;
  const fromMs = filters.from ? Date.parse(`${filters.from}T00:00:00Z`) : null;
  const toMs = filters.to ? Date.parse(`${filters.to}T23:59:59.999Z`) : null;
  const wantType = filters.type && filters.type !== 'all' ? filters.type : null;
  return list.filter((m) => {
    if (filters.conversationId && m?.conversation_id !== filters.conversationId) return false;
    if (fromMs !== null || toMs !== null) {
      const ms = m?.created_at ? new Date(m.created_at).valueOf() : NaN;
      if (!Number.isFinite(ms)) return false;
      if (fromMs !== null && ms < fromMs) return false;
      if (toMs !== null && ms > toMs) return false;
    }
    if (wantType && classifyContentType(m?.content) !== wantType) return false;
    return true;
  });
}
