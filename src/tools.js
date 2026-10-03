import { assertPublicUrl, FETCH_TIMEOUT_MS } from './net.js';
import { getEventsForRange, dayStartMs, DEFAULT_ZONE } from './ical.js';

// Re-exported so existing callers keep working; new code imports from net.js.
export { assertPublicUrl };

const MAX_PAGE_BYTES = 300_000;

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

export async function toolWebSearch(args = {}, env = process.env) {
  const query = String(args.query || '').trim().slice(0, 200);
  if (!query) throw new Error('A search query is required.');
  const braveKey = env.BRAVE_SEARCH_API_KEY?.trim();
  if (braveKey) {
    try {
      return await braveSearch(query, braveKey);
    } catch {
      // fall through to the free backend
    }
  }
  return duckDuckGoSearch(query);
}

async function braveSearch(query, apiKey) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&text_decorations=false`;
  const headers = { Accept: 'application/json', 'X-Subscription-Token': apiKey };
  let response = null;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let transient = false;
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) {
        response = res;
        break;
      }
      // 429/5xx may clear up: retry. Other 4xx are the request's fault (bad
      // key included) — no point burning retries or credits on them.
      transient = res.status === 429 || res.status >= 500;
      lastError = new Error(`Brave search failed (HTTP ${res.status}).`);
    } catch (error) {
      transient = true; // network error, timeout, abort
      lastError = error;
    }
    if (!transient) break;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
  }
  if (!response) throw lastError || new Error('Brave search failed.');
  const data = await response.json().catch(() => null);
  const results = (data?.web?.results || []).slice(0, 5).map((entry) => ({
    url: String(entry.url || ''),
    title: String(entry.title || '').slice(0, 200),
    snippet: String(entry.description || '').slice(0, 280)
  })).filter((entry) => entry.url && entry.title);
  if (!results.length) throw new Error('Brave returned no results.');
  return { results, via: 'brave' };
}

async function duckDuckGoSearch(query) {
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

function cleanArg(value, max, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim().slice(0, max);
}

function writeContext(ctx, tool) {
  if (!ctx || !ctx.db || !ctx.userId) throw new Error(`${tool} is not available in this context.`);
  return ctx;
}

export function toolCreateTask(args = {}, ctx = null) {
  const { db, userId } = writeContext(ctx, 'create_task');
  const title = cleanArg(args.title, 120, 'title');
  const prompt = cleanArg(args.prompt, 6000, 'prompt');
  const risk = args.risk === 'external' ? 'external' : 'internal';
  const recurrence = ['daily', 'weekly'].includes(args.recurrence) ? args.recurrence : 'none';
  let scheduleAt = null;
  if (args.scheduleAt) {
    const date = new Date(args.scheduleAt);
    if (Number.isNaN(date.valueOf())) throw new Error('scheduleAt must be a valid date.');
    scheduleAt = date.toISOString();
  }
  const task = db.addTask(userId, { title, prompt, risk, scheduleAt, recurrence });
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    risk: task.risk,
    note: task.status === 'waiting_approval'
      ? 'Created, waiting for the owner to approve it in the Tasks tab.'
      : 'Created.'
  };
}

export function toolSaveMemory(args = {}, ctx = null) {
  const { db, userId } = writeContext(ctx, 'save_memory');
  const content = cleanArg(args.content, 2000, 'content');
  const memory = db.addMemory(userId, content);
  return { id: memory.id, content: memory.content, note: 'Saved. The user can delete it in the Memories tab.' };
}

function validDateStr(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const [, y, mo, d] = match;
  const check = new Date(Date.UTC(+y, +mo - 1, +d));
  if (check.getUTCFullYear() !== +y || check.getUTCMonth() !== +mo - 1 || check.getUTCDate() !== +d) return null;
  return `${y}-${mo}-${d}`;
}

export async function toolReadCalendar(args = {}, ctx = null) {
  const { db, userId } = writeContext(ctx, 'read_calendar');
  const zone = DEFAULT_ZONE;
  const dateStr = validDateStr(args.date) || new Date().toLocaleDateString('en-CA', { timeZone: zone });
  let days = Math.floor(Number(args.days));
  if (!Number.isFinite(days) || days < 1) days = 1;
  if (days > 14) days = 14;
  const rangeStartMs = dayStartMs(dateStr, 0, zone);
  const rangeEndMs = dayStartMs(dateStr, days, zone);
  const { events, feedErrors, feeds } = await getEventsForRange(db, userId, rangeStartMs, rangeEndMs, zone);
  if (!feeds.length) {
    return { date: dateStr, days, events: [], note: 'No calendars are connected yet. Add an iCal feed in the Connections tab.' };
  }
  return {
    date: dateStr,
    days,
    events: events.map((e) => ({
      calendar: e.calendar,
      title: e.title,
      start: new Date(e.startMs).toISOString(),
      end: new Date(e.endMs).toISOString(),
      allDay: e.allDay,
      ...(e.location ? { location: e.location } : {})
    })),
    ...(feedErrors.length ? { feedErrors } : {})
  };
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
  },
  {
    type: 'function',
    name: 'create_task',
    description: 'Create a task for Orbit to work on. Only call this when the user clearly asked for a task or reminder. Think-only (internal) tasks are created right away; external-action tasks go to "waiting approval" for the user to approve in the Tasks tab. Always tell the user what you created in your visible reply.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title.' },
        prompt: { type: 'string', description: 'What Orbit should do for this task.' },
        risk: { type: 'string', description: '"internal" for think-only (default) or "external" for tasks that act on the world.' },
        recurrence: { type: 'string', description: '"none" (default), "daily", or "weekly".' },
        scheduleAt: { type: 'string', description: 'ISO date/time for when the task should run. Omit to queue it now.' }
      },
      required: ['title', 'prompt'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'save_memory',
    description: 'Save something the user asked you to remember. Only call this when the user clearly asked ("remember this") or it is plainly worth keeping. Always tell the user what you saved in your visible reply.',
    parameters: {
      type: 'object',
      properties: { content: { type: 'string', description: 'The memory to save (max 2000 characters).' } },
      required: ['content'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'read_calendar',
    description: 'Read the user\'s calendar events across all connected iCal feeds. Use it when the user asks about their schedule, upcoming events, or availability on a date.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Start date as YYYY-MM-DD. Defaults to today.' },
        days: { type: 'number', description: 'How many days to include starting from date. Default 1, max 14.' }
      },
      additionalProperties: false
    }
  }
];

const TOOL_SUMMARIES = {
  get_datetime: () => '',
  web_search: (args) => String(args.query || '').slice(0, 80),
  fetch_url: (args) => String(args.url || '').slice(0, 80),
  create_task: (args) => String(args.title || '').slice(0, 80),
  save_memory: (args) => String(args.content || '').slice(0, 80),
  read_calendar: (args) => String(args.date || 'today').slice(0, 40)
};

export async function executeTool(name, args = {}, env = process.env, ctx = null) {
  const clean = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'get_datetime': return { result: toolGetDatetime(clean), summary: '' };
    case 'web_search': {
      const result = await toolWebSearch(clean, env);
      return { result, summary: String(clean.query || '').slice(0, 80) };
    }
    case 'fetch_url': {
      const result = await toolFetchUrl(clean);
      return { result, summary: String(clean.url || '').slice(0, 80) };
    }
    case 'create_task': {
      const result = toolCreateTask(clean, ctx);
      return { result, summary: String(clean.title || '').slice(0, 80) };
    }
    case 'save_memory': {
      const result = toolSaveMemory(clean, ctx);
      return { result, summary: String(clean.content || '').slice(0, 80) };
    }
    case 'read_calendar': {
      const result = await toolReadCalendar(clean, ctx);
      return { result, summary: String(clean.date || 'today').slice(0, 40) };
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export function summarizeToolCall(name, args) {
  const fn = TOOL_SUMMARIES[name];
  return fn ? fn(args || {}) : '';
}
