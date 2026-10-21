# Orbit Buddy 1.1 signup safety

This work replaces manual admission with automatic, risk-based signup while preserving every existing account.

## Safe rollout

1. `SIGNUP_RISK_MODE=off` is the default and keeps current behavior.
2. `observe` records privacy-preserving decisions but never blocks a signup.
3. Measure false positives, native App Attest coverage, and bot patterns in TestFlight.
4. Add verified email and Sign in with Apple account linking without replacing existing passwords.
5. Enable `enforce` only after device and recovery tests pass.

In `enforce`, the legacy owner-controlled registration door is replaced by the
automatic decision: low-risk applicants join, ambiguous applicants are sent to
step-up verification, and strong abuse signals are denied. `off` and `observe`
retain the legacy door exactly, so shadow testing cannot accidentally open
registration. Initial owner creation always bypasses risk enforcement.

`SIGNUPS_PAUSED=true` is an emergency server-side stop for new member accounts; it never disables existing users or the initial owner account. `SIGNUP_AUDIT_KEY` enables keyed, non-reversible applicant correlation. Raw email addresses and IP addresses are not written to the risk audit table.

The owner-only `GET /api/admin/signup-risk` endpoint returns decision and signal
counts plus sanitized recent events. It deliberately omits event IDs and keyed
subject hashes so the operational view cannot reveal applicant identifiers.

## Decision policy

- Default to immediate access.
- Ask for step-up verification when evidence is ambiguous.
- Deny only strong, explainable automation or abuse signals.
- Never score protected personal traits, message content, contacts, or private profile data.
- Keep an appeal and account-recovery path before production enforcement.

## Remaining before 1.1

- Implement the verified-email step-up that the `verify` decision now reserves.
- Sign in with Apple and verified-email account linking.
- App Attest assertion at signup with simulator/TestFlight fallbacks.
- Render the owner audit summary and emergency signup pause in the Safety UI.
- Recovery and appeal flow.
- Shadow-mode telemetry review and false-positive thresholds.
- TestFlight validation on existing and newly created accounts.
