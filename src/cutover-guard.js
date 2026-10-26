// A production revision must be explicitly opened after the previous revision
// has no replicas. Test/development instances remain open unless asked to
// exercise the hold. Unknown values fail closed.
export function cutoverHeld(env = {}) {
  const value = String(env.ORBIT_CUTOVER_HOLD ?? '').trim().toLowerCase();
  if (value === 'false') return false;
  if (value === 'true' || value) return true;
  return env.NODE_ENV === 'production';
}

export function cutoverUnavailable() {
  return Object.assign(new Error('Background work and account connections are temporarily paused. Try again shortly.'), { status: 503 });
}
