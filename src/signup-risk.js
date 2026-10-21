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
  // Command-line HTTP clients are not malicious by themselves. They are an
  // explainable ambiguity signal, so enforcement asks for email verification
  // instead of denying access.
  if (/\b(curl|wget|python-requests|go-http-client)\b/i.test(agent)) {
    signals.push('non_browser_client');
    score += 30;
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

// Preserve the current owner-controlled door while a rollout is off or only
// observing. Enforcement is the explicit cutover: low-risk applicants are
// admitted automatically, ambiguous applicants take the verification path,
// and only strong abuse signals are denied. Initial owner creation is always
// allowed so a configuration mistake cannot lock a fresh installation.
export function signupAdmission({ mode, result, hasOwner, registrationOpen = false, verifiedEmail = false } = {}) {
  if (!hasOwner) return { action: 'allow', reason: 'initial_owner' };
  if (mode !== 'enforce') {
    return registrationOpen
      ? { action: 'allow', reason: 'legacy_door_open' }
      : { action: 'closed', reason: 'legacy_door_closed' };
  }
  if (result?.decision === 'deny') return { action: 'deny', reason: 'strong_abuse_signal' };
  if (result?.decision === 'verify') {
    return verifiedEmail
      ? { action: 'allow', reason: 'verified_email' }
      : { action: 'verify', reason: 'step_up_required' };
  }
  return { action: 'allow', reason: 'low_risk' };
}

export function summarizeSignupRiskEvents(rows = []) {
  const decisions = { allow: 0, verify: 0, deny: 0 };
  const signals = {};
  const events = [];
  for (const row of rows) {
    const decision = String(row?.decision || '');
    if (Object.hasOwn(decisions, decision)) decisions[decision]++;
    let parsed = [];
    try { parsed = JSON.parse(row?.signals_json || '[]'); } catch {}
    if (!Array.isArray(parsed)) parsed = [];
    parsed = parsed.map((signal) => String(signal).slice(0, 80)).filter(Boolean);
    for (const signal of parsed) signals[signal] = (signals[signal] || 0) + 1;
    events.push({
      mode: String(row?.mode || 'off'),
      decision,
      score: Number(row?.score) || 0,
      signals: parsed,
      createdAt: row?.created_at || null,
    });
  }
  return { total: rows.length, decisions, signals, latestAt: events[0]?.createdAt || null, events };
}
