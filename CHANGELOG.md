# Changelog

## Unreleased

- Added Memory connections + emotional-intelligence layer: Orbit now spots recurring themes across memories and surfaces genuine insights — "third Thursday in a row you've been wiped after class" — with confidence that grows with occurrences. Two memories on a theme is "I'm starting to notice…"; three or more is "This keeps coming up…"; a single data point is never presented as a pattern. A per-message emotional-tone read (stressed, frustrated, excited, sad, burnt out, anxious, celebratory) is tracked per user over time, so emotional runs surface too ("You've seemed drained the last three evenings"), and the adaptive soul's context detection is emotionally grounded by it. Honesty is load-bearing and stated in code, prompts, and these notes: Orbit MODELS emotions — it does not feel them. "Are you sad?" gets an honest no; it never performs distress or claims a feeling. Surfacing reuses the proactive-memory infrastructure (the memory_surfacing table, the shared 3/day proactive cap, quiet hours, deliverProactive to web/app + WhatsApp; at most one aside per chat turn, never mid-task, never repeated inside its cooldown, established patterns only for background pushes, emerging ones as chat asides only). Uncomfortable patterns go through the honest-soul kindness pattern: observation + why it matters + one constructive path, never judgment. Demo mode: no pattern surfacing, no emotional tracking. No new DB tables (additive touchMemorySurfacing helper only); per-user isolated; works on web/app and WhatsApp (shared runChatReplyJob pipeline).

- Added Proactive memory: Orbit now volunteers relevant memories at the right moment instead of waiting to be asked. Upcoming dates embedded in memories ("Mom's birthday is October 23", "dentist appointment on 2026-10-23") trigger a gentle heads-up; open loops ("want to try that Thai place") surface as a natural aside when the conversation turns topical. Two graceful paths: at most one volunteered memory per chat turn (a prompt hint the model may weave in or skip silently — never mid-task, when the turn used tools), and a background push through the existing proactive pipeline (quiet hours, the shared 3/day proactive cap via claimProactiveSlot, deliverProactive to web/app + WhatsApp; max one proactive memory push per user per day). Relevance-gated: only high-confidence, non-decayed memories surface, and every surfacing is recorded per occurrence so nothing repeats ("why are you telling me this?" gets an exact chat-native answer naming the memory, when it was saved, and why it was timely). No repeats across either path; personal-dates rows already covered by the briefing are not double-nudged. Demo mode: fully off. Additive DB table (memory_surfacing) on SQLite, the Postgres self-migration array, and postgres-schema.sql; per-user isolated.

- Added Soul core: a versioned personality record per user (name, warmth/directness/playfulness/formality axes, stylistic will/won't commitments — personality only, never personal facts). Renders as a system-prompt layer for chat on web/app and WhatsApp alike (prompt-only, no new infra, no extra API calls); stays separate from "Writes like you" (voice = how he writes, soul = how Orbit is — they compose). Tunable in chat: "be more playful", "stop being so formal", "be more direct with me" take effect immediately and are shown back; full append-only edit history with "go back to how you were" one-step revert and "soul history" listing. Demo users get a neutral default soul (not tunable); an owner's tuned soul never leaks to demo users or non-owners. Additive DB tables (soul_records, soul_history) on SQLite, the Postgres self-migration array, and postgres-schema.sql.

- Added Goals/Projects v2 visuals: goal cards now show an SVG progress ring (percentage in the center, ring colored lime/violet/coral for on-track/at-risk/overdue by target date) with an accessible aria-label, and the Projects section gained a quiet List | Kanban | Timeline view toggle (persisted per device in localStorage, defaulting to List). Kanban groups steps into four status columns and the timeline shows dated steps in ascending order with an unscheduled lane; both reuse the existing per-step action buttons, and both views work on desktop and mobile. Pure client-side rendering of existing snapshot data — no server changes.

- Added X6 "Project radar": ambient, read-only awareness of the user's GitHub repos. Polls at most every 30 minutes (hooks into the existing proactive loop, no new timer) for failed Actions runs on the default branch, new Dependabot/security alerts, and merged PRs; ranks findings (failed CI on main = high, merged PR = low, routine pushes ignored), dedupes so nothing is ever surfaced twice, and delivers high-signal findings as check-ins (max 1 radar check-in/day, inside the shared proactive budget) with quieter ones as a new Project radar card in the Today-tab briefing (same responsive card on desktop and iOS). Per-repo "mute radar for <repo>" / "unmute radar for <repo>" chat commands plus a "radar status" view, persisted per user. Read-only by contract: only HTTP GETs to the GitHub API, token from GITHUB_RADAR_TOKEN (never logged); repo list auto-discovered from recent pushes or overridden via RADAR_REPOS. Additive DB tables (radar_findings, radar_deliveries, radar_mutes) on SQLite and Postgres.

- Added "Writes like you" personal writing voice: explicit opt-in via chat ("learn how I write") or the new Safety panel, learns a compact style profile from up to 30 recent sent emails (full bodies never stored), injects it as a drafting-only style instruction when Orbit drafts emails/messages/copy, and deletes profile + opt-in immediately on "forget how I write". Includes a Safety toggle to turn the voice off without deleting, per-user additive DB columns, and `/api/writing-voice` endpoints (the profile text never leaves the server).

- Added image attachments in chat: the composer attach button (file picker incl. iPhone camera roll, clipboard paste, drag-and-drop) uploads to a new authed POST /api/chat/attachments endpoint, shows a thumbnail preview, and sends the image through a shared vision pipeline with a text placeholder in history (bytes never persisted or logged).
- WhatsApp inbound photos now run through the same vision pipeline (Twilio MediaUrl0 download, first image only); the configured chat model is tried first with a one-time sol fallback if the model rejects image input.
- Published production images with GitHub's short-lived repository token instead of a stored GHCR personal access token.
- Added a scheduled public health monitor covering PostgreSQL readiness and durable encrypted-backup freshness.
- Reported a safe backup state from `/healthz` while keeping detailed backup diagnostics owner-only.
- Aligned Azure documentation and probe thresholds with the PostgreSQL production deployment.

## 0.6.0

- Gated every Azure production deployment on the full test suite and a production dependency audit, with serialized deployments.
- Moved Gmail send and move-to-trash actions behind atomic server-side approvals and added clear review details in the Approvals UI.
- Reduced the Azure SQLite recovery-point window and added 168 retained versioned snapshots plus a forced graceful-shutdown snapshot.
- Updated production, connector, backup, and security documentation to match the active Azure deployment.
- Fixed stale tool-definition assertions after the Gmail delete tool was added.
- Updated the Capacitor toolchain's transitive UUID dependency to clear its moderate security advisory.

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
