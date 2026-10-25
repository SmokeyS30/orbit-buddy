// D1: chat image attachments — ephemeral server-side staging.
//
// Uploaded image bytes are held in memory only, keyed by a random UUID and
// bound to the uploading user. The client sends the attachment id with
// /api/chat; the server consumes it (takeAttachment) in the same turn and the
// bytes are dropped immediately after processImageInput() runs. Entries expire
// after 10 minutes. Bytes never touch the DB or disk, and are never logged.

import { randomUUID } from 'node:crypto';
import { validateImageInput, MAX_IMAGE_BYTES } from './model.js';
import { reserveRetainedMediaBuffer } from './media-memory.js';

/** Staged attachments expire this long after upload. */
export const ATTACHMENT_TTL_MS = 10 * 60_000;
/** Per-user cap on simultaneously staged attachments (bounds memory). */
export const MAX_ATTACHMENTS_PER_USER = 5;
// Slightly over the 10MB image cap to absorb multipart framing overhead.
export const MAX_UPLOAD_BYTES = MAX_IMAGE_BYTES + 256 * 1024;
export const MAX_CONCURRENT_ATTACHMENT_UPLOADS=4;
export const MAX_CONCURRENT_UPLOADS_PER_USER=2;

const staged = new Map(); // id -> { userId, bytes, mimeType, createdAt }
let activeUploads=0;
const activeByUser=new Map();

export function acquireAttachmentUpload(userId){
  const owned=activeByUser.get(userId)||0;
  if(activeUploads>=MAX_CONCURRENT_ATTACHMENT_UPLOADS||owned>=MAX_CONCURRENT_UPLOADS_PER_USER){
    throw Object.assign(new Error('Attachment upload capacity is temporarily full. Retry shortly.'),{status:429});
  }
  activeUploads++;activeByUser.set(userId,owned+1);
  let released=false;
  return()=>{
    if(released)return;released=true;activeUploads--;
    const remaining=(activeByUser.get(userId)||1)-1;
    if(remaining>0)activeByUser.set(userId,remaining);else activeByUser.delete(userId);
  };
}

function discard(id,entry){staged.delete(id);entry.releaseBudget();}

export function pruneAttachments(nowMs = Date.now()) {
  for (const [id, entry] of staged) {
    if (nowMs - entry.createdAt > ATTACHMENT_TTL_MS) discard(id,entry);
  }
}

export function clearAttachmentsForUser(userId){
  for(const [id,entry] of staged)if(entry.userId===userId)discard(id,entry);
}

function mimeFromPartHeaders(headers) {
  const match = /content-type:\s*([^\r\n;]+)/i.exec(headers);
  return match ? match[1].trim() : '';
}

/**
 * Binary-safe multipart parser for a single image upload. Returns
 * { bytes: Buffer, filename, mimeType } for the first file part, or null when
 * the body has no file part. Operates on Buffers so image bytes are never
 * corrupted by string decoding (unlike the text-oriented import parser).
 */
export function parseMultipartImage(bodyBuffer, contentType) {
  const match = /boundary=([^;]+)/i.exec(String(contentType || ''));
  if (!match) return null;
  const boundary = Buffer.from(`--${match[1].trim().replace(/^"|"$/g, '')}`, 'latin1');
  const headerEndMarker = Buffer.from('\r\n\r\n', 'latin1');
  let cursor = 0;
  for (;;) {
    const start = bodyBuffer.indexOf(boundary, cursor);
    if (start === -1) return null;
    let partStart = start + boundary.length;
    if (bodyBuffer[partStart] === 0x2d && bodyBuffer[partStart + 1] === 0x2d) return null; // closing `--`
    if (bodyBuffer[partStart] === 0x0d && bodyBuffer[partStart + 1] === 0x0a) partStart += 2;
    const headerEnd = bodyBuffer.indexOf(headerEndMarker, partStart);
    if (headerEnd === -1) return null;
    const headers = bodyBuffer.slice(partStart, headerEnd).toString('latin1');
    const contentStart = headerEnd + headerEndMarker.length;
    if (!/filename=/.test(headers)) {
      cursor = contentStart; // text field — skip to the next part
      continue;
    }
    const nextBoundary = bodyBuffer.indexOf(boundary, contentStart);
    if (nextBoundary === -1) return null;
    let contentEnd = nextBoundary;
    if (bodyBuffer[contentEnd - 2] === 0x0d && bodyBuffer[contentEnd - 1] === 0x0a) contentEnd -= 2;
    const fileMatch = /filename="([^"]{1,200})"/i.exec(headers) || /filename=([^;\r\n]{1,200})/i.exec(headers);
    return {
      bytes: bodyBuffer.slice(contentStart, contentEnd),
      filename: fileMatch ? fileMatch[1] : 'image',
      mimeType: mimeFromPartHeaders(headers),
    };
  }
}

/**
 * Validate and stage an uploaded image, returning the attachment id the
 * client includes with its /api/chat send. Validation failures throw with an
 * HTTP-style `status` so the upload endpoint can fail fast.
 */
export function stageAttachment(userId, { bytes, mimeType }) {
  pruneAttachments();
  let owned = 0;
  for (const entry of staged.values()) if (entry.userId === userId) owned += 1;
  if (owned >= MAX_ATTACHMENTS_PER_USER) {
    throw Object.assign(new Error('Too many pending attachments. Send or remove one first.'), { status: 429 });
  }
  const {buffer,mime}=validateImageInput({bytes,mimeType}); // no throwaway base64 copy
  const {bytes:retained,releaseBudget}=reserveRetainedMediaBuffer(buffer);
  try{
    const id = randomUUID();
    staged.set(id, {
      userId,
      bytes:retained,
      mimeType:mime,
      createdAt: Date.now(),
      releaseBudget,
    });
    return id;
  }catch(error){releaseBudget();throw error;}
}

/**
 * Consume a staged attachment: returns { bytes, mimeType } and deletes the
 * entry, or null when the id is unknown, expired, or belongs to another user.
 */
export function takeAttachment(userId, id) {
  const entry = peekAttachment(userId, id);
  if (!entry) return null;
  discard(String(id),entry);
  return { bytes: entry.bytes, mimeType: entry.mimeType };
}

/**
 * Non-destructive lookup for two-phase consumption: callers can verify every
 * id resolves BEFORE consuming any of them, so one stale id never silently
 * drops the other attachments in the same turn.
 */
export function peekAttachment(userId, id) {
  pruneAttachments();
  const entry = staged.get(String(id || ''));
  return entry && entry.userId === userId ? entry : null;
}
