// Transactional email via Resend (https://resend.com).
// If RESEND_API_KEY is not set, sendEmail() returns false and callers should fall back.

const RESEND_API = 'https://api.resend.com/emails';

/**
 * Send a transactional email via Resend.
 * @param {object} env - environment (needs RESEND_API_KEY, optional EMAIL_FROM)
 * @param {object} opts - { to, subject, text, html }
 * @returns {Promise<boolean>} true if sent, false if not configured or failed (never throws)
 */
export async function sendEmail(env, { to, subject, text, html }) {
  const apiKey = env.RESEND_API_KEY || process.env.RESEND_API_KEY;
  if (!apiKey) return false;
  const from = env.EMAIL_FROM || process.env.EMAIL_FROM || 'Orbit <onboarding@resend.dev>';
  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        ...(text ? { text } : {}),
        ...(html ? { html } : {})
      }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn('Resend email failed:', err.message || err.error || `HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('Resend email error:', e.message);
    return false;
  }
}

/**
 * Whether transactional email is configured.
 */
export function emailConfigured(env) {
  return !!(env.RESEND_API_KEY || process.env.RESEND_API_KEY);
}
