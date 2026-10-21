import { createRemoteJWKSet, jwtVerify, SignJWT, importPKCS8 } from 'jose';

const issuer = 'https://appleid.apple.com';
const appleKeys = createRemoteJWKSet(new URL(`${issuer}/auth/keys`), { timeoutDuration: 5000 });
const rejected = () => Object.assign(new Error('Apple sign-in could not be verified. Please start again.'), { status: 401 });

export function appleAuthReady(env) {
  return ['APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY'].every(k => typeof env[k] === 'string' && env[k].trim());
}

export async function verifyAppleIdentity(token, { audience, nonce, keys = appleKeys }) {
  try {
    if (typeof token !== 'string' || token.length > 16384 || !audience || !nonce) throw rejected();
    const { payload } = await jwtVerify(token, keys, {
      issuer, audience, algorithms: ['RS256'], requiredClaims: ['sub', 'iat', 'exp', 'nonce'], maxTokenAge: '10m',
    });
    if (payload.nonce !== nonce || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw rejected();
    return payload;
  } catch { throw rejected(); }
}

// Code exchange is mandatory: a valid identity token alone never creates a session.
// Tokens returned by Apple are held only in memory and are never logged or stored.
export async function validateAppleAuthorization({ identityToken, authorizationCode, nonce }, env, { keys = appleKeys, fetchImpl = fetch } = {}) {
  if (!appleAuthReady(env)) throw Object.assign(new Error('Apple sign-in is not configured.'), { status: 503 });
  if (typeof authorizationCode !== 'string' || !authorizationCode || authorizationCode.length > 4096) throw rejected();
  const original = await verifyAppleIdentity(identityToken, { audience: env.APPLE_CLIENT_ID, nonce, keys });
  try {
    const privateKey = await importPKCS8(env.APPLE_PRIVATE_KEY, 'ES256');
    const clientSecret = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: env.APPLE_KEY_ID })
      .setIssuer(env.APPLE_TEAM_ID).setSubject(env.APPLE_CLIENT_ID).setAudience(issuer)
      .setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const response = await fetchImpl(`${issuer}/auth/token`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.APPLE_CLIENT_ID, client_secret: clientSecret,
        code: authorizationCode, grant_type: 'authorization_code',
        ...(env.APPLE_REDIRECT_URI ? { redirect_uri: env.APPLE_REDIRECT_URI } : {}) }),
    });
    if (!response.ok) throw rejected();
    const body = await response.json();
    const exchanged = await verifyAppleIdentity(body.id_token, { audience: env.APPLE_CLIENT_ID, nonce, keys });
    if (exchanged.sub !== original.sub) throw rejected();
    return { subject: exchanged.sub, email: exchanged.email_verified === true || exchanged.email_verified === 'true' ? exchanged.email : null };
  } catch { throw rejected(); }
}
