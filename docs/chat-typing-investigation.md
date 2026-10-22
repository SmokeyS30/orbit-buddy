# Chat typing investigation — 2026-10-21

## Revision and scope

Fetched origin/main: `2f55993022118c7ff7af45236e0622a27de32acc`.
`git ls-remote` reports signup branch and PR 194 head as
`2e6edcd09e48c6ded3ffe66577dde0c56666474a`. Main's merge commit explicitly
merges PR 194. Compared with previously verified `9b0c8aa`, the only subsequent
file changes on main are marketing version 1.1 and its layout test. GitHub
GraphQL PR metadata lookup returned Forbidden; no PR state was changed.
Installed build and production deployment revision remain unknown.

The original `/workspace/orbit-buddy` checkout was clean on branch `work` and
remains untouched. Changes are in `/workspace/orbit-buddy-chat`, branch
`fix/chat-typing-render-race`, based on fetched main. No AGENTS.md or local
SKILL.md files were found. Available SwiftUI engineering skills do not apply to
this Capacitor DOM issue; no Swift changes were made.

## Trace and evidence

- `public/index.html`: native HTML textarea, two rows, maxlength 6000.
  `public/app.js` document input listener only updates `lastTypeAt`. No typed
  character API calls, draft saves, controlled-value reconciliation, autosizing,
  scrollHeight reads or keyboard handlers occur on the ordinary input path.
  Paste can upload image files; that is a separate explicit path.
- `isComposing()` protects focused input, nonempty drafts and the last 3 seconds
  after input. `refresh()` runs every 15 seconds while visible. It skips full
  `render()` during composing, but still fetches/parses status, setup, snapshot,
  writing voice, and owner admin data; writes the conversation ID to localStorage;
  updates status/typing UI; and invokes briefing/catchup. No production payload
  sizes or timings were measured. Native auth token reads also occur per request,
  not per character.
- Snapshot history defaults to 60 messages (SQLite and PostgreSQL adapters).
  `renderMessages()` builds markdown/canvas and action DOM for the entire history,
  followed by synchronous layout reads and scroll writes, then two animation-frame
  bottom adjustments. It caches a fingerprint of IDs/content lengths. Same-length
  edits and unconditional rebuilding while typingActive are existing limitations.
- Confirmed race: `renderMessages()` awaits `loadCanvas()` after the composing
  check in `refresh()`. Current main then calls replaceChildren regardless of
  intervening typing/thread changes/newer render requests. Cold module loading
  can widen that interval; even a memoized promise yields execution.
- Regression harness executes the actual source function with a delayed module
  promise and instrumented DOM. Current main: typing overlap rebuild count 1
  (expected 0), out-of-order renders count 2 (expected 1), thread switch count 1
  (expected 0). Fixed source: 0, 1, 0 respectively. Unchanged idle history remains
  one rebuild with no additional load. These are operation counts, not device
  performance numbers or proof this race caused the reported real-world freezes.
- `loadBriefing()` redraws cached briefing on each refresh; async briefing/catchup
  completions lack a composing guard. Snapshot JSON work, these redraws, full
  history rendering, CSS effects and platform keyboard/autocorrection are remaining
  hypotheses. Profile before broad changes. Streaming also performs text updates
  and layout/scroll reads, relevant only if a reply overlaps composing.
- `sendChatMessage()` waits for lazy voice/canvas modules before displaying the
  optimistic bubble. That explains a possible cold-send delay, not typing freezes;
  left unchanged to keep this patch scoped. It already uses optimistic messages.
- `OrbitBridgeViewController.swift` only registers StoreKit/signup plugins. No
  custom native keyboard listeners/resize path or frontend visualViewport handlers
  were found. Mobile CSS constrains textarea height with dvh, resize:none;
  default WKWebView keyboard behavior and CSS layout require device inspection.
  Legacy `ios/OrbitCompanion` is not the Capacitor target.

## Patch

`public/app.js`: recheck composing and conversation identity after the async module
load, reject superseded render requests, and only commit the fingerprint when
history is actually rendered. Deferred history retries on a later idle refresh
(existing focus/draft/3-second guard still applies); no input debounce is added.
`test/chat-render-race.test.js`: four executable regressions, three demonstrably
failing on the baseline. `public/index.html` and `public/sw.js`: synchronized web
asset version/cache bump so a future web release can deliver the change.

## Delivery path (nothing released)

