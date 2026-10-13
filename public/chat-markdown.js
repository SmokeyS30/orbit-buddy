// Markdown rendering for assistant chat messages.
// Pipeline: marked (parse) -> DOMPurify (sanitize) -> bare-URL autolink ->
// copy buttons on code blocks. Fail-safe by design: any step that cannot run
// returns null/false and the caller falls back to plain textContent rendering,
// so a missing/blocked vendor lib can never produce unsanitized HTML.
//
// Security note: raw HTML in model output is stripped by DOMPurify *after*
// parsing (the standard, safe place to do it). DOMPurify's defaults remove
// scripts, event handlers, and dangerous URL schemes; we additionally forbid
// a few structural tags and force external links to open safely.

const MARKED_OPTIONS = { breaks: true, gfm: true };

// Tags that have no business inside a chat bubble, even if "safe".
const FORBID_TAGS = ['style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'video', 'audio'];

function globalScope() {
  if (typeof window !== 'undefined') return window;
  return typeof globalThis !== 'undefined' ? globalThis : {};
}

// Resolve the marked parse function from a UMD global or an injected dep.
function resolveParse(markedLib) {
  if (!markedLib) return null;
  if (typeof markedLib.parse === 'function') return markedLib.parse.bind(markedLib);
  if (typeof markedLib.marked === 'function') return markedLib.marked;
  if (typeof markedLib === 'function') return markedLib;
  return null;
}

// Resolve a bound DOMPurify instance from a UMD global or an injected dep.
function resolvePurify(deps) {
  const scope = globalScope();
  const candidate = deps.DOMPurify || deps.dompurify || scope.DOMPurify || null;
  if (!candidate) return null;
  if (typeof candidate.sanitize === 'function') return candidate; // browser UMD: already bound
  if (typeof candidate === 'function') {
    try {
      const instance = candidate(scope.window || scope);
      if (instance && typeof instance.sanitize === 'function') return instance;
    } catch (_) { /* fall through */ }
  }
  return null;
}

/** Parse markdown to HTML. Returns null when marked is unavailable or throws. */
export function markdownToHtml(source, deps = {}) {
  const parse = resolveParse(deps.marked || globalScope().marked || null);
  if (!parse) return null;
  try {
    return parse(String(source ?? ''), MARKED_OPTIONS);
  } catch (_) {
    return null;
  }
}

/** Sanitize parsed HTML. Returns null when DOMPurify is unavailable or throws. */
export function sanitizeHtml(html, deps = {}) {
  const purify = resolvePurify(deps);
  if (!purify) return null;
  try {
    return purify.sanitize(String(html ?? ''), { FORBID_TAGS });
  } catch (_) {
    return null;
  }
}

// Matches http(s)://... and www.... URLs in plain text. The match may include
// trailing punctuation or unbalanced brackets; linkifySegments trims those.
const URL_PATTERN = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;

// Trim trailing sentence punctuation and unbalanced closing brackets/parens
// from a candidate URL (e.g. "see https://a.b/c." or "(https://a.b/c)").
function trimUrlEnd(url) {
  let end = url.length;
  while (end > 0 && /[.,;:!?\]]/.test(url[end - 1])) end--;
  let depth = 0;
  for (let i = 0; i < end; i++) {
    if (url[i] === '(') depth++;
    else if (url[i] === ')') depth--;
  }
  while (end > 0 && url[end - 1] === ')' && depth < 0) { end--; depth++; }
  return url.slice(0, end);
}

/**
 * Split plain text into {type:'text'|'link'} segments for autolinking.
 * Pure function (no DOM) so it is unit-testable.
 */
export function linkifySegments(text) {
  const segments = [];
  const input = String(text ?? '');
  URL_PATTERN.lastIndex = 0;
  let last = 0;
  let match;
  while ((match = URL_PATTERN.exec(input)) !== null) {
    const url = trimUrlEnd(match[0]);
    if (match.index > last) segments.push({ type: 'text', value: input.slice(last, match.index) });
    if (url) {
      segments.push({
        type: 'link',
        href: url.startsWith('www.') ? `https://${url}` : url,
        label: url,
      });
    }
    last = match.index + url.length;
  }
  if (last < input.length) segments.push({ type: 'text', value: input.slice(last) });
  return segments;
}

function getDocument(deps) {
  if (deps.document) return deps.document;
  return typeof document !== 'undefined' ? document : null;
}

