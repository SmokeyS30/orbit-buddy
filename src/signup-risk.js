import { createHmac } from 'node:crypto';

const VALID_MODES = new Set(['off', 'observe', 'enforce']);

export function signupRiskMode(env = {}) {
  const value = String(env.SIGNUP_RISK_MODE || 'off').trim().toLowerCase();
  return VALID_MODES.has(value) ? value : 'off';
}

export function signupsPaused(env = {}) {
  return /^(1|true|yes|on)$/i.test(String(env.SIGNUPS_PAUSED || '').trim());
}

export function evaluateSignupRisk({ email, userAgent, native = false, attested = false } = {}) {
  const signals = [];
  let score = 0;
  const agent = String(userAgent || '').trim();

  if (!agent) {
    signals.push('missing_user_agent');
    score += 20;
  }
  if (/(headless|selenium|playwright|puppeteer)|\b(bot|crawler|spider)\b/i.test(agent)) {
    signals.push('automation_user_agent');
    score += 80;
  }
  // App Attest is not yet required during registration. Recording this signal
  // in observation mode lets us measure real-device coverage before enforcing it.
  if (native && !attested) signals.push('native_attestation_unavailable');

  const decision = score >= 80 ? 'deny' : score >= 30 ? 'verify' : 'allow';
  return { decision, score, signals };
}

export function signupAuditSubject(email, key) {
  const secret = String(key || '').trim();
  if (!secret) return null;
  return createHmac('sha256', secret).update(String(email || '').trim().toLowerCase()).digest('hex');
}

export function shouldBlockSignup(mode, result) {
  return mode === 'enforce' && result?.decision === 'deny';
}
