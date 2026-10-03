# OAuth connector status

OAuth providers are disabled in Orbit Buddy v0.5. The interface and documentation do not claim GitHub, Google, or Slack OAuth support.

Calendar awareness is available through read-only iCal subscription URLs in the Connections tab. Set `DATA_ENCRYPTION_KEY` to a stable, randomly generated secret so those URLs are encrypted at rest. The Render blueprint generates this value automatically.

Do not add an OAuth provider by changing documentation or environment variables alone. A future provider needs a reviewed implementation, least-privilege scopes, revocation behavior, integration tests, and updated threat modeling before it is advertised.
