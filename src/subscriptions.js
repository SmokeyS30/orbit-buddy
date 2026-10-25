/** StoreKit 2 subscriptions backed by Apple's official server library. */
import crypto from 'node:crypto';
import {
  APIError, APIException, AppStoreServerAPIClient, Environment,
  SignedDataVerifier, Status,
} from '@apple/app-store-server-library';

export const BUNDLE_ID_DEFAULT = 'com.smokeys30.orbitbuddy';
export const FREE_DAILY_LIMIT = 25;
export const BASIC_DAILY_LIMIT = 100;
export const PRODUCTS = {
  'com.smokeys30.orbitbuddy.basic.monthly': { price: 2.99, interval: 'month', level: 3, plan: 'basic', dailyLimit: BASIC_DAILY_LIMIT, name: 'Basic Monthly' },
  // Keep the original product identifiers so existing Standard subscribers
  // retain their entitlement while the customer-facing plan becomes Plus.
  'com.smokeys30.orbitbuddy.standard.monthly': { price: 5.99, interval: 'month', level: 2, plan: 'plus', dailyLimit: null, name: 'Plus Monthly' },
  'com.smokeys30.orbitbuddy.standard.yearly': { price: 59.99, interval: 'year', level: 2, plan: 'plus', dailyLimit: null, name: 'Plus Yearly' },
  // The existing Pro product becomes Unlimited without invalidating receipts.
  'com.smokeys30.orbitbuddy.pro.monthly': { price: 19.99, interval: 'month', level: 1, plan: 'unlimited', dailyLimit: null, name: 'Unlimited Monthly' },
};

const UNLIMITED_STATUSES = new Set(['active', 'grace']);
const TRANSACTION_NOT_FOUND = Number(APIError.TRANSACTION_ID_NOT_FOUND || 4040010);

