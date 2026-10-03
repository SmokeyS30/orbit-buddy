# Security policy

## Supported versions

Security fixes are provided for the latest release on `main`.

## Report a vulnerability

Use GitHub private vulnerability reporting instead of opening a public issue. Do not include API keys, OAuth tokens, recovery codes, personal data, or exploit traffic in a public report.

## Security model

- Every private API route requires a signed-in session.
- Passwords use salted `scrypt`; session tokens, recovery codes, and OAuth states are stored only as hashes.
- Browser mutations require a per-session CSRF token. Session cookies are HttpOnly, SameSite Strict, and Secure in production.
- The first account is the owner. Registration is closed by default; the owner opens the door from Safety → Registration door when adding someone, then closes it again.
- Access requests are unauthenticated by design and rate-limited to a few per hour per address; they only notify the owner and never create accounts.
- The owner is notified if registration stays open over an hour. Push action tokens that open the door are single-use, expire after a day, and are stored only as hashes.
- Model credentials remain server-side. Responses API calls use `store: false` by default.
- OAuth providers are disabled in the current release. Calendar access uses read-only iCal feeds.
- Calendar feed URLs are masked in API responses and encrypted with AES-256-GCM in SQLite when `DATA_ENCRYPTION_KEY` is configured.
- External tasks stop for explicit approval and currently produce only plans or drafts.
- Calendar-event proposals stop for explicit approval and produce a downloadable `.ics` file; they do not write to a calendar provider.
- The emergency pause stops new AI work, the background worker, and connector reads. It does not erase data or revoke provider tokens.
- Portable and automatic backups use authenticated encryption. Restore merges data and leaves Orbit paused for human review.
- Saved memory is typed, explicit, and deletable. Inferred memories remain suggestions until the user approves them.
- There is no arbitrary shell, browser-control, purchasing, email-send, or messaging-send capability.

## Deployment checklist

1. Use the persistent disk and HTTPS endpoint supplied by Render.
2. Generate unique `DATA_ENCRYPTION_KEY` and `BACKUP_ENCRYPTION_KEY` values; never reuse the account password.
3. Registration is closed by default and opens only from the Safety tab; close it again after your person signs up. Per-user rate limits blunt abuse if the link spreads.
4. Keep iCal subscription URLs out of logs and screenshots, and revoke/regenerate a feed if it leaks.
5. Rotate `DATA_ENCRYPTION_KEY` only through a planned migration; changing it immediately makes existing encrypted calendar URLs unreadable.
6. Store recovery codes and portable backup passphrases separately from the server.
7. Review the audit log, dependency alerts, CodeQL results, and Render deploy logs after each release.

## Emergency response

Use **Safety → Emergency pause** first. Preserve logs and an encrypted backup, then revoke affected API keys or calendar subscription URLs. Rotate Render secrets and account passwords, deploy a reviewed build, and only resume after checking the audit trail.

No software can guarantee protection from every attack. Orbit reduces exposure through least privilege, visible approvals, revocation, encrypted secrets, backups, and testable boundaries; it does not replace device updates, multi-factor authentication at connected providers, or professional incident response.
