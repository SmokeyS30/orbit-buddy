import { assertPublicUrl, FETCH_TIMEOUT_MS } from './net.js';
import { getEventsForRange, dayStartMs, DEFAULT_ZONE } from './ical.js';
import { extractPersonNames, normalizeMemoryKind, normalizePriority, todayInZone, validDateString, validTimeString, validTimeZone } from './intelligence.js';

// Re-exported so existing callers keep working; new code imports from net.js.
export { assertPublicUrl };

const MAX_PAGE_BYTES = 300_000;

export function toolGetDatetime(args = {}, ctx = null) {
  let timeZone = validTimeZone(ctx?.timeZone, DEFAULT_ZONE);
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

export async function toolGetWeather(args = {}) {
  const location = String(args.location || '').trim().slice(0, 100) || 'Brewster, MA';
  // Geocode the location (Open-Meteo, free, no key)
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`;
  let geo;
  try {
    const res = await fetch(geoUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const data = await res.json();
    if (!data.results?.length) throw new Error('Location not found.');
    geo = data.results[0];
  } catch (e) {
    throw new Error(`Could not find "${location}": ${e.message}`);
  }
  // Get weather (Fahrenheit, since user is US-based)
  const wxUrl = `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}&current=temperature_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=auto&forecast_days=3`;
  try {
    const res = await fetch(wxUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const wx = await res.json();
    const cur = wx.current || {};
    const daily = wx.daily || {};
    const codeToDesc = (c) => ({0:'Clear',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',45:'Foggy',48:'Icy fog',51:'Light drizzle',53:'Drizzle',55:'Heavy drizzle',61:'Light rain',63:'Rain',65:'Heavy rain',71:'Light snow',73:'Snow',75:'Heavy snow',80:'Light showers',81:'Showers',82:'Heavy showers',95:'Thunderstorm'}[c] || 'Unknown');
    let out = `Weather for ${geo.name}${geo.admin1 ? ', '+geo.admin1 : ''}:\n`;
    out += `CURRENT: ${Math.round(cur.temperature_2m)}°F, ${codeToDesc(cur.weather_code)}, wind ${Math.round(cur.wind_speed_10m || 0)} mph\n`;
    if (daily.time) {
      out += `3-DAY FORECAST (share all 3 days with the user):\n`;
      for (let i = 0; i < Math.min(3, daily.time.length); i++) {
        const date = new Date(daily.time[i]+'T12:00:00').toLocaleDateString('en-US', {weekday:'short'});
        out += `  ${date}: ${codeToDesc(daily.weather_code?.[i])}, high ${Math.round(daily.temperature_2m_max?.[i])}°F / low ${Math.round(daily.temperature_2m_min?.[i])}°F\n`;
      }
    }
    return out.trim();
  } catch (e) {
    throw new Error(`Weather lookup failed: ${e.message}`);
  }
}

export function toolCalculate(args = {}) {
  const expr = String(args.expression || '').trim().slice(0, 200);
  if (!expr) throw new Error('An expression is required.');
  // Safe math: only allow numbers, operators, parentheses, decimals, and common functions
  // Convert common phrases: "15% of 240" -> "240*0.15"
  let cleaned = expr.toLowerCase()
    .replace(/(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)/g, '($2*$1/100)')
    .replace(/(\d+(?:\.\d+)?)\s*percent\s*of\s*(\d+(?:\.\d+)?)/g, '($2*$1/100)');
  // Unit conversions (simple)
  const conversions = [
    [/(\d+(?:\.\d+)?)\s*miles?\s*to\s*km/i, (m) => `${m[1]} miles = ${(parseFloat(m[1])*1.60934).toFixed(2)} km`],
    [/(\d+(?:\.\d+)?)\s*km\s*to\s*miles?/i, (m) => `${m[1]} km = ${(parseFloat(m[1])/1.60934).toFixed(2)} miles`],
    [/(\d+(?:\.\d+)?)\s*°?f\s*to\s*°?c/i, (m) => `${m[1]}°F = ${((parseFloat(m[1])-32)*5/9).toFixed(1)}°C`],
    [/(\d+(?:\.\d+)?)\s*°?c\s*to\s*°?f/i, (m) => `${m[1]}°C = ${(parseFloat(m[1])*9/5+32).toFixed(1)}°F`],
    [/(\d+(?:\.\d+)?)\s*lbs?\s*to\s*kg/i, (m) => `${m[1]} lbs = ${(parseFloat(m[1])*0.453592).toFixed(2)} kg`],
    [/(\d+(?:\.\d+)?)\s*kg\s*to\s*lbs?/i, (m) => `${m[1]} kg = ${(parseFloat(m[1])/0.453592).toFixed(2)} lbs`],
  ];
  for (const [regex, fn] of conversions) {
    const m = cleaned.match(regex);
    if (m) return fn(m);
  }
  // Safe arithmetic only: numbers, + - * / ( ) . and spaces
  if (!/^[\d\s+\-*/().]+$/.test(cleaned)) {
    throw new Error('I can only do basic arithmetic and unit conversions.');
  }
  try {
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${cleaned})`)();
    if (typeof result !== 'number' || !isFinite(result)) throw new Error('Invalid');
    return `${expr} = ${Math.round(result*10000)/10000}`;
  } catch {
    throw new Error('Could not calculate that.');
  }
}

