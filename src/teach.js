// Teach Orbit (X3) — explicit knowledge base.
//
// Taught knowledge is EXPLICIT (the user gave it directly: "remember that…",
// "teach Orbit that…", uploaded documents). Memories are OBSERVED (Orbit
// noticed them). The two are stored in separate tables, listed separately,
// and deletable independently. Explicit teaching auto-saves — a direct
// instruction needs no tap.
//
// Document upload accepts ALL file types (owner decision, 2026-10-16): text
// is extracted best-effort per type, and anything we can't read is stored as
// an honest metadata note — nothing is ever rejected by type.

import zlib from 'node:zlib';

/** Sane upload cap for taught files — matches the chat image attachment cap. */
export const TEACH_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Chat-taught items: single-instruction cap (keeps "remember that…" tight). */
export const TEACH_MAX_CHAT_CHARS = 2000;
/** Per-document stored text cap — bounds the knowledge base and prompts. */
export const TEACH_MAX_STORED_CHARS = 50000;

// ---------------------------------------------------------------------------
// Teach-in-chat command parsing
// ---------------------------------------------------------------------------

/**
 * Match explicit teaching instructions. Returns { content } or null.
 * "remember that my mom's birthday is June 12" / "teach Orbit that…" /
 * "note that…". Everything else (including "remember the milk") is not a
 * teach command and flows to the model as normal chat.
 */
export function parseTeachCommand(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 4000) return null;
  const m =
    t.match(/^(?:remember|note)\s+that\s+([\s\S]+)$/i) ||
    t.match(/^teach\s+(?:orbit\s+)?that\s+([\s\S]+)$/i);
  if (!m) return null;
  const content = m[1].trim().replace(/\s+/g, ' ');
  if (content.length < 3 || content.length > TEACH_MAX_CHAT_CHARS) return null;
  return { content };
}

// ---------------------------------------------------------------------------
// Best-effort text extraction (zero dependencies)
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst', 'csv', 'tsv', 'json', 'jsonl', 'xml',
  'html', 'htm', 'xhtml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log',
  'srt', 'vtt', 'tex', 'org',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'py', 'pyi', 'rb',
  'go', 'rs', 'java', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'kt',
  'kts', 'php', 'sh', 'bash', 'zsh', 'fish', 'sql', 'css', 'scss', 'less',
  'vue', 'svelte', 'r', 'jl', 'lua', 'pl', 'pm', 'ps1', 'bat', 'cmd',
  'dockerfile', 'makefile', 'mk', 'env', 'gitignore', 'editorconfig',
]);

function extOf(filename) {
  const base = String(filename || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase().slice(0, 12);
}

function isProbablyText(bytes) {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (!sample.length) return false;
  let bad = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 0x09) bad++;
    else if (b > 0x0d && b < 0x20 && b !== 0x1b) bad++;
  }
  return bad / sample.length < 0.05;
}

function decodeText(bytes) {
  return Buffer.from(bytes).toString('utf8').replace(/�+/g, '').replace(/\0/g, '');
}

// --- PDF: BT/ET blocks, (string)Tj and […]TJ operators, WinAnsi mapping ---
// Best-effort: handles common text PDFs. Encrypted, compressed-object, or
// ToUnicode-CMap PDFs may yield little — callers report that honestly.

function decodePdfString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      const n = raw[i + 1];
      if (n === 'n' || n === 'r') { out += '\n'; i++; }
      else if (n === 't') { out += '\t'; i++; }
      else if (n === 'b') { out += '\b'; i++; }
      else if (n === 'f') { out += '\f'; i++; }
      else if (n === '\\' || n === '(' || n === ')') { out += n; i++; }
      else if (n >= '0' && n <= '7') {
        let oct = '';
        for (let k = 1; k <= 3 && i + k < raw.length && raw[i + k] >= '0' && raw[i + k] <= '7'; k++) oct += raw[i + k];
        out += String.fromCharCode(parseInt(oct, 8));
        i += oct.length;
      } else { out += n; i++; }
    } else {
      out += ch;
    }
  }
  return out;
}

const WIN_ANSI_PUNCT = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†',
  0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ',
  0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•',
  0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›',
  0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

function winAnsiToUnicode(s) {
  return s.replace(/[\x80-\x9f]/g, (c) => WIN_ANSI_PUNCT[c.charCodeAt(0)] || c);
}

function extractPdfText(bytes) {
  const src = Buffer.from(bytes).toString('latin1');
  const texts = [];
  const blockRe = /BT([\s\S]*?)ET/g;
  const strRe = /\((?:\\.|[^\\()])*\)\s*Tj|\[[\s\S]*?\]\s*TJ/g;
  const partRe = /\((?:\\.|[^\\()])*\)/g;
  let bm;
  while ((bm = blockRe.exec(src)) && texts.join(' ').length < 200000) {
    const block = bm[1];
    let sm;
    while ((sm = strRe.exec(block))) {
      const op = sm[0];
      if (/Tj\s*$/.test(op)) {
        const inner = op.slice(1, op.lastIndexOf(')'));
        texts.push(winAnsiToUnicode(decodePdfString(inner)));
      } else {
        const parts = [];
        let pm;
        partRe.lastIndex = 0;
        while ((pm = partRe.exec(op))) parts.push(winAnsiToUnicode(decodePdfString(pm[0].slice(1, -1))));
        texts.push(parts.join(''));
      }
    }
  }
  return texts.join(' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// --- DOCX: minimal ZIP walk to word/document.xml, <w:t> runs per paragraph ---

function decodeXmlEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e]));
}