// Public DER certificates downloaded from Apple's PKI repository. These are
// trust anchors, not secrets. Their SHA-256 fingerprints are asserted in tests.
export const APPLE_ROOT_CA_DER_BASE64 = [
  // Apple Root CA — B0:B1:73:0E:CB:C7:FF:45:05:14:2C:49:F1:29:5E:6E:DA:6B:CA:ED:7E:2C:68:C5:BE:91:B5:A1:10:01:F0:24
  'MIIEuzCCA6OgAwIBAgIBAjANBgkqhkiG9w0BAQUFADBiMQswCQYDVQQGEwJVUzETMBEGA1UEChMKQXBwbGUgSW5jLjEmMCQGA1UECxMdQXBwbGUgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkxFjAUBgNVBAMTDUFwcGxlIFJvb3QgQ0EwHhcNMDYwNDI1MjE0MDM2WhcNMzUwMjA5MjE0MDM2WjBiMQswCQYDVQQGEwJVUzETMBEGA1UEChMKQXBwbGUgSW5jLjEmMCQGA1UECxMdQXBwbGUgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkxFjAUBgNVBAMTDUFwcGxlIFJvb3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDkkakJH5HbHkdQ6wXtXnmELes2oldMVeyLGYne+Uts9QerIjAC6Bg++FAJ039BqJj50cpmnCRrEdCju+QbKsMflZ56DKRHi1vUFjczy8QPTc4UadHJGXL1XQ7Vf1+b8iUDulWPTV0N8WQ1IxVLFVkds5T39pyez1C6wVhQZ48ItCD3y6wsIG9wtj8BMIy3Q88PnT3zK0koGsj+zrW5DtleHNbLPbU6rfQPDgCSC7EhFi501TwN22IWq6NxkkdTVcGvL0Gz+PvjcM3mo0xFfh9Ma1CWQYnEdGILEINBhzOKgbEwWOxaBDKMaLOPHd5lc/9nXmW8Sdh2nzMUZaF3lMktAgMBAAGjggF6MIIBdjAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUK9BpR5R2Cf70a40uQKb3R01/CF4wHwYDVR0jBBgwFoAUK9BpR5R2Cf70a40uQKb3R01/CF4wggERBgNVHSAEggEIMIIBBDCCAQAGCSqGSIb3Y2QFATCB8jAqBggrBgEFBQcCARYeaHR0cHM6Ly93d3cuYXBwbGUuY29tL2FwcGxlY2EvMIHDBggrBgEFBQcCAjCBthqBs1JlbGlhbmNlIG9uIHRoaXMgY2VydGlmaWNhdGUgYnkgYW55IHBhcnR5IGFzc3VtZXMgYWNjZXB0YW5jZSBvZiB0aGUgdGhlbiBhcHBsaWNhYmxlIHN0YW5kYXJkIHRlcm1zIGFuZCBjb25kaXRpb25zIG9mIHVzZSwgY2VydGlmaWNhdGUgcG9saWN5IGFuZCBjZXJ0aWZpY2F0aW9uIHByYWN0aWNlIHN0YXRlbWVudHMuMA0GCSqGSIb3DQEBBQUAA4IBAQBcNplMLXi37Yyb3PN3m/J20ncwT8EfhYOFG5k9RzfyqZtAjizUsZAS2L70c5vu0mQPy3lPNNiiPvl4/2vIB+x9OYOLUyDTOMSxv5pPCmv/K/xZpwUJfBdAVhEedNO3iyM7R6PVbyTi69G3cN8PReEnyvFteO3ntRcXqNx+IjXKJdXZD9Zr1KIkIxH3oayPc4FgxhtbCS+SsvhESPBgOJ4V9T0mZyCKM2r3DYLP3uujL/lTaltkwGMzd/c6ByxW69oPIQ7aunMZT7XZNn/Bh1XZp5m5MkL72NVxnn6hUrcbvZNCJBIqxw8dtk2cXmPIS4AXUKqK1drk/NAJBzewdXUh',
  // Apple Root CA - G2 — C2:B9:B0:42:DD:57:83:0E:7D:11:7D:AC:55:AC:8A:E1:94:07:D3:8E:41:D8:8F:32:15:BC:3A:89:04:44:A0:50
  'MIIFkjCCA3qgAwIBAgIIAeDltYNno+AwDQYJKoZIhvcNAQEMBQAwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEcyMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxMDA5WhcNMzkwNDMwMTgxMDA5WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzIxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBANgREkhI2imKScUcx+xuM23+TfvgHN6sXuI2pyT5f1BrTM65MFQn5bPW7SXmMLYFN14UIhHF6Kob0vuy0gmVOKTvKkmMXT5xZgM4+xb1hYjkWpIMBDLyyED7Ul+f9sDx47pFoFDVEovy3d6RhiPw9bZyLgHaC/YuOQhfGaFjQQscp5TBhsRTL3b2CtcM0YM/GlMZ81fVJ3/8E7j4ko380yhDPLVoACVdJ2LT3VXdRCCQgzWTxb+4Gftr49wIQuavbfqeQMpOhYV4SbHXw8EwOTKrfl+q04tvny0aIWhwZ7Oj8ZhBbZF8+NfbqOdfIRqMM78xdLe40fTgIvS/cjTf94FNcX1RoeKz8NMoFnNvzcytN31O661A4T+B/fc9Cj6i8b0xlilZ3MIZgIxbdMYs0xBTJh0UT8TUgWY8h2czJxQI6bR3hDRSj4n4aJgXv8O7qhOTH11UL6jHfPsNFL4VPSQ08prcdUFmIrQB1guvkJ4M6mL4m1k8COKWNORj3rw31OsMiANDC1CvoDTdUE0V+1ok2Az6DGOeHwOx4e7hqkP0ZmUoNwIx7wHHHtHMn23KVDpA287PT0aLSmWaasZobNfMmRtHsHLDd4/E92GcdB/O/WuhwpyUgquUoue9G7q5cDmVF8Up8zlYNPXEpMZ7YLlmQ1A/bmH8DvmGqmAMQ0uVAgMBAAGjQjBAMB0GA1UdDgQWBBTEmRNsGAPCe8CjoA1/coB6HHcmjTAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQwFAAOCAgEAUabz4vS4PZO/Lc4Pu1vhVRROTtHlznldgX/+tvCHM/jvlOV+3Gp5pxy+8JS3ptEwnMgNCnWefZKVfhidfsJxaXwU6s+DDuQUQp50DhDNqxq6EWGBeNjxtUVAeKuowM77fWM3aPbn+6/Gw0vsHzYmE1SGlHKy6gLti23kDKaQwFd1z4xCfVzmMX3zybKSaUYOiPjjLUKyOKimGY3xn83uamW8GrAlvacp/fQ+onVJv57byfenHmOZ4VxG/5IFjPoeIPmGlFYl5bRXOJ3riGQUIUkhOb9iZqmxospvPyFgxYnURTbImHy99v6ZSYA7LNKmp4gDBDEZt7Y6YUX6yfIjyGNzv1aJMbDZfGKnexWoiIqrOEDCzBL/FePwN983csvMmOa/orz6JopxVtfnJBtIRD6e/J/JzBrsQzwBvDR4yGn1xuZW7AYJNpDrFEobXsmII9oDMJELuDY++ee1KG++P+w8j2Ud5cAeh6Squpj9kuNsJnfdBrRkBof0Tta6SqoWqPQFZ2aWuuJVecMsXUmPgEkrihLHdoBR37q9ZV0+N0djMenl9MU/S60EinpxLK8JQzcPqOMyT/RFtm2XNuyE9QoB6he7hY1Ck3DDUOUUi78/w0EP3SIEIwiKum1xRKtzCTrJ+VKACd+66eYWyi4uTLLT3OUEVLLUNIAytbwPF+E=',
  // Apple Root CA - G3 — 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79
  'MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==',
];

