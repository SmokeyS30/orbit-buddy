import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 300_000;

function ipIsPrivate(ip) {
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    return lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd') || ip === '::';
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
}

// Blocks server-side request forgery: the model must never fetch internal,
// link-local, or otherwise non-public addresses, including via redirects.
export async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new Error('That is not a valid URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https URLs are allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (ipIsPrivate(host)) throw new Error('That address is not publicly reachable.');
    return url.toString();
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error('Could not resolve that hostname.');
  }
  if (!addresses.length || addresses.some((entry) => ipIsPrivate(entry.address))) {
    throw new Error('That address is not publicly reachable.');
  }
  return url.toString();
}

export function toolGetDatetime(args = {}) {
  let timeZone = 'America/New_York';
  if (typeof args.timeZone === 'string' && args.timeZone.trim()) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: args.timeZone.trim() });
      timeZone = args.timeZone.trim();
    } catch {
      // fall through to the default
    }
  }
  const now = new Date();
  return {
    iso: now.toISOString(),
    local: new Intl.DateTimeFormat('en-US', { timeZone, dateStyle: 'full', timeStyle: 'short' }).format(now),
    timeZone
  };
}

export function parseLiteResults(html) {
  const results = [];
  const linkPattern = /<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*>([^<]{1,200})<\/a>/gi;
  const snippetPattern = /<td[^>]*class=['"]?result-snippet['"]?[^>]*>([\s\S]{1,400}?)<\/td>/gi;
  const links = [];
  let match;
  while ((match = linkPattern.exec(html)) && links.length < 8) {
    const href = match[1].trim();
    const title = match[2].replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
    if (!/^https?:\/\//i.test(href) || /duckduckgo\.com/i.test(href) || !title) continue;
    links.push({ url: href, title });
  }
  const snippets = [];
  while ((match = snippetPattern.exec(html)) && snippets.length < 8) {
    snippets.push(match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280));
  }
  for (let i = 0; i < links.length && results.length < 5; i += 1) {
    results.push({ ...links[i], snippet: snippets[i] || '' });
  }
  return results;
}

export async function toolWebSearch(args = {}) {
  const query = String(args.query || '').trim().slice(0, 200);
  if (!query) throw new Error('A search query is required.');
  const headers = { 'User-Agent': 'orbit-buddy/1.0 (read-only web research)' };
  try {
    const response = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const data = await response.json().catch(() => null);
    if (data?.AbstractText) {
      return { answer: data.AbstractText, source: data.AbstractURL || undefined, via: 'instant-answer' };
    }
  } catch {
    // fall through to the lite-HTML fallback
  }
  const response = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Search failed (HTTP ${response.status}).`);
  const html = await response.text();
  const results = parseLiteResults(html);
  if (!results.length) return { results: [], note: 'No results found.' };
  return { results, via: 'web-search' };
}

export async function toolFetchUrl(args = {}) {
  const url = await assertPublicUrl(args.url);
  const headers = { 'User-Agent': 'orbit-buddy/1.0 (read-only page reader)' };
  let response;
  try {
    response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`Could not fetch that page: ${error.message}`);
  }
  // Re-check after redirects: a public URL must not bounce into the private network.
  const finalUrl = await assertPublicUrl(response.url);
  const contentType = response.headers.get('content-type') || '';
  if (!/text|json|xml|html/i.test(contentType)) throw new Error('That URL did not return readable text.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_PAGE_BYTES) throw new Error('That page is too large to read.');
  const text = buffer.toString('utf8')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) throw new Error('No readable text found on that page.');
  return { url: finalUrl, text: text.slice(0, 6000) };
}

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    name: 'get_datetime',
    description: 'Get the current date and time. Use it whenever the user asks about "now", "today", or when resolving relative dates.',
    parameters: {
      type: 'object',
      properties: { timeZone: { type: 'string', description: 'IANA timezone, e.g. America/New_York. Defaults to America/New_York.' } },
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'web_search',
    description: 'Search the live web for current information. Use it when the user asks about news, prices, hours, or anything that may have changed since your training.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query.' } },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'fetch_url',
    description: 'Fetch a web page and return its readable text. Use it to read an article or page the user linked or that a search returned.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The http(s) URL to read.' } },
      required: ['url'],
      additionalProperties: false
    }
  }
];

const TOOL_SUMMARIES = {
  get_datetime: () => '',
  web_search: (args) => String(args.query || '').slice(0, 80),
  fetch_url: (args) => String(args.url || '').slice(0, 80)
};

export async function executeTool(name, args = {}) {
  const clean = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'get_datetime': return { result: toolGetDatetime(clean), summary: '' };
    case 'web_search': {
      const result = await toolWebSearch(clean);
      return { result, summary: String(clean.query || '').slice(0, 80) };
    }
    case 'fetch_url': {
      const result = await toolFetchUrl(clean);
      return { result, summary: String(clean.url || '').slice(0, 80) };
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export function summarizeToolCall(name, args) {
  const fn = TOOL_SUMMARIES[name];
  return fn ? fn(args || {}) : '';
}
