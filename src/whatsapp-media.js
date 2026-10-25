// D5: WhatsApp outbound media — ephemeral staging + signed expiring URLs.
//
// Orbit can receive WhatsApp media (D1) but could not send any. Twilio fetches
// `MediaUrl` server-side, so staged media must live at a public HTTPS URL:
// GET /api/whatsapp/media/:token. Tokens are HMAC-SHA256 signed with a
// sub-key derived from the existing DATA_ENCRYPTION_KEY server secret — no new
// credential is introduced and nothing is rotated. Bytes live in memory only,
// expire after 15 minutes, are never persisted, and are never logged.
// Invalid and expired tokens both answer 404 (never 403) so tokens leak
// nothing about validity. Staged media is non-destructive (Twilio may retry a
// fetch inside the window) and expiry is never extended on fetch.

import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { reserveMediaBytes } from './media-memory.js';

/** Signed media URLs live this long (Twilio may retry inside the window). */
export const WHATSAPP_MEDIA_TTL_MS = 15 * 60_000;
/** Content types Twilio can relay outbound to WhatsApp (images + PDF docs). */
export const WHATSAPP_MEDIA_ALLOWLIST = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
/** 10 MB outbound cap (matches Twilio's WhatsApp media limit). */
export const MAX_WHATSAPP_MEDIA_BYTES = 10 * 1024 * 1024;
/** Per-user cap on simultaneously staged outbound media (bounds memory). */
export const MAX_STAGED_WHATSAPP_MEDIA = 5;

const staged = new Map(); // mediaId -> { userId, bytes, mimeType, createdAt }

export function pruneWhatsAppMedia(nowMs = Date.now()) {
  for (const [id, entry] of staged) {
    if (nowMs - entry.createdAt > WHATSAPP_MEDIA_TTL_MS){staged.delete(id);entry.releaseBudget();}
  }
}

export function clearWhatsAppMediaForUser(userId){
  for(const [id,entry] of staged)if(entry.userId===userId){staged.delete(id);entry.releaseBudget();}
}

function normalizeContentType(mimeType) {
  return String(mimeType || '').split(';')[0].trim().toLowerCase();
}

/**
 * Derive the media-signing sub-key from the existing server encryption key
 * (DATA_ENCRYPTION_KEY). Domain-separated so the HMAC key is never used
 * cross-protocol. Returns null when no server secret is configured.
 */
export function deriveMediaSigningKey(serverSecret) {
  if (!serverSecret) return null;
  return createHmac('sha256', serverSecret).update('orbit-whatsapp-media-v1', 'utf8').digest();
}

/**
 * Validate and stage outbound WhatsApp media for one user, returning the
 * mediaId the send path signs into a URL. Same ephemeral pattern as D1's
 * stageAttachment: in-memory, bound to the user, 15-minute TTL, never
 * persisted, never logged. Validation failures throw with an HTTP-style
 * `status` so callers can fail fast.
 */
export function stageWhatsAppMedia(userId, { bytes, mimeType }, nowMs = Date.now()) {
  pruneWhatsAppMedia(nowMs);
  const type = normalizeContentType(mimeType);
  if (!WHATSAPP_MEDIA_ALLOWLIST.includes(type)) {
    throw Object.assign(new Error('Unsupported media type.'), { status: 415 });
  }
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!buf.length) throw Object.assign(new Error('Empty media payload.'), { status: 400 });
  if (buf.length > MAX_WHATSAPP_MEDIA_BYTES) {
    throw Object.assign(new Error('Media file is too large.'), { status: 413 });
  }
  let owned = 0;
  for (const entry of staged.values()) if (entry.userId === userId) owned += 1;
  if (owned >= MAX_STAGED_WHATSAPP_MEDIA) {
    throw Object.assign(new Error('Too many staged media files. Wait for the current send to finish.'), { status: 429 });
  }
  const releaseBudget=reserveMediaBytes(buf.length);
  const mediaId = randomUUID();
  staged.set(mediaId, { userId, bytes: buf, mimeType: type, createdAt: nowMs, releaseBudget });
  return mediaId;
}

/**
 * Non-destructive lookup: Twilio may retry a fetch, so a valid token can be
 * fetched more than once inside the window. Returns { bytes, mimeType } or
 * null when unknown or expired.
 */
export function peekWhatsAppMedia(mediaId, nowMs = Date.now()) {
  pruneWhatsAppMedia(nowMs);
  return staged.get(String(mediaId || '')) || null;
}

const MEDIA_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sign a media token: `mediaId.expiry.signature`, where
 * signature = HMAC-SHA256(mediaId + '.' + expiry, sub-key), base64url.
 * Throws when no server secret is available (503-style).
 */
export function signWhatsAppMediaToken(mediaId, secret, nowMs = Date.now()) {
  if (!secret) {
    throw Object.assign(new Error('WhatsApp media is not configured.'), { status: 503 });
  }
  const id = String(mediaId || '');
  if (!MEDIA_ID_RE.test(id)) throw Object.assign(new Error('Unknown media.'), { status: 404 });
  const expiry = nowMs + WHATSAPP_MEDIA_TTL_MS;
  const signature = createHmac('sha256', secret).update(`${id}.${expiry}`, 'utf8').digest('base64url');
  return `${id}.${expiry}.${signature}`;
}

/**
 * Verify a media token. Returns { mediaId, expiry } when the signature is
 * valid and unexpired, null otherwise (malformed, tampered, expired, or no
 * secret). Comparison uses timingSafeEqual.
 */
export function verifyWhatsAppMediaToken(token, secret, nowMs = Date.now()) {
  if (!secret) return null;
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [id, expiryStr, signature] = parts;
  const expiry = Number(expiryStr);
  if (!MEDIA_ID_RE.test(id) || !Number.isInteger(expiry) || expiry <= nowMs) return null;
  let expected, actual;
  try {
    expected = createHmac('sha256', secret).update(`${id}.${expiryStr}`, 'utf8').digest();
    actual = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (expected.length !== actual.length) return null;
  return timingSafeEqual(expected, actual) ? { mediaId: id, expiry } : null;
}

/**
 * Absolute signed URL Twilio can fetch (MediaUrl needs the full public
 * origin). Requires a public HTTPS base (PUBLIC_BASE_URL); HTTP is rejected
 * because a signed media URL must never be served over an insecure origin.
 */
export function buildWhatsAppMediaUrl(publicBase, mediaId, secret, nowMs = Date.now()) {
  const base = String(publicBase || '').replace(/\/$/, '');
  if (!/^https:\/\//.test(base)) {
    throw Object.assign(new Error('A public HTTPS base URL is required for WhatsApp media.'), { status: 503 });
  }
  const token = signWhatsAppMediaToken(mediaId, secret, nowMs);
  return `${base}/api/whatsapp/media/${token}`;
}
