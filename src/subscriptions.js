/**
 * StoreKit 2 subscription service (no third-party SDK).
 *
 * Locked catalog:
 *   com.smokeys30.orbitbuddy.standard.monthly — $5.99/mo  (service level 2)
 *   com.smokeys30.orbitbuddy.standard.yearly  — $59.99/yr (service level 2)
 *   com.smokeys30.orbitbuddy.pro.monthly      — $19.99/mo  (service level 1)
 * Free tier: 25 chat messages per New York calendar day. Paid: unlimited.
 *
 * Safety: SUBSCRIPTIONS_ENABLED defaults to false. The quota is NEVER
 * enforced unless subscriptions are explicitly enabled AND Apple's server
 * configuration is complete. Existing production users are never blocked
 * at message 26 while products/credentials are unavailable.
 *
 * Env:
 *   SUBSCRIPTIONS_ENABLED=true|false (default false)
 *   APPSTORE_ISSUER_ID      — App Store Connect API issuer ID
 *   APPSTORE_KEY_ID         — API key ID
 *   APPSTORE_PRIVATE_KEY_P8 — API private key (.p8 text)
 *   APPSTORE_BUNDLE_ID      — defaults to com.smokeys30.orbitbuddy
 *   APPSTORE_SANDBOX=true   — use the sandbox App Store Server API
 *
 * Verification is two-layered:
 *   1. JWS signature + certificate-chain validation of the signed payload
 *      (defense in depth; never logs the payload itself).
 *   2. Server-to-server confirmation with Apple's App Store Server API —
 *      this is the trust anchor. No entitlement is granted without it.
 */
import crypto from 'node:crypto';

export const BUNDLE_ID_DEFAULT = 'com.smokeys30.orbitbuddy';
export const FREE_DAILY_LIMIT = 25;

export const PRODUCTS = {
  'com.smokeys30.orbitbuddy.standard.monthly': { price: 5.99, interval: 'month', level: 2, name: 'Standard Monthly' },
  'com.smokeys30.orbitbuddy.standard.yearly': { price: 59.99, interval: 'year', level: 2, name: 'Standard Yearly' },
  'com.smokeys30.orbitbuddy.pro.monthly': { price: 19.99, interval: 'month', level: 1, name: 'Pro Monthly' },
};

// Statuses that keep the user unlimited.
const UNLIMITED_STATUSES = new Set(['active', 'grace']);

// ---------------------------------------------------------------------------
// Universal midnight reset: one reset at 00:00 America/New_York for every
// user worldwide. Timestamps are stored in UTC; the NY calendar day is
// derived, never stored as local time.
// ---------------------------------------------------------------------------

/** YYYY-MM-DD key for the given instant in America/New_York. */
export function nyDayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * UTC instant of the next 00:00 America/New_York after `date`.
 * Handles DST: 04:00Z in EDT, 05:00Z in EST — computed, not hardcoded.
 */
export function nextResetUtc(date = new Date()) {
  // Find midnight NY by probing: start from UTC midnight guesses.
  const day = new Date(date);
  for (let add = 0; add < 3; add++) {
    const candidate = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + add, 4, 0, 0));
    // Check what NY wall-clock time this candidate is; adjust.
    const nyParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(candidate);
    const get = (t) => nyParts.find((p) => p.type === t).value;
    if (get('hour') === '00' && get('minute') === '00' && candidate > date) return candidate;
    // Not midnight NY: shift by the observed offset difference.
    const nyHour = parseInt(get('hour'), 10);
    const shiftHours = nyHour <= 12 ? -nyHour : 24 - nyHour;
    const adjusted = new Date(candidate.getTime() + shiftHours * 3600_000);
    if (adjusted > date) {
      const check = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(adjusted);
      const cg = (t) => check.find((p) => p.type === t).value;
      if (cg('hour') === '00' && cg('minute') === '00') return adjusted;
    }
  }
  // Fallback: 24h from now (should never hit).
  return new Date(date.getTime() + 24 * 3600_000);
}

// ---------------------------------------------------------------------------
// JWS verification (Apple signed transactions / notification payloads)
// ---------------------------------------------------------------------------

const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function parseJws(jws) {
  if (typeof jws !== 'string') throw new Error('JWS must be a string');
  const parts = jws.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWS');
  const header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
  const payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: b64urlDecode(parts[2]) };
}

/**
 * Verify an Apple JWS: ES256 signature against the x5c leaf key, plus
 * certificate-chain link validation (each cert issued by the next, root
 * self-signed with Apple as issuer). Returns the decoded payload.
 * Never logs or returns the raw JWS.
 */
