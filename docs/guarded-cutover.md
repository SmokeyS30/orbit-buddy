# Guarded server cutover

This procedure applies to the one-time transition from the unguarded server to
the reviewed task and OAuth worker changes. It does not authorize a full app
outage. The first guard release and the final feature release must be reviewed
and merged separately. A push to `main` automatically builds the image and
deploys it **held**. It never opens background task/proactive work or connector
begin, disconnect, callback, or token refresh work automatically.

1. Record the current main SHA and healthy Azure revision. Merge the guard
   release through the protected route after independent review. Its existing
   Azure OIDC workflow atomically sets the new image and the nonsecret
   `ORBIT_CUTOVER_HOLD=true` value. Verify exact image/SHA, `cutoverHold:true`
   on `/readyz` and `/healthz`, ordinary HTTP availability, and that every
   predecessor revision is inactive with **zero replicas in two observations**.
   Record this guard bootstrap SHA and revision. Only now is the narrow pause
   established. Chat and unrelated HTTP routes remain available.
2. Rebase and review the corrected task/media/OAuth release on that exact main.
   Its main-push workflow deploys another held revision. Verify its exact SHA,
   closed flag, public health, and that every predecessor, including the
   bootstrap guard revision, is inactive with zero replicas twice. Do not use
   queue emptiness or traffic percentage as a substitute for replica drain.
3. After independent final review, manually dispatch `Open verified held
   cutover` on `main` with the exact target `release_sha` and the recorded
   `guard_bootstrap_sha`. The workflow requires the checked-out main SHA to
   match, verifies the target is already held, checks all prior revisions and
   replicas, then creates a new revision of the **same image** with
   `ORBIT_CUTOVER_HOLD=false`. It verifies public SHA and open flag and waits
   until the held predecessor has no replicas. Report the completed revision
   and time when tasks/connectors are available again.

If the initial guard image never becomes healthy, the prior unguarded app may
remain active. The script **does not** call that a safe pause and does not
automatically roll back to an unguarded image. Stop the rollout and report the
observed image, revision, and hold state. Once a positively verified held
predecessor exists, failure may roll back only to a held image. Unknown Azure
state, failed replica queries, public health errors, unexpected revisions, and
incomplete rollback verification stop the workflow. Do not manually retry a
timed-out mutation without first reconciling actual Azure state.

Do not cancel the opening workflow after its Azure update starts. SIGINT and
SIGTERM trigger a best-effort held rollback, but a hard runner kill, loss of
Azure access, or delayed Azure operation can prevent proof that the hold was
restored. In that case, treat task/connector state as **unknown**, do not
claim the app is safely held or fully reopened, and obtain explicit operator
review before another mutation. Already-started provider effects cannot be
recalled. The workflow cannot guarantee that an unguarded old revision stops
if the first guarded revision never becomes ready without taking the entire
service offline, which this cutover does not do.

For planning, recent successful releases took roughly 3–4 minutes each.
Three revision transitions suggest a 10–20 minute successful pause; this is
an estimate, not an SLA. A failed transition can exceed it. Individual guarded
scripts abort after 20 minutes; workflow job limits are 45 minutes to leave
room for reporting and best-effort rollback. These limits do not make an
uncertain Azure mutation safe or guarantee recovery within the window.