export async function toolGetNews(args = {}) {
  const topic = String(args.topic || '').trim().slice(0, 50).toLowerCase();
  // Curated RSS feeds (free, no key)
  const feeds = {
    tech: 'https://news.ycombinator.com/rss',
    world: 'http://feeds.bbci.co.uk/news/rss.xml',
    us: 'http://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml',
  };
  const feedUrl = feeds[topic] || feeds.tech;
  const feedName = topic && feeds[topic] ? topic : 'tech';
  try {
    const res = await fetch(feedUrl, {
      headers: { 'User-Agent': 'orbit-buddy/1.0 (news reader)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    const xml = await res.text();
    // Simple RSS parsing (no dependencies)
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemRegex.exec(xml)) && items.length < 8) {
      const itemXml = match[1];
      const title = (itemXml.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
      const link = (itemXml.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || '').trim();
      if (title) items.push({ title: title.slice(0, 120), link: link.slice(0, 200) });
    }
    if (!items.length) throw new Error('No headlines found.');
    let out = `${feedName.charAt(0).toUpperCase() + feedName.slice(1)} headlines:\n`;
    items.forEach((item, i) => {
      out += `${i + 1}. ${item.title}\n`;
    });
    return out.trim();
  } catch (e) {
    throw new Error(`News lookup failed: ${e.message}`);
  }
}

export async function toolGetStock(args = {}) {
  const symbol = String(args.symbol || '').trim().toUpperCase().slice(0, 20);
  if (!symbol) throw new Error('A stock symbol or crypto name is required.');
  // Crypto via CoinGecko (free, no key)
  const cryptoMap = { BTC: 'bitcoin', ETH: 'ethereum', BITCOIN: 'bitcoin', ETHEREUM: 'ethereum', DOGE: 'dogecoin', SOL: 'solana' };
  if (cryptoMap[symbol]) {
    const id = cryptoMap[symbol];
    try {
      const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      const data = await res.json();
      const info = data[id];
      if (!info) throw new Error('Not found.');
      const change = info.usd_24h_change || 0;
      const arrow = change >= 0 ? '▲' : '▼';
      return `${symbol}: $${info.usd.toLocaleString()} ${arrow} ${Math.abs(change).toFixed(2)}% (24h)`;
    } catch (e) {
      throw new Error(`Crypto lookup failed: ${e.message}`);
    }
  }
  // Stocks via Yahoo Finance (no key)
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('Symbol not found.');
    const meta = result.meta;
    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose || meta.previousClose;
    if (price == null) throw new Error('No price data.');
    const change = prev ? ((price - prev) / prev * 100) : 0;
    const arrow = change >= 0 ? '▲' : '▼';
    const name = meta.longName || meta.shortName || symbol;
    return `${name} (${symbol}): $${price.toFixed(2)} ${arrow} ${Math.abs(change).toFixed(2)}%`;
  } catch (e) {
    throw new Error(`Stock lookup failed: ${e.message}`);
  }
}

export async function toolGetSports(args = {}) {
  const league = String(args.league || 'nfl').trim().toLowerCase().slice(0, 10);
  // ESPN unofficial API (free, no key)
  const leagues = { nfl: 'nfl', nba: 'nba', mlb: 'mlb', nhl: 'nhl' };
  const espnLeague = leagues[league] || 'nfl';
  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${espnLeague}/scoreboard?limit=10`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    const data = await res.json();
    const events = data.events || [];
    if (!events.length) return `No ${espnLeague.toUpperCase()} games found right now.`;
    let out = `${espnLeague.toUpperCase()} scores:\n`;
    for (const event of events.slice(0, 8)) {
      const comp = event.competitions?.[0];
      if (!comp) continue;
      const teams = comp.competitors || [];
      const away = teams.find(t => t.homeAway === 'away');
      const home = teams.find(t => t.homeAway === 'home');
      if (!away || !home) continue;
      const status = event.status?.type?.shortDetail || '';
      out += `${away.team.abbreviation} ${away.score} @ ${home.team.abbreviation} ${home.score} (${status})\n`;
    }
    return out.trim();
  } catch (e) {
    throw new Error(`Sports lookup failed: ${e.message}`);
  }
}

function cleanArg(value, max, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim().slice(0, max);
}

function writeContext(ctx, tool) {
  if (!ctx || !ctx.db || !ctx.userId) throw new Error(`${tool} is not available in this context.`);
  return ctx;
}

function extractResearchUrls(text) {
  const urlRegex = /https?:\/\/[^\s)"']+/g;
  return [...new Set(String(text).match(urlRegex) || [])];
}

export async function toolDeepResearch(args = {}, env = process.env) {
  const topic = String(args.topic || '').trim().slice(0, 200);
  if (!topic) throw new Error('A research topic is required.');
  const angles = String(args.angles || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 3);
  const queries = [topic, ...angles.map(a => `${topic} ${a}`)].slice(0, 3);
  const results = [];
  const seenUrls = new Set();
  for (const query of queries) {
    try {
      const searchResult = await toolWebSearch({ query }, env);
      results.push({ query, search: String(searchResult).slice(0, 5000) });
      for (const url of extractResearchUrls(searchResult).slice(0, 2)) {
        if (seenUrls.has(url) || seenUrls.size >= 4) continue;
        seenUrls.add(url);
        try {
          const content = await toolFetchUrl({ url });
          results.push({ url, content: String(content).slice(0, 8000) });
        } catch { /* skip failed fetches */ }
      }
    } catch { /* skip failed searches */ }
    if (seenUrls.size >= 4) break;
  }
  let out = `# Research: ${topic}\n\n`;
  for (const r of results) {
    if (r.query) out += `## Search: ${r.query}\n${r.search}\n\n`;
    else if (r.url) out += `## Source: ${r.url}\n${r.content}\n\n`;
  }
  return out.slice(0, 30000);
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
  const memory = db.addMemory(userId, content, { kind: normalizeMemoryKind(args.kind), source: 'explicit' });
  try { for (const name of extractPersonNames(content)) db.trackPersonMention(userId, name); } catch (e) {}
  return { id: memory.id, content: memory.content, note: 'Saved. The user can delete it in the Memories tab.' };
}

export function toolProposeMemory(args = {}, ctx = null) {
  const { db, userId } = writeContext(ctx, 'propose_memory');
  const content = cleanArg(args.content, 500, 'content');
  const kind = normalizeMemoryKind(args.kind);
  const suggestion = db.addMemorySuggestion(userId, content, { kind, confidence: 0.7 });
  return { id: suggestion.id, content, kind, note: 'Proposed for the user to approve or dismiss.' };
}

export function toolSavePersonalDate(args = {}, ctx = null) {
  const { db, userId } = writeContext(ctx, 'save_personal_date');
  const label = cleanArg(args.label, 120, 'label');
  const month = Math.floor(Number(args.month));
  const day = Math.floor(Number(args.day));
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('month must be 1-12.');
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('day must be 1-31.');
  const year = args.year == null || args.year === '' ? null : Math.floor(Number(args.year));
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2100)) throw new Error('year must be 1900-2100.');
  const type = ['birthday', 'anniversary', 'other'].includes(args.type) ? args.type : 'other';
  const notes = args.notes ? String(args.notes).trim().slice(0, 500) : null;
  const giftNag = args.giftNag === undefined || args.giftNag === null ? null : !!args.giftNag;
  const saved = db.addPersonalDate(userId, { label, month, day, year, type, notes, giftNag });
  const monthName = new Date(2000, month - 1, 1).toLocaleString('en-US', { month: 'long' });
  return { id: saved.id, label: saved.label, date: `${monthName} ${day}`, type: saved.type, note: 'Saved to important personal dates. Orbit will nudge before and on the day.' };
}

