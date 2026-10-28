# Server chat timing diagnostics

Orbit records anonymous timing numbers after each completed chat turn. The
owner-only `GET /api/admin/chat-latency` endpoint reports the last hour (up to
2,000 recent turns) with p50, p95 and p99 for queue wait, selected conversation
and model-context database reads, context preparation, model first token, model
completion, and total reply completion. It also reports reply failures and
chitchat model fallbacks. Missing first-token measurements are excluded when a
model returns without streaming.

The recorder keeps only numbers and two boolean flags in memory. It does not
store or log message text, identifiers, model error messages, or per-user
records. A process restart clears the window. Each replica has its own window;
the owner endpoint and public alert state describe the replica that answered
the request. Azure logs receive aggregate snapshots every 15 minutes only
when at least 20 turns are present.

The public `/healthz` endpoint exposes only `chatPerformance.state` and
`windowMinutes`. The existing Production Monitor workflow fails when that
state is `degraded`. To avoid alerts from tiny samples, thresholds apply after
20 turns in the window: p95 queue wait over 30 seconds, p95 model first token
over 90 seconds, p95 total completion over 180 seconds, or at least five failed
turns and a failure rate of at least 20%. An `insufficient` state means fewer
than 20 turns were measured on that replica.
