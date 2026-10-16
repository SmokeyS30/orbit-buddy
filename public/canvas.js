// Orbit Buddy Canvas — documents, not walls of text.
//
// When Orbit produces something substantial (a study plan, trip itinerary,
// project plan, comparison table), the chat bubble is replaced by a persistent,
// beautifully typeset document panel. Detection is automatic from the response
// shape — no buttons, no toggles.
//
// Print/PDF/share go through the existing printable-document flow: the chat
// commands "print this" / "share this" open a printable page for the latest
// canvas document in the conversation. "Revise this" needs no special
// handling — the document is an ordinary assistant message, so the revision
// request resolves against conversation history.

/** Structural analysis of a message, for canvas detection. Pure. */
export function canvasScore(content) {
  const s = String(content || '');
  const headings = (s.match(/^#{1,3}\s+\S/gm) || []).length;
  const tableLines = (s.match(/^\s*\|.*\|\s*$/gm) || []).length;
  const tables = tableLines >= 2 ? 1 : 0; // header + at least one row
  const lists = (s.match(/^\s*(?:[-*+]|\d+[.)])\s+\S/gm) || []).length;
  const fences = Math.floor(((s.match(/^```/gm) || []).length) / 2);
  return { length: s.length, headings, tables, lists, fences };
}

/**
 * A message is canvas-worthy when it is long AND structured: a document,
 * not a long paragraph. Thresholds are deliberately high so ordinary long
 * replies stay as chat bubbles.
 */
export function isCanvasWorthy(content) {
  const c = canvasScore(content);
  if (c.length < 1200) return false;
  const structure = c.headings + c.tables * 2 + Math.min(c.lists / 4, 2) + c.fences;
  return structure >= 3;
}

/** Title for the document panel: first heading, else the first real line. */
export function canvasTitle(content) {
  const s = String(content || '');
  const clean = (t) => t.replace(/[*_`~#]/g, '').trim().slice(0, 80);
  const h = /^#{1,3}\s+(.+)$/m.exec(s);
  if (h && clean(h[1])) return clean(h[1]);
  for (const line of s.split('\n')) {
    const t = clean(line);
    if (t.length >= 8) return t;
  }
  return 'Document';
}

/** Chat commands that act on the latest canvas document. Pure. */
export function isCanvasCommand(text) {
  const t = String(text || '').trim();
  return (
    /^(print|pdf)\s+(this|it|the\s+(document|doc|plan|itinerary|canvas))[\s.!?]*$/i.test(t) ||
    /^make\s+a\s+pdf\s+of\s+this[\s.!?]*$/i.test(t) ||
    /^share\s+(this|it|the\s+(document|doc|plan|itinerary))[\s.!?]*$/i.test(t)
  );
}

/** Find the most recent canvas-worthy assistant message. Pure. */
export function findLatestCanvasMessage(messages) {
  const items = Array.isArray(messages) ? messages : [];
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i];
    if (m && m.role === 'assistant' && isCanvasWorthy(m.content)) {
      return { id: m.id || null, content: m.content, title: canvasTitle(m.content) };
    }
  }
  return null;
}

/**
 * Line-based diff of two texts. Pure. Returns an ordered op list:
 * {type:'same'|'del'|'add', text}. Simple LCS over lines; inputs whose
 * line-count product exceeds the cap degrade to whole-document replace.
 */
export function lineDiff(oldText, newText) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  const finish = (ops) => ops;
  if (a.length * b.length > 250000) {
    if (String(oldText ?? '') === String(newText ?? '')) return finish(a.map((text) => ({ type: 'same', text })));
    return finish([...a.map((text) => ({ type: 'del', text })), ...b.map((text) => ({ type: 'add', text }))]);
  }
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'del', text: a[i] }); i++; }
    else { ops.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) { ops.push({ type: 'del', text: a[i] }); i++; }
  while (j < m) { ops.push({ type: 'add', text: b[j] }); j++; }
  return ops;
}