// Fuzzy-match a personal date by label: exact (case-insensitive) wins, then substring.
// Among substring matches, prefer the one whose label is shortest (most specific).
function findPersonalDate(db, userId, label) {
  const dates = db.listPersonalDates(userId);
  const q = String(label || '').trim().toLowerCase();
  if (!q || !dates.length) return null;
  const exact = dates.find((d) => String(d.label || '').trim().toLowerCase() === q);
  if (exact) return exact;
  const hits = dates.filter((d) => String(d.label || '').toLowerCase().includes(q));
  if (!hits.length) return null;
  hits.sort((a, b) => String(a.label).length - String(b.label).length);
  return hits[0];
}

export function toolMarkGiftDone(args = {}, ctx = null) {
  const { db, userId } = writeContext(ctx, 'mark_gift_done');
  const label = cleanArg(args.label, 120, 'label');
  const date = findPersonalDate(db, userId, label);
  if (!date) throw new Error(`No important personal date found matching "${label}".`);
  db.markGiftDone(userId, date.id);
  return { id: date.id, label: date.label, note: 'Gift marked as done — nagging stopped.' };
}

export function toolEnableGiftReminder(args = {}, ctx = null) {
  const { db, userId } = writeContext(ctx, 'enable_gift_reminder');
  const label = cleanArg(args.label, 120, 'label');
  const date = findPersonalDate(db, userId, label);
  if (!date) throw new Error(`No important personal date found matching "${label}".`);
  db.updatePersonalDate(userId, date.id, { giftNag: true, giftDone: false });
  return { id: date.id, label: date.label, note: 'Gift reminders enabled — Orbit will nag until the gift is done.' };
}