function extractDocxText(bytes) {
  try {
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (data.length < 30) return '';
    let eocd = -1;
    for (let i = data.length - 22; i >= Math.max(0, data.length - 66000); i--) {
      if (data.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return '';
    const count = data.readUInt16LE(eocd + 10);
    let cdOff = data.readUInt32LE(eocd + 16);
    for (let n = 0; n < count && cdOff + 46 <= data.length; n++) {
      if (data.readUInt32LE(cdOff) !== 0x02014b50) break;
      const method = data.readUInt16LE(cdOff + 10);
      const compSize = data.readUInt32LE(cdOff + 20);
      const nameLen = data.readUInt16LE(cdOff + 28);
      const extraLen = data.readUInt16LE(cdOff + 30);
      const commentLen = data.readUInt16LE(cdOff + 32);
      const localOff = data.readUInt32LE(cdOff + 42);
      const name = data.toString('utf8', cdOff + 46, cdOff + 46 + nameLen);
      cdOff += 46 + nameLen + extraLen + commentLen;
      if (name !== 'word/document.xml') continue;
      if (localOff + 30 > data.length) return '';
      const lhNameLen = data.readUInt16LE(localOff + 26);
      const lhExtraLen = data.readUInt16LE(localOff + 28);
      const contentOff = localOff + 30 + lhNameLen + lhExtraLen;
      const comp = data.subarray(contentOff, contentOff + compSize);
      const xml = method === 8 ? zlib.inflateRawSync(comp).toString('utf8') : comp.toString('utf8');
      const lines = [];
      for (const para of xml.split(/<\/w:p[^>]*>/)) {
        const parts = [];
        const tRe = /<w:t[^>]*>([^<]*)<\/w:t>/g;
        let tm;
        while ((tm = tRe.exec(para))) parts.push(decodeXmlEntities(tm[1]));
        const line = parts.join('');
        if (line) lines.push(line);
      }
      return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    return '';
  } catch {
    return '';
  }
}

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** Honest placeholder for files whose content we can't extract as text. */
export function teachMetadataNote({ filename, mimeType, bytes, reason }) {
  const name = String(filename || 'file');
  const type = String(mimeType || 'unknown type');
  const why = reason || "I couldn't extract readable text from it";
  return `Shared file "${name}" (${type}, ${humanSize(bytes && bytes.length)}). ${why} — it's listed here so you can see it and remove it anytime.`;
}

/** Suggest a filename for WhatsApp media when Twilio provides none. */
export function teachFilenameForMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  const map = {
    'application/pdf': 'pdf', 'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/plain': 'txt', 'text/csv': 'csv', 'text/html': 'html',
    'application/json': 'json', 'application/zip': 'zip',
  };
  const ext = map[mime] || (mime.startsWith('video/') ? mime.slice(6).split(';')[0] : null) || 'file';
  return `shared-document.${ext}`;
}

/**
 * Best-effort text extraction from an uploaded file. Never rejects by type.
 * Returns { text, truncated, extraction, needsVision, note } where extraction
 * is one of 'text' | 'pdf' | 'docx' | 'image' | 'metadata'.
 */
export function extractTeachText({ bytes, filename, mimeType }) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  const ext = extOf(filename);
  const name = String(filename || 'file');
  const cap = (text, extraction, note) => {
    const clean = String(text || '').replace(/\s+\n/g, '\n').trim();
    if (clean.length > TEACH_MAX_STORED_CHARS) {
      return { text: clean.slice(0, TEACH_MAX_STORED_CHARS) + '\n\n[…truncated — the full file was longer]', truncated: true, extraction, needsVision: false, note: note || '' };
    }
    return { text: clean, truncated: false, extraction, needsVision: false, note: note || '' };
  };

  // Images: text comes from the vision pipeline (caller handles needsVision).
  if (IMAGE_MIMES.has(mime) || (IMAGE_EXTS.has(ext) && mime.startsWith('image/'))) {
    return { text: '', truncated: false, extraction: 'image', needsVision: true, note: '' };
  }
  // PDF (also sniff %PDF- when the mime is missing/wrong).
  if (mime === 'application/pdf' || ext === 'pdf' || buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    const text = extractPdfText(buf);
    if (!text) {
      return { text: teachMetadataNote({ filename: name, mimeType: mimeType || 'application/pdf', bytes: buf, reason: 'I could not pull readable text out of this PDF (it may be scanned images or use an unsupported encoding)' }), truncated: false, extraction: 'metadata', needsVision: false, note: 'pdf-unreadable' };
    }
    return cap(text, 'pdf');
  }
  // DOCX (zip sniff: PK\x03\x04).
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === 'docx' ||
      (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && ext === '')) {
    const text = extractDocxText(buf);
    if (!text) {
      return { text: teachMetadataNote({ filename: name, mimeType: mimeType || 'document', bytes: buf, reason: "I couldn't read this Word document's contents" }), truncated: false, extraction: 'metadata', needsVision: false, note: 'docx-unreadable' };
    }
    return cap(text, 'docx');
  }
  // Plain text (mime, extension, or content sniff).
  if (mime.startsWith('text/') || mime === 'application/json' || mime.endsWith('+json') || mime.endsWith('+xml') ||
      TEXT_EXTENSIONS.has(ext) || (!mime && isProbablyText(buf))) {
    return cap(decodeText(buf), 'text');
  }
  // Everything else: accept it, store an honest note — never reject by type.
  return { text: teachMetadataNote({ filename: name, mimeType: mimeType || 'unknown type', bytes: buf }), truncated: false, extraction: 'metadata', needsVision: false, note: '' };
}
