// Every model invocation carries an account ID. This guard is checked before
// each provider request and retry, including calls made by background work.
export async function requireAiSharingConsent(db, userId) {
  const user = userId ? await db.getUserById(userId) : null;
  if (!user?.ai_sharing_consent_at) {
    throw Object.assign(new Error('Allow AI data sharing in Safety before using this feature.'), { status: 403, code: 'AI_SHARING_CONSENT_REQUIRED' });
  }
}

export function consentGatedModel(model, db) {
  const guarded = Object.create(model);
  for (const method of ['respond', 'respondChitchat']) {
    if (typeof model[method] !== 'function') continue;
    guarded[method] = async ({ aiConsentUserId, assertActive, ...args }) => {
      const check = async () => {
        if (assertActive) await assertActive();
        await requireAiSharingConsent(db, aiConsentUserId);
      };
      await check();
      const result = await model[method]({ ...args, assertActive: check });
      await check();
      return result;
    };
  }
  return guarded;
}
