// The consent screen names only OpenAI and Microsoft Azure OpenAI. A custom
// OpenAI-compatible URL is a different recipient and needs a new disclosure.
export function disclosedAiRecipientConfigured(env) {
  const primary=env.AZURE_OPENAI_ENDPOINT?.trim();
  const usingAzure=Boolean(primary&&env.AZURE_OPENAI_API_KEY?.trim()&&env.AZURE_OPENAI_DEPLOYMENT?.trim());
  const allowed=(value,azure)=>{
    try {
      const url=new URL(value);
      const host=url.hostname.toLowerCase();
      const testLocal=env.NODE_ENV==='test'&&env.ALLOW_INSECURE_MODEL_URL==='true'&&['localhost','127.0.0.1','[::1]'].includes(host);
      if(url.username||url.password||url.search||url.hash||(!testLocal&&url.protocol!=='https:'))return false;
      if(testLocal)return ['http:','https:'].includes(url.protocol);
      if(url.port)return false;
      return azure
        ? ['.openai.azure.com','.cognitiveservices.azure.com','.services.ai.azure.com'].some(suffix=>host.endsWith(suffix)&&host.length>suffix.length)
        : host==='api.openai.com';
    } catch {return false;}
  };
  if(!usingAzure)return allowed(env.OPENAI_BASE_URL||'https://api.openai.com/v1',false);
  if(!allowed(primary,true))return false;
  const secondary=env.AZURE_OPENAI_SECONDARY_ENDPOINT?.trim();
  return !(secondary&&env.AZURE_OPENAI_SECONDARY_KEY?.trim())||allowed(secondary,true);
}

// Every model invocation carries an account ID. This guard is checked before
// each provider request and retry, including calls made by background work.
export async function requireAiSharingConsent(db, userId, recipientAllowed=false) {
  const user = userId ? await db.getUserById(userId) : null;
  if (!user?.ai_sharing_consent_at || user.disabled || user.moderation_blocked) {
    throw Object.assign(new Error('Allow AI data sharing in Safety before using this feature.'), { status: 403, code: 'AI_SHARING_CONSENT_REQUIRED' });
  }
  if(!recipientAllowed)throw Object.assign(new Error('The configured AI recipient is not covered by the current disclosure.'),{status:503,code:'AI_SHARING_RECIPIENT_UNDISCLOSED'});
}

export function consentGatedModel(model, db, recipientAllowed=false) {
  const guarded = Object.create(model);
  for (const method of ['respond', 'respondChitchat']) {
    if (typeof model[method] !== 'function') continue;
    guarded[method] = async ({ aiConsentUserId, assertActive, ...args }) => {
      const check = async () => {
        if (assertActive) await assertActive();
        await requireAiSharingConsent(db, aiConsentUserId, recipientAllowed);
      };
      await check();
      const result = await model[method]({ ...args, assertActive: check });
      await check();
      return result;
    };
  }
  return guarded;
}
