# Orbit Buddy

Orbit Buddy is a privacy-first, self-hostable AI companion that stays online, remembers what matters, checks in on its own, prepares background work, and remains usable from a desktop, iPhone, or Android device.

It is an original open-source project inspired by persistent assistants. It is **not** OpenAI Dots, is not affiliated with OpenAI, and does not copy OpenAI branding or proprietary implementation details.

## Why Orbit is different

Most AI apps wait for you to type. Orbit is built to do the opposite — it comes to you:

- **It follows up.** Mention an upcoming appointment, interview, trip, or deadline and Orbit notes the date, then checks in afterward to ask how it went — in chat and as a push notification.
- **It checks in first.** Morning briefings, evening wind-downs, and a gentle nudge if you've been quiet for a couple of days keep the conversation alive without you having to start it.
- **It's yours, privately.** Self-hostable and open source: your conversations live in your own SQLite database, encrypted backups stay under your passphrase, and nothing you say trains anyone's model. Your buddy, not their product.
- **It keeps your threads.** Separate conversations per topic, a name it actually calls you, and a steady-copilot personality — warm, unhurried, and quietly competent.

## What works in v0.5

- Responsive control center installable as a PWA on iPhone, Android, macOS, Windows, and Linux
- Multi-user accounts with salted `scrypt` password hashes, 30-day secure sessions, CSRF protection, and one-time recovery codes
- Authenticated chat through the OpenAI Responses API, with a clearly labeled demo mode when no API key is configured
- Persistent SQLite messages, typed user-approved memories, goals with user-controlled progress, scheduled follow-ups, timezone-aware routines, tasks, generated artifacts, and audit events
- Immediate, scheduled, daily, and weekly background thinking tasks that continue on the server after the browser closes
- Approval-based intelligence: Orbit can propose inferred memories for review and retrieve the most relevant approved memories for each conversation
- Automatic follow-ups: Orbit can schedule and prioritize dated check-ins from chat, while keeping them visible and removable in Memory
- Goals and routines: create measurable goals, record progress, and schedule daily or weekly briefings, reflections, and custom check-ins from the Goals tab
- Multi-step projects with priorities, target dates, resumable steps, and progress that changes only when the user reports or confirms it
- A unified Approvals tab for reviewing external task plans and calendar proposals before anything is produced
- Calendar-event proposals that become downloadable `.ics` files after approval, without giving Orbit calendar write access
- A seven-day Reliability view for model health, chat and background-work success, pending approvals, and recent safe failures
- Grounded daily briefings that combine the upcoming agenda, active goals, pending tasks, and due follow-ups into a short set of priorities
- Respectful proactivity: follow-ups, routines, and quiet nudges share a three-message daily limit and honor timezone, quiet hours, and opt-out settings
- Push notifications through standards-based Web Push
- Read-only iCal feeds for Google, Apple, Outlook, and other calendars; feed URLs are encrypted at rest when `DATA_ENCRYPTION_KEY` is configured
- Model tools in chat: live web search, page reading, current date/time, calendar reading, task creation, project and goal tracking, routine management, approval-gated calendar proposals, approved memory saving, memory proposals, and scheduled follow-ups
- Model connection diagnostics with an automatic Luna fallback when a configured model such as Astra is unavailable to the OpenAI project
- Encrypted downloadable backups, daily encrypted server backups, seven-backup retention, and non-destructive restore
- Owner-only emergency pause that stops new AI work and connector access without deleting data
- A native iPhone companion source project in `ios/OrbitCompanion`
- Docker, Render, CI, CodeQL, and Dependabot configuration

Orbit does not provide arbitrary remote shell access, silently send messages, make purchases, or take high-impact actions. External tasks stop at an approval gate and currently produce a plan or draft. That boundary is deliberate.

## Quick start

Requires Node.js 24 or newer.

```bash
git clone https://github.com/SmokeyS30/orbit-buddy.git
cd orbit-buddy
cp .env.example .env
npm ci
npm start
```

Open `http://127.0.0.1:3000`. The first person to register becomes the owner and receives ten one-time recovery codes. Save those codes outside Orbit. Later registrations stay closed unless the owner opens the door from Safety → Registration door. Visitors facing a closed door can send an access request from the signup screen instead. The owner is nudged if the door stays open over an hour, and access-request push notifications carry a one-tap button to open the door.