export function toolScheduleFollowUp(args = {}, ctx = null) {
  const { db, userId } = writeContext(ctx, 'schedule_followup');
  const description = cleanArg(args.description, 120, 'description');
  const dueDate = validDateStr(args.date);
  if (!dueDate) throw new Error('date must be YYYY-MM-DD.');
  const priority = normalizePriority(args.priority);
  const followUp = db.addFollowUp(userId, { description, dueDate, priority, sourceMessageId: ctx.messageId || null });
  return { id: followUp.id, description, date: dueDate, priority, note: 'Scheduled. The user can remove it from Memory.' };
}

export function toolCreateGoal(args = {}, ctx = null) {
  const { db, userId } = writeContext(ctx, 'create_goal');
  const title = cleanArg(args.title, 120, 'title');
  const description = typeof args.description === 'string' && args.description.trim() ? args.description.trim().slice(0, 1000) : null;
  const targetDate = args.targetDate ? validDateString(args.targetDate) : null;
  if (args.targetDate && !targetDate) throw new Error('targetDate must be YYYY-MM-DD.');
  const nextStep = typeof args.nextStep === 'string' && args.nextStep.trim() ? args.nextStep.trim().slice(0, 500) : null;
  const goal = db.addGoal(userId, { title, description, priority: normalizePriority(args.priority), targetDate, nextStep });
  return { id: goal.id, title: goal.title, priority: goal.priority, targetDate: goal.target_date, note: 'Goal created. Progress stays user-controlled.' };
}

export function toolUpdateGoal(args = {}, ctx = null) {
  const { db, userId } = writeContext(ctx, 'update_goal');
  const goalId = cleanArg(args.goalId, 80, 'goalId');
  const progressValue = Number(args.progress);
  if (args.progress !== undefined && (!Number.isFinite(progressValue) || progressValue < 0 || progressValue > 100)) throw new Error('progress must be a number from 0 to 100.');
  const progress = args.progress === undefined ? undefined : Math.round(progressValue);
  const status = args.status === undefined ? undefined : (['active', 'paused', 'completed'].includes(args.status) ? args.status : null);
  if (args.status !== undefined && !status) throw new Error('status must be active, paused, or completed.');
  const nextStep = args.nextStep === undefined ? undefined : String(args.nextStep || '').trim().slice(0, 500);
  const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim().slice(0, 1000) : null;
  const goal = db.updateGoal(userId, goalId, { progress, status, nextStep, note });
  if (!goal) throw new Error('Goal not found.');
  return { id: goal.id, title: goal.title, progress: goal.progress, status: goal.status, nextStep: goal.next_step, note: 'Goal updated.' };
}

export function toolCreateProject(args = {}, ctx = null) {
  const { db, userId } = writeContext(ctx, 'create_project');
  const title = cleanArg(args.title, 120, 'title');
  const description = typeof args.description === 'string' && args.description.trim() ? args.description.trim().slice(0, 1000) : null;
  const targetDate = args.targetDate ? validDateString(args.targetDate) : null;
  if (args.targetDate && !targetDate) throw new Error('targetDate must be YYYY-MM-DD.');
  const steps = Array.isArray(args.steps) ? args.steps.slice(0, 20).map((step) => {
    const dueDate = step?.dueDate ? validDateString(step.dueDate) : null;
    if (step?.dueDate && !dueDate) throw new Error('step dueDate must be YYYY-MM-DD.');
    return {
      title: cleanArg(step?.title, 160, 'step title'),
      details: typeof step?.details === 'string' ? step.details.trim().slice(0, 1000) : null,
      dueDate
    };
  }) : [];
  const project = db.addProject(userId, { title, description, priority: normalizePriority(args.priority), targetDate, steps });
  return { id: project.id, title: project.title, steps: project.steps.map((step) => ({ id: step.id, title: step.title, status: step.status })), note: 'Project created. Progress remains user-controlled.' };
}

export function toolUpdateProjectStep(args = {}, ctx = null) {
  const { db, userId } = writeContext(ctx, 'update_project_step');
  const stepId = cleanArg(args.stepId, 80, 'stepId');
  const status = ['planned', 'in_progress', 'blocked', 'completed'].includes(args.status) ? args.status : null;
  if (!status) throw new Error('status must be planned, in_progress, blocked, or completed.');
  const step = db.updateProjectStep(userId, stepId, { status, details: args.note === undefined ? undefined : String(args.note || '').slice(0, 1000) });
  if (!step) throw new Error('Project step not found.');
  return { id: step.id, title: step.title, status: step.status, note: 'Project step updated from the user’s explicit report.' };
}

