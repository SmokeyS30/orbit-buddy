# Orbit Buddy

Orbit Buddy is a privacy-first, self-hostable AI companion that keeps context, prepares background work, remembers only what you explicitly save, and works from a desktop or phone browser.

It is an original open-source project inspired by the category of persistent assistants. It is **not** OpenAI Dots, is not affiliated with OpenAI, and does not copy OpenAI branding or proprietary implementation details.

## What works in v0.1

- Responsive control center installable as a PWA on macOS, iPhone, Android, Windows, and Linux
- Authenticated chat through the OpenAI Responses API
- Useful demo mode when no API key is configured
- Persistent SQLite conversation history, user-approved memory, tasks, results, and audit events
- Immediate, scheduled, daily, and weekly background thinking tasks
- Explicit approval gate for tasks marked as external
- Server-side API credentials, strict browser security headers, rate limiting, request-size limits, and constant-time token comparison
- Docker and Render deployment files
- Zero runtime npm dependencies

Orbit v0.1 does **not** control a computer, send messages, make purchases, or access connected apps. External tasks produce a plan or draft even after approval. This limit is intentional while the connector permission model is developed.

## Quick start

Requires Node.js 24 or newer.

```bash
git clone https://github.com/SmokeyS30/orbit-buddy.git
cd orbit-buddy
cp .env.example .env
```

Load the environment values with your preferred secret manager, then run:

```bash
npm start
```

Open `http://127.0.0.1:3000` and enter `BUDDY_ACCESS_TOKEN`.

At minimum, use a unique access token containing 24 or more characters. `OPENAI_API_KEY` is optional; without it Orbit clearly identifies demo mode. The default model is `gpt-5.4-mini`, and you can select another Responses API model with `OPENAI_MODEL`.

## Deploy on Render

The included `render.yaml` creates a Docker web service, a generated access token, and a 1 GB persistent disk. Render's persistent disk requires a paid instance; removing the disk makes data ephemeral and is not recommended for a real buddy.

[Deploy to Render](https://render.com/deploy?repo=https://github.com/SmokeyS30/orbit-buddy)

After deployment:

1. Add `OPENAI_API_KEY` in Render's Environment page.
2. Copy the generated `BUDDY_ACCESS_TOKEN` into a password manager.
3. Open the service URL and unlock Orbit with that token.
4. On iPhone, use Safari's **Share → Add to Home Screen**.

Never put either secret in GitHub, screenshots, issues, or client-side JavaScript.

## How it differs from OpenAI Dots

OpenAI describes Dots as managed, always-on agents with cloud computers, connected apps, proactive memory, messaging channels, and optional local-computer access. Orbit's first release focuses on the open, inspectable foundation: self-hosting, explicit memory, scheduling, approval boundaries, and an audit log. It deliberately omits broad computer and app access until those capabilities can be added with narrowly scoped connectors.

## Architecture

```text
Browser / installed PWA
        │ bearer token
        ▼
Node HTTP service ─────► OpenAI Responses API (optional, store=false)
        │
        ├── SQLite: chat, tasks, explicit memory
        ├── background task scheduler
        └── human-readable audit trail
```

## Development

```bash
npm test
npm run check
npm run dev
```

See [SECURITY.md](SECURITY.md) before adding any connector or tool. Contributions are welcome under the [Apache-2.0 license](LICENSE).

## Roadmap

- Encrypted multi-user accounts and passkeys
- Push notifications and timezone-aware scheduling
- Optional local model providers
- Connector SDK with capability manifests, least-privilege OAuth, dry runs, and revocation
- End-to-end encrypted backups
- Voice input and accessible audio updates
- Signed plugin bundles and a public connector registry

The goal is not “unlimited autonomy.” The goal is a dependable buddy whose access is understandable, reviewable, and easy to revoke.