export function nyDayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function nextResetUtc(date = new Date()) {
  for (let add = 0; add < 3; add++) {
    const candidate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + add, 4));
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(candidate);
    const get = (type) => parts.find((part) => part.type === type).value;
    if (get('hour') === '00' && get('minute') === '00' && candidate > date) return candidate;
    const hour = Number(get('hour'));
    const adjusted = new Date(candidate.getTime() + (hour <= 12 ? -hour : 24 - hour) * 3600_000);
    const check = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(adjusted);
    const checkGet = (type) => check.find((part) => part.type === type).value;
    if (adjusted > date && checkGet('hour') === '00' && checkGet('minute') === '00') return adjusted;
  }
  return new Date(date.getTime() + 24 * 3600_000);
}

export function mapAppleStatus(value) {
  switch (Number(value)) {
    case Status.ACTIVE: return 'active';
    case Status.EXPIRED: return 'expired';
    case Status.BILLING_RETRY: return 'billing-retry';
    case Status.BILLING_GRACE_PERIOD: return 'grace';
    case Status.REVOKED: return 'revoked';
    default: return null;
  }
}

const isoFromMillis = (value) => Number.isFinite(Number(value)) ? new Date(Number(value)).toISOString() : null;
const normalizePrivateKey = (value) => String(value || '').trim().replace(/\\n/g, '\n');
const isTransactionNotFound = (error) => error instanceof APIException && Number(error.apiError) === TRANSACTION_NOT_FOUND;
const statusRank = (status) => ({ active: 5, grace: 4, 'billing-retry': 3, expired: 2, revoked: 1 }[status] || 0);

function validateConfig({ issuerId, keyId, privateKey, appAppleId, sandboxOnly }) {
  if (!issuerId || !keyId || !privateKey) return 'missing App Store API credentials';
  if (!sandboxOnly && !Number.isSafeInteger(appAppleId)) return 'APPSTORE_APP_APPLE_ID is required for production';
  try {
    if (crypto.createPrivateKey(privateKey).asymmetricKeyType !== 'ec') return 'APPSTORE_PRIVATE_KEY_P8 must be an EC private key';
  } catch (_) { return 'APPSTORE_PRIVATE_KEY_P8 is invalid'; }
  return null;
}

function createAppleRuntime({ issuerId, keyId, privateKey, bundleId, appAppleId, sandboxOnly }) {
  const roots = APPLE_ROOT_CA_DER_BASE64.map((value) => Buffer.from(value, 'base64'));
  const sandbox = {
    environment: Environment.SANDBOX,
    verifier: new SignedDataVerifier(roots, true, Environment.SANDBOX, bundleId),
    client: new AppStoreServerAPIClient(privateKey, keyId, issuerId, bundleId, Environment.SANDBOX),
  };
  if (sandboxOnly) return { sandbox };
  return {
    production: {
      environment: Environment.PRODUCTION,
      verifier: new SignedDataVerifier(roots, true, Environment.PRODUCTION, bundleId, appAppleId),
      client: new AppStoreServerAPIClient(privateKey, keyId, issuerId, bundleId, Environment.PRODUCTION),
    },
    sandbox,
  };
}