export function toolProposeCalendarEvent(args = {}, ctx = null) {
  const { db, userId } = writeContext(ctx, 'propose_calendar_event');
  const title = cleanArg(args.title, 160, 'title');
  const start = new Date(args.startAt);
  const end = new Date(args.endAt);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || end <= start) throw new Error('startAt and endAt must be valid ISO times, with endAt after startAt.');
  const timeZone = validTimeZone(args.timeZone || ctx?.timeZone, DEFAULT_ZONE);
  const payload = {
    title,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    timeZone,
    location: typeof args.location === 'string' && args.location.trim() ? args.location.trim().slice(0, 300) : null,
    notes: typeof args.notes === 'string' && args.notes.trim() ? args.notes.trim().slice(0, 1000) : null
  };
  const approval = db.addApproval(userId, {
    kind: 'calendar_event', title: `Add “${title}” to a calendar`,
    summary: `${start.toISOString()} to ${end.toISOString()} (${timeZone})`, payload,
    sourceMessageId: ctx?.messageId || null
  });
  return { approvalId: approval.id, status: 'pending', ...payload, note: 'Calendar event proposed. Nothing is added until the user approves it in Approvals.' };
}

export function toolCreateRoutine(args = {}, ctx = null) {
  const { db, userId } = writeContext(ctx, 'create_routine');
  const title = cleanArg(args.title, 120, 'title');
  const prompt = cleanArg(args.prompt, 2000, 'prompt');
  const kind = ['briefing', 'reflection', 'custom'].includes(args.kind) ? args.kind : 'custom';
  const cadence = ['daily', 'weekdays', 'weekly'].includes(args.cadence) ? args.cadence : 'daily';
  const timeLocal = validTimeString(args.timeLocal);
  if (!timeLocal) throw new Error('timeLocal must be HH:MM in 24-hour time.');
  const requestedDay = Number(args.dayOfWeek);
  if (cadence === 'weekly' && (!Number.isInteger(requestedDay) || requestedDay < 0 || requestedDay > 6)) throw new Error('dayOfWeek must be an integer from 0 (Sunday) through 6 (Saturday).');
  const dayOfWeek = cadence === 'weekly' ? requestedDay : null;
  const routine = db.addRoutine(userId, { title, prompt, kind, cadence, timeLocal, dayOfWeek });
  return { id: routine.id, title: routine.title, kind, cadence, timeLocal, dayOfWeek, note: 'Routine created. It follows your timezone and quiet-hour settings.' };
}

function validDateStr(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const [, y, mo, d] = match;
  const check = new Date(Date.UTC(+y, +mo - 1, +d));
  if (check.getUTCFullYear() !== +y || check.getUTCMonth() !== +mo - 1 || check.getUTCDate() !== +d) return null;
  return `${y}-${mo}-${d}`;
}

import { sendEmail, searchEmails, readEmail } from './gmail.js';

function gmailContext(ctx, tool) {
  const { db, userId } = writeContext(ctx, tool);
  if (!ctx.gmail) throw new Error('Gmail is not connected. Connect it in the Connections tab first.');
  return { db, userId, gmail: ctx.gmail };
}

export async function toolGmailSend(args = {}, ctx = null) {
  const { gmail } = gmailContext(ctx, 'gmail_send');
  const result = await sendEmail(() => gmail.getToken(), {
    to: cleanArg(args.to, 500, 'to'),
    subject: cleanArg(args.subject, 200, 'subject'),
    body: cleanArg(args.body, 10000, 'body'),
    cc: args.cc ? cleanArg(args.cc, 500, 'cc') : undefined,
    bcc: args.bcc ? cleanArg(args.bcc, 500, 'bcc') : undefined
  });
  return { ...result, note: 'Email sent via Gmail.' };
}

export async function toolGmailSearch(args = {}, ctx = null) {
  const { gmail } = gmailContext(ctx, 'gmail_search');
  const query = cleanArg(args.query, 200, 'query');
  return searchEmails(() => gmail.getToken(), { query, max: args.max });
}

export async function toolGmailRead(args = {}, ctx = null) {
  const { gmail } = gmailContext(ctx, 'gmail_read');
  const query = cleanArg(args.query, 200, 'query');
  return readEmail(() => gmail.getToken(), { query });
}

