// Conversation import: parse ChatGPT / generic exports into flat message lists.
// Hand-rolled, zero dependencies. The raw export is never persisted — only
// extracted memory suggestions survive, and only after the user approves them.

const MAX_MESSAGES = 5000; // hard cap so a giant export can't blow up the job
const MAX_CONTENT_LEN = 2000; // per-message truncation before analysis

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT_LEN);
}

// ChatGPT export shape:
// { conversations: [ { title, mapping: { nodeId: { message: { author: { role }, content: { parts: [...] } }, create_time } } } ] }
export function parseChatGPTExport(data) {
  const conversations = Array.isArray(data?.conversations) ? data.conversations : [];
  const out = [];
  for (const convo of conversations) {
    const mapping = convo?.mapping;
    if (!mapping || typeof mapping !== 'object') continue;
    const nodes = [];
    for (const node of Object.values(mapping)) {
      const msg = node?.message;
      if (!msg) continue;
      const role = msg?.author?.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const parts = msg?.content?.parts;
      if (!Array.isArray(parts)) continue;
      const text = parts.filter((p) => typeof p === 'string').join('\n').trim();
      if (!text) continue;
      nodes.push({ role, content: cleanText(text), at: Number(msg.create_time) || 0 });
    }
    nodes.sort((a, b) => a.at - b.at);
    for (const n of nodes) out.push({ role: n.role, content: n.content });
    if (out.length >= MAX_MESSAGES) break;
  }
  return out.slice(0, MAX_MESSAGES);
}

// Generic shape: { messages: [ { role: 'user'|'assistant', content: '...' } ] }
export function parseGenericExport(data) {
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const out = [];
  for (const m of messages) {
    const role = String(m?.role || '').toLowerCase();
    if (role !== 'user' && role !== 'assistant') continue;
    const content = cleanText(m?.content);
    if (!content) continue;
    out.push({ role, content });
    if (out.length >= MAX_MESSAGES) break;
  }
  return out;
}

// Try each known format; returns { messages, format } or null when nothing parses.
export function extractMessages(data) {
  if (!data || typeof data !== 'object') return null;
  // Unwrap common wrappers
  const candidates = [data];
  if (data.data && typeof data.data === 'object') candidates.push(data.data);
  for (const candidate of candidates) {
    if (Array.isArray(candidate.conversations)) {
      const messages = parseChatGPTExport(candidate);
      if (messages.length) return { messages, format: 'chatgpt' };
    }
    if (Array.isArray(candidate.messages)) {
      const messages = parseGenericExport(candidate);
      if (messages.length) return { messages, format: 'generic' };
    }
  }
  return null;
}

// Split into chunks of ~N messages for bounded model calls. Drops chunks that
// are all-assistant (nothing to learn about the user) or trivially short.
export function chunkMessages(messages, size = 20) {
  const chunks = [];
  for (let i = 0; i < messages.length; i += size) {
    const chunk = messages.slice(i, i + size);
    const userText = chunk.filter((m) => m.role === 'user').map((m) => m.content).join(' ');
    if (userText.replace(/\s/g, '').length < 40) continue; // skip trivial chunks
    chunks.push(chunk);
  }
  return chunks;
}

// Minimal multipart/form-data parser for a single file field. Returns the file
// bytes as a string, or null. Hand-rolled to avoid new dependencies.
export function parseMultipartFile(bodyBuffer, contentType) {
  const match = /boundary=([^;]+)/i.exec(String(contentType || ''));
  if (!match) return null;
  const boundary = '--' + match[1].trim().replace(/^"|"$/g, '');
  const body = bodyBuffer.toString('latin1');
  const parts = body.split(boundary);
  for (const part of parts) {
    if (!part.includes('filename=')) continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    let content = part.slice(headerEnd + 4);
    // Strip trailing CRLF before the next boundary
    if (content.endsWith('\r\n')) content = content.slice(0, -2);
    return Buffer.from(content, 'latin1').toString('utf8');
  }
  return null;
}
