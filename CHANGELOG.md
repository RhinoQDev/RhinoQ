# Changelog

## Unreleased

- **Breaking (`@rhinoq/node`):** `BullMQTaskBridge` now requires
  `terminalProjection`; there is no default. Only the application knows whether
  one BullMQ job is the whole user-facing Task, and the previous
  `single-execution` default drove a fan-out batch to a terminal `succeeded` on
  its first finished item — silently, and irreversibly, because terminal Task
  states are never reopened. Migration: pass `'single-execution'` to keep the
  old behavior, or `'execution-only'` for fan-out. TypeScript callers get a
  compile error; JavaScript callers get a `TypeError` at construction instead
  of a wrong terminal state at the first completed job.

- Added per-attempt outcome, requiring PostgreSQL schema **017** (additive).
  A Task holds one aggregate result reference; a fan-out now records one per
  item, so an application no longer has to keep a parallel per-item store to
  answer "where did item 37 land" and "why did item 38 fail". `Execution` gains
  `resultRef` (`POST /v1/task-executions/{id}/result`) and `failureReason`
  (`POST /v1/task-executions/{id}/state` with
  `{"state":"failed","reason":"..."}`), bounded and truncated on rune
  boundaries because it travels with every poll. `TaskSnapshot` exposes only
  `hasResult` and `failureReason` per execution — never the reference itself,
  matching the existing rule that polling must not repeatedly ship a storage
  location. Read references through the owner-scoped
  `GET /v1/tasks/{id}/execution-results`. The BullMQ bridge maps
  `resultReference` onto the Execution that produced it and adds a
  `failureReason` hook defaulting to BullMQ's `failedReason`; previously
  `resultReference` was ignored entirely in `execution-only` mode.

- Fixed duplicate lifecycle commands consuming an entity version. A progress
  write carrying the value already stored, and a cancellation request on a Task
  already in `cancel_requested`, now return `200` with the current snapshot,
  leave `entityVersion` unchanged and do not touch the store. Neither is fenced:
  a write that changes nothing cannot lose an update, so a stale
  `expectedVersion` is accepted for these two commands only. Queues re-deliver
  events on reconnect, so version churn here pushed an identical snapshot to
  every `watchTask()` client and turned duplicates into
  `RHINOQ_VERSION_CONFLICT` for writers that were genuinely current. The rule
  lives in the Task domain; the previous read-then-skip guard in the Gateway
  cancel handler was removed because it raced concurrent writers.

- Reduced round trips on the Task write path. Commands render their snapshot
  from the row the store just fenced instead of re-reading the Task, which also
  stops a command from being answered with a version some concurrent writer
  produced. Task creation no longer re-reads at all. In the BullMQ bridge a
  progress event costs 4 Gateway calls instead of 6, or 3 when the value is
  unchanged; completed and failed events drop one lookup each.

- `@rhinoq/node` now ships a CommonJS entry point alongside ESM, so a NestJS
  application — still CommonJS by default — can `require('@rhinoq/node')` in a
  constructor instead of routing every touch point through `await import()`.
  Verified from a clean install of the packed tarball in both module systems.

- The Gateway's Task surface no longer returns operator remediation to end-user
  credentials. A `401` on an owner-scoped Task route keeps the
  `RHINOQ_UNAUTHORIZED` code but drops the `RHINOQ_AGENT_TOKEN` environment
  variable and the `curl` health check that the deployer-facing message carries.

- Fixed four contracts exposed by the real BullMQ adopter probe. Task snapshots
  now return `ownerId` so the application can authorize without a parallel
  Task-owner table (the Agent bearer remains an operator credential, not
  tenant auth). Core progress rejects completed-count regression and changes to
  an already-known total. Cancellation has an orthogonal, persisted outcome, so
  a Task that succeeds after a cancel request reports `too_late` instead of
  looking like no cancellation happened. The BullMQ bridge adds explicit
  `execution-only` terminal projection for fan-out workloads, preventing the
  first completed item from completing the aggregate Task. The Gateway also
  separates optional owner-scoped Task credentials from its privileged
  operator/runtime token. Owner credentials can read matching Tasks/results
  and request cancellation, receive non-enumerating `404` responses across
  owners, and cannot call queue/operator APIs or arbitrary lifecycle
  transitions. Organization membership and RBAC remain out of scope.

- Added a shared Task wire-contract golden fixture consumed by both Go and
  Node tests. `TaskSnapshot` and `TaskResult` v1 field names, nesting,
  timestamps and execution summaries now fail CI when one language drifts
  without an explicit contract/version update.

- Fixed the PostgreSQL Finding suppression contract fixture to use the database
  clock instead of a calendar date that eventually expired. Added regression
  coverage proving active suppression stays hidden and expired suppression
  returns to the default inbox. GitHub CI now runs Go and PostgreSQL tests
  uncached and shuffled to expose order/time coupling, with a weekly scheduled
  run to catch calendar-sensitive regressions while the repository is idle.

