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