export async function toolReadCalendar(args = {}, ctx = null) {
  const { db, userId } = writeContext(ctx, 'read_calendar');
  const zone = validTimeZone(ctx?.timeZone, DEFAULT_ZONE);
  const dateStr = validDateStr(args.date) || todayInZone(zone);
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
    name: 'deep_research',
    description: 'Do thorough multi-source research on a topic. Searches several angles, reads top results, and returns synthesized findings with sources. Use when the user asks to research something in depth, compare options, or get a comprehensive overview.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'The research topic or question.' },
        angles: { type: 'string', description: 'Comma-separated search angles to cover (e.g. "pricing,reviews,alternatives"). Optional.' }
      },
      required: ['topic'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'get_weather',
    description: 'Get current weather and 3-day forecast for a location. Returns current conditions PLUS a 3-day forecast — always share the full forecast with the user, not just today. Use when the user asks about weather, temperature, rain, etc.',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City or place name (e.g. "Boston", "Brewster MA"). Defaults to Brewster, MA.' }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'calculate',
    description: 'Do math: arithmetic, percentages, and unit conversions (miles/km, F/C, lbs/kg). Use for "what is 15% of 240" or "convert 5 miles to km".',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'The math expression or conversion (e.g. "15% of 240", "5 miles to km", "(12+8)*3").' }
      },
      required: ['expression'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'get_news',
    description: 'Get latest news headlines. Topics: "tech" (Hacker News), "world" (BBC), "us" (BBC US/Canada). Defaults to tech. Use when the user asks for news or headlines.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '"tech", "world", or "us". Defaults to "tech".' }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'get_stock',
    description: 'Get stock or crypto price. For stocks use ticker like "AAPL"; for crypto use "BTC", "ETH", etc. Returns current price and daily change. Use when the user asks about stock prices or crypto.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Stock ticker (e.g. "AAPL") or crypto symbol (e.g. "BTC").' }
      },
      required: ['symbol'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'get_sports',
    description: 'Get recent sports scores. Leagues: "nfl", "nba", "mlb", "nhl". Defaults to nfl. Use when the user asks about game scores or sports results.',
    parameters: {
      type: 'object',
      properties: {
        league: { type: 'string', description: '"nfl", "nba", "mlb", or "nhl". Defaults to "nfl".' }
      },
      required: [],
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
    description: 'Save something the user explicitly asked you to remember. Never call this merely because a detail seems useful. Always tell the user what you saved in your visible reply.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The memory to save (max 2000 characters).' },
        kind: { type: 'string', enum: ['fact', 'preference', 'goal', 'project', 'decision', 'relationship'] }
      },
      required: ['content'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'save_personal_date',
    description: 'Save any meaningful personal date to the user\u2019s Important personal dates \u2014 birthdays, anniversaries, graduations, memorials, sobriety milestones, gotcha days, or anything else that matters to them. NOT for appointments (doctor visits etc). Orbit will nudge them before and on the day. Only call when the user mentions a date worth remembering or asks you to save one. Always tell the user what you saved in your visible reply.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'What to call it, e.g. "Mom\u2019s birthday", "Our anniversary", "Dad\u2019s memorial", "1 year sober".' },
        month: { type: 'integer', description: 'Month 1-12.' },
        day: { type: 'integer', description: 'Day 1-31.' },
        year: { type: 'integer', description: 'Year (optional; include for anniversaries where the count matters, e.g. wedding year).' },
        type: { type: 'string', enum: ['birthday', 'anniversary', 'other'], description: 'Use birthday or anniversary when it fits, otherwise other (graduations, memorials, milestones, etc).' },
        notes: { type: 'string', description: 'Optional note, e.g. gift ideas.' },
        giftNag: { type: 'boolean', description: 'Nag about a gift for this date. Defaults automatically: true for birthdays and anniversaries, false for other types. Only set true for an other-type date if the user mentions wanting a gift reminder.' }
      },
      required: ['label', 'month', 'day'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'mark_gift_done',
    description: 'Stop gift nagging for an important personal date when the user says the gift is handled \u2014 e.g. "got Mom\u2019s gift", "I bought it", "done". Matches the date by label (fuzzy). Only call when the user clearly indicates the gift is taken care of.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Label of the personal date, e.g. "Mom\u2019s birthday". Fuzzy-matched.' }
      },
      required: ['label'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'enable_gift_reminder',
    description: 'Turn on gift nagging for an existing important personal date of type "other" when the user asks to be reminded about a gift for it \u2014 e.g. "remind me about a gift for Dad\u2019s memorial". Matches the date by label (fuzzy). Birthdays and anniversaries already nag automatically.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Label of the personal date, e.g. "Dad\u2019s memorial". Fuzzy-matched.' }
      },
      required: ['label'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'propose_memory',
    description: 'Propose a durable fact, preference, goal, project detail, decision, or relationship detail for the user to approve. Use this instead of save_memory when the user did not explicitly ask you to remember it. Do not propose transient or sensitive details.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'One concise, self-contained memory proposal.' },
        kind: { type: 'string', enum: ['fact', 'preference', 'goal', 'project', 'decision', 'relationship'] }
      },
      required: ['content', 'kind'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'schedule_followup',
    description: 'Schedule a warm follow-up after the user mentions a meaningful upcoming event with a clear date. Do not use for vague dates or routine calendar items.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short event description.' },
        date: { type: 'string', description: 'Follow-up date as YYYY-MM-DD.' },
        priority: { type: 'number', description: '1 low, 2 normal, or 3 high.' }
      },
      required: ['description', 'date'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'create_goal',
    description: 'Create a user-owned goal only when the user explicitly asks to track or create one. Progress must never be inferred as completed.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' }, description: { type: 'string' },
        priority: { type: 'number', description: '1 low, 2 normal, or 3 high.' },
        targetDate: { type: 'string', description: 'Optional YYYY-MM-DD target.' },
        nextStep: { type: 'string', description: 'Optional concrete next action.' }
      },
      required: ['title'], additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'update_goal',
    description: 'Update a goal only when the user clearly reports progress, changes its status, or asks to change its next step. Never infer completion.',
    parameters: {
      type: 'object',
      properties: {
        goalId: { type: 'string' }, progress: { type: 'number', description: '0 to 100.' },
        status: { type: 'string', enum: ['active', 'paused', 'completed'] },
        nextStep: { type: 'string' }, note: { type: 'string' }
      },
      required: ['goalId'], additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'create_routine',
    description: 'Create a proactive recurring briefing, reflection, or custom routine only when the user explicitly asks for one.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' }, prompt: { type: 'string' },
        kind: { type: 'string', enum: ['briefing', 'reflection', 'custom'] },
        cadence: { type: 'string', enum: ['daily', 'weekdays', 'weekly'] },
        timeLocal: { type: 'string', description: 'Local 24-hour HH:MM time.' },
        dayOfWeek: { type: 'number', description: 'For weekly routines: 0 Sunday through 6 Saturday.' }
      },
      required: ['title', 'prompt', 'kind', 'cadence', 'timeLocal'], additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'create_project',
    description: 'Create a multi-step project only when the user explicitly asks Orbit to plan or track one. Project and step progress remain user-controlled.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' }, description: { type: 'string' },
        priority: { type: 'number', description: '1 low, 2 normal, or 3 high.' },
        targetDate: { type: 'string', description: 'Optional YYYY-MM-DD target.' },
        steps: { type: 'array', maxItems: 20, items: { type: 'object', properties: { title: { type: 'string' }, details: { type: 'string' }, dueDate: { type: 'string', description: 'Optional YYYY-MM-DD due date.' } }, required: ['title'], additionalProperties: false } }
      },
      required: ['title', 'steps'], additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'update_project_step',
    description: 'Update a project step only when the user explicitly reports its state or asks to change it. Never infer completion.',
    parameters: {
      type: 'object',
      properties: { stepId: { type: 'string' }, status: { type: 'string', enum: ['planned', 'in_progress', 'blocked', 'completed'] }, note: { type: 'string' } },
      required: ['stepId', 'status'], additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'propose_calendar_event',
    description: 'Propose a calendar event only when the user explicitly asks to schedule or add it. This creates an approval item and never writes to an external calendar automatically.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' }, startAt: { type: 'string', description: 'ISO date/time with offset.' }, endAt: { type: 'string', description: 'ISO date/time with offset.' },
        timeZone: { type: 'string', description: 'IANA timezone.' }, location: { type: 'string' }, notes: { type: 'string' }
      },
      required: ['title', 'startAt', 'endAt'], additionalProperties: false
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
  },
  {
    type: 'function',
    name: 'gmail_send',
    description: 'Send an email via the user\'s connected Gmail. ALWAYS show the user the exact recipient, subject, and body and get their explicit confirmation before calling this. Never send without confirmation.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address (comma-separated for multiple).' },
        subject: { type: 'string', description: 'Email subject.' },
        body: { type: 'string', description: 'Plain text email body.' },
        cc: { type: 'string', description: 'CC recipients (optional).' },
        bcc: { type: 'string', description: 'BCC recipients (optional).' }
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'gmail_search',
    description: 'Search the user\'s Gmail inbox. Returns sender, subject, date, and snippet for up to 10 matches. Use Gmail search syntax (from:, subject:, is:unread, after:, etc.).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query.' },
        max: { type: 'number', description: 'Max results (1-10, default 5).' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'gmail_read',
    description: 'Read the full body of the best-matching email for a search query. Use when the user asks about the contents of a specific email.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query to find the email to read.' }
      },
      required: ['query'],
      additionalProperties: false
    }
  }
];

