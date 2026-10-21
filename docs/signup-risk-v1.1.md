# Orbit Buddy 1.1 signup safety

Draft PR #194, branch `feat/risk-based-signup-v1.1`; baseline `c4c861a`.
No deployment, enforcement activation, account conversion, or Apple submission is part of this work.
Keep `SIGNUP_RISK_MODE=off` (default) or `observe`. Both retain the existing owner-controlled registration door. Existing accounts and password login remain supported. The pre-existing future `enforce` policy is covered by tests but is **not authorized for rollout**.

## Apple sign-in and explicit linking

The native app requests a five-minute server nonce, supplies it to AuthenticationServices, and submits the identity token and authorization code together. The backend uses `jose` with Apple's fixed HTTPS JWKS endpoint, RS256 only, issuer/audience/expiry/issued-at/sub/nonce checks. A mandatory authorization-code exchange at Apple's fixed token endpoint uses a short-lived ES256 client secret. Both identity tokens must agree on subject and nonce. No provider access/refresh token is persisted, returned, or logged. Challenges are purpose-bound, account-bound for linking, and atomically consumed before exchange; failures require a new Apple attempt.

Account creation continues through the existing password/email flow. After creating an account, use **Safety → Sign in with Apple** to link it, confirming the current password. Subsequent native Apple sign-in can authenticate that linked account. Matching email addresses (including verified Apple and private-relay addresses) **never merge or link accounts automatically**. Database constraints uniquely bind each Apple subject and each account; collisions return 409 without changing ownership. Disabled accounts cannot sign in. Session validity is checked again after the external exchange when linking.

Required server secrets/configuration, to be provisioned through a secret manager or protected environment, never chat or source control:

- `APPLE_CLIENT_ID=com.smokeys30.orbitbuddy` for this native app; a web Services ID is not interchangeable.
- `APPLE_TEAM_ID=S6L62N62M4`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (PKCS#8 Sign in with Apple signing key).
- Optional `APPLE_REDIRECT_URI` only when the initiating authorization actually uses that registered redirect. Native flow omits it.

Missing configuration returns 503; no fake verification fallback exists. Cloud tests generate local keys and mock the Apple exchange. They are not live Apple verification. Browser-based Apple authorization is not implemented; web users retain password/email access.

## App Attest

`APPLE_APP_BUNDLE_ID=com.smokeys30.orbitbuddy` and `APPLE_TEAM_ID` enable the backend. `node-app-attest` verifies Apple root signatures, nonce extension, key ID, RP ID, counter zero, credential ID and environment. The wrapper additionally enforces certificate lifetime/order, payload sizes and CBOR shape/depth. Development attestations are accepted only outside production with `APP_ATTEST_ALLOW_DEVELOPMENT=true`; production rejects development keys even if they were stored earlier.

Attestation challenges are five-minute, one-time and bound to normalized signup email plus key ID. After enrollment, assertions sign the exact JSON payload returned by `/api/auth/attest/challenge` (UTF-8, no reserialization). The server reconstructs that payload, checks the signature and strictly increasing counter, then advances the counter with database compare-and-swap. A successful assertion yields a five-minute, email-bound, single-use signup proof. Neither native headers nor a client `attested` flag count as evidence.

Public keys/counters persist; attestation blobs and Apple receipts do not. The native plugin stores only its public key identifier and enrollment flag in UserDefaults. Simulator, unsupported hardware, Apple outages, expired proofs and stale enrollment fall back to the existing password/email signup flow. Attestation only affects observation telemetry in this release; it grants no admission bypass. Reinstall/key invalidation can require new enrollment; verify that lifecycle on devices before enforcement. Fraud-metric receipt retrieval is not implemented or required by this observation policy.

## Owner controls, appeals, and recovery

Safety shows the latest 100 sanitized risk events' aggregate decisions, current mode and pause state. These counts describe observations, not actual admissions. No keyed applicant identifiers appear in the dashboard. Pause changes and appeal review require an owner session plus CSRF. `SIGNUPS_PAUSED=true` overrides the owner's stored pause toggle; the UI cannot clear the environment override. Initial owner setup and existing logins remain available. Account creation rechecks the door/pause after password hashing and inside its transaction.

Applicants can submit a 500-character appeal using **Need help joining?**. Owner review marks a request reviewed/closed and never grants or changes account ownership. Appeals store the supplied email and note (unverified applicant claims), are owner-only and pruned after 30 days on new submissions. Do not put passwords or sensitive documents in appeals. Public submission is rate-limited; delivery to an external party is not performed.

Existing recovery codes and email resets remain supported. Recovery validates ownership before consumption; password update, code rotation and session revocation run in a transaction. Email reset tokens are atomically consumed with the password change and session revocation. Disabled accounts cannot recover themselves. The insecure legacy email-only `/api/access-claim` route now returns 410; approved applicants use the secure emailed reset link instead. Failed reset email delivery invalidates its token and no longer sends bearer reset links in push notifications.

Email verification requires the existing transactional email provider, a correct `PUBLIC_BASE_URL`, and `SIGNUP_AUDIT_KEY` (or existing data/connector encryption key). Verification hashes and user creation commit together, rolling back on collisions. Existing password hashes and identity associations are not rewritten.

## Storage and verification

SQLite startup and PostgreSQL upgrade migrations share additive `signupSecuritySchema`; the PostgreSQL bootstrap SQL includes the same tables. Added tables: `signup_challenges`, `app_attest_keys`, `signup_appeals`. Existing `auth_identities`, risk audit and verification-token tables retain their constraints. PostgreSQL advisory transaction locking serializes signup bootstrap so concurrent requests cannot create multiple owners. SQLite uses `BEGIN IMMEDIATE`.

Run Node 24, `npm ci --ignore-scripts`, then `TEST_DATABASE_URL=<isolated PostgreSQL test URL> npm run check` and `npm audit --omit=dev --audit-level=high`. CI supplies PostgreSQL 16; CodeQL scans JavaScript/TypeScript with security-and-quality queries. Tests cover signed JWT failures, mandatory code exchange, explicit linking/collisions, disabled accounts, challenge/purpose/email binding, replay, compare-and-swap counters, recovery ownership and reset races, rollback and migration persistence. The App Attest positive fixture is a public historical example from the pinned dependency, verified under its historical certificate date; production expiration is tested separately.

## Security review and remaining release gates

- No user data, protected characteristics or message content is used as a risk signal. User-agent classification is weak/spoofable; do not enable enforcement from these scores alone.
- Public endpoint rate limits are process-local existing infrastructure. Distributed abuse controls and measured false-positive thresholds remain prerequisites for a large rollout.
- Apple signing credentials were not provided or exercised live. Do not interpret mocks or recorded fixtures as Apple production validation.
- The Swift bridge, signing entitlements, Simulator and archive are unverified until Xcode builds on the user's Mac. CodeQL covers JavaScript/TypeScript, not this Swift implementation.
- Native API traffic currently targets `https://orbitbuddy.app`; this draft's endpoints are not deployed there. Full device integration needs a separately approved non-production backend and test build URL, or an independently approved future rollout. Do not point draft builds at production to test new signup behavior.
- No persistent external access, Apple capability registration, signing-key creation, merge, deployment, TestFlight upload or submission has been performed.

See [Mac validation handoff](signup-risk-mac-handoff.md).

Protocol references: [Apple App Attest server validation](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server), [Apple token validation](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens), and the pinned [node-app-attest implementation](https://github.com/uebelack/node-app-attest).