/**
 * Autolink bare URLs in text nodes, skipping nodes already inside links,
 * code, or pre blocks (marked's own autolinker handles most cases; this is
 * the safety net for URLs it misses). Returns the number of links created.
 */
export function autolinkTextNodes(root, deps = {}) {
  const doc = getDocument(deps);
  if (!doc || !root || typeof doc.createTreeWalker !== 'function') return 0;
  const SHOW_TEXT = 4;
  const FILTER_ACCEPT = 1;
  const FILTER_REJECT = 2;
  const walker = doc.createTreeWalker(root, SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('a, pre, code')) return FILTER_REJECT;
      return FILTER_ACCEPT;
    },
  });
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);
  let created = 0;
  for (const textNode of textNodes) {
    const segments = linkifySegments(textNode.nodeValue);
    if (!segments.some((s) => s.type === 'link')) continue;
    const fragment = doc.createDocumentFragment();
    for (const segment of segments) {
      if (segment.type === 'link') {
        const anchor = doc.createElement('a');
        anchor.href = segment.href;
        anchor.textContent = segment.label;
        fragment.appendChild(anchor);
        created++;
      } else {
        fragment.appendChild(doc.createTextNode(segment.value));
      }
    }
    textNode.replaceWith(fragment);
  }
  return created;
}

/** Force every link in the message to open in a new tab, safely. */
export function hardenLinks(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  let count = 0;
  for (const anchor of root.querySelectorAll('a[href]')) {
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
    count++;
  }
  return count;
}

/** Copy text to the clipboard, with a textarea fallback. Resolves true on success. */
export async function copyText(text, nav, doc) {
  const navigatorRef = nav || (typeof navigator !== 'undefined' ? navigator : null);
  const docRef = doc || getDocument({});
  try {
    if (navigatorRef && navigatorRef.clipboard && typeof navigatorRef.clipboard.writeText === 'function') {
      await navigatorRef.clipboard.writeText(String(text ?? ''));
      return true;
    }
  } catch (_) { /* fall through to legacy path */ }
  try {
    if (!docRef || !docRef.body || typeof docRef.execCommand !== 'function') return false;
    const area = docRef.createElement('textarea');
    area.value = String(text ?? '');
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    docRef.body.appendChild(area);
    area.select();
    const ok = docRef.execCommand('copy');
    area.remove();
    return !!ok;
  } catch (_) {
    return false;
  }
}

/**
 * Wrap each <pre> in a .codeblock container with a small Copy button.
 * Idempotent: skips pres that are already wrapped. Returns buttons added.
 */
export function decorateCodeBlocks(root, deps = {}) {
  const doc = getDocument(deps);
  if (!doc || !root || typeof root.querySelectorAll !== 'function') return 0;
  const nav = deps.navigator || (typeof navigator !== 'undefined' ? navigator : null);
  let added = 0;
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.closest && pre.closest('.codeblock')) continue;
    const code = typeof pre.querySelector === 'function' ? pre.querySelector('code') : null;
    const codeText = (code || pre).textContent || '';
    const wrap = doc.createElement('div');
    wrap.className = 'codeblock';
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'copy-btn';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', 'Copy code to clipboard');
    button.addEventListener('click', async () => {
      const ok = await copyText(codeText, nav, doc);
      button.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(() => { button.textContent = 'Copy'; }, 1600);
    });
    if (typeof pre.replaceWith === 'function') {
      pre.replaceWith(wrap);
    } else if (pre.parentNode) {
      pre.parentNode.insertBefore(wrap, pre);
    } else {
      continue;
    }
    wrap.append(pre, button);
    added++;
  }
  return added;
}

/**
 * Render an assistant message's markdown into el. Returns true on success,
 * false when the vendor libs are unavailable (caller falls back to textContent).
 */
export function renderAssistantMarkdown(el, source, deps = {}) {
  const doc = getDocument(deps);
  if (!doc || !el) return false;
  const html = markdownToHtml(source, deps);
  if (html === null) return false;
  const safe = sanitizeHtml(html, deps);
  if (safe === null) return false;
  const wrap = doc.createElement('div');
  wrap.className = 'md';
  wrap.innerHTML = safe;
  autolinkTextNodes(wrap, deps);
  hardenLinks(wrap);
  decorateCodeBlocks(wrap, deps);
  if (typeof el.replaceChildren === 'function') el.replaceChildren(wrap);
  else { el.innerHTML = ''; el.appendChild(wrap); }
  return true;
}
