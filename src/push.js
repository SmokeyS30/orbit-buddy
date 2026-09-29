import webpush from 'web-push';

export function createPushService(env, db) {
  let publicKey = env.VAPID_PUBLIC_KEY?.trim() || db.getSetting('vapid_public_key');
  let privateKey = env.VAPID_PRIVATE_KEY?.trim() || db.getSetting('vapid_private_key');
  if (!publicKey && !privateKey) {
    const generated = webpush.generateVAPIDKeys();
    publicKey = generated.publicKey; privateKey = generated.privateKey;
    db.setSetting('vapid_public_key', publicKey); db.setSetting('vapid_private_key', privateKey);
  }
  const subject = env.VAPID_SUBJECT?.trim() || 'https://github.com/SmokeyS30/orbit-buddy';
  const configured = Boolean(publicKey && privateKey);
  if (configured) webpush.setVapidDetails(subject, publicKey, privateKey);

  return {
    configured, publicKey: configured ? publicKey : null,
    async notify(userId, title, body, data = {}) {
      if (!configured) return { sent: 0, failed: 0 };
      let sent = 0; let failed = 0;
      const payload = JSON.stringify({ title, body, data });
      for (const subscription of db.listPush(userId)) {
        try {
          await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload, { TTL: 3600, urgency: 'normal' });
          sent += 1;
        } catch (error) {
          failed += 1;
          if ([404, 410].includes(error.statusCode)) db.deletePushById(subscription.id);
        }
      }
      return { sent, failed };
    }
  };
}
