# OAuth connector status

Gmail OAuth is active in production. Orbit requests Gmail read, send, and modify scopes so it can search/read mail and perform two narrowly defined writes: send a reviewed draft or move a reviewed message to trash. Those writes create server-side approval records and do not execute from the model tool call itself. Access and refresh tokens are encrypted with the stable `DATA_ENCRYPTION_KEY`.

Calendar awareness remains available through read-only iCal subscription URLs in the Connections tab. Orbit does not request calendar write access; approved calendar proposals produce downloadable `.ics` files.

GitHub and Slack provider definitions are not configured or advertised in the Azure production deployment. Do not enable another provider by changing documentation or environment variables alone. It needs least-privilege scopes, revocation behavior, integration tests, approval handling for every write, and updated threat modeling before it is advertised.
