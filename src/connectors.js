import { createHash, randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, hashToken, randomToken } from './security.js';

// No OAuth providers are configured. Calendar access is handled by per-user
// iCal feeds (see src/ical.js) instead of provider OAuth.
const providers = {};

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
    if (provider.pkce) { url.searchParams.set('code_challenge', challenge(verifier)); url.searchParams.set('code_challenge_method', 'S256'); }
    return url.toString();
  }

  async function complete(providerId, code, state) {
    const provider = providers[providerId];
    const oauthState = db.consumeOauthState(hashToken(state));
    if (!provider || !oauthState || oauthState.provider !== providerId) throw Object.assign(new Error('OAuth state is invalid or expired.'), { status: 400 });
    const params = new URLSearchParams({ code, client_id: env[provider.clientId], client_secret: env[provider.clientSecret], redirect_uri: oauthState.redirect_uri });
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
    else throw Object.assign(new Error('Unknown connector.'), { status: 404 });
    const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json','User-Agent':'Orbit-Buddy'},signal:AbortSignal.timeout(20_000)});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok||payload.ok===false) throw Object.assign(new Error('Connector preview failed.'),{status:502});
    return transform(payload);
  }

  return { available, begin, complete, preview, providers: Object.fromEntries(Object.entries(providers).map(([id,p])=>[id,{label:p.label}])) };
}
