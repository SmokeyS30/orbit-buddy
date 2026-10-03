import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const FETCH_TIMEOUT_MS = 10_000;

function ipIsPrivate(ip) {
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    return lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd') || ip === '::';
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
}

// Blocks server-side request forgery: the caller must never fetch internal,
// link-local, or otherwise non-public addresses, including via redirects.
export async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new Error('That is not a valid URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https URLs are allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (ipIsPrivate(host)) throw new Error('That address is not publicly reachable.');
    return url.toString();
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error('Could not resolve that hostname.');
  }
  if (!addresses.length || addresses.some((entry) => ipIsPrivate(entry.address))) {
    throw new Error('That address is not publicly reachable.');
  }
  return url.toString();
}
