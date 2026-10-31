const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

// A failed first request must be retried even if navigator.onLine never changes.
// The caller returns "retry" only for failures that should be attempted again.
export function createConnectionRecovery(connect, {
  visible = () => true,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  let timer = null;
  let inFlight = null;
  let afterAuthInFlight = null;
  let failures = 0;
  let stopped = false;

  function clearPending() {
    if (timer !== null) cancel(timer);
    timer = null;
  }

  function retryLater() {
    if (stopped || !visible() || timer !== null) return;
    const delay = RETRY_DELAYS_MS[Math.min(failures++, RETRY_DELAYS_MS.length - 1)];
    timer = schedule(() => {
      timer = null;
      if (!stopped && visible()) attempt();
    }, delay);
  }

  function attempt() {
    if (stopped) return Promise.resolve('stopped');
    if (inFlight) return inFlight;
    clearPending();
    inFlight = Promise.resolve().then(connect).catch(() => 'retry').then((result) => {
      if (result === 'retry') retryLater();
      else failures = 0;
      return result;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  function wake() {
    stopped = false;
    if (visible()) return attempt();
  }

  // Authentication changes the credentials observed by connect(). If a
  // pre-login request is already running, a normal wake would merely reuse it.
  // Queue exactly one new attempt after that request settles instead.
  function afterAuth() {
    stopped = false;
    if (!visible()) return Promise.resolve('hidden');
    if (!inFlight) return attempt();
    if (!afterAuthInFlight) {
      afterAuthInFlight = inFlight.then(() => undefined, () => undefined).then(() => {
        if (stopped) return 'stopped';
        if (!visible()) return 'hidden';
        return attempt();
      }).finally(() => { afterAuthInFlight = null; });
    }
    return afterAuthInFlight;
  }

  function stop() {
    stopped = true;
    clearPending();
  }

  return { attempt, wake, afterAuth, stop };
}

// WKWebView's connectivity hint is not a prerequisite for a real HTTPS fetch.
export function canAttemptNetwork(native, online) {
  return native || online;
}

export function isTransportError(error, native, online) {
  if (error?.status) return false;
  return !canAttemptNetwork(native, online)
    || error?.offline === true
    || /failed to fetch|load failed|network error|networkerror|request timed out/i.test(String(error?.message || ''));
}