`capacitor.config.ts` sets webDir to `public` with no remote server.url.
`scripts/sync-ios.mjs` runs Capacitor sync and writes the API origin into
`ios/App/App/public/native-config.js`; this config changes API calls, not the
source of the UI assets. Native backend default is https://orbitbuddy.app.
`ios/CAPACITOR_README.md` explicitly describes bundled PWA files and rebuilds for
frontend changes. No over-the-air asset updater was found. Generated installed
bundle cannot be inspected here, so verify the user's actual build too.

For this repository's native app: incorporate patch into an approved release,
install locked dependencies, `npm run ios:sync`, build/test in Xcode, then follow
separately authorized native distribution. A server-only deployment cannot replace
this JavaScript in an installed bundled app. Backend/API optimizations could reach
installed apps but are not a demonstrated fix for this typing issue.

For browser/PWA: an approved web deployment of public assets plus updated service
worker/cache delivers the fix on refresh/update. Existing service-worker reload
handlers have their own draft-interruption risk and are not changed here. Do not
claim the web update path updates a bundled WKWebView.

## Minimum device validation

1. Record installed version/build, device/iOS, bundled asset revision and backend;
   reproduce on original build before comparing patched build on the same device.
2. Cold-launch a 60-message history with long markdown/canvas messages; type
   immediately while history/chunks load. Type continuously across multiple
   15-second refresh intervals; compare input-to-paint and main-thread stalls with
   Safari Web Inspector/Instruments. Verify no dropped text/caret jumps.
3. Repeat with keyboard autocorrection/predictive text, emoji, dictation, paste,
   multiline text and IME composition; open/dismiss keyboard and rotate. Include
   slower supported iPhone hardware and both good/poor network conditions.
4. Switch threads while loading, then stop typing/blur with an empty draft and
   confirm deferred history appears. Check scroll position when reading older
   messages, newest-message settling, incoming reply while composing, optimistic
   sends, offline/reconnect and foreground/background transitions.

No Xcode, Simulator or real-device run was performed. Native behavior and any
perceived responsiveness improvement remain unverified until these checks pass.

## Validation results

- Baseline regression harness: 1 passed, 3 failed (expected, confirming races).
- Focused regression/scroll/cache/native-config/iOS-layout checks: 21/21 passed.
- `npm run check`: syntax checks passed; 909 tests executed, 903 passed,
  6 failed solely at the PostgreSQL prerequisite assertion that
  `TEST_DATABASE_URL` must be set. No database connection was attempted by those
  six tests. PostgreSQL integration validation remains blocked by missing local
  test database configuration; no production configuration was changed.
- `git diff --check`: passed. Original worktree remains clean.
- Dependency installation initially failed because npm's default cache path was
  unavailable; rerunning with a writable `/tmp/orbit-npm-cache` succeeded.
- Supporting logs: `/tmp/orbit-chat-targeted.log`, `/tmp/orbit-chat-check.log`.

## Mac follow-up and 1.1.1 preparation — 2026-10-21

The validation results above describe the initial typing-race patch. On the Mac,
the draft PR was extended with a separate Safety cleanup: Quiet Hours fields stay
inside their card, briefing selects have consistent WebKit sizing, and the signed-in
Apple link control becomes gray and disabled only when authenticated account data
confirms that Apple is linked. The logged-out Sign in with Apple control and password
login remain available. The server exposes the current account's linked state in
`/api/status`; that server change must reach the app's backend before a released
client can display the confirmed state on a fresh launch.

Locked dependencies installed with scripts disabled. `npm run check` passed all
911 tests with an isolated, disposable local PostgreSQL 16 database. Static WebKit
and Chromium Safety fixtures were inspected at 320, 375, and 430 px, landscape,
and enlarged text. No horizontal overflow was measured; time fields, selects,
and the proactive checkbox accepted input. Static Today, Goals, and Tasks layouts
were also inspected at narrow and landscape sizes. An account-free staging bundle
built and cold-launched in an iPhone Simulator. These fixture and Simulator checks
do not establish live authenticated behavior or resolution of the reported freeze.

The proposed 1.1.1 release uses build 20261026, one above the highest local Orbit
archive. App Store Connect build-number availability was not independently checked.
The release archive must explicitly bundle `https://orbitbuddy.app`; staging
screenshots and test accounts must not be treated as production validation. The
real-iPhone comparison, keyboard and IME cases, live notifications, offline flows,
and input-to-paint profiling in the checklist above remain open.
