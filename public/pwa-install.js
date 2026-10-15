/* Orbit Buddy "Add to Home Screen" nudge.
 *
 * Self-contained: one <script defer> in index.html, no dependencies, no
 * framework. Rules:
 * - Never on first load: only after MIN_VISITS distinct days in localStorage.
 * - Never when already installed (standalone display mode / iOS standalone /
 *   Capacitor native shell).
 * - Never re-nag: dismissal is remembered; re-eligible after 30 days max.
 * - Android/Chrome: defers beforeinstallprompt, fires it from the nudge tap.
 * - iOS Safari: no beforeinstallprompt exists — show the manual
 *   Share -> Add to Home Screen hint with the exact affordance.
 * - Quiet by design: one small dismissible pill, no persistent buttons.
 */

(function () {
  'use strict';

  var VISITS_KEY = 'ob-pwa-visits';
  var DISMISS_KEY = 'ob-pwa-dismissed';
  var MIN_VISITS = 3; // distinct days before we ever nudge
  var RE_ELIGIBLE_DAYS = 30; // dismissal memory window
  var DAY_MS = 24 * 60 * 60 * 1000;

  function dayString(date) {
    return date.toISOString().slice(0, 10);
  }

  function readJson(storage, key, fallback) {
    try {
      var raw = storage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(storage, key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }

  // Record today's visit; returns the distinct-day count.
  function recordVisit(storage, now) {
    var days = readJson(storage, VISITS_KEY, []);
    if (!Array.isArray(days)) days = [];
    var today = dayString(now);
    if (days.indexOf(today) === -1) {
      days.push(today);
      days = days.slice(-60); // keep the list bounded
      writeJson(storage, VISITS_KEY, days);
    }
    return days.length;
  }

  function isIos(ua) {
    var agent = ua || '';
    if (/iPhone|iPod/.test(agent)) return true;
    // iPadOS 13+ reports a desktop UA; detect via touch capability at runtime.
    return false;
  }

  function isIpadOs(navigatorObj, ua) {
    if (/iPad/.test(ua || '')) return true;
    return (
      /Macintosh/.test(ua || '') &&
      navigatorObj &&
      typeof navigatorObj.maxTouchPoints === 'number' &&
      navigatorObj.maxTouchPoints > 1
    );
  }

  function isInstalled(env) {
    // Capacitor native shell: already an installed app, never nudge.
    if (env.capacitorNative) return true;
    if (env.standalone) return true; // iOS navigator.standalone
    if (env.displayStandalone) return true; // matchMedia('(display-mode: standalone)')
    return false;
  }

  // Pure gating decision; everything impure is passed in for testability.
  function shouldShowNudge(opts) {
    if (opts.installed) return false;
    if (opts.visitCount < MIN_VISITS) return false;
    if (opts.dismissedAt != null) {
      var age = opts.now - opts.dismissedAt;
      if (!(age >= RE_ELIGIBLE_DAYS * DAY_MS)) return false;
    }
    return true;
  }

  function installCopy(isIosPlatform) {
    if (isIosPlatform) {
      return {
        title: 'Add Orbit to your Home Screen',
        body: 'Tap the Share button in Safari\u2019s toolbar (the square with an arrow pointing up), then tap \u201CAdd to Home Screen\u201D.',
        action: null, // no programmatic install on iOS; the hint is the action
      };
    }
    return {
      title: 'Add Orbit to your Home Screen',
      body: 'Install Orbit for faster, full-screen access \u2014 no app store needed.',
      action: 'install',
    };
  }

  var deferredPrompt = null;
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault(); // hold it until the user taps our nudge
      deferredPrompt = event;
    });
  }

  function injectStyles() {
    if (document.getElementById('ob-pwa-nudge-styles')) return;
    var style = document.createElement('style');
    style.id = 'ob-pwa-nudge-styles';
    style.textContent = [
      '#ob-pwa-nudge{position:fixed;left:50%;transform:translateX(-50%) translateY(12px);bottom:calc(1rem + env(safe-area-inset-bottom,0px));z-index:60;max-width:min(92vw,26rem);display:flex;align-items:center;gap:.65rem;padding:.7rem .8rem;border-radius:1rem;background:rgba(20,22,28,.92);color:#f2f3f5;box-shadow:0 8px 28px rgba(0,0,0,.35);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);font:400 .85rem/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;opacity:0;pointer-events:none;transition:opacity .25s ease,transform .25s ease}',
      '#ob-pwa-nudge.ob-show{opacity:1;pointer-events:auto;transform:translateX(-50%) translateY(0)}',
      '#ob-pwa-nudge .ob-pwa-text{flex:1;min-width:0}',
      '#ob-pwa-nudge .ob-pwa-text strong{display:block;font-size:.85rem;margin-bottom:.15rem}',
      '#ob-pwa-nudge .ob-pwa-text span{opacity:.85;font-size:.78rem}',
      '#ob-pwa-nudge button{flex:none;border:0;border-radius:.65rem;cursor:pointer;font:600 .8rem/1 system-ui,sans-serif}',
      '#ob-pwa-nudge .ob-pwa-install{background:#7c6cf0;color:#fff;padding:.55rem .85rem}',
      '#ob-pwa-nudge .ob-pwa-install:active{transform:scale(.97)}',
      '#ob-pwa-nudge .ob-pwa-dismiss{background:transparent;color:rgba(255,255,255,.6);font-size:1rem;padding:.4rem .5rem}',
      '@media (prefers-color-scheme:light){#ob-pwa-nudge{background:rgba(255,255,255,.96);color:#16181d;box-shadow:0 8px 28px rgba(0,0,0,.18)}#ob-pwa-nudge .ob-pwa-dismiss{color:rgba(0,0,0,.5)}}',
    ].join('\n');
    document.head.appendChild(style);
  }

  function showNudge(copy, storage) {
    if (document.getElementById('ob-pwa-nudge')) return;
    injectStyles();
    var bar = document.createElement('div');
    bar.id = 'ob-pwa-nudge';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', copy.title);

    var text = document.createElement('div');
    text.className = 'ob-pwa-text';
    var title = document.createElement('strong');
    title.textContent = copy.title;
    var body = document.createElement('span');
    body.textContent = copy.body;
    text.appendChild(title);
    text.appendChild(body);
    bar.appendChild(text);

    if (copy.action === 'install') {
      var install = document.createElement('button');
      install.className = 'ob-pwa-install';
      install.type = 'button';
      install.textContent = 'Install';
      install.addEventListener('click', function () {
        if (deferredPrompt && typeof deferredPrompt.prompt === 'function') {
          deferredPrompt.prompt();
          if (deferredPrompt.userChoice && typeof deferredPrompt.userChoice.then === 'function') {
            deferredPrompt.userChoice
              .then(function (choice) {
                if (choice && choice.outcome === 'accepted') dismiss(true);
                deferredPrompt = null;
              })
              .catch(function () {
                deferredPrompt = null;
              });
          } else {
            deferredPrompt = null;
          }
        }
        dismiss(false);
      });
      bar.appendChild(install);
    }

    var close = document.createElement('button');
    close.className = 'ob-pwa-dismiss';
    close.type = 'button';
    close.textContent = '\u00D7';
    close.setAttribute('aria-label', 'Dismiss');
    close.addEventListener('click', function () {
      dismiss(true);
    });
    bar.appendChild(close);

    function dismiss(remember) {
      if (remember) writeJson(storage, DISMISS_KEY, Date.now());
      bar.classList.remove('ob-show');
      setTimeout(function () {
        if (bar.parentNode) bar.parentNode.removeChild(bar);
      }, 300);
    }

    document.body.appendChild(bar);
    // Animate in on the next frame so the transition plays.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        bar.classList.add('ob-show');
      });
    });
  }

  function init() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    var storage;
    try {
      storage = window.localStorage;
      if (!storage) return;
    } catch (_) {
      return;
    }
    var now = new Date();
    var visitCount = recordVisit(storage, now);
    var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    var nav = typeof navigator !== 'undefined' ? navigator : {};
    var ios = isIos(ua) || isIpadOs(nav, ua);
    var env = {
      capacitorNative:
        !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()),
      standalone: nav.standalone === true,
      displayStandalone:
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(display-mode: standalone)').matches,
    };
    var dismissedAt = readJson(storage, DISMISS_KEY, null);
    var show = shouldShowNudge({
      installed: isInstalled(env),
      visitCount: visitCount,
      dismissedAt: dismissedAt,
      now: now.getTime(),
    });
    if (!show) return;
    showNudge(installCopy(ios), storage);
  }

  // Run after parsing (script is deferred) but don't fight the boot sequence.
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  // Exported for node unit tests; inert in the browser.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      MIN_VISITS: MIN_VISITS,
      RE_ELIGIBLE_DAYS: RE_ELIGIBLE_DAYS,
      recordVisit: recordVisit,
      shouldShowNudge: shouldShowNudge,
      isInstalled: isInstalled,
      isIos: isIos,
      isIpadOs: isIpadOs,
      installCopy: installCopy,
    };
  }
})();