- Prepared `@rhinoq/node@0.1.0-beta.2`. The BullMQ lifecycle bridge now
  re-reads and retries a bounded number of times after a Gateway optimistic
  version conflict, so a concurrent Task mutation does not silently drop an
  observed queue lifecycle/progress/result update. It still does not override
  a terminal Task state or add BullMQ dispatch, cancellation or retry support.
  The SDK also adds `watchTask()`, a framework-neutral async iterator with
  non-overlapping polls, monotonic Snapshot delivery, terminal stop and
  `AbortSignal` cancellation.

- Added a fail-closed per-job BullMQ reconciliation path. After a bridge
  restart, an application can read a **known** BullMQ Job and pass its current
  state to `BullMQTaskBridge.reconcile()`, which brings the durable Task and
  Execution forward through the normal version-fenced API. Failed observations
  require explicit `terminal: true`; the bridge does not scan Redis, discover
  jobs, dispatch, cancel or invent retry attempts.

- Published the first Node SDK evaluation prerelease:
  `@rhinoq/node@0.1.0-beta.1`. It remains a development preview and must be
  installed by exact version, not treated as a production or stable release.
  Tag releases also test, pack, verify tag/package version and can publish with
  npm provenance through GitHub OIDC after the owner configures trusted
  publishing. `docs/releasing.md` records the account actions that cannot
  safely be automated from this repository.

- Refined the embedded, read-only Workbench into the **Obsidian Ledger** visual
  system: a calmer dark operational surface with a mineral palette, evidence
  path motif and clearer type hierarchy. This is a presentation-only change;
  it does not add browser writes, payload access, remote hosting or a new data
  source.

- Added a deliberately narrow, source-only Node BullMQ lifecycle bridge. An
  application continues to enqueue and own BullMQ/Redis, then calls `track()`
  for a job; the bridge durably creates/binds its Task Execution and projects
  waiting, active, progress, completed and explicitly confirmed terminal
  failure events through the version-fenced Task API. Runtime/external-ID
  lookup survives a bridge restart. It intentionally does not dispatch jobs,
  rewrite handlers, own Redis, cancel, orchestrate retries or claim
  outage-wide reconciliation. Go, HTTP and Node contract tests cover the new
  lookup and Execution-state fence.

- Completed the documentation narrative migration to Task Platform first.
  README, documentation index and Getting Started now begin with the
  user-facing Task contract; the native queue/runtime and Verified Tasks are
  explicit optional paths. A concise `docs/product-positioning.md` now separates
  the intended existing-worker adoption wedge from capabilities that are only
  planned. `RHINOQ_PRODUCT_DIRECTION_v3.md` is labeled as long-range research,
  so its BullMQ adapter, realtime, frontend and provider proposals cannot be
  mistaken for implemented behavior.

- Hardened the security baseline after a repository audit. Go now requires
  1.25 and prefers patched toolchain 1.26.5; pgx is upgraded to 5.9.2 and
  x/text to 0.39.0. `govulncheck` now reports no reachable vulnerabilities in
  either Go module, `npm audit` reports none in the Node SDK, and Gitleaks found
  no secrets in history or the working tree. CI now repeats those checks.
  The HTTP Gateway defaults to loopback, requires a bearer token of at least 32
  bytes, hashes both sides before constant-time comparison, rejects
  unauthenticated non-loopback binding and trailing JSON, bounds header/read
  resources, and stops returning raw parser/store errors. Codex Security
  0.1.1/plugin 0.1.14 was run natively and in Linux but failed to seal
  `scan-manifest.json`; the audit records this as tool failure, not a clean
  scan, and keeps tenant/role auth, TLS, redaction and abuse controls as release
  blockers.

- Repositioned RhinoQ as a Task Platform with optional Verified Tasks and added
  the first domain foundation. `Task` now has an independent lifecycle,
  versioned known/indeterminate progress and result references; `Execution`
  links each attempt immutably to either a native RhinoQ Job or a stable
  external-runtime ID. Retry creates a new Execution rather than reopening a
  terminal attempt. Store ports, an optimistic-concurrency memory adapter and
  application create/bind/read use cases are included; attempt allocation is
  atomic at the store boundary so concurrent retries cannot choose the same
  number. A versioned Snapshot DTO omits ownership and runtime-internal IDs,
  and lifecycle/progress commands reject stale entity versions; indeterminate
  progress omits `total` instead of inventing a percentage. PostgreSQL
  migration 015 and a Task/Execution store are implemented with optimistic
  updates and per-Task atomic attempt allocation; its real-database contract
  and an eight-writer concurrent-attempt test pass on PostgreSQL 16. A public Go
  facade, versioned HTTP create/read/state/progress endpoints and typed Node
  polling client now expose the first Task slice with stale-write conflicts.
  A separate version-fenced result-reference API avoids repeating storage
  locations in every Snapshot poll. BullMQ/native automatic dispatch, result
  payload proxying, realtime transport and frontend components remain
  explicitly unimplemented.

