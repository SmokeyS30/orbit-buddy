// Live Activities bridge for the native iOS app (Capacitor).
//
// Safe to call from anywhere: on the web, on Android, or on iOS versions
// without the native plugin, every entry point no-ops and resolves null.
// Only the Capacitor iOS build (which registers the `LiveActivities`
// native plugin — see ios/App/App/LiveActivitiesPlugin.swift) actually
// starts, updates, or ends activities.
//
// Pure helpers are exported for unit tests. All functions return promises
// that never reject.

function nativePlugin() {
  try {
    if (typeof window === 'undefined') return null;
    const cap = window.Capacitor;
    if (!cap || typeof cap.isNativePlatform !== 'function') return null;
    if (cap.isNativePlatform() !== true) return null;
    if (typeof cap.registerPlugin !== 'function') return null;
    return cap.registerPlugin('LiveActivities');
  } catch (_) {
    return null;
  }
}

async function callNative(method, options) {
  const plugin = nativePlugin();
  if (!plugin) return null;
  try {
    const fn = plugin[method];
    if (typeof fn !== 'function') return null;
    return await fn.call(plugin, options || {});
  } catch (_) {
    return null;
  }
}

/** Resolve true when the native app reports Live Activities are enabled. */
export function liveActivitiesSupported() {
  return callNative('supportsLiveActivities')
    .then((res) => !!(res && res.supported));
}

/**
 * Start (or replace) the "voice conversation in progress" activity.
 * No-op unless running inside the native iOS app.
 */
export function startVoiceActivity({ title = 'Voice chat', status = 'Listening…', buddyName = 'Orbit' } = {}) {
  return callNative('startActivity', {
    id: 'voice',
    kind: 'voice',
    title,
    status,
    buddyName,
    deepLink: 'orbitbuddy://voice',
  }).then((res) => (res && res.id) || null);
}

/** End the voice activity. Safe to call when none is running. */
export function endVoiceActivity() {
  return callNative('endActivity', { id: 'voice' }).then(() => null);
}

/**
 * Start (or replace) the "Orbit is working on…" activity for a long
 * background task. Not wired to any UI yet — exposed for future use.
 */
export function startTaskActivity({ title, status = 'Working…', detail = '' } = {}) {
  return callNative('startActivity', {
    id: 'task',
    kind: 'task',
    title: title || 'Orbit is working',
    status,
    detail,
    deepLink: 'orbitbuddy://',
  }).then((res) => (res && res.id) || null);
}

/** End the task activity. Safe to call when none is running. */
export function endTaskActivity() {
  return callNative('endActivity', { id: 'task' }).then(() => null);
}
