# Duo Stage 2 — desk mode (notes)

Branch: `feat/duo-desk-mode-stage2`, based on `feat/duo-adaptive-stage1`
(parked locally; not pushed, no PR). Scope: stage 2 of 2 for scope B —
the glanceable "desk mode" surface for the unfolded Duo.

## What changed

- `public/desktop.css` — appended one desk-mode block (nothing existing
  was edited or removed):
  - `@media(min-width:761px)`: the active Today view becomes a CSS grid —
    hero across the top, then a two-column row: the existing briefing
    surface (`#today-briefing`) as a glanceable column
    (`minmax(300px,400px)`, independently scrolling,
    `max-height:calc(100dvh - 150px)`) beside the conversation panel.
    Inside the column the briefing cards stack single-column and the
    masthead headline steps down to 30px.
  - A small `@media print` guard restores the stacked layout for print.
- `test/duo-desk-mode.test.js` — new test file (7 tests): cutover
  activation and exclusivity, layout placement, phone-tier
  non-regression, chat bottom-anchor/composer invariants, automatic +
  read-only guarantees, briefing/check-in surface reuse, print fallback.
- `test/duo-layout.test.js` — one guard updated, deliberately: the
  "exists exactly once" assertion now counts the *bounded* stage-1 tier
  query (`@media(min-width:761px) and (max-width:1023px)`) instead of
  every `min-width:761px` query, because stage 2 adds a second,
  intentionally unbounded one. The leakage protection is unchanged for
  the bounded tier, and the desk block carries its own exactly-once
  assertion in the new test file.
- This file. **No HTML, JS, server, or native changes.**

## How desk mode works (and decides to show)

Desk mode is pure placement of DOM that already exists, decided by
viewport width alone — the same mechanism as stage 1, so fold/unfold
and window resize adapt **live**, with no reload, no JS, and no device
detection.

The Today view's children were already in exactly the right order:
`.hero-card`, then `#today-briefing`, then `.conversation-panel`. Grid
areas (`"hero hero" "desk chat"`) put the briefing column beside the
chat; that is the entire feature. Because the grid selector is
`#today.view.active`, inactive views keep `display:none` and other tabs
are untouched.

What the panel shows is precisely what the Today tab already renders —
no new fetches, endpoints, or render code:

- **Briefing + today's calendar:** `renderBriefing()` (app.js) renders
  into `#today-briefing` from the existing `GET /api/today-briefing`
  payload (10-minute client cache): masthead/dek, weather, the agenda
  card (today's calendar events via `buildAgendaCard`/`agendaRow`),
  focus goals, open loops, anniversaries/tomorrow, project radar, and
  the systems line.
- **Orbit's check-ins:** client-side, check-ins surface as the
  "While you were away" catch-up card (`GET /api/catchup-digest`,
  items with `kind:'checkin'`), which `renderCatchupCard()` also
  renders into `#today-briefing` — so it lands in the desk column
  automatically whenever it appears.

Read-only holds by construction: the change adds no JS and no markup,
so the panel cannot call anything. Calendar writes were already
approval-gated proposals elsewhere in the app and are untouched.

## Cutover choice: unbounded above 761px (justification)

Stage 1's tier is bounded (761–1023) to protect the desktop layout.
Desk mode is deliberately **not** capped at 1023, for one concrete
reason: the Duo's exact unfolded CSS width is still unverified and may
land at or above 1024px. Capping desk mode at 1023 could mean it never
appears on the device it exists for. On true desktop widths the same
placement is an enhancement rather than a regression — briefing and
check-ins stay glanceable beside the conversation instead of scrolling
away above it — and nothing is removed or reordered: hero, briefing,
and chat are all still present, chat behavior (including
bottom-anchoring and the composer) is rule-for-rule unchanged, and the
existing ≥1024/≥1400 tier rules (tab wrap, shell widths, message
heights) still apply underneath. The stage-1 bounded tier's rules and
the desk block coexist without overlap conflicts: within 761–1023 both
apply, and they touch disjoint properties except `.shell`/tab rules,
which only the stage-1 tier sets.

## Binding rules honored

- No new toggle, button, or setting (UI minimalism) — activation is
  automatic by width; tests assert no desk markup or script exists.
- Chat bottom-anchored: the desk block contains no `.messages`,
  `.composer`, or flex-direction rules; `chat-scroll.js` invariants
  asserted by test, same as stage 1.
- Calendar writes OUT; no silent data writes; no new endpoints; no
  auth/security changes; no new paid services.
- Info.plist **not** touched: the stage-1 Split View decision stands
  (flag stays false until the multi-scene bridge audit is done on a
  Mac). Desk mode needs no native change.

## Test results

Run on the branch (base: stage 1 tip `7eaab2a`), 2026-10-25:

- Focused: `node --test test/duo-desk-mode.test.js
  test/duo-layout.test.js test/ios-layout.test.js` — **20/20 pass**
  (7 new desk-mode tests + 5 stage-1 duo-layout + 8 ios-layout,
  unmodified except the one guard described above).
- Full suite: `npm test` with `TMPDIR=/home/hatch/.scratch/tmp` and a
  disposable local PostgreSQL 16 (`TEST_DATABASE_URL` pointing at a
  throwaway `orbit_test` database, per
  `scripts/prepare-test-postgres.mjs`) — **1,061 tests, 1,061 pass,
  0 fail**, exit code 0 (stage 1's 1,054 + the 7 new tests). Wall-clock
  ~22 minutes on the shared build VM; no test skipped. No pre-existing
  failures were encountered, so no clean-base comparison was needed.

## What remains unverified (needs Edward's Duo / a Mac)

- Whether the physical Duo's unfolded viewport actually lands ≥761px
  and how the desk column reads on the real panel (text size, the
  300–400px column width against the chat, masthead scale).
- Fold/unfold **live** adaptation inside the Capacitor web view (pure
  CSS guarantees re-layout in principle; only hardware proves the web
  view re-evaluates the media queries without a reload).
- Panel scrolling feel: the briefing column scrolls independently
  (`overflow-y:auto`); check the gesture doesn't fight the message
  list's scroll on the touch device.
- Safe-area insets on the inner display while desk mode is active
  (stage 1's left/right inset rules apply to `.shell`; the desk column
  inherits them, but hinge/camera clearance is a hardware check).
- iOS simulator build of the branch (no Xcode on the build VM). The
  change is web-only, so the native bundle just needs
  `npx cap sync` + the usual archive flow when this is picked up.
- Split View remains off (stage-1 decision); desk mode does not
  change that either way.
