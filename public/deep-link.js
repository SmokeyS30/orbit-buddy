// W4: notification tap deep-linking (?conversation=<id>).
//
// Pure, unit-tested helpers. The service worker routes a tapped notification to
// `/?conversation=<id>#<view>`; the app consumes the param once at boot and
// seeds its active conversation from it (see public/app.js).

// Conversation ids are server-generated UUIDs; this whitelist keeps a crafted
// URL param from ever reaching the DOM or an API call unvalidated.
const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

// Returns the conversation id from a notification-tap deep-link URL, or null
// when the param is absent or fails validation.
export function parseConversationDeepLink(search) {
  try {
    const id = new URLSearchParams(search || '').get('conversation');
    return id && CONVERSATION_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}