const TOOL_SUMMARIES = {
  get_datetime: () => '',
  web_search: (args) => String(args.query || '').slice(0, 80),
  fetch_url: (args) => String(args.url || '').slice(0, 80),
  deep_research: (args) => String(args.topic || '').slice(0, 80),
  get_weather: (args) => String(args.location || 'Brewster, MA').slice(0, 80),
  calculate: (args) => String(args.expression || '').slice(0, 80),
  get_news: (args) => String(args.topic || 'tech').slice(0, 80),
  get_stock: (args) => String(args.symbol || '').slice(0, 80),
  get_sports: (args) => String(args.league || 'nfl').slice(0, 80),
  create_task: (args) => String(args.title || '').slice(0, 80),
  save_memory: (args) => String(args.content || '').slice(0, 80),
  save_personal_date: (args) => `${String(args.label || '').slice(0, 60)} (${args.month}/${args.day})`,
  mark_gift_done: (args) => `Gift done: ${String(args.label || '').slice(0, 60)}`,
  enable_gift_reminder: (args) => `Gift reminders on: ${String(args.label || '').slice(0, 60)}`,
  propose_memory: (args) => String(args.content || '').slice(0, 80),
  schedule_followup: (args) => `${String(args.description || '').slice(0, 60)} on ${String(args.date || '').slice(0, 10)}`,
  create_goal: (args) => String(args.title || '').slice(0, 80),
  update_goal: (args) => String(args.goalId || '').slice(0, 80),
  create_routine: (args) => String(args.title || '').slice(0, 80),
  create_project: (args) => String(args.title || '').slice(0, 80),
  update_project_step: (args) => String(args.stepId || '').slice(0, 80),
  propose_calendar_event: (args) => String(args.title || '').slice(0, 80),
  read_calendar: (args) => String(args.date || 'today').slice(0, 40),
  gmail_send: (args) => `${String(args.to || '').slice(0, 40)}: ${String(args.subject || '').slice(0, 40)}`,
  gmail_search: (args) => String(args.query || '').slice(0, 80),
  gmail_read: (args) => String(args.query || '').slice(0, 80)
};

