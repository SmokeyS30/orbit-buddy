# Orbit Buddy subscriptions — activation runbook

StoreKit 2 with no third-party purchase SDK. The iOS client uses Apple's
StoreKit framework directly, and the server uses Apple's official App Store
Server Library. No entitlement is granted without Apple API confirmation.

## Production quota enforcement: DISABLED by default

`SUBSCRIPTIONS_ENABLED` defaults to **false**. The 25/day free-tier limit is
**never** enforced unless **both** are true:

1. `SUBSCRIPTIONS_ENABLED=true` is set on the server, **AND**
2. Apple server configuration is complete (`APPSTORE_ISSUER_ID`,
   `APPSTORE_KEY_ID`, `APPSTORE_PRIVATE_KEY_P8`, and
   `APPSTORE_APP_APPLE_ID` all valid).

If either is missing, the server fail-opens: every chat message is allowed
and no user is ever blocked at message 26. `GET /api/subscriptions/status`
reports `{enabled, configured, ready}` so you can verify before flipping
the switch.

**Do not set SUBSCRIPTIONS_ENABLED=true until the App Store Connect
products below exist and the webhook is receiving notifications.**

## Azure environment variables / secrets

Set on the orbit-buddy Container App (all as secrets except where noted):

| Name | Value |
|---|---|
| `SUBSCRIPTIONS_ENABLED` | `true` (only when activating; default false) |
| `APPSTORE_ISSUER_ID` | App Store Connect API issuer ID (from Users and Access → Integrations → App Store Connect API) |
| `APPSTORE_KEY_ID` | API key ID (10 chars) |
| `APPSTORE_PRIVATE_KEY_P8` | The `.p8` private key text, full contents including BEGIN/END lines |
| `APPSTORE_APP_APPLE_ID` | Orbit Buddy's numeric Apple app ID (required for production JWS validation) |
| `APPSTORE_BUNDLE_ID` | Optional — defaults to `com.smokeys30.orbitbuddy` |
| `APPSTORE_SANDBOX` | `true` for sandbox testing, absent/false for production |
| `COMPED_USER_IDS` | Optional comma-separated Orbit user IDs that get unlimited chat free, bypassing both the subscription check and the 25/day limit — regardless of `SUBSCRIPTIONS_ENABLED`. |
| `COMPED_USER_EMAILS` | Optional comma-separated, case-insensitive Orbit account emails. Use this for the owner's mom, dad, and friend so they remain free even if their accounts are created after deployment. The `owner` role is always exempt automatically. No app update is needed when this list changes. |

Create the key in **Users and Access → Integrations → In-App Purchase**.
Download the .p8 once; Apple never shows it again. Keep it only in Azure's
secret store. Apple's public root certificates are pinned in the code and
their SHA-256 fingerprints are covered by regression tests.

## App Store Connect setup (Codex lane)

1. **Subscription group**: create group **"Orbit Buddy Plans"**.
2. **Products** (all auto-renewable, in that group):

   | Product ID | Name | Price | Service level |
   |---|---|---|---|
   | `com.smokeys30.orbitbuddy.standard.monthly` | Standard Monthly | $5.99/mo | 2 |
   | `com.smokeys30.orbitbuddy.standard.yearly` | Standard Yearly | $59.99/yr | 2 |
   | `com.smokeys30.orbitbuddy.pro.monthly` | Pro Monthly | $19.99/mo | 1 |

   Pro has **no** yearly product. Service levels: Standard = 2, Pro = 1
   (higher number = higher level for upgrade/downgrade ranking).
3. **App Store Server Notifications v2**: set the webhook URL to
   `https://orbitbuddy.app/api/subscriptions/apple-notifications`
   (version 2, all notification types).
4. Fill in the subscription display name, description, and review screenshot
   for each product; submit for review with the app version.

## Webhook URL

`POST https://orbitbuddy.app/api/subscriptions/apple-notifications`
Public endpoint — Apple authenticates via the JWS `signedPayload` itself,
which the server verifies (signature + Apple cert chain). The raw payload
is never logged. Notifications are idempotent (UUID dedupe) and
out-of-order safe. A notification UUID is claimed before processing, retained
only after success, and released on failure so Apple's retry is not lost.

## Deployment order

1. Merge the subscriptions PR (code only; `SUBSCRIPTIONS_ENABLED` stays false).
2. Deploy — the new tables (`subscriptions`, `daily_usage`,
   `subscription_purchase_intents`, `daily_usage`, and
   `processed_notifications`) are created by additive startup migrations on both
   SQLite and Postgres. Verify with `GET /api/subscriptions/status`:
   expect `{enabled:false, configured:false, ready:false, enforcementReady:false}`.
3. Complete the App Store Connect products + webhook above.
4. Set the `APPSTORE_*` secrets in Azure (keep `SUBSCRIPTIONS_ENABLED=false`).
5. Redeploy; verify `GET /api/subscriptions/status` shows
   `{enabled:false, configured:true, ready:true, enforcementReady:false}`. StoreKit
   purchases and server verification are now available for sandbox testing, but
   the daily limit remains fail-open.
6. Sandbox test (below) with a TestFlight build.
7. Only after sandbox passes and the subscription-capable app version is ready
   for release: set `SUBSCRIPTIONS_ENABLED=true`, redeploy, and verify
   `ready:true` plus `enforcementReady:true`. The quota is now live.

## Sandbox acceptance plan (TestFlight + sandbox Apple ID)

- [ ] Products load with correct prices in the app
- [ ] Purchase Standard Monthly (sandbox) → entitlement active, unlimited chat
- [ ] Message 26 as a free user → inline paywall appears in chat (no popup)
- [ ] Cancel in sandbox → `DID_FAIL_TO_RENEW`/expiry → back to free tier
- [ ] Refund via sandbox → `REFUND` → revoked → free tier
- [ ] Restore Purchases on a second device → entitlement recovered
- [ ] Ask-to-Buy pending → app shows "waiting for approval", no charge, no entitlement
- [ ] Approve Ask-to-Buy later → transaction update verifies, unlocks, and finishes
- [ ] Billing retry without grace → free allowance; grace period → unlimited until grace expiry
- [ ] Upgrade Standard → Pro and downgrade Pro → Standard at the next renewal
- [ ] Webhook receives `DID_RENEW` on renewal (check server logs for
      `[subscriptions]`, never the payload)
- [ ] Daily reset: usage counter clears at midnight ET (04:00 UTC in EDT)

## Universal reset rule

One reset at 00:00 America/New_York for every user worldwide
(04:00 UTC during daylight time, 05:00 UTC during standard time).
All timestamps stored in UTC; the NY calendar day is derived per request.
The scheduled job prunes yesterday's rows and is idempotent — a missed run
self-heals because the day key rolls forward automatically.

## What the iOS build must include

- `StoreKitPlugin.swift` and `OrbitBridgeViewController.swift` in the App
  target's Compile Sources
- No new capabilities or entitlements needed for StoreKit 2
- The plugin must send `VerificationResult.jwsRepresentation` (never decoded
  `Transaction.jsonRepresentation`) and call `transaction.finish()` only after
  `/api/subscriptions/verify` succeeds
- Simulator build and launch were verified on this branch before PR update
