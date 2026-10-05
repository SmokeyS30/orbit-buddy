import { createHash, randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, hashToken, randomToken } from './security.js';

// OAuth providers. Gmail is the first live provider.
const providers = {
  gmail: {
    label: 'Gmail',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    profile: 'https://www.googleapis.com/oauth2/v2/userinfo',
    // send + readonly: Orbit can send mail and read/search the inbox, but not delete or modify.
    scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly',
    clientId: 'GMAIL_CLIENT_ID',
    clientSecret: 'GMAIL_CLIENT_SECRET',
    pkce: false,
    // Google needs these extra params on the authorize URL
    extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' }
  }
};

const challenge = (value) => createHash('sha256').update(value).digest('base64url');

export function createConnectorService(env, db, encryptionKey) {
  function available() {
    return Object.entries(providers).map(([id, provider]) => ({
      id, label: provider.label,
      configured: Boolean(encryptionKey && env[provider.clientId] && env[provider.clientSecret])
    }));
  }

  function begin(userId, providerId, origin) {
    const provider = providers[providerId];
    if (!provider) throw Object.assign(new Error('Unknown connector.'), { status: 404 });
    if (!encryptionKey || !env[provider.clientId] || !env[provider.clientSecret]) throw Object.assign(new Error(`${provider.label} OAuth is not configured.`), { status: 503 });
    const state = randomToken(32); const verifier = provider.pkce ? randomToken(48) : null;
    const redirectUri = `${origin}/api/connectors/${providerId}/callback`;
    db.addOauthState({ stateHash: hashToken(state), userId, provider: providerId, codeVerifier: verifier, redirectUri, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    const url = new URL(provider.authorize);
    url.searchParams.set('client_id', env[provider.clientId]); url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', provider.scope); url.searchParams.set('state', state);
    url.searchParams.set('response_type', 'code');
    if (provider.extraAuthorizeParams) for (const [k, v] of Object.entries(provider.extraAuthorizeParams)) url.searchParams.set(k, v);
    if (provider.pkce) { url.searchParams.set('code_challenge', challenge(verifier)); url.searchParams.set('code_challenge_method', 'S256'); }
    return url.toString();
  }

  async function complete(providerId, code, state) {
    const provider = providers[providerId];
    const oauthState = db.consumeOauthState(hashToken(state));
    if (!provider || !oauthState || oauthState.provider !== providerId) throw Object.assign(new Error('OAuth state is invalid or expired.'), { status: 400 });
    const params = new URLSearchParams({ code, client_id: env[provider.clientId], client_secret: env[provider.clientSecret], redirect_uri: oauthState.redirect_uri, grant_type: 'authorization_code' });
    if (oauthState.code_verifier) params.set('code_verifier', oauthState.code_verifier);
    const tokenResponse = await fetch(provider.token, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: params, signal: AbortSignal.timeout(30_000) });
    const tokens = await tokenResponse.json();
    const accessToken = providerId === 'slack' ? tokens.access_token : tokens.access_token;
    if (!tokenResponse.ok || !accessToken || tokens.ok === false) throw Object.assign(new Error('OAuth token exchange failed.'), { status: 502 });
    const profileResponse = await fetch(provider.profile, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'Orbit-Buddy' }, signal: AbortSignal.timeout(20_000) });
    const profile = await profileResponse.json().catch(() => ({}));
    db.saveConnector(oauthState.user_id, providerId, {
      accessEncrypted: encryptSecret(accessToken, encryptionKey),
      refreshEncrypted: tokens.refresh_token ? encryptSecret(tokens.refresh_token, encryptionKey) : null,
      scopes: tokens.scope || provider.scope,
      expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
      profile
    });
    return { userId: oauthState.user_id, provider: providerId };
  }

  async function preview(userId, providerId) {
    const row = db.getConnector(userId, providerId);
    if (!row) throw Object.assign(new Error('Connector is not connected.'), { status: 404 });
    const token = decryptSecret(row.access_encrypted, encryptionKey);
    let url; let transform = (value) => value;
    if (providerId === 'github') { url='https://api.github.com/user/repos?per_page=20&sort=updated'; transform=(items)=>items.map((item)=>({name:item.full_name,private:item.private,url:item.html_url,updatedAt:item.updated_at})); }
    else if (providerId === 'slack') { url='https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=20'; transform=(value)=>(value.channels||[]).map((item)=>({name:item.name,id:item.id,private:item.is_private})); }
    else if (providerId === 'gmail') { url='https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5'; transform=(value)=>(value.messages||[]).map((item)=>({name:`Email ${item.id.slice(0,8)}…`,id:item.id})); }
    else throw Object.assign(new Error('Unknown connector.'), { status: 404 });
    const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json','User-Agent':'Orbit-Buddy'},signal:AbortSignal.timeout(20_000)});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok||payload.ok===false) throw Object.assign(new Error('Connector preview failed.'),{status:502});
    return transform(payload);
  }

  async function getValidToken(userId, providerId) {
    const provider = providers[providerId];
    if (!provider) throw Object.assign(new Error('Unknown connector.'), { status: 404 });
    const row = db.getConnector(userId, providerId);
    if (!row) throw Object.assign(new Error(`${provider.label} is not connected.`), { status: 404 });
    // If token isn't expiring soon (5 min buffer), use it as-is
    if (row.expires_at && new Date(row.expires_at).valueOf() - Date.now() > 5 * 60_000) {
      return decryptSecret(row.access_encrypted, encryptionKey);
    }
    // Refresh needed
    if (!row.refresh_encrypted) throw Object.assign(new Error(`${provider.label} session expired. Please reconnect.`), { status: 401 });
    const refreshToken = decryptSecret(row.refresh_encrypted, encryptionKey);
    const params = new URLSearchParams({
      client_id: env[provider.clientId], client_secret: env[provider.clientSecret],
      refresh_token: refreshToken, grant_type: 'refresh_token'
    });
    const res = await fetch(provider.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params, signal: AbortSignal.timeout(30_000) });
    const tokens = await res.json().catch(() => ({}));
    if (!res.ok || !tokens.access_token) throw Object.assign(new Error(`${provider.label} token refresh failed. Please reconnect.`), { status: 502 });
    db.saveConnector(userId, providerId, {
      accessEncrypted: encryptSecret(tokens.access_token, encryptionKey),
      refreshEncrypted: tokens.refresh_token ? encryptSecret(tokens.refresh_token, encryptionKey) : row.refresh_encrypted,
      scopes: row.scopes,
      expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
      profile: row.profile_json ? JSON.parse(row.profile_json) : {}
    });
    return tokens.access_token;
  }

  return { available, begin, complete, preview, getValidToken, providers: Object.fromEntries(Object.entries(providers).map(([id,p])=>[id,{label:p.label}])) };
}
