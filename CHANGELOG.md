# Changelog

## Unreleased

## 0.6.0

- Gated every Azure production deployment on the full test suite and a production dependency audit, with serialized deployments.
- Moved Gmail send and move-to-trash actions behind atomic server-side approvals and added clear review details in the Approvals UI.
- Reduced the Azure SQLite recovery-point window and added 168 retained versioned snapshots plus a forced graceful-shutdown snapshot.
- Updated production, connector, backup, and security documentation to match the active Azure deployment.
- Fixed stale tool-definition assertions after the Gmail delete tool was added.

## 0.5.1

- Fixed quiet-hour time fields overlapping on narrow Safety layouts.
- Kept unsaved Time & check-ins edits from being overwritten by automatic refreshes.

## 0.5.0

- Fixed stale installed-app JavaScript hiding newly deployed Safety controls.
- Made direct Safety links activate the correct view on startup.
- Made the model check a permanent Safety control and reload open app windows after an app-shell update.
- Fixed streamed Astra replies being discarded when the API used CRLF framing or returned an empty stream, with an automatic non-streaming retry.
- Added resumable multi-step projects with user-controlled progress.
- Added a unified approval center for external task plans and calendar-event proposals.
- Added approval-generated `.ics` files without granting Orbit calendar write access.
- Added a seven-day reliability dashboard for model health, chat success, background work, approvals, and safe failures.

## 0.4.1

- Added a no-token OpenAI key and model-availability check that runs at startup and on demand from Safety.
- Added model-name aliases and a compatibility fallback chain through Luna, GPT-5.4 mini, GPT-4.1 mini, and GPT-4o mini for projects without Astra access.
- Set Astra as the primary model for the Render deployment while preserving compatibility fallbacks.
- Replaced the generic model failure response with actionable authentication, quota, access, network, and service diagnostics.

## 0.4.0

- Added measurable goals with progress history, next actions, target dates, and explicit user control over progress updates.
- Added timezone-aware daily and weekly briefings, reflections, and custom routines.
- Added grounded daily briefings based on the user's agenda, active goals, tasks, and due follow-ups.
- Added priority ordering and a shared three-message daily limit for proactive follow-ups, routines, and quiet nudges.
- Added model connection diagnostics and an automatic Luna fallback when a configured model such as Astra is unavailable to the OpenAI project.
- Added safe retry cooldowns for failed proactive work and expanded encrypted backup support for goals and routines.

## 0.3.0

- Added typed, relevance-ranked memory and approval-required memory suggestions.
- Added structured, visible follow-ups and user-controlled timezone, quiet hours, and proactive check-in preferences.
- Added conversation summaries for long-running threads and crash-safe task leases with recovery.
- Added encryption at rest for iCal feed URLs through `DATA_ENCRYPTION_KEY`.
- Corrected product copy and documentation to reflect that OAuth providers are disabled and external tasks create plans or drafts only.
- Added a registration door: signups are closed by default and the owner opens/closes them from Safety → Registration door.
- Added access requests: visitors facing a closed door can ask the owner for access; requests notify the owner by push and are rate-limited.
- Added a door-left-open nudge and a one-tap "open the door" push action (single-use expiring token) for access requests.
- Added read-only chat tools (web_search, fetch_url, get_datetime) with SSRF protection; tool use is logged to the activity timeline.
- web_search now prefers the Brave Search API when BRAVE_SEARCH_API_KEY is set (sync: false in render.yaml), falling back to the free DuckDuckGo backend otherwise.

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