export function createSubscriptionService(env, db, dependencies = {}) {
  const enabled = String(env.SUBSCRIPTIONS_ENABLED || '').toLowerCase() === 'true';
  const issuerId = String(env.APPSTORE_ISSUER_ID || '').trim();
  const keyId = String(env.APPSTORE_KEY_ID || '').trim();
  const privateKey = normalizePrivateKey(env.APPSTORE_PRIVATE_KEY_P8);
  const bundleId = String(env.APPSTORE_BUNDLE_ID || '').trim() || BUNDLE_ID_DEFAULT;
  const appAppleIdRaw = String(env.APPSTORE_APP_APPLE_ID || '').trim();
  const appAppleId = /^\d+$/.test(appAppleIdRaw) ? Number(appAppleIdRaw) : NaN;
  const sandboxOnly = String(env.APPSTORE_SANDBOX || '').toLowerCase() === 'true';
  const compedUserIds = new Set(String(env.COMPED_USER_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));
  const compedUserEmails = new Set(String(env.COMPED_USER_EMAILS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));

  let runtime = dependencies.appleRuntime || null;
  let configurationError = null;
  if (!runtime) {
    configurationError = validateConfig({ issuerId, keyId, privateKey, appAppleId, sandboxOnly });
    if (!configurationError) {
      try { runtime = createAppleRuntime({ issuerId, keyId, privateKey, bundleId, appAppleId, sandboxOnly }); }
      catch (_) { configurationError = 'Apple verification runtime could not be initialized'; }
    }
  }
  const configured = Boolean(runtime && (runtime.production || runtime.sandbox));
  // Purchases and receipt verification must be testable before quota
  // enforcement is enabled. Keep these two readiness states separate so the
  // rollout can fail open for chat while StoreKit is exercised in sandbox.
  const purchaseReady = configured;
  const enforcementReady = enabled && configured;
  if (!enabled) console.log('[subscriptions] disabled; quota enforcement is fail-open.');
  else if (!configured) console.warn(`[subscriptions] not ready (${configurationError || 'configuration incomplete'}); quota enforcement is fail-open.`);

  async function verifySigned(kind, signedData, preferredEnvironment = null) {
    const order = preferredEnvironment === Environment.SANDBOX ? [runtime?.sandbox, runtime?.production] : [runtime?.production, runtime?.sandbox];
    let lastError;
    for (const target of order.filter(Boolean)) {
      try {
        const method = kind === 'notification' ? 'verifyAndDecodeNotification' : kind === 'renewal' ? 'verifyAndDecodeRenewalInfo' : 'verifyAndDecodeTransaction';
        return { payload: await target.verifier[method](signedData), target };
      } catch (error) { lastError = error; }
    }
    throw Object.assign(new Error('Apple signed data could not be verified.'), { status: 400, cause: lastError });
  }

  async function apiForTransaction(transactionId, method, preferredTarget = null) {
    const order = preferredTarget === runtime?.sandbox ? [runtime?.sandbox, runtime?.production] : [runtime?.production, runtime?.sandbox];
    let lastError;
    for (const target of order.filter(Boolean)) {
      try { return { response: await target.client[method](transactionId), target }; }
      catch (error) { lastError = error; if (!isTransactionNotFound(error)) throw error; }
    }
    throw lastError || new Error('Transaction not found in either App Store environment.');
  }

  async function resolveEntitlement(transactionId, preferredTarget) {
    const { response, target } = await apiForTransaction(transactionId, 'getAllSubscriptionStatuses', preferredTarget);
    const choices = [];
    for (const group of response.data || []) {
      for (const item of group.lastTransactions || []) {
        if (!item.signedTransactionInfo) continue;
        const { payload: txn } = await verifySigned('transaction', item.signedTransactionInfo, target.environment);
        const status = mapAppleStatus(item.status);
        if (!PRODUCTS[txn.productId] || !status) continue;
        choices.push({
          transactionId: txn.transactionId,
          originalTransactionId: txn.originalTransactionId,
          productId: txn.productId,
          appAccountToken: txn.appAccountToken || null,
          status: txn.revocationDate ? 'revoked' : status,
          expiresAt: isoFromMillis(txn.expiresDate),
          environment: String(target.environment).toLowerCase(),
          signedAt: isoFromMillis(txn.signedDate),
        });
      }
    }
    choices.sort((a, b) => statusRank(b.status) - statusRank(a.status) || new Date(b.expiresAt || 0) - new Date(a.expiresAt || 0));
    return choices[0] || null;
  }

  async function verifyTransaction(signedTransaction, { expectedAppAccountToken, expectedProductId } = {}) {
    if (!purchaseReady) throw Object.assign(new Error('Subscriptions are not ready.'), { status: 503 });
    if (!expectedAppAccountToken) throw Object.assign(new Error('Purchase is not bound to this Orbit account.'), { status: 403 });
    const { payload: deviceTxn, target: signedTarget } = await verifySigned('transaction', signedTransaction);
    if (!deviceTxn.transactionId || !PRODUCTS[deviceTxn.productId]) throw Object.assign(new Error('Unknown transaction product.'), { status: 400 });
    if (expectedProductId && deviceTxn.productId !== expectedProductId) throw Object.assign(new Error('Transaction product does not match the purchase intent.'), { status: 403 });
    if (!deviceTxn.appAccountToken || deviceTxn.appAccountToken !== expectedAppAccountToken) throw Object.assign(new Error('Transaction is not bound to this Orbit account.'), { status: 403 });

    const { response: info, target } = await apiForTransaction(deviceTxn.transactionId, 'getTransactionInfo', signedTarget);
    if (!info.signedTransactionInfo) throw new Error('Apple returned no signed transaction information.');
    const { payload: serverTxn } = await verifySigned('transaction', info.signedTransactionInfo, target.environment);
    if (serverTxn.transactionId !== deviceTxn.transactionId || serverTxn.productId !== deviceTxn.productId) throw Object.assign(new Error('Transaction did not match Apple server data.'), { status: 403 });
    if (!serverTxn.appAccountToken || serverTxn.appAccountToken !== expectedAppAccountToken) throw Object.assign(new Error('Apple server transaction is not bound to this Orbit account.'), { status: 403 });
    if (serverTxn.revocationDate) throw Object.assign(new Error('Transaction has been revoked.'), { status: 403 });

    const entitlement = await resolveEntitlement(serverTxn.originalTransactionId || serverTxn.transactionId, target);
    if (!entitlement || entitlement.originalTransactionId !== serverTxn.originalTransactionId || entitlement.appAccountToken !== expectedAppAccountToken) throw Object.assign(new Error('No matching subscription entitlement was found.'), { status: 403 });
    if (entitlement.status === 'active' && entitlement.expiresAt && new Date(entitlement.expiresAt) <= Date.now()) entitlement.status = 'expired';
    return entitlement;
  }

  // Validate the device JWS before using its account token to find a pending
  // purchase. The token is only a lookup key; entitlement still requires the
  // independent App Store transaction and status checks in verifyTransaction.
  async function signedTransactionBinding(signedTransaction) {
    if (!purchaseReady) throw Object.assign(new Error('Subscriptions are not ready.'), { status: 503 });
    const { payload } = await verifySigned('transaction', signedTransaction);
    if (!payload.transactionId || !PRODUCTS[payload.productId]) throw Object.assign(new Error('Unknown transaction product.'), { status: 400 });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(payload.appAccountToken || '')))
      throw Object.assign(new Error('Transaction has no valid Orbit account binding.'), { status: 403 });
    return { appAccountToken: payload.appAccountToken, productId: payload.productId };
  }

  async function fetchEntitlements(userId) {
    if (!purchaseReady) throw Object.assign(new Error('Subscriptions are not ready.'), { status: 503 });
    const current = db.getSubscription(userId);
    if (!current?.original_transaction_id || !current?.app_account_token) return [];
    const preferred = current.environment === 'sandbox' ? runtime.sandbox : runtime.production;
    const entitlement = await resolveEntitlement(current.original_transaction_id, preferred);
    return entitlement?.appAccountToken === current.app_account_token ? [entitlement] : [];
  }

  async function handleNotification(signedPayload) {
    if (!configured) throw Object.assign(new Error('Subscriptions are not configured.'), { status: 503 });
    const { payload: outer, target } = await verifySigned('notification', signedPayload);
    const notificationId = outer.notificationUUID;
    if (!notificationId) throw new Error('Notification missing UUID.');
    if (!db.claimNotification(notificationId)) return { deduped: true };
    try {
      if (!outer.data?.signedTransactionInfo) { db.completeNotification(notificationId); return { ignored: true, reason: 'no transaction' }; }
      const { payload: txn } = await verifySigned('transaction', outer.data.signedTransactionInfo, target.environment);
      if (!txn.appAccountToken) { db.completeNotification(notificationId); return { ignored: true, reason: 'no account token' }; }
      const userId = db.findUserByAppAccountToken(txn.appAccountToken);
      if (!userId) { db.completeNotification(notificationId); return { ignored: true, reason: 'unknown account token' }; }
      const current = db.getSubscription(userId);
      const eventSignedAt = isoFromMillis(outer.signedDate);
      if (!eventSignedAt) throw new Error('Notification missing signed date.');
      if (current?.last_event_signed_at && eventSignedAt && new Date(eventSignedAt) < new Date(current.last_event_signed_at)) {
        db.completeNotification(notificationId); return { ignored: true, reason: 'stale notification' };
      }
      const entitlement = await resolveEntitlement(txn.originalTransactionId || txn.transactionId, target);
      if (!entitlement || entitlement.appAccountToken !== txn.appAccountToken) throw new Error('Apple status did not match the notification account token.');
      if (!db.applySubscriptionNotification(userId, { ...entitlement, lastEventSignedAt: eventSignedAt })) {
        db.completeNotification(notificationId); return { ignored: true, reason: 'stale notification' };
      }
      try { db.addEvent(userId, 'subscription_updated', `Subscription ${entitlement.status}.`); } catch (_) {}
      db.completeNotification(notificationId);
      return { ok: true, status: entitlement.status };
    } catch (error) {
      try { db.releaseNotification(notificationId); } catch (_) {}
      throw error;
    }
  }

  const isComped = (userId, user) => {
    const email = String(user?.email || user?.user_email || '').trim().toLowerCase();
    return compedUserIds.has(String(userId)) || (email && compedUserEmails.has(email)) || user?.role === 'owner' || user?.user_role === 'owner';
  };
  function activeProduct(userId, user) {
    if (isComped(userId, user)) return { plan: 'unlimited', dailyLimit: null, comped: true };
    if (!configured) return null;
    const sub = db.getSubscription(userId);
    if (!sub || !UNLIMITED_STATUSES.has(sub.status) || (sub.expires_at && new Date(sub.expires_at) <= Date.now())) return null;
    return PRODUCTS[sub.product_id] || null;
  }
  function isPaid(userId, user) {
    return Boolean(activeProduct(userId, user));
  }

  function tier(userId, user) {
    return activeProduct(userId, user)?.plan || 'included';
  }

  function consumeQuota(userId, user, now = new Date()) {
    if (isComped(userId, user)) return { allowed: true, unlimited: true, comped: true };
    if (!enforcementReady) return { allowed: true, enforced: false };
    const product = activeProduct(userId, user);
    if (product && product.dailyLimit == null) return { allowed: true, enforced: true, unlimited: true, plan: product.plan };
    const limit = product?.dailyLimit || FREE_DAILY_LIMIT;
    const day = nyDayKey(now);
    const result = db.consumeDailyUsage(userId, day, limit);
    return result.allowed
      ? { allowed: true, enforced: true, used: result.count, limit, day, plan: product?.plan || 'included' }
      : { allowed: false, enforced: true, used: result.count, limit, day, plan: product?.plan || 'included', resetAt: nextResetUtc(now).toISOString() };
  }

  function runDailyReset(now = new Date()) {
    const today = nyDayKey(now);
    db.pruneDailyUsage(today);
    try { db.pruneNotifications(); } catch (_) {}
    try { db.prunePurchaseIntents(); } catch (_) {}
    return { prunedBefore: today };
  }

  function status(userId, user) {
    const sub = userId ? db.getSubscription(userId) : null;
    const comped = userId ? isComped(userId, user) : false;
    const product = userId ? activeProduct(userId, user) : null;
    return {
      enabled, configured, ready: purchaseReady, enforcementReady, comped, environment: sandboxOnly ? 'sandbox' : 'production', products: Object.keys(PRODUCTS),
      entitlement: sub ? { product: sub.product_id, plan: PRODUCTS[sub.product_id]?.plan || null, status: sub.status, expiresAt: sub.expires_at, unlimited: Boolean(product && product.dailyLimit == null) }
        : (comped ? { product: 'comped', plan: 'unlimited', status: 'active', expiresAt: null, unlimited: true } : null),
    };
  }

  return {
    enabled, configured, get ready() { return purchaseReady; }, get enforcementReady() { return enforcementReady; }, PRODUCTS, FREE_DAILY_LIMIT, BASIC_DAILY_LIMIT,
    status, signedTransactionBinding, verifyTransaction, fetchEntitlements, handleNotification,
    isPaid, isComped, tier, consumeQuota, runDailyReset, nyDayKey, nextResetUtc,
  };
}
