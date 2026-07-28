# Changelog

## Unreleased

- Added crash-safe periodic table Rule evaluation with migration
  `007_rule_schedules.sql`, bounded page cursors, database-clock scheduling,
  owner/epoch fencing, failure backoff, and a public `RunRuleScheduler` runtime.
- Added append-only job/table integrity Rules with memory/PostgreSQL stores,
  draft/enable/disable lifecycle, Agent/Go APIs and migration `006_rules.sql`.
- Added PostgreSQL read-only Rule Explain and evaluation: statement timeout,
  hard row limit, canonical result-shape validation, plan-cost and sequential
  scan budgets, persisted query hash/evidence, and `rhinoq explain <rule-id>`.
- Connected Rule observations to persistent Findings: violations open or
  deduplicate drift, passing rechecks auto-resolve it with an append-only
  `passed` event, and table pages enforce a strict subject cursor.
- Added persistent memory and PostgreSQL finding stores, atomic observation
  deduplication, lifecycle transitions, append-only finding events, business
  subject filtering, public Go APIs and Agent HTTP endpoints.
- Added migration `005_findings.sql` with inbox and subject timeline indexes,
  plus transaction-scoped advisory locking so concurrent first observations
  fold into one finding instead of racing on the primary key.
- Reviewed the v2 strategy against current official competitor capabilities;
  kept RhinoQ as a PostgreSQL job queue while removing outdated claims that
  pg-boss lacks dashboards, workflows, priorities or rate limiting.
- Reframed v0.1 as an Integrity Slice: observe an existing execution system,
  verify one indexed business invariant, persist a finding, and support an
  audited operator lifecycle without requiring a queue cutover.
- Added a sourced competitive landscape covering BullMQ, pg-boss, Graphile
  Worker, PGMQ, DBOS, Hatchet, Restate, Temporal, Inngest and Trigger.dev.
- Narrowed external-effect claims to acknowledge durable execution,
  transactional steps and provider idempotency while preserving the explicit
  accepted/confirmed/outcome distinction.
- Added append-only attempt evidence for claim, release, completion, failure and
  lease expiry, exposed through the Go facade, Agent HTTP and TypeScript client.
- Made PostgreSQL job transitions and attempt evidence atomic, and made a
  terminal failed attempt atomically downgrade its pending effects to uncertain.
- Fixed PostgreSQL batch claim ordering, stale-effect fence precedence, SQL
  enqueue ambiguity and migration schema drift found by the real-database suite.
- Removed the legacy TypeScript state machine/store exports so the SDK remains
  a thin Agent client and correctness has one authoritative Go implementation.
- Added implementation-linked layer and runtime sequence diagrams.
- Added a real-PostgreSQL integration harness and CI service covering migrations,
  storage contracts, fencing, effect uncertainty, admission, recovery, and SQL
  enqueue behavior.
- Added the finding lifecycle domain model with deduplication, expiring
  suppression, operator transitions, and explicit regression after resolution.
- Added the initial layered architecture scaffold.
- Added AI project-memory and release-governance files under `.ai/`.
- Added contracts, job state transitions, effect confirmation policy, ports and `EnqueueJob`.
- Added durable global per-queue fixed-window rate limiting and bounded retry jitter.
- Added queue/state job counts and bounded paginated job inspection APIs.
- Fixed worker shutdown cancellation around claim and concurrency admission.
- Added a derived Needs Attention view for dead jobs, blocked execution, uncertain effects, and outcome mismatches.
- Added guarded dead/blocked replay with effect safety checks and transactional hash-chained audit.
- Added `lease_epoch` fencing: every claim advances the epoch, and heartbeat, complete, fail, release, begin effect and confirm effect all verify `(lease_owner, lease_epoch)` before writing.
- Added job priority with FIFO ordering inside a priority and priority aging against starvation.
- Added job resource classes and per-queue producer admission control with a reserved critical budget, reject and delay overflow modes, and a typed `RHINOQ_QUEUE_OVER_CAPACITY` error.
- Added poison-job protection: repeated worker crashes park a job as `blocked`/`poison_job` instead of handing it to the next worker.
- Rewrote the worker loop to keep execution slots busy: batch size follows free slots and a prefetch factor, a slow job no longer blocks its batch, and an idle worker backs off and wakes when a rate-limit window reopens.
- Added the six-step graceful shutdown, including handing back prefetched jobs with their attempt and never releasing a lease a handler may still hold.
- Made the PostgreSQL claim path batch its updates and use database time as the clock authority for `not_before`, lease expiry and retry scheduling.
- Made the heartbeat renew the lease, verify the fence and report cancellation in one round trip.
- Added five-part operator-facing error messages for over-capacity and lost-lease failures, and expanded `rhinoq doctor` with fencing, timing and `--ci` support.

- Added the Agent HTTP surface (`cmd/rhinoq-agent`): protocol handshake with compatible/degraded/rejected negotiation, enqueue, claim, heartbeat, complete, fail, release, effect begin/resolve, operator reads, replay and audit.
- Added the language-neutral error envelope with retry classes and a derived grouping fingerprint, so the same failure groups identically in every SDK.
- Added `/health/live` and `/health/ready` as separate endpoints and a dependency-free Prometheus `/metrics` exporter.
- Added the effect ledger to the public API: `job.Effect()` opens, runs and confirms a provider call under an explicit confirmation policy, skips work an earlier attempt already confirmed, and refuses to re-run an uncertain one.
- Added `rhinoq.NotHappened` so a call that provably never reached the provider stays retryable instead of becoming uncertain.
- Added the remote worker API (`ClaimJobs`, `Heartbeat`, `CompleteJob`, `FailJob`, `ReleaseJob`, `BeginEffect`, `ResolveEffect`) so a worker in any language runs on the same engine.
- Added `rhinoq.enqueue()` in migration `003_sql_enqueue.sql` with a job allowlist, per-role permission, payload size and schema checks, so any ORM can enqueue inside its own transaction.
- Added a single-file TypeScript Agent client as the reference for porting to other languages.
- The lease reaper now downgrades effects left open by dead executions to uncertain, bounded by lease epoch so a live execution's effect is untouched.
- Unclassified handler errors are now retried cautiously twice before being parked, instead of being blocked on the first failure.

### Breaking changes

- `rhinoq.Client.Enqueue` now takes a `JobRequest` instead of positional arguments.
- `ports.Lease` identifies an execution by owner and epoch; `ports.ClaimInput` requires an owner and `RenewLease` returns a `LeaseStatus`.
- `ports.FailureTransition` carries `RetryIn` instead of an absolute `NotBefore`.
- `EffectStore.BeginEffect` and the new `ConfirmEffect` require a lease; `SaveEffect` remains for RhinoQ-authored transitions.
- Migration `002_fencing_scheduling_admission.sql` must be applied; `lease_id` is left in place for a later contract migration.
- `EffectStore` gained `MarkPendingUncertain`; `RequeueExpired` returns the expired leases it swept.
- `EffectStore` gained `CheckLease`; `JobStore` gained `ListAttemptEvents`; and
  `FailureTransition` now carries a language-neutral failure class.
- `lease.NewReaper` takes a `lease.Config` instead of positional arguments.
