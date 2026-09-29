# OAuth connector setup

Create separate OAuth applications for each provider you want to enable. Use the exact public HTTPS Render URL; do not use wildcard callbacks.

## GitHub

Create an OAuth App and set its authorization callback URL to:

```text
https://YOUR-ORBIT.example/api/connectors/github/callback
```

Set the resulting client ID and secret as `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`.

## Google Calendar

Create a Web application OAuth client, configure the consent screen, and add:

```text
https://YOUR-ORBIT.example/api/connectors/google/callback
```

Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. Orbit asks for read-only Calendar access.

## Slack

Create a Slack app with the documented read scopes and redirect URL:

```text
https://YOUR-ORBIT.example/api/connectors/slack/callback
```

Set `SLACK_OAUTH_CLIENT_ID` and `SLACK_OAUTH_CLIENT_SECRET`.

## Shared encryption key

All enabled connectors require `CONNECTOR_ENCRYPTION_KEY`. Generate a base64-encoded 32-byte value:

```bash
openssl rand -base64 32
```

Changing this key does not automatically re-encrypt stored connector credentials. Disconnect connectors before a planned rotation, change the key, redeploy, then reconnect them.
