// WhatsApp messaging via Twilio (Phase 1: text only).
// ES module. No secrets are logged; the auth token is only used for
// HMAC verification and Basic-auth API calls.

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify Twilio's X-Twilio-Signature on an incoming webhook POST.
 * Algorithm (per Twilio docs): sort POST params by key, concatenate
 * url + key+value for each pair, HMAC-SHA1 with the auth token, base64.
 */
export function verifyTwilioSignature({ authToken, url, params, signature }) {
  if (!authToken || !url || !signature) return false;
  try {
    const keys = Object.keys(params || {}).sort();
    let data = String(url);
    for (const key of keys) data += key + String(params[key]);
    const expected = createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(signature), 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Strip the "whatsapp:" prefix Twilio adds to From/To values. */
export function stripWhatsAppPrefix(value) {
  return String(value || '').replace(/^whatsapp:/i, '');
}

/** True for a plausible E.164 number like +15085551234. */
export function isE164(value) {
  return /^\+\d{7,15}$/.test(String(value || ''));
}

/** Normalize a Twilio From value to E.164, or null if invalid. */
export function normalizePhone(from) {
  const e164 = stripWhatsAppPrefix(from);
  return isE164(e164) ? e164 : null;
}

/** Read an application/x-www-form-urlencoded body into a plain object. */
export async function readFormBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  const params = new URLSearchParams(text);
  const out = {};
  for (const [key, value] of params) out[key] = value;
  return out;
}

/** True when all three Twilio secrets are present in env. */
export function whatsappConfigured(env) {
  return Boolean(
    env?.TWILIO_ACCOUNT_SID?.trim() &&
    env?.TWILIO_AUTH_TOKEN?.trim() &&
    env?.TWILIO_WHATSAPP_NUMBER?.trim()
  );
}

/**
 * Send a WhatsApp text message via Twilio's Messages API.
 * Returns the Twilio message SID. Throws on non-2xx.
 */
export async function sendWhatsAppText({ accountSid, authToken, fromNumber, toPhone, body }) {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
  const form = new URLSearchParams({
    From: `whatsapp:${fromNumber}`,
    To: `whatsapp:${toPhone}`,
    Body: String(body || '').slice(0, 1600),
  });
  const credentials = Buffer.from(`${accountSid}:${authToken}`, 'utf8').toString('base64');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Twilio send failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const data = await response.json().catch(() => ({}));
  return data.sid || null;
}

/** Mask a phone for display: +15085551234 -> +1 ••• ••• 1234 */
export function maskPhone(e164) {
  const digits = String(e164 || '').replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return `+${digits.slice(0, digits.length - 10)} ••• ••• ${digits.slice(-4)}`.replace(/^\+ /, '+');
}

/** True when the Twilio media content type is an audio voice note (WhatsApp sends audio/ogg). */
export function isAudioContentType(mimeType) {
  return String(mimeType || '').toLowerCase().startsWith('audio/');
}

/**
 * Parse a WhatsApp location share from webhook form params.
 * Twilio sends `Latitude`/`Longitude` (and optionally `Address`/`Label`).
 * Returns { lat, lng } rounded to 4 decimals, or null when absent/invalid.
 * Coordinates are range-checked; invalid values are treated as "no location".
 */
export function parseWhatsAppLocation(params) {
  const lat = Number(params?.Latitude);
  const lng = Number(params?.Longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat: lat.toFixed(4), lng: lng.toFixed(4) };
}

/** Format a parsed location as the chat-pipeline message text. */
export function formatLocationMessage({ lat, lng }, label = '') {
  const clean = String(label || '').trim().slice(0, 120);
  return `[Shared location: ${lat}, ${lng}]${clean ? ` ${clean}` : ''}`;
}

/**
 * Stored in the conversation history in place of a location message.
 * Coordinates are NEVER persisted — only the model turn sees them.
 */
export const LOCATION_STORED_MESSAGE = '[Shared location]';

/** WhatsApp's customer-service messaging window: free-form outbound messages
 * are only allowed within 24h of the user's last inbound message. Outside the
 * window only approved template messages may be sent — and this app sends no
 * templates, so outbound WhatsApp delivery must be skipped/fallback elsewhere.
 */
export const WHATSAPP_MESSAGE_WINDOW_MS = 24 * 3600_000;

/**
 * True when the 24h messaging window is open for the given last-inbound
 * timestamp (ISO string). Pure and testable; `nowMs` is injectable.
 */
export function isWindowOpen(lastInboundAt, nowMs = Date.now()) {
  if (!lastInboundAt) return false;
  const at = new Date(lastInboundAt).valueOf();
  if (!Number.isFinite(at)) return false;
  const age = nowMs - at;
  return age >= 0 && age < WHATSAPP_MESSAGE_WINDOW_MS;
}

/** Max bytes downloaded from a Twilio media URL (~10 MB; WhatsApp voice notes are far smaller). */
export const MAX_TWILIO_MEDIA_BYTES = 10 * 1024 * 1024;

/**
 * Download a Twilio-hosted media file (media URLs 401 without auth).
 * GET with Basic auth (AccountSid:AuthToken), with a size cap enforced via
 * Content-Length when present and a streaming cap as a backstop.
 * Returns { bytes: Buffer, contentType }. Throws on HTTP errors or oversize.
 */
export async function downloadTwilioMedia({ accountSid, authToken, url, maxBytes = MAX_TWILIO_MEDIA_BYTES }) {
  if (!url) throw new Error('No media URL provided.');
  const credentials = Buffer.from(`${accountSid}:${authToken}`, 'utf8').toString('base64');
  const response = await fetch(String(url), {
    headers: { Authorization: `Basic ${credentials}` },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Twilio media download failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw Object.assign(new Error('Media file is too large.'), { code: 'MEDIA_TOO_LARGE' });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Media file is too large.'), { code: 'MEDIA_TOO_LARGE' });
    chunks.push(chunk);
  }
  const contentType = String(response.headers?.get?.('content-type') || '').split(';')[0].trim();
  return { bytes: Buffer.concat(chunks), contentType };
}

/** OpenAI Whisper transcription endpoint. */
export const WHISPER_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

/**
 * Transcribe a voice-note's audio bytes with Whisper (whisper-1 takes Ogg/Opus
 * natively — no conversion). Returns the transcript text. Throws on failure.
 * Audio is processed in memory and never persisted.
 */
export async function transcribeVoiceNote({ apiKey, audioBytes, filename = 'voice-note.ogg', mimeType = 'audio/ogg' }) {
  if (!apiKey?.trim()) throw new Error('Transcription is not configured.');
  const bytes = Buffer.isBuffer(audioBytes) ? audioBytes : Buffer.from(audioBytes || []);
  if (!bytes.length) throw new Error('Empty audio payload.');
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('file', new Blob([bytes], { type: mimeType }), filename);
  const response = await fetch(WHISPER_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
    body: form,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Transcription failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const data = await response.json().catch(() => ({}));
  return String(data.text || '').trim();
}

/**
 * Build a wa.me deep link that opens WhatsApp to Orbit's number with the
 * linking code pre-filled. Tapping it on a phone opens the chat ready to send.
 * `fromNumber` is the configured TWILIO_WHATSAPP_NUMBER (may include the
 * "whatsapp:" prefix and formatting); digits are extracted for wa.me.
 */
export function buildLinkDeepLink(fromNumber, code) {
  const digits = String(fromNumber || '').replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(String(code || ''))}`;
}
