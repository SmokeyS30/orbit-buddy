import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  markdownToHtml,
  sanitizeHtml,
  linkifySegments,
  hardenLinks,
  copyText,
  decorateCodeBlocks,
  renderAssistantMarkdown,
} from '../public/chat-markdown.js';

// Load the real vendored marked UMD in a CJS sandbox (the repo is
// "type": "module", so require() would treat the UMD file as ESM).
function loadMarked() {
  const src = readFileSync(new URL('../public/vendor/marked.min.js', import.meta.url), 'utf8');
  assert.match(src, /marked v12\.0\.2/, 'vendored marked should be v12.0.2');
  const module = { exports: {} };
  new Function('module', 'exports', src)(module, module.exports);
  return module.exports;
}

const marked = loadMarked();

test('vendored marked parses core markdown constructs', () => {
  const html = markdownToHtml('# Hello\n\n**bold** and *italic*\n\n- one\n- two', { marked });
  assert.match(html, /<h1[^>]*>Hello<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<ul>[\s\S]*<li>one<\/li>/);
});

test('vendored marked renders code fences, tables, blockquotes, links', () => {
  const html = markdownToHtml(
    '> quote\n\n```js\nconst a = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[orbit](https://orbitbuddy.app)',
    { marked },
  );
  assert.match(html, /<blockquote>/);
  assert.match(html, /<pre><code class="language-js">/);
  assert.match(html, /<table>/);
  assert.match(html, /<a href="https:\/\/orbitbuddy\.app">orbit<\/a>/);
});

test('vendored marked uses breaks:true so single newlines become <br>', () => {
  const html = markdownToHtml('line one\nline two', { marked });
  assert.match(html, /line one<br>\s*line two/);
});

test('markdownToHtml returns null when marked is unavailable', () => {
  assert.equal(markdownToHtml('**hi**', { marked: null }), null);
  assert.equal(markdownToHtml('**hi**', {}), null);
});

test('sanitizeHtml delegates to DOMPurify with forbidden tags', () => {
  let seen;
  const fake = {
    sanitize: (html, config) => { seen = { html, config }; return `clean:${html}`; },
  };
  const out = sanitizeHtml('<p>hi</p>', { DOMPurify: fake });
  assert.equal(out, 'clean:<p>hi</p>');
  // script/style are stripped by DOMPurify's defaults; FORBID_TAGS covers the rest.
  assert.ok(seen.config.FORBID_TAGS.includes('iframe'));
  assert.ok(seen.config.FORBID_TAGS.includes('form'));
});

test('sanitizeHtml returns null when DOMPurify is unavailable or throws', () => {
  assert.equal(sanitizeHtml('<p>hi</p>', {}), null);
  assert.equal(sanitizeHtml('<p>hi</p>', { DOMPurify: { sanitize() { throw new Error('boom'); } } }), null);
});

test('linkifySegments autolinks http(s) URLs and trims sentence punctuation', () => {
  const segments = linkifySegments('See https://example.com/a, and this.');
  assert.deepEqual(segments, [
    { type: 'text', value: 'See ' },
    { type: 'link', href: 'https://example.com/a', label: 'https://example.com/a' },
    { type: 'text', value: ', and this.' },
  ]);
});

test('linkifySegments upgrades www. URLs and keeps balanced parens', () => {
  const segments = linkifySegments('try www.example.com and https://en.wikipedia.org/wiki/X_(y).');
  assert.equal(segments[1].href, 'https://www.example.com');
  assert.equal(segments[3].href, 'https://en.wikipedia.org/wiki/X_(y)');
  assert.equal(segments[4].value, '.');
});

test('linkifySegments trims an unbalanced trailing paren', () => {
  const segments = linkifySegments('(see https://example.com/a)');
  assert.equal(segments[1].href, 'https://example.com/a');
  assert.equal(segments[2].value, ')');
});

test('linkifySegments returns a single text segment when there are no URLs', () => {
  assert.deepEqual(linkifySegments('no links here'), [{ type: 'text', value: 'no links here' }]);
});

// --- Minimal fake DOM -----------------------------------------------------

function fakeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    attributes: {},
    children: [],
    handlers: {},
    parent: null,
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    append(...kids) { for (const k of kids) this.appendChild(k); return this; },
    appendChild(k) { k.parent = this; this.children.push(k); return k; },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    replaceWith(other) { this.replacedWith = other; },
    closest(sel) {
      if (sel === '.codeblock' && this.className === 'codeblock') return this;
      if (sel === 'a, pre, code' && ['A', 'PRE', 'CODE'].includes(this.tagName)) return this;
      return this.parent ? this.parent.closest(sel) : null;
    },
    querySelector(sel) {
      if (sel === 'code') return this.children.find((c) => c.tagName === 'CODE') || null;
      return null;
    },
    querySelectorAll() { return []; },
  };
  return el;
}

function fakeDocument({ pres = [], anchors = [] } = {}) {
  const doc = {
    created: [],
    createElement(tag) { const el = fakeElement(tag); this.created.push(el); return el; },
    createTextNode(text) { const el = fakeElement('#text'); el.textContent = text; return el; },
    createDocumentFragment() { const el = fakeElement('#fragment'); return el; },
    createTreeWalker() { return { nextNode() { return null; } }; },
  };
  doc.root = {
    querySelectorAll(sel) {
      if (sel === 'pre') return pres;
      if (sel === 'a[href]') return anchors;
      return [];
    },
  };
  return doc;
}

test('hardenLinks forces _blank + noopener on anchors', () => {
  const a = fakeElement('a');
  const doc = fakeDocument({ anchors: [a] });
  assert.equal(hardenLinks(doc.root), 1);
  assert.equal(a.getAttribute('target'), '_blank');
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
});

test('copyText uses navigator.clipboard when available', async () => {
  let written;
  const nav = { clipboard: { writeText: async (t) => { written = t; } } };
  assert.equal(await copyText('hello', nav, null), true);
  assert.equal(written, 'hello');
});

test('copyText returns false when no clipboard and no document fallback', async () => {
  assert.equal(await copyText('hello', {}, null), false);
});

test('decorateCodeBlocks wraps pre with a Copy button that copies code text', async () => {
  const pre = fakeElement('pre');
  const code = fakeElement('code');
  code.textContent = 'const a = 1;';
  pre.appendChild(code);
  pre.textContent = 'const a = 1;';
  const doc = fakeDocument({ pres: [pre] });
  let written;
  const nav = { clipboard: { writeText: async (t) => { written = t; } } };
  assert.equal(decorateCodeBlocks(doc.root, { document: doc, navigator: nav }), 1);
  const wrap = pre.replacedWith;
  assert.equal(wrap.className, 'codeblock');
  const button = wrap.children.find((c) => c.tagName === 'BUTTON');
  assert.equal(button.textContent, 'Copy');
  assert.equal(button.getAttribute('aria-label'), 'Copy code to clipboard');
  await button.handlers.click();
  assert.equal(written, 'const a = 1;');
  assert.equal(button.textContent, 'Copied');
});

test('decorateCodeBlocks skips pres that are already wrapped', () => {
  const pre = fakeElement('pre');
  pre.closest = () => ({ className: 'codeblock' });
  const doc = fakeDocument({ pres: [pre] });
  assert.equal(decorateCodeBlocks(doc.root, { document: doc }), 0);
});

test('renderAssistantMarkdown renders sanitized markdown into a .md wrapper', () => {
  const doc = fakeDocument();
  const el = fakeElement('div');
  el.replaceChildren = function (kid) { this.children = [kid]; };
  const ok = renderAssistantMarkdown(el, '# Title\n\n**bold**', {
    marked,
    DOMPurify: { sanitize: (html) => `SAFE:${html}` },
    document: doc,
  });
  assert.equal(ok, true);
  const wrap = el.children[0];
  assert.equal(wrap.className, 'md');
  assert.match(wrap.innerHTML, /^SAFE:<h1[^>]*>Title<\/h1>/);
  assert.match(wrap.innerHTML, /<strong>bold<\/strong>/);
});

test('renderAssistantMarkdown fails safe to textContent when libs are missing', () => {
  const doc = fakeDocument();
  const el = fakeElement('div');
  assert.equal(renderAssistantMarkdown(el, '**hi**', { document: doc }), false);
  assert.equal(el.children.length, 0);
});
