# OrbitLiveActivity — WidgetKit Live Activity extension (native iOS only)

Live Activities for active things: voice conversation in progress, and
"Orbit is working on…" while it handles a long task. Lock screen +
Dynamic Island. Tapping the activity deep-links back into the app
(`orbitbuddy://voice` / `orbitbuddy://`).

**Deliberately NOT a home-screen widget** — Edward doesn't use widgets
(2026-10-13), so this target registers only the Live Activity.

## Files

| File | Target(s) | Purpose |
|---|---|---|
| `OrbitAttributes.swift` | App **and** OrbitLiveActivity | Shared ActivityKit model — same file in both targets so the shapes always match |
| `OrbitLiveActivity.swift` | OrbitLiveActivity | Lock-screen + Dynamic Island layouts |
| `OrbitLiveActivityBundle.swift` | OrbitLiveActivity | `@main` WidgetBundle |
| `Info.plist` | OrbitLiveActivity | `com.apple.widgetkit-extension` |
| `OrbitLiveActivity.entitlements` | OrbitLiveActivity | App Group `group.com.smokeys30.orbitbuddy` |
| `../App/App.entitlements` | App | Same App Group on the main app |

The Capacitor bridge plugin (`../App/LiveActivitiesPlugin.swift`) starts,
updates, and ends activities; the web app drives it through
`public/live-activities.js` (no-op on web/Android).

## Hand-added to App.xcodeproj — read before running `npx cap`

This target was added to `ios/App/App.xcodeproj` by hand (X1 mega-build,
2026-10-15). `npx cap sync ios` only refreshes web assets and
`capacitor.config.json` — it preserves hand-added targets and files, so
this survives syncs. Do **not** re-run `npx cap add ios` (it regenerates
the whole project and would drop this target).

## Edward's Thursday build steps

1. Pull latest, then `npx cap sync ios` (or open `ios/App/App.xcodeproj` directly).
2. In Xcode, select the **OrbitLiveActivity** target → Signing & Capabilities:
   choose your Apple development team, verify the bundle ID
   (`com.smokeys30.orbitbuddy.OrbitLiveActivity`), and enable the
   **App Groups** capability with `group.com.smokeys30.orbitbuddy`.
   Do the same App Group step on the **App** target (bundle ID
   `com.smokeys30.orbitbuddy`).
3. Product → Archive.

Live Activities need no special entitlement beyond the extension target.
The extension requires iOS 16.1+; the main app still supports iOS 15
(the plugin simply isn't registered there).
