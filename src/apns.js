/**
 * Apple Push Notification service (APNs) provider-token auth.
 *
 * Sends native iOS pushes via HTTP/2 to the APNs production endpoint
 * (api.push.apple.com:443 — TestFlight builds use production APNs).
 * Auth is a short-lived ES256 JWT signed with the .p8 key; it is cached
 * and refreshed before Apple's 60-minute maximum.
 *
 * Env: APNS_KEY_P8 (full .p8 private-key text), APNS_KEY_ID, APNS_TEAM_ID,
 *      APNS_BUNDLE_ID (defaults to com.smokeys30.orbitbuddy).
 * When any required var is absent the service reports configured=false,
 * logs once at startup, and notify() becomes a harmless no-op — the server
 * always starts fine without APNs.
 */
import http2 from 'node:http2';
import crypto from 'node:crypto';

export const APNS_PRODUCTION_HOST = 'api.push.apple.com';
export const APNS_PRODUCTION_PORT = 443;
const PROVIDER_TOKEN_TTL_MS = 55 * 60 * 1000; // refresh before Apple's 60-min max

const base64url = (value) => Buffer.from(value).toString('base64url');

/** Build a signed APNs provider-auth JWT (ES256). Exported for tests. */
export function createApnsProviderToken({ keyP8, keyId, teamId, issuedAt = Math.floor(Date.now() / 1000) }) {
  const key = keyP8.includes('\\n') ? keyP8.replace(/\\n/g, '\n') : keyP8;
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const payload = base64url(JSON.stringify({ iss: teamId, iat: issuedAt }));
  const data = `${header}.${payload}`;
  const signature = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `${data}.${base64url(signature)}`;
}

export function createApnsService(env, db, { connect = http2.connect } = {}) {
  const keyP8 = String(env.APNS_KEY_P8 || '').trim();
  const keyId = String(env.APNS_KEY_ID || '').trim();
  const teamId = String(env.APNS_TEAM_ID || '').trim();
  const bundleId = String(env.APNS_BUNDLE_ID || '').trim() || 'com.smokeys30.orbitbuddy';
  const configured = Boolean(keyP8 && keyId && teamId);
  if (!configured) {
    console.log('[apns] APNs not configured — native iOS push disabled. Set APNS_KEY_P8, APNS_KEY_ID and APNS_TEAM_ID to enable.');
  }

  let providerToken = null;
  let providerTokenIssuedAt = 0;
  const currentProviderToken = () => {
    if (!providerToken || Date.now() - providerTokenIssuedAt >= PROVIDER_TOKEN_TTL_MS) {
      providerToken = createApnsProviderToken({ keyP8, keyId, teamId });
      providerTokenIssuedAt = Date.now();
    }
    return providerToken;
  };

  let session = null;
  const getSession = () => {
    if (!session || session.destroyed) {
      session = connect(`https://${APNS_PRODUCTION_HOST}:${APNS_PRODUCTION_PORT}`);
      session.on('error', () => { session = null; });
    }
    return session;
  };

  function sendToToken(deviceToken, { title, body, data = {} }) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        aps: { alert: { title: String(title), body: String(body) }, sound: 'default' },
        ...data,
      });
      let req;
      try {
        req = getSession().request({
          ':method': 'POST',
          ':path': `/3/device/${deviceToken}`,
          'authorization': `bearer ${currentProviderToken()}`,
          'apns-topic': bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        });
      } catch (error) {
        session = null;
        reject(error);
        return;
      }
      let responseBody = '';
      req.on('response', (headers) => {
        const status = headers[':status'];
        req.on('data', (chunk) => { responseBody += chunk; });
        req.on('end', () => {
          if (status === 200) return resolve({ status });
          const error = new Error(`APNs rejected the push (${status}): ${responseBody.slice(0, 200)}`);
          error.apnsStatus = status;
          try { error.apnsReason = JSON.parse(responseBody).reason; } catch (_) {}
          reject(error);
        });
      });
      req.on('error', (error) => { session = null; reject(error); });
      req.end(payload);
    });
  }

  return {
    configured,
    bundleId,
    /**
     * Send a push to every registered iOS device for the user.
     * A 410 (or Unregistered reason) means the token is dead — drop it.
     */
    async notify(userId, title, body, data = {}) {
      if (!configured) return { sent: 0, failed: 0, skipped: true };
      let sent = 0;
      let failed = 0;
      let firstError = null;
      for (const row of db.listApnsTokens(userId)) {
        try {
          await sendToToken(row.device_token, { title, body, data });
          sent += 1;
        } catch (error) {
          failed += 1;
          if (!firstError) firstError = error?.apnsReason || error?.message || 'APNs delivery failed';
          if (error && (error.apnsStatus === 410 || error.apnsReason === 'Unregistered')) {
            try { db.deleteApnsToken(row.device_token); } catch (_) {}
          }
        }
      }
      return { sent, failed, ...(firstError ? { error: firstError } : {}) };
    },
    close() {
      try { if (session) session.close(); } catch (_) {}
      session = null;
    },
  };
}