export async function executeTool(name, args = {}, env = process.env, ctx = null) {
  const clean = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'get_datetime': return { result: toolGetDatetime(clean, ctx), summary: '' };
    case 'web_search': {
      const result = await toolWebSearch(clean, env);
      return { result, summary: String(clean.query || '').slice(0, 80) };
    }
    case 'fetch_url': {
      const result = await toolFetchUrl(clean);
      return { result, summary: String(clean.url || '').slice(0, 80) };
    }
    case 'deep_research': {
      const result = await toolDeepResearch(clean, env);
      return { result, summary: String(clean.topic || '').slice(0, 80) };
    }
    case 'get_weather': {
      const result = await toolGetWeather(clean);
      return { result, summary: String(clean.location || 'Brewster, MA').slice(0, 80) };
    }
    case 'calculate': {
      const result = toolCalculate(clean);
      return { result, summary: String(clean.expression || '').slice(0, 80) };
    }
    case 'get_news': {
      const result = await toolGetNews(clean);
      return { result, summary: String(clean.topic || 'tech').slice(0, 80) };
    }
    case 'get_stock': {
      const result = await toolGetStock(clean);
      return { result, summary: String(clean.symbol || '').slice(0, 80) };
    }
    case 'get_sports': {
      const result = await toolGetSports(clean);
      return { result, summary: String(clean.league || 'nfl').slice(0, 80) };
    }
    case 'create_task': {
      const result = toolCreateTask(clean, ctx);
      return { result, summary: String(clean.title || '').slice(0, 80) };
    }
    case 'save_memory': {
      const result = toolSaveMemory(clean, ctx);
      return { result, summary: String(clean.content || '').slice(0, 80) };
    }
    case 'save_personal_date': {
      const result = toolSavePersonalDate(clean, ctx);
      return { result, summary: `${String(clean.label || '').slice(0, 60)} (${clean.month}/${clean.day})` };
    }
    case 'mark_gift_done': {
      const result = toolMarkGiftDone(clean, ctx);
      return { result, summary: `Gift done: ${String(result.label || '').slice(0, 60)}` };
    }
    case 'enable_gift_reminder': {
      const result = toolEnableGiftReminder(clean, ctx);
      return { result, summary: `Gift reminders on: ${String(result.label || '').slice(0, 60)}` };
    }
    case 'propose_memory': {
      const result = toolProposeMemory(clean, ctx);
      return { result, summary: String(clean.content || '').slice(0, 80) };
    }
    case 'schedule_followup': {
      const result = toolScheduleFollowUp(clean, ctx);
      return { result, summary: `${String(clean.description || '').slice(0, 60)} on ${String(clean.date || '').slice(0, 10)}` };
    }
    case 'create_goal': {
      const result = toolCreateGoal(clean, ctx);
      return { result, summary: String(clean.title || '').slice(0, 80) };
    }
    case 'update_goal': {
      const result = toolUpdateGoal(clean, ctx);
      return { result, summary: String(clean.goalId || '').slice(0, 80) };
    }
    case 'create_routine': {
      const result = toolCreateRoutine(clean, ctx);
      return { result, summary: String(clean.title || '').slice(0, 80) };
    }
    case 'create_project': {
      const result = toolCreateProject(clean, ctx);
      return { result, summary: String(clean.title || '').slice(0, 80) };
    }
    case 'update_project_step': {
      const result = toolUpdateProjectStep(clean, ctx);
      return { result, summary: String(clean.stepId || '').slice(0, 80) };
    }
    case 'propose_calendar_event': {
      const result = toolProposeCalendarEvent(clean, ctx);
      return { result, summary: String(clean.title || '').slice(0, 80) };
    }
    case 'read_calendar': {
      const result = await toolReadCalendar(clean, ctx);
      return { result, summary: String(clean.date || 'today').slice(0, 40) };
    }
    case 'gmail_send': {
      const result = await toolGmailSend(clean, ctx);
      return { result, summary: `Email to ${String(clean.to || '').slice(0, 40)}` };
    }
    case 'gmail_search': {
      const result = await toolGmailSearch(clean, ctx);
      return { result, summary: String(clean.query || '').slice(0, 80) };
    }
    case 'gmail_read': {
      const result = await toolGmailRead(clean, ctx);
      return { result, summary: String(clean.query || '').slice(0, 80) };
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export function summarizeToolCall(name, args) {
  const fn = TOOL_SUMMARIES[name];
  return fn ? fn(args || {}) : '';
}
