# Orbit Buddy

Orbit Buddy is a privacy-first, self-hostable AI companion that stays online, remembers what matters, checks in on its own, prepares background work, and remains usable from a desktop, iPhone, or Android device.

It is an original open-source project inspired by persistent assistants. It is **not** OpenAI Dots, is not affiliated with OpenAI, and does not copy OpenAI branding or proprietary implementation details.

## Why Orbit is different

Most AI apps wait for you to type. Orbit is built to do the opposite — it comes to you:

- **It follows up.** Mention an upcoming appointment, interview, trip, or deadline and Orbit notes the date, then checks in afterward to ask how it went — in chat and as a push notification.
- **It checks in first.** Morning briefings, evening wind-downs, and a gentle nudge if you've been quiet for a couple of days keep the conversation alive without you having to start it.
- **It's yours, privately.** Self-hostable and open source: your conversations live in your own SQLite database, encrypted backups stay under your passphrase, and nothing you say trains anyone's model. Your buddy, not their product.
- **It keeps your threads.** Separate conversations per topic, a name it actually calls you, and a steady-copilot personality — warm, unhurried, and quietly competent.

## What works in v0.2

- Responsive control center installable as a PWA on iPhone, Android, macOS, Windows, and Linux
- Multi-user accounts with salted `scrypt` password hashes, 30-day secure sessions, CSRF protection, and one-time recovery codes
- Authenticated chat through the OpenAI Responses API, with a clearly labeled demo mode when no API key is configured
- Persistent SQLite messages, explicit memories, scheduled tasks, generated artifacts, connections, and audit events
- Immediate, scheduled, daily, and weekly background thinking tasks that continue on the server after the browser closes
- Automatic follow-ups: Orbit notices dated events you mention in chat and checks in afterward, unprompted
- Quiet check-ins: a proactive nudge if you haven't chatted in a couple of days
- Push notifications through standards-based Web Push
- Read-only OAuth previews for GitHub repositories, Google Calendar events, and Slack channels
- Scoped automation tokens for Apple Shortcuts, Android automation tools, and personal integrations
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

Open `http://127.0.0.1:3000`. The first person to register becomes the owner and receives ten one-time recovery codes. Save those codes outside Orbit. Registration closes after the owner account is created unless `OPEN_REGISTRATION=true`; the included Render blueprint enables it so people can create accounts without an invite code. Set it to `false` at any time to stop new registrations without affecting existing users.

`OPENAI_API_KEY` is optional. Without it, Orbit works in demo mode and never pretends a model request ran. The default model is configurable with `OPENAI_MODEL`.

## Deploy on Render

The included blueprint creates a Docker web service with a 1 GB persistent disk. The disk is required for durable accounts, tasks, and backups and normally requires a paid Render instance.

[Deploy to Render](https://render.com/deploy?repo=https://github.com/SmokeyS30/orbit-buddy)

During setup, provide `OPENAI_API_KEY` for real AI responses. Orbit generates and preserves a Web Push signing key pair on its protected persistent disk. OAuth connectors require provider-specific client credentials added later in Render. Unconfigured connectors stay visibly disabled.

After the first deployment:

1. Open the Render URL and create the owner account.
2. Store the recovery codes in a password manager or offline safe.
3. Install Orbit from Safari's **Share → Add to Home Screen** on iPhone, or Chrome's **Install app** on Android.
4. Enable notifications from Orbit's Safety tab.
5. Export an encrypted backup and verify that you can retain its passphrase separately.

Never put API keys, OAuth secrets, recovery codes, backup passphrases, or automation tokens in GitHub, screenshots, or issues.

## Phone automation

Orbit can create a limited token that only permits internal thinking tasks. In **Connections → Phone automation**, create a token and copy it once. A Shortcut can then make this request:

```http
POST https://YOUR-ORBIT.example/api/automation/tasks
Authorization: Bearer orbit_YOUR_TOKEN
Content-Type: application/json

{"title":"Phone note","prompt":"Turn this note into a checklist"}
```

Requests through this endpoint are forced to `internal` risk. They cannot use the token to access memories, files, connectors, account controls, or emergency controls.

## OAuth connectors

Orbit currently asks only for read-oriented scopes:

- GitHub: profile and email, then a preview of the user's repositories
- Google: identity plus read-only Calendar access
- Slack: read channel metadata and basic user information

Tokens are encrypted before entering SQLite. Each connector can be disconnected from the UI. Configure the provider callback as:

```text
https://YOUR-ORBIT.example/api/connectors/PROVIDER/callback
```

where `PROVIDER` is `github`, `google`, or `slack`. See [docs/OAUTH.md](docs/OAUTH.md) for provider-specific setup.

## Backups and recovery

- **Account recovery:** one-time recovery codes reset the password and revoke active sessions.
- **Portable backup:** the user supplies a 16+ character passphrase; the browser downloads an authenticated AES-256-GCM archive.
- **Automatic backup:** when `BACKUP_ENCRYPTION_KEY` is set, Orbit writes one encrypted backup per user per day to the persistent disk and retains seven.
- **Restore:** data is merged without deleting existing records, then Orbit remains paused for review.

The Render disk is not an off-site backup. Download portable backups to a separate protected location.

## Architecture

```text
Installed PWA / native iPhone companion / Shortcut
                      │ HTTPS + session or scoped token
                      ▼
               Node service on Render
                  │      │       │
                  │      │       └── Web Push
                  │      └────────── OAuth providers (read-only previews)
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
