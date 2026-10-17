// geo-prompt.js — one-time-per-device geolocation prompt gate.
//
// Edward's rule: the app asks for location ONCE per device, remembers the
// answer for as long as he's signed in, and never re-prompts on that device.
// A new device prompts once, then remembers. Sign-out clears the remembered
// answer (clearGeoAsked) so the next user on the same device gets asked.
//
// How it works: the browser permission dialog only appears when
// getCurrentPosition() is called while the permission state is "prompt".
// So we gate the call:
//   - permission "granted"  -> call freely (browser won't show a dialog)
//   - permission "denied"   -> never call (respect quietly, home weather)
//   - permission "prompt"   -> call only if this device was never asked
//   - no Permissions API    -> same as "prompt" (ask once, then remember)
//
// This changes NOTHING about what location data is collected or how it's
// used — coords are still sent with the briefing request only and never
// stored. It only controls whether the question is asked again.

export const GEO_ASKED_KEY = 'orbit-geo-asked';
// Legacy key from the denial-only era (only ever set on deny). Treated as
// "asked" so users who denied before this gate don't get asked again.
export const GEO_DENIED_KEY = 'orbit-geo-denied';

function readFlag(storage, key) {
  try {
    return !!storage && storage.getItem(key) === '1';
  } catch (_) {
    return false;
  }
}

export function wasGeoAsked(storage) {
  return readFlag(storage, GEO_ASKED_KEY) || readFlag(storage, GEO_DENIED_KEY);
}

export function markGeoAsked(storage) {
  try {
    if (storage) storage.setItem(GEO_ASKED_KEY, '1');
  } catch (_) {
    /* storage unavailable — fail open, same as before */
  }
}

export function clearGeoAsked(storage) {
  try {
    if (storage) {
      storage.removeItem(GEO_ASKED_KEY);
      storage.removeItem(GEO_DENIED_KEY);
    }
  } catch (_) {
    /* nothing to clear */
  }
}

// 'granted' | 'denied' | 'prompt' | 'unknown' (no Permissions API / error)
export async function queryGeoPermission(nav) {
  try {
    const perms = nav && nav.permissions;
    if (!perms || typeof perms.query !== 'function') return 'unknown';
    const status = await perms.query({ name: 'geolocation' });
    const s = status && status.state;
    return s === 'granted' || s === 'denied' || s === 'prompt' ? s : 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

// Decide whether calling getCurrentPosition() is safe. `attempt` means the
// call won't surface a *repeat* question; `countsAsAsk` means this call may
// show the browser dialog, so the device must be marked as asked.
export async function geoAttemptPlan(storage, nav) {
  const perm = await queryGeoPermission(nav);
  if (perm === 'granted') return { attempt: true, countsAsAsk: false };
  if (perm === 'denied') return { attempt: false, countsAsAsk: false };
  if (wasGeoAsked(storage)) return { attempt: false, countsAsAsk: false };
  return { attempt: true, countsAsAsk: true };
}
