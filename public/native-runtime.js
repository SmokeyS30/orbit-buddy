/**
 * Describe the browser/native context without depending on Capacitor being
 * ready at module-evaluation time.  Release WKWebViews have occasionally
 * exposed only part of the bridge while their local document was starting, so
 * the native decision intentionally uses several independent signals.
 */
export function nativeRuntimeInfo(win = globalThis.window) {
  const location = win?.location || {};
  const navigator = win?.navigator || {};
  const capacitor = win?.Capacitor;

  let platform = null;
  let capacitorNative = false;
  try { platform = capacitor?.getPlatform?.() || null; } catch (_) {}
  try { capacitorNative = capacitor?.isNativePlatform?.() === true; } catch (_) {}

  const protocol = String(location.protocol || '').toLowerCase();
  const capacitorScheme = protocol === 'capacitor:' || protocol === 'ionic:';
  const bridgePresent = Boolean(win?.webkit?.messageHandlers?.bridge);
  const userAgent = String(navigator.userAgent || '');
  const navigatorPlatform = String(navigator.platform || '');
  const iosDevice = /iPad|iPhone|iPod/i.test(userAgent)
    || (navigatorPlatform === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 1);
  const native = capacitorNative
    || platform === 'ios'
    || platform === 'android'
    || capacitorScheme
    || bridgePresent;

  return {
    native,
    iosDevice,
    platform,
    protocol,
    capacitorPresent: Boolean(capacitor),
    bridgePresent,
  };
}

export function isNativeRuntime(win = globalThis.window) {
  return nativeRuntimeInfo(win).native;
}

/**
 * Browser speech recognition may send audio to an unnamed browser service.
 * The AI permission choice identifies only OpenAI and Azure OpenAI, so all
 * runtimes use the consent-gated server transcription path.
 */
export function shouldUseWebSpeech() {
  return false;
}