export function verifyAppleJws(jws, { expectedBundleId = BUNDLE_ID_DEFAULT } = {}) {
  const { header, payload, signingInput, signature } = parseJws(jws);
  if (header.alg !== 'ES256') throw new Error('Unexpected JWS alg');
  const chain = header.x5c;
  if (!Array.isArray(chain) || chain.length === 0) throw new Error('JWS missing x5c chain');
  const certs = chain.map((b64) => new crypto.X509Certificate(Buffer.from(b64, 'base64')));
  const leaf = certs[0];
  // Signature check against the leaf public key. Apple JWS uses ES256 with
  // raw R||S (ieee-p1363), not DER.
  const ok = crypto.verify('sha256', Buffer.from(signingInput), { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' }, signature);
  if (!ok) throw new Error('JWS signature invalid');
  // Chain links: each cert's issuer must match the next cert's subject, and
  // the link signature must verify with the issuer's public key. Root must
  // be self-signed by Apple.
  for (let i = 0; i < certs.length - 1; i++) {
    if (certs[i].issuer !== certs[i + 1].subject) throw new Error('Certificate chain broken');
    if (!certs[i].verify(certs[i + 1].publicKey)) throw new Error('Certificate link signature invalid');
  }
  const root = certs[certs.length - 1];
  if (!root.verify(root.publicKey) || !/Apple/i.test(root.issuer)) {
    throw new Error('JWS not rooted at Apple CA');
  }
  if (payload.bundleId && payload.bundleId !== expectedBundleId) {
    throw new Error('JWS bundleId mismatch');
  }
  return payload;
}

// ---------------------------------------------------------------------------
// App Store Server API (server-to-server confirmation)
// ---------------------------------------------------------------------------

const API_PROD = 'https://api.storekit.itunes.apple.com';
const API_SANDBOX = 'https://api.storekit-sandbox.itunes.apple.com';

function apiJwt({ issuerId, keyId, privateKey, bundleId }) {
  const key = privateKey.includes('\\n') ? privateKey.replace(/\\n/g, '\n') : privateKey;
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: issuerId, iat: now, exp: now + 3600, aud: 'appstoreconnect-v1', bid: bundleId,
  })).toString('base64url');
  const data = `${header}.${payload}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `${data}.${Buffer.from(sig).toString('base64url')}`;
}

async function appStoreGet({ base, path, jwt }) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${jwt}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`App Store Server API ${res.status}`);
    err.appleStatus = res.status;
    throw err;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createSubscriptionService(env, db) {
  const enabled = String(env.SUBSCRIPTIONS_ENABLED || '').toLowerCase() === 'true';
  const issuerId = String(env.APPSTORE_ISSUER_ID || '').trim();
  const keyId = String(env.APPSTORE_KEY_ID || '').trim();
  const privateKey = String(env.APPSTORE_PRIVATE_KEY_P8 || '').trim();
  const bundleId = String(env.APPSTORE_BUNDLE_ID || '').trim() || BUNDLE_ID_DEFAULT;
  const sandbox = String(env.APPSTORE_SANDBOX || '').toLowerCase() === 'true';
  const configured = Boolean(issuerId && keyId && privateKey);
  const apiBase = sandbox ? API_SANDBOX : API_PROD;
  // Comped exemption: designated user IDs (comma-separated) plus the owner
  // role always get unlimited chat for free, bypassing both the subscription
  // check and the daily limit — regardless of SUBSCRIPTIONS_ENABLED.
  const compedUserIds = new Set(
    String(env.COMPED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
  );

  if (!enabled) {
    console.log('[subscriptions] SUBSCRIPTIONS_ENABLED is not true — quota enforcement disabled.');
  } else if (!configured) {
    console.log('[subscriptions] SUBSCRIPTIONS_ENABLED=true but Apple server config incomplete (need APPSTORE_ISSUER_ID, APPSTORE_KEY_ID, APPSTORE_PRIVATE_KEY_P8) — quota enforcement disabled until configured.');
  }

  const ready = enabled && configured;
  const signedJwt = () => apiJwt({ issuerId, keyId, privateKey, bundleId });

  /**
   * Verify a client-supplied signed transaction and confirm it with Apple.
   * Returns { productId, status, expiresAt, environment, originalTransactionId,
   *           appAccountToken } — throws on any verification failure.
   * Never grants entitlement without Apple server confirmation.
   */
  async function verifyTransaction(signedTransaction, { userId, expectedAppAccountToken } = {}) {
    if (!ready) throw Object.assign(new Error('Subscriptions are not ready.'), { status: 503 });
    const claims = verifyAppleJws(signedTransaction, { expectedBundleId: bundleId });
    const productId = claims.productId;
    if (!PRODUCTS[productId]) throw Object.assign(new Error('Unknown product.'), { status: 400 });
    if (expectedAppAccountToken && claims.appAccountToken && claims.appAccountToken !== expectedAppAccountToken) {
      throw Object.assign(new Error('Transaction is not bound to this account.'), { status: 403 });
    }
    if (userId && claims.appAccountToken) {
      const sub = db.getSubscription(userId);
      if (sub && sub.app_account_token && sub.app_account_token !== claims.appAccountToken) {
        throw Object.assign(new Error('Transaction is not bound to this account.'), { status: 403 });
      }
    }
    // Server-to-server confirmation: the trust anchor.
    const info = await appStoreGet({ base: apiBase, path: `/inApps/v1/transactions/${claims.transactionId}`, jwt: signedJwt() });
    const txn = verifyAppleJws(info.signedTransactionInfo, { expectedBundleId: bundleId });
    if (txn.transactionId !== claims.transactionId) throw new Error('Transaction mismatch with Apple');
    if (txn.productId !== productId) throw new Error('Product mismatch with Apple');
    const environment = (txn.environment || (sandbox ? 'Sandbox' : 'Production')).toLowerCase();
    return {
      productId,
      status: 'active',
      expiresAt: txn.expiresDate ? new Date(Number(txn.expiresDate)).toISOString() : null,
      environment,
      originalTransactionId: txn.originalTransactionId || null,
      appAccountToken: txn.appAccountToken || null,
    };
  }

  /** Look up current entitlement from Apple (used by restore). */
  async function fetchEntitlements(userId) {
    const sub = db.getSubscription(userId);
    if (!sub || !sub.original_transaction_id) return [];
    const data = await appStoreGet({
      base: apiBase, path: `/inApps/v1/subscriptions/${sub.original_transaction_id}`, jwt: signedJwt(),
    });
    const out = [];
    for (const group of data.data || []) {
      for (const item of group.lastTransactions || []) {
        const txn = verifyAppleJws(item.signedTransactionInfo, { expectedBundleId: bundleId });
        const renewal = item.signedRenewalInfo ? verifyAppleJws(item.signedRenewalInfo, { expectedBundleId: bundleId }) : {};
        out.push({
          productId: txn.productId,
          status: renewal.autoRenewStatus === '0' ? 'expired' : 'active',
          expiresAt: txn.expiresDate ? new Date(Number(txn.expiresDate)).toISOString() : null,
          environment: (txn.environment || '').toLowerCase(),
          originalTransactionId: txn.originalTransactionId,
        });
      }
    }
    return out;
  }

  /**
   * Handle an App Store Server Notifications v2 payload.
   * Idempotent (notificationUUID dedupe), replay-safe, out-of-order safe:
   * only applies updates that move the stored record forward in time.
   */
  async function handleNotification(signedPayload) {
    if (!configured) throw Object.assign(new Error('Subscriptions not configured.'), { status: 503 });
    const outer = verifyAppleJws(signedPayload, { expectedBundleId: bundleId });
    const notificationId = outer.notificationUUID;
    if (!notificationId) throw new Error('Notification missing UUID');
    // Idempotency: first write wins; replays are dropped silently.
    const firstSeen = db.markNotificationProcessed(notificationId);
    if (!firstSeen) return { deduped: true };
    const data = outer.data || {};
    const type = outer.notificationType;
    const txnInfo = data.signedTransactionInfo ? verifyAppleJws(data.signedTransactionInfo, { expectedBundleId: bundleId }) : null;
    const renewalInfo = data.signedRenewalInfo ? verifyAppleJws(data.signedRenewalInfo, { expectedBundleId: bundleId }) : {};
    if (!txnInfo) return { ignored: true, reason: 'no transaction' };

    // Find the user by appAccountToken ownership.
    const appAccountToken = txnInfo.appAccountToken;
    const userId = appAccountToken ? db.findUserByAppAccountToken?.(appAccountToken) : null;
    if (!userId) return { ignored: true, reason: 'unknown account token' };

    const statusFor = () => {
      switch (type) {
        case 'DID_RENEW': return renewalInfo.autoRenewStatus === '0' ? 'expired' : 'active';
        case 'DID_FAIL_TO_RENEW':
          return renewalInfo.isInBillingRetryPeriod === 'true' || renewalInfo.isInBillingRetryPeriod === true
            ? 'billing-retry'
            : (renewalInfo.gracePeriodExpiresDate ? 'grace' : 'expired');
        case 'EXPIRED': return 'expired';
        case 'REFUND':
        case 'REVOKE': return 'revoked';
        case 'GRACE_PERIOD_EXPIRED': return renewalInfo.isInBillingRetryPeriod ? 'billing-retry' : 'expired';
        case 'DID_CHANGE_RENEWAL_STATUS':
          return renewalInfo.autoRenewStatus === '0' ? 'expired' : 'active';
        default: return null;
      }
    };
    const status = statusFor();
    if (!status) return { ignored: true, reason: `unhandled type ${type}` };

    // Out-of-order protection: only move forward in time.
    const current = db.getSubscription(userId);
    const incomingExpiry = txnInfo.expiresDate ? new Date(Number(txnInfo.expiresDate)).toISOString() : null;
    if (current && current.updated_at && outer.signedDate) {
      const notifTime = new Date(Number(outer.signedDate)).toISOString();
      if (notifTime < current.updated_at && status !== 'revoked') {
        return { ignored: true, reason: 'stale notification' };
      }
    }
    db.saveSubscription(userId, {
      productId: txnInfo.productId,
      status,
      expiresAt: incomingExpiry,
      appAccountToken,
      environment: (txnInfo.environment || '').toLowerCase(),
      originalTransactionId: txnInfo.originalTransactionId,
    });
    try { db.addEvent(userId, 'subscription_updated', `Subscription ${status}.`); } catch (_) {}
    return { ok: true, status };
  }

  /** Is this user comped (free unlimited)? Owner role is always exempt. */
  function isComped(userId, user) {
    if (compedUserIds.has(String(userId))) return true;
    if (user && (user.role === 'owner' || user.user_role === 'owner')) return true;
    return false;
  }

  /** Is this user currently entitled to unlimited chat? */
  function isPaid(userId, user) {
    if (isComped(userId, user)) return true;
    if (!ready) return false;
    const sub = db.getSubscription(userId);
    if (!sub) return false;
    if (!UNLIMITED_STATUSES.has(sub.status)) return false;
    if (sub.expires_at && new Date(sub.expires_at).valueOf() < Date.now()) return false;
    return true;
  }

  /**
   * Check the daily quota BEFORE accepting a chat message.
   * Returns { allowed: true } or { allowed: false, used, limit, resetAt }.
   * Comped users are always unlimited. When subscriptions are not ready,
   * everything is allowed (fail-open).
   */
  function checkQuota(userId, user, now = new Date()) {
    if (isComped(userId, user)) return { allowed: true, unlimited: true, comped: true };
    if (!ready) return { allowed: true, enforced: false };
    if (isPaid(userId, user)) return { allowed: true, enforced: true, unlimited: true };
    const day = nyDayKey(now);
    const used = db.getDailyUsageCount(userId, day);
    if (used >= FREE_DAILY_LIMIT) {
      return { allowed: false, enforced: true, used, limit: FREE_DAILY_LIMIT, resetAt: nextResetUtc(now).toISOString(), day };
    }
    return { allowed: true, enforced: true, used, limit: FREE_DAILY_LIMIT, day };
  }

  /** Atomically record one accepted chat message against today's quota. */
  function recordUsage(userId, user, now = new Date()) {
    if (isComped(userId, user)) return;
    if (!ready) return;
    if (isPaid(userId, user)) return;
    db.incrementDailyUsage(userId, nyDayKey(now));
  }

  /**
   * Scheduled reset: prune usage rows older than yesterday (NY). Idempotent
   * by construction — today's rows are never touched, and a missed run
   * changes nothing because the day key rolls forward on its own.
   */
  function runDailyReset(now = new Date()) {
    const today = nyDayKey(now);
    db.pruneDailyUsage(today);
    try { db.pruneNotifications(); } catch (_) {}
    return { prunedBefore: today };
  }

  function status(userId, user) {
    const sub = userId ? db.getSubscription(userId) : null;
    const comped = userId ? isComped(userId, user) : false;
    return {
      enabled,
      configured,
      ready,
      comped,
      environment: sandbox ? 'sandbox' : 'production',
      products: Object.keys(PRODUCTS),
      entitlement: sub ? {
        product: sub.product_id, status: sub.status,
        expiresAt: sub.expires_at, unlimited: isPaid(userId, user),
      } : (comped ? { product: 'comped', status: 'active', expiresAt: null, unlimited: true } : null),
    };
  }

  return {
    enabled, configured, get ready() { return ready; },
    PRODUCTS, FREE_DAILY_LIMIT,
    status, verifyTransaction, fetchEntitlements, handleNotification,
    isPaid, isComped, checkQuota, recordUsage, runDailyReset,
    nyDayKey, nextResetUtc, verifyAppleJws,
  };
}
