# Security policy

## Supported versions

Security fixes are currently provided for the latest release on `main`.

## Report a vulnerability

Please use GitHub's private vulnerability reporting feature instead of opening a public issue. Do not include API keys, access tokens, personal data, or exploit traffic in a public report.

## Security model

- Every API route except `/healthz` requires a bearer token.
- Model credentials remain server-side and are never returned to the browser.
- Responses API calls use `store: false` by default.
- Orbit has no shell, browser-control, email, purchasing, or messaging connector in v0.1.
- Tasks labeled `external` stop at an approval gate and still produce only a plan or draft.
- Saved memory is explicit and deletable. Orbit does not silently infer or save new memories.
- The included Render blueprint uses persistent storage. Protect the service URL and rotate `BUDDY_ACCESS_TOKEN` if it may have been exposed.

No software can guarantee protection from every attack. Keep Node updated, use a unique access token, restrict connected services, and review releases before upgrading.
