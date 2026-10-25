# Duo Stage 1 — adaptive layout foundation (notes)

Branch: `feat/duo-adaptive-stage1` (parked locally; not pushed, no PR).
Scope: stage 1 of 2 for scope B. Stage 2 (Duo desk mode) is separate and not
included here.

## What changed

- `public/desktop.css` — appended one new media tier (nothing existing was
  edited or removed):
  `@media(min-width:761px) and (max-width:1023px)` with rules for `.shell`,
  `.tabs`, `.tab`, `.hero-card`, `.form-grid`, `.messages`, `.message`.
- `test/duo-layout.test.js` — new test file (5 tests) covering the tier, the
  safe-area rules, non-regression of the phone/desktop tiers, the chat
  bottom-anchor invariants, and the Split View decision guard.
- This file. No HTML, JS, or native code changes. No Info.plist change (see
  the Split View decision below).

## Why this shape

The layout system before stage 1:

- Base (`public/styles.css`): shell capped at 1180px, hero two columns,
  form grid 3 columns, connector/settings grids 2 columns, tab bar scrolls
  horizontally, messages max-height 480px, bubbles max-width 82%.
- `max-width:900px` (styles.css): a few grids collapse earlier.
- `max-width:760px` (styles.css + `public/mobile.css`): the full phone tier —
  everything stacks, composer reorders, messages cap at min(52dvh, 480px).
- `min-width:1024px` (`public/desktop.css`): tab bar wraps instead of
  scrolling; roomier topbar.
- `min-width:1400px` (desktop.css): shell widens to 1320px, hero grows,
  messages max-height 560px, grids go 3-column.

The gap was 761–1023px — exactly the unfolded-foldable / large-tablet-pane
band. It silently got the raw base tier: a 3-column form grid squeezed to
~230px per column, 56px hero side padding eating the width, and a tab bar
that still scrolled even though there was room for it to wrap.

The new tier reuses the codebase's own treatments instead of inventing a
parallel system:

- Tab bar wraps with the *same* rule values the desktop tier applies from
  1024px (`overflow:visible; flex-wrap:wrap`, tabs `flex:1 1 auto;
  min-width:90px`) — it just starts at 761px now.
- Hero stays two-pane (240px orb column vs desktop's 280px) with padding
  scaled down (34px 40px vs 38px 56px base / 48px 72px at 1400px).
- Form grid drops 3 → 2 columns using the same `repeat(2,minmax(0,1fr))`
  idiom the 900px breakpoint already uses for `.metric-grid`.
- Messages max-height 520px (between base 480 and the 1400px tier's 560);
  bubbles max-width 78% (between base 82% and the 1400px tier's 75%).

Being pure width-based CSS, the layout adapts **live** on fold/unfold and on
window resize — no reload, no JS device detection. Because the tier is
bounded (761–1023), phone (≤760) and desktop (≥1024/1400) rendering cannot
regress from it; `desktop.css` also loads last in `index.html`, so within
its range the tier wins the cascade by normal source order.

Safe area: the shell now honors `env(safe-area-inset-left/right)` inside
this tier (the codebase already used the top/bottom insets throughout;
left/right were only used by the standalone support page). On devices
without side insets this resolves to 0 and changes nothing.

Chat bottom-anchoring (Edward's standing rule) is untouched: the tier does
not restack any flex container, does not touch `.composer`, and the message
column stays `display:flex; flex-direction:column` with `chat-scroll.js`
scrolling to the bottom. The new tests assert all of that.

## Split View decision: plist left unchanged (for now)

`ios/App/App/Info.plist` keeps `UIApplicationSupportsMultipleScenes` =
**false**. The flip is *not* safe to make blind, for concrete reasons in
the current native code:

- `SceneDelegate` builds a **fresh `OrbitBridgeViewController` per scene**,
  and `OrbitBridgeViewController.capacitorDidLoad()` registers **fresh
  `StoreKitPlugin` and `SignupSecurityPlugin` instances per bridge**. Two
  simultaneous scenes would mean two live bridges/web views: duplicate push
  registration, duplicate App Attest/StoreKit handling, and two independent
  chat runtimes signed into the same account — with nothing in the native
  code deduplicating per-scene state.
- All scene callbacks route through the `SceneDelegateProxy.shared`
  singleton, whose behavior with multiple concurrent scenes has never been
  exercised in this app.
- Swift cannot be compiled or run on the build VM used for stage 1 (no
  Xcode), so none of this could be verified here. Enabling multitasking
  unverified risks a broken Split View experience in the same release line
  currently in App Store review — worse than full-screen-only.

The web-side half of Split View support *is* done: layout is purely
width-driven, so any window width lands in a deliberate tier — phone layout
below 761px (which is what Split View half/third panes would get), the new
tier at 761–1023px, desktop above. No further CSS work is needed when the
flag flips.

**Follow-up (Mac-side, before stage 2 ships):** on a branch, flip the flag
in Xcode, build, and on the physical Duo + an iPad verify: two scenes open
side by side, only one push registration, no duplicated chat sends or
sockets, StoreKit purchase/restore works from both scenes, App Attest
signup flow works. If duplicates appear, either gate secondary scenes to a
read-only/limited bridge or keep the flag off and ship stage 1 as-is — the
CSS tier is fully valuable without Split View.

## Test results

Run on the branch (base: main @ 2bb642a), 2026-10-25:

- Focused: `node --test test/duo-layout.test.js test/ios-layout.test.js` —
  **13/13 pass** (5 new duo-layout tests + all 8 pre-existing ios-layout
  tests, unmodified).
- Full suite: `npm test` with a disposable local PostgreSQL 16
  (`TEST_DATABASE_URL` pointing at a throwaway `orbit_test` database, as
  `scripts/prepare-test-postgres.mjs` requires) — **1,054 tests, 1,054
  pass, 0 fail**, exit code 0. Wall-clock was ~22 minutes on the shared
  build VM (many test files run serially with real timers); no test was
  skipped. With zero failures there was nothing to baseline against clean
  main — no pre-existing failures were encountered.

## What remains unverified (needs Edward's Duo / a Mac)

- The Duo's exact CSS viewport width unfolded. Stage 1 assumes it lands in
  (or above) the 761–1023 band based on the 7.6" panel class; if the device
  reports ≥1024 CSS px it gets the existing desktop tier, which is also a
  deliberate layout — confirm on hardware which tier it actually hits and
  that text/bubbles read well there.
- Fold/unfold live adaptation on the real device (CSS guarantees it in
  principle; only hardware proves it in the Capacitor web view).
- Safe-area insets on the inner display (hinge/camera) — the rules resolve
  to whatever iOS reports; check no content slides under a camera cutout.
- Split View behavior (flag still off — see decision above).
- iOS simulator build of the branch (no Xcode on the build VM). The change
  is web-only, so the native bundle just needs `npx cap sync` + the usual
  archive flow when this is picked up for a release.