- Fixed Snapshot convergence before exposing Execution binding publicly.
  Creating or binding a child Execution now advances the parent Task version
  atomically in the memory lock/PostgreSQL transaction. Previously two
  snapshots could share one `entityVersion` while containing different
  Execution state, making stale-response rejection unsound. Go, HTTP and Node
  now expose create/bind operations that return the new aggregate Snapshot;
  runtime-internal job/external IDs remain write-only.

- Added an evidence-scoped product-strengths document and a matching README
  summary. Implemented strengths are now separated from architectural
  advantages and unproven product claims, so “keep your queue” and code
  reduction cannot be advertised before a real adapter and before/after
  adoption measurement exist.

- Audited repository boundaries against Temporal, Hatchet, Inngest and
  Trigger.dev. Task wire contracts are now data-only and no longer import
  domain records; the application owns domain-to-contract mapping. A regression
  test parses Go imports and rejects forbidden layer dependencies. The audit
  also records why RhinoQ remains a modular monolith instead of copying mature
  projects' service/package count.

- Table Rules can page on `(changed_at, subject_id)` instead of `subject_id`
  alone, via `Cursor: rhinoq.CursorChanged` and migration 014. A row that just
  moved is then seen on the next page rather than after a full pass. The
  composite is enforced, not assumed: paging on a timestamp alone skips rows
  that share one, which for an integrity checker means reporting a table clean
  because it never looked at part of it. Explain refuses a changed-since Rule
  that cannot return `changed_at`, since it could never resume.

- Added a business-subject investigation view to the Workbench:
  `/api/v1/subjects/{type}/{id}` and a rail that merges findings, operator
  decisions and Effect Ledger entries into one time-ordered narrative, with the
  executions that touched the subject listed whether or not RhinoQ ran them.
  Clicking a Finding now opens it instead of showing a "timeline is planned"
  toast.

- Effects no longer require a RhinoQ job. A new correlation model gives every
  entry a `SubjectRef` and an `ExecutionRef`, and a RhinoQ job id becomes one
  kind of execution reference rather than a precondition, so a team running
  BullMQ, Temporal or cron can record what its worker did and read it back by
  business subject. The external path is explicitly weaker: without a lease
  nothing can fence it, so deduplication rests on the execution reference plus
  the idempotency key, and recording a RhinoQ execution through it is refused
  rather than silently accepted.

- Rule observations are three-state: passed, violated and unknown. The query's
  `violated` column is now nullable — `NULL` means the check could not decide —
  with an optional `unknown_reason` column and a per-Rule `OnUnknown` policy
  (`retry` by default, or `finding`). An unknown never resolves a Finding,
  which a boolean made impossible to avoid: a provider timeout was
  indistinguishable from a pass and silently closed real drift.

- Added `rhinoq.NewIntegrity(db)` and `rhinoq scan`, an entry point that
  verifies business invariants without adopting the queue. The facade starts no
  worker, claim loop, heartbeat, retry scheduler, lease reaper or recovery
  executor, and a regression test asserts its method set stays free of runtime
  operations. `*Client` embeds it, so a deployment that adds the runtime later
  keeps the Rules and Findings it already registered.
- Claim now takes a batch in exactly one round trip. It previously cost three
  statements plus one per distinct execution lane, with the per-lane rate
  reservations running inside the window where candidate rows were already
  locked. Rate slots are also reserved from what was actually claimed rather
  than from the over-fetched candidate set.
- Bounded the lease reaper. `RequeueExpired` had no LIMIT, so a mass expiry
  locked and rewrote every expired row in one statement. It now reaps bounded
  batches and the sweep drains them within a time budget, exposed as
  `RHINOQ_REAP_BATCH_LIMIT` and `RHINOQ_REAP_SWEEP_BUDGET`.
- Made the outbox set-based and fixed a durability bug it exposed: a publisher
  that failed or died mid-batch left its events claimed and unpublished
  forever, because the claim filter skipped claimed rows and nothing ever
  cleared them.

- Licensed the project under Apache-2.0 and recorded the decision as ADR-0013.
  The repository previously carried no license, which left it "all rights
  reserved" and made any external use, fork or redistribution legally
  impossible. `LICENSE`, `NOTICE`, the Node package manifest and the
  contribution, governance and security policies now agree on that boundary.
- Changed the Go module path from `github.com/rhinoq/rhinoq` to
  `github.com/madebyduy/RhinoQ` so it matches the repository that hosts it.
  `go get github.com/madebyduy/RhinoQ/pkg/rhinoq` and
  `go install github.com/madebyduy/RhinoQ/cmd/rhinoq@latest` now resolve
  directly; the documented local `replace` workaround is gone. Applications
  that already vendored the old path must update their imports.
