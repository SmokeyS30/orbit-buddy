import { promisify } from 'node:util';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const scrypt = promisify(scryptCallback);

export const hashToken = (value) => createHash('sha256').update(String(value)).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export async function hashPassword(password, salt = randomBytes(16).toString('base64url')) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw Object.assign(new Error('Password must contain 12 to 256 characters.'), { status: 400 });
  }
  const derived = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { hash: Buffer.from(derived).toString('base64url'), salt };
}

export async function verifyPassword(password, expectedHash, salt) {
  try {
    const result = await hashPassword(password, salt);
    const left = Buffer.from(result.hash); const right = Buffer.from(expectedHash || '');
    return left.length === right.length && timingSafeEqual(left, right);
  } catch { return false; }
}

export function makeRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(8).toString('hex').toUpperCase();
    return `ORBIT-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12)}`;
  });
}

export function parseCookies(header = '') {
  const output = {};
  for (const piece of header.split(';')) {
    const index = piece.indexOf('=');
    if (index < 0) continue;
    output[decodeURIComponent(piece.slice(0, index).trim())] = decodeURIComponent(piece.slice(index + 1).trim());
  }
  return output;
}

export function sessionCookie(token, { secure = true, maxAge = 60 * 60 * 24 * 30 } = {}) {
  return `orbit_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie({ secure = true } = {}) {
  return `orbit_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function readEncryptionKey(value) {
  if (!value) return null;
  try {
    const key = Buffer.from(value, 'base64');
    if (key.length === 32) return key;
  } catch {}
  // Hosting providers commonly generate opaque secrets rather than raw keys.
  // Hash a sufficiently long generated value into a stable 256-bit key.
  return String(value).length >= 32 ? createHash('sha256').update(String(value)).digest() : null;
}

export function encryptSecret(plaintext, key) {
  if (!key) throw new Error('Connector encryption is not configured.');
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((value) => value.toString('base64url')).join('.');
}

export function decryptSecret(payload, key) {
  if (!key) throw new Error('Connector encryption is not configured.');
  const [iv, tag, encrypted] = String(payload).split('.').map((value) => Buffer.from(value, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export async function encryptPortable(value, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 16) throw Object.assign(new Error('Backup passphrase must contain at least 16 characters.'), { status: 400 });
  const salt = randomBytes(16); const iv = randomBytes(12);
  const key = Buffer.from(await scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `ORBITBK2.${[salt, iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.')}`;
}

export async function decryptPortable(payload, passphrase) {
  const parts = String(payload).split('.');
  if (parts.length !== 5 || parts[0] !== 'ORBITBK2') throw Object.assign(new Error('Backup format is not recognized.'), { status: 400 });
  const [salt, iv, tag, encrypted] = parts.slice(1).map((part) => Buffer.from(part, 'base64url'));
  const key = Buffer.from(await scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
  } catch { throw Object.assign(new Error('Backup could not be decrypted. Check the passphrase and file.'), { status: 400 }); }
}
