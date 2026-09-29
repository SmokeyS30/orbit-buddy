# Security policy

## Supported versions

Security fixes are provided for the latest release on `main`.

## Report a vulnerability

Use GitHub private vulnerability reporting instead of opening a public issue. Do not include API keys, OAuth tokens, recovery codes, personal data, or exploit traffic in a public report.

## Security model

- Every private API route requires a signed-in session or a narrowly scoped automation token.
- Passwords use salted `scrypt`; session tokens, recovery codes, OAuth states, and automation tokens are stored only as hashes.
- Browser mutations require a per-session CSRF token. Session cookies are HttpOnly, SameSite Strict, and Secure in production.
- The first account is the owner. Later registration is closed unless `ORBIT_INVITE_CODE` is configured and supplied.
- Model credentials remain server-side. Responses API calls use `store: false` by default.
- OAuth access and refresh tokens are encrypted with AES-256-GCM before they enter SQLite.
- GitHub, Google Calendar, and Slack connectors are read-only previews. Disconnecting removes their stored tokens from Orbit.
- External tasks stop for explicit approval and currently produce only plans or drafts.
- The emergency pause stops new AI work, the background worker, and connector reads. It does not erase data or revoke provider tokens.
- Portable and automatic backups use authenticated encryption. Restore merges data and leaves Orbit paused for human review.
- Saved memory is explicit and deletable. Orbit does not silently infer or save new memories.
- There is no arbitrary shell, browser-control, purchasing, email-send, or messaging-send capability.

## Deployment checklist

1. Use the persistent disk and HTTPS endpoint supplied by Render.
2. Generate a unique `CONNECTOR_ENCRYPTION_KEY` and `BACKUP_ENCRYPTION_KEY`; never reuse the account password.
3. Keep `ORBIT_INVITE_CODE` private or leave it unset after creating all intended users.
4. Use separate OAuth applications for production and development, with exact callback URLs.
5. Rotate OAuth credentials and connector encryption keys through a planned migration; changing the encryption key immediately makes existing stored connector tokens unreadable.
6. Store recovery codes and portable backup passphrases separately from the server.
7. Review the audit log, dependency alerts, CodeQL results, and Render deploy logs after each release.

## Emergency response

Use **Safety → Emergency pause** first. Preserve logs and an encrypted backup, then revoke the affected OAuth application or API credentials at each provider. Rotate Render secrets and account passwords, deploy a reviewed build, and only resume after checking the audit trail.

No software can guarantee protection from every attack. Orbit reduces exposure through least privilege, visible approvals, revocation, encrypted secrets, backups, and testable boundaries; it does not replace device updates, multi-factor authentication at connected providers, or professional incident response.