`OPENAI_API_KEY` is optional. Without it, Orbit works in demo mode and never pretends a model request ran. The primary model is configurable with `OPENAI_MODEL`; the default is `gpt-6-luna`. `OPENAI_FALLBACK_MODELS` accepts a comma-separated compatibility chain; the Render default covers Luna, GPT-5.4 mini, GPT-4.1 mini, and GPT-4o mini. Orbit checks the project's model list without generating tokens, then selects the first available model. Authentication, quota, and billing failures are shown as connection errors and are not retried against another model.

To request Astra, set `OPENAI_MODEL=gpt-6-astra` (the shorthand `astra` is also normalized). Astra access is project-dependent. If that project cannot use Astra, Orbit continues with an available fallback and displays the exact failure class in Safety instead of failing the conversation. Use **Safety → AI model connection → Check connection** to re-run the no-token diagnostic after changing Render settings.

## Deploy on Render

The included blueprint creates a Docker web service with a 1 GB persistent disk. The disk is required for durable accounts, tasks, and backups and normally requires a paid Render instance.

[Deploy to Render](https://render.com/deploy?repo=https://github.com/SmokeyS30/orbit-buddy)

During setup, provide `OPENAI_API_KEY` for real AI responses. Orbit generates and preserves a Web Push signing key pair on its protected persistent disk. The blueprint also generates `DATA_ENCRYPTION_KEY` so private calendar feed URLs are encrypted in SQLite.

After the first deployment:

1. Open the Render URL and create the owner account.
2. Store the recovery codes in a password manager or offline safe.
3. Install Orbit from Safari's **Share → Add to Home Screen** on iPhone, or Chrome's **Install app** on Android.
4. Enable notifications from Orbit's Safety tab.
5. Export an encrypted backup and verify that you can retain its passphrase separately.

Never put API keys, OAuth secrets, recovery codes, or backup passphrases in GitHub, screenshots, or issues.


## Calendar connections

Orbit v0.5 uses read-only iCal subscription URLs instead of OAuth. Add a calendar from the Connections tab; Orbit masks the URL in API responses and encrypts it at rest when `DATA_ENCRYPTION_KEY` is set. Treat iCal URLs like passwords because anyone holding one may be able to read that calendar. Orbit can propose events, but approval only produces an `.ics` file for you to import; it cannot silently write to a calendar. OAuth providers are intentionally disabled in this release; [docs/OAUTH.md](docs/OAUTH.md) records that boundary.

## Backups and recovery

- **Account recovery:** one-time recovery codes reset the password and revoke active sessions.
- **Portable backup:** the user supplies a 16+ character passphrase; the browser downloads an authenticated AES-256-GCM archive.
- **Automatic backup:** when `BACKUP_ENCRYPTION_KEY` is set, Orbit writes one encrypted backup per user per day to the persistent disk and retains seven.
- **Restore:** data is merged without deleting existing records, then Orbit remains paused for review.

The Render disk is not an off-site backup. Download portable backups to a separate protected location.

## Architecture

```text
Installed PWA / native iPhone companion
                      │ HTTPS + session
                      ▼
               Node service on Render
                  │      │       │
                  │      │       └── Web Push
                  │      └────────── Calendar providers (read-only iCal)
                  ├───────────────── OpenAI Responses API (optional, store=false)
                  └───────────────── SQLite + encrypted backup files
```

## Development

```bash
npm run check
npm audit
npm run dev
```

See [SECURITY.md](SECURITY.md) before adding any connector or tool. Contributions are welcome under the [Apache-2.0 license](LICENSE).

## Honest platform limits

- Render keeps server work running when the phone or computer is closed, subject to the selected Render service's availability.
- The installed PWA is the production mobile client. iPhone Web Push requires an installed Home Screen web app and a supported iOS version.
- The native iPhone project is a companion foundation for login, status, task creation, and emergency controls. It still requires an Apple developer team and a real-device archive before TestFlight or App Store distribution.
- Orbit cannot run arbitrary work directly on an iPhone or control a Mac. A future local device agent must be separately installed and explicitly constrained to approved folders and capabilities.

The goal is not unlimited autonomy. The goal is a dependable buddy whose access is understandable, reviewable, backed up, and easy to revoke.
