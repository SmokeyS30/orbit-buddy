// Gmail API helpers. All functions take a getToken() that returns a valid access token.
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function apiFetch(getToken, path, options = {}) {
  const token = await getToken();
  const res = await fetch(`${GMAIL_API}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(30_000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Gmail API error (HTTP ${res.status}).`);
  return data;
}

// RFC 2822 message -> base64url for the Gmail send API
function encodeMessage({ to, cc, bcc, subject, body }) {
  const lines = [`To: ${to}`];
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body);
  return Buffer.from(lines.join('\r\n'), 'utf-8').toString('base64url');
}

export async function sendEmail(getToken, { to, subject, body, cc, bcc }) {
  if (!to || !String(to).trim()) throw new Error('A recipient email address is required.');
  if (!subject || !String(subject).trim()) throw new Error('A subject is required.');
  if (!body || !String(body).trim()) throw new Error('A message body is required.');
  // Basic email validation
  const emails = String(to).split(',').map(e => e.trim()).filter(Boolean);
  for (const e of emails) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error(`"${e}" doesn't look like a valid email address.`);
  }
  const raw = encodeMessage({ to: emails.join(', '), cc, bcc, subject: String(subject).trim(), body: String(body).trim() });
  const result = await apiFetch(getToken, '/messages/send', { method: 'POST', body: JSON.stringify({ raw }) });
  return { sent: true, messageId: result.id, to: emails.join(', '), subject: String(subject).trim() };
}

export async function searchEmails(getToken, { query, max = 5 }) {
  if (!query || !String(query).trim()) throw new Error('A search query is required.');
  const list = await apiFetch(getToken, `/messages?q=${encodeURIComponent(String(query).trim())}&maxResults=${Math.min(Math.max(parseInt(max, 10) || 5, 1), 10)}`);
  const messages = list.messages || [];
  const results = [];
  for (const m of messages) {
    const full = await apiFetch(getToken, `/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
    const headers = Object.fromEntries((full.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
    results.push({
      from: headers.from || '', subject: headers.subject || '(no subject)',
      date: headers.date || '', snippet: full.snippet || ''
    });
  }
  return { count: results.length, emails: results };
}

export async function readEmail(getToken, { query }) {
  // Find the single best match and return its full body
  const list = await apiFetch(getToken, `/messages?q=${encodeURIComponent(String(query).trim())}&maxResults=1`);
  if (!list.messages?.length) return { found: false };
  const full = await apiFetch(getToken, `/messages/${list.messages[0].id}?format=full`);
  const headers = Object.fromEntries((full.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
  // Extract plain text body (walk MIME parts)
  let bodyText = '';
  const walk = (part) => {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      bodyText += Buffer.from(part.body.data, 'base64url').toString('utf-8');
    } else if (part.parts) {
      for (const p of part.parts) walk(p);
    }
  };
  walk(full.payload || {});
  return {
    found: true,
    from: headers.from || '', subject: headers.subject || '(no subject)',
    date: headers.date || '', body: bodyText.slice(0, 5000)
  };
}

// Move an email to trash (recoverable for 30 days) by message ID
export async function trashEmail(getToken, { id }) {
  if (!id) throw new Error('A message ID is required.');
  await apiFetch(getToken, `/messages/${encodeURIComponent(id)}/trash`, { method: 'POST' });
  return { trashed: true, id };
}