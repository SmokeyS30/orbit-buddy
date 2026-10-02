# Changelog

## Unreleased

- Added a registration door: signups are closed by default and the owner opens/closes them from Safety → Registration door.
- Added access requests: visitors facing a closed door can ask the owner for access; requests notify the owner by push and are rate-limited.
- Added a door-left-open nudge and a one-tap "open the door" push action (single-use expiring token) for access requests.

## 0.2.0

- Added multi-user accounts, secure cookie sessions, recovery codes, and invite-gated registration.
- Added per-user isolation for messages, memories, tasks, artifacts, events, connectors, notifications, and automation credentials.
- Added encrypted portable and daily server backups with non-destructive restore.
- Added standards-based Web Push and mobile installation guidance.
- Added read-only GitHub, Google Calendar, and Slack OAuth connectors with encrypted token storage.
- Added scoped phone automation tokens and a native SwiftUI iPhone companion foundation.
- Added owner emergency pause/resume controls.
- Added CodeQL, Dependabot, and expanded security/integration tests.

## 0.1.0

- Initial self-hosted PWA, explicit memory, scheduled background tasks, approval gates, audit events, Docker, and Render blueprint.