- Moved unpublished product research (`RHINOQ.md`, `files/`) into an ignored
  `private/` directory. The published sources of truth are `README.md`,
  `ARCHITECTURE.md`, `docs/` and the tests.
- Added a tag-triggered release pipeline that cross-compiles the `rhinoq` CLI
  for Linux, macOS and Windows on amd64/arm64 and publishes a cosign-signed
  `checksums.txt`. `rhinoq version` is now stamped from the release tag and
  still reports the development version when built from source. The pipeline
  remains unproven until the first `v*` tag runs it.

- Added a complete CLI reference covering every implemented command, action,
  flag, exit code, read/write boundary, JSON/pagination behavior and common
  failure, plus topic-aware `rhinoq help <command>` output with regression
  tests.
- Replaced non-runnable preview installation claims with tested source-checkout
  and local-module instructions while documenting tagged Go/npm and prebuilt
  CLI distribution as release blockers.
- Expanded the Node.js guide with an explained build/pack/install flow,
  PowerShell and Unix setup, complete `PostgresProducer`, `RhinoQWorker`,
  `NodeJob` and `RhinoQClient` references, a four-terminal runnable walkthrough
  and troubleshooting; the producer example is now repeatable and can
  demonstrate idempotent enqueue with an explicit business ID.
- Fixed the documented Node preview packaging command and made the official
  HTTP Gateway register `pgx`, so `go run ./cmd/rhinoq-agent` can connect to the
  configured PostgreSQL database without a custom bootstrap.
- Fixed `rhinoq.enqueue()` producer authorization to check the invoking
  PostgreSQL login rather than the owner of its `SECURITY DEFINER` function,
  with a real-database regression contract.
- Added RhinoQ Workbench, an embedded loopback-only developer interface with
  demo/live PostgreSQL modes, a dense execution table, Needs Attention,
  Findings, Rules, command navigation and a per-job Evidence Rail.
- Added bounded public inspection for one job plus its attempt, Effect Ledger,
  outcome and replay-audit evidence. The browser contract remains payload-free,
  same-origin and read-only.
- Added CSP and local-interface security headers, responsive light/dark layouts,
  keyboard/table preferences and a tested 160 KiB embedded frontend budget with
  no JavaScript runtime dependency.
- Added the development-preview `@rhinoq/node` SDK with a dependency-free
  PostgreSQL producer, typed/timeout-bounded Gateway client, high-level worker,
  explicit failure classification, operator reads/controls and Node test suite,
  including a real `pg` transaction rollback contract.
- Added the authenticated external-effect confirmation endpoint and Node
  `confirmEffect` API so a verified webhook can move an `external-signal`
  effect from pending to confirmed after the handler returns.
- Claims can now be restricted to registered handler names. Go and Node workers
  filter before PostgreSQL locks candidates, enforce a 1,000-job hard cap, and
  a Node worker releases an unexpected job instead of executing the wrong
  handler.
- Stabilized camelCase HTTP job/attention/audit fields for non-Go SDKs and
  added a wire-format integration test.
- Added a dedicated Node.js guide and runnable producer/worker examples while
  documenting that npm and prebuilt CLI releases are still pending.
- Added the embedded migration runner and direct PostgreSQL CLI: read-only
  migration plan/status/SQL, explicit apply with checksums and advisory
  locking, database-aware `doctor`, payload-safe job inspection, queue
  controls, Finding triage, and standalone Rule scheduling.
- Migration status/apply now fail closed when the database is newer than the
  running binary, its applied history contains a version gap, or any RhinoQ
  object exists without authoritative migration history.
- Added bounded `--limit`/`--offset` pagination to direct PostgreSQL list and
  Needs Attention CLI operations.
- Changed enqueue scheduling to pass a `RunAfter` duration into the store, so
  PostgreSQL—not the producer's wall clock—computes `not_before`; negative
  delays are rejected.
- Made embedded Go the documented default. The optional HTTP gateway remains
  available for non-Go workers and is explicitly not an AI/LLM dependency.
- Unified Needs Attention with live persistent Findings while preserving safe
  queue filtering and excluding resolved or actively suppressed drift.
- Fixed scheduled Rule version consistency: each fenced lease evaluates the
  immutable version it claimed; enabling wakes its durable schedule without
  scanning every Rule on each poll, and disabling stops future claims without
  falsely cancelling an in-flight page.
- Rewrote the README around installation, first durable job, deterministic
  integrity Rules, manual operations, honest limitations, and a mandatory
  README synchronization rule for user-visible changes.
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
  lease expiry, exposed through the Go facade, Gateway HTTP and Node client.
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
