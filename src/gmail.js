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
  const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
  const lines = [`To: ${clean(to)}`];
  if (cc) lines.push(`Cc: ${clean(cc)}`);
  if (bcc) lines.push(`Bcc: ${clean(bcc)}`);
  const encodedSubject = /^[\x20-\x7e]*$/.test(clean(subject)) ? clean(subject) : `=?UTF-8?B?${Buffer.from(clean(subject), 'utf-8').toString('base64')}?=`;
  const encodedBody = Buffer.from(String(body), 'utf-8').toString('base64').replace(/.{1,76}/g, '$&\r\n').trimEnd();
  lines.push(`Subject: ${encodedSubject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', encodedBody);
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
  const validList = (label, value) => {
    if (!value) return '';
    const list = String(value).split(',').map(e => e.trim()).filter(Boolean);
    for (const e of list) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error(`"${e}" doesn't look like a valid ${label} email address.`);
    return list.join(', ');
  };
  const raw = encodeMessage({ to: emails.join(', '), cc: validList('Cc', cc), bcc: validList('Bcc', bcc), subject: String(subject).trim(), body: String(body).trim() });
  const result = await apiFetch(getToken, '/messages/send', { method: 'POST', body: JSON.stringify({ raw }) });
  return { sent: true, messageId: result.id, to: emails.join(', '), subject: String(subject).trim() };
}

export async function searchEmails(getToken, { query, max = 5 }) {
  if (!query || !String(query).trim()) throw new Error('A search query is required.');
  const list = await apiFetch(getToken, `/messages?q=${encodeURIComponent(String(query).trim())}&maxResults=${Math.min(Math.max(parseInt(max, 10) || 5, 1), 10)}`);
  const messages = list.messages || [];
  const results = [];
  for (const m of messages) {
    try {
      const full = await apiFetch(getToken, `/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
      const headers = Object.fromEntries((full.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
      results.push({
        id: m.id,
        from: headers.from || '', subject: headers.subject || '(no subject)',
        date: headers.date || '', snippet: full.snippet || ''
      });
    } catch (e) {
      // Skip messages that fail to fetch (e.g. deleted or modified between list and get)
      console.warn(`Skipping email ${m.id}: ${e.message}`);
    }
  }
  return { count: results.length, emails: results };
}

export async function readEmail(getToken, { query }) {
  // Find the single best match and return its full body
  const list = await apiFetch(getToken, `/messages?q=${encodeURIComponent(String(query).trim())}&maxResults=1`);
  if (!list.messages?.length) return { found: false };
  let full;
  try {
    full = await apiFetch(getToken, `/messages/${list.messages[0].id}?format=full`);
  } catch (e) {
    console.warn(`readEmail: message ${list.messages[0].id} unavailable: ${e.message}`);
    return { found: false };
  }
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

// List recent SENT emails with plain-text bodies for voice learning.
// Bodies stay in memory; nothing is persisted here. max is capped at 30.
export async function listSentEmails(getToken, { max = 30 } = {}) {
  const limit = Math.min(Math.max(parseInt(max, 10) || 30, 1), 30);
  const list = await apiFetch(getToken, `/messages?q=${encodeURIComponent('in:sent')}&maxResults=${limit}`);
  const messages = list.messages || [];
  const emails = [];
  for (const m of messages) {
    try {
      const full = await apiFetch(getToken, `/messages/${m.id}?format=full`);
      const headers = Object.fromEntries((full.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
      let bodyText = '';
      const walk = (part) => {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          bodyText += Buffer.from(part.body.data, 'base64url').toString('utf-8');
        } else if (part.parts) {
          for (const p of part.parts) walk(p);
        }
      };
      walk(full.payload || {});
      emails.push({ id: m.id, subject: headers.subject || '(no subject)', date: headers.date || '', body: bodyText.slice(0, 4000) });
    } catch (e) {
      console.warn(`Skipping sent email ${m.id}: ${e.message}`);
    }
  }
  return { count: emails.length, emails };
}

const TRASH_PREVIEW_FIELDS=['id','mailbox','threadId','historyId','from','subject','date','snippet'];
const cleanPreviewText=(value,limit)=>String(value||'').replace(/\s+/g,' ').trim().slice(0,limit);

async function trashPreviewForToken(token,id){
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(String(id||'')))throw Object.assign(new Error('A valid Gmail message ID is required.'),{status:400});
  let profile,message;
  try{
    const getToken=async()=>token;
    profile=await apiFetch(getToken,'/profile');
    message=await apiFetch(getToken,`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
  }catch(error){throw Object.assign(new Error('Could not verify this Gmail message. Try again after checking the connection.'),{status:502,cause:error});}
  const mailbox=cleanPreviewText(profile.emailAddress,254).toLowerCase();
  if(!mailbox.includes('@')||message.id!==id||!message.threadId||!message.historyId||message.labelIds?.includes('TRASH')){
    throw Object.assign(new Error('Gmail returned incomplete or changed metadata for the selected message.'),{status:409});
  }
  const headers=Object.fromEntries((message.payload?.headers||[]).map(header=>[String(header.name||'').toLowerCase(),header.value]));
  const from=cleanPreviewText(headers.from,300);
  if(!from)throw Object.assign(new Error('Gmail did not provide a sender for this message.'),{status:409});
  return{
    id:String(id),mailbox,threadId:cleanPreviewText(message.threadId,100),historyId:cleanPreviewText(message.historyId,100),
    from,subject:cleanPreviewText(headers.subject,300)||'(no subject)',date:cleanPreviewText(headers.date,100),
    snippet:cleanPreviewText(message.snippet,200)
  };
}

// Build the review card from Gmail's exact message ID and mailbox, never from
// model-supplied sender/subject text. Reuse one access token for both reads.
export async function getTrashPreview(getToken,{id}){
  return trashPreviewForToken(await getToken(),id);
}

// Move the exact reviewed message to trash. The metadata and connected Gmail
// mailbox must still match immediately before the write. Legacy approvals
// without an authoritative preview cannot be executed.
export async function trashEmail(getToken,{id,expectedPreview}){
  if(!expectedPreview||TRASH_PREVIEW_FIELDS.some(field=>typeof expectedPreview[field]!=='string')){
    throw Object.assign(new Error('This Gmail deletion lacks a verified preview. Stage it again.'),{status:409});
  }
  const token=await getToken();
  const current=await trashPreviewForToken(token,id);
  if(TRASH_PREVIEW_FIELDS.some(field=>current[field]!==expectedPreview[field])){
    throw Object.assign(new Error('This Gmail message or connected mailbox changed. Stage it again.'),{status:409});
  }
  await apiFetch(async()=>token,`/messages/${encodeURIComponent(id)}/trash`,{method:'POST'});
  return{trashed:true,id};
}
