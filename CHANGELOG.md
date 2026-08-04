# Changelog

## Unreleased

Follow-up to the beta.8 audit. Every item here closes a gap the release left
open, or a claim it made that the repository could not back.

### Node SDK

- `npx rhinoq notify add|list|remove|test` now exists. `notify` shipped in
  beta.8 with the stated reason that Node teams could not use notifications —
  and then shipped only in the Go CLI. Both CLIs read and write the same
  `.rhinoq/notifications.json`, which is a file rather than an engine table
  precisely so an SDK can share it without reaching into private state.
  `notify send` stays Go-only: a real delivery is recorded in the durable
  delivery ledger, and reimplementing that deduplication in TypeScript would
  put correctness in two languages.
- Added `TaskMetrics` and `checkEmbeddedHealth`. The Gateway has `/metrics` and
  `/healthz`; an application on the embedded PostgreSQL Task client had
  neither. Counters only — no latency, rate or percentile, because publishing a
  performance number without its benchmark is a claim this project does not
  make.
- Added `createNodeTaskMiddleware`, `registerFastifyTaskRoutes` and
  `taskRoutePatterns`. Express, Fastify and NestJS all share one trap: their
  wildcard does not match the bare collection path, so a `/tasks/*` route
  silently loses `listTasks` and the only symptom is a 404.
- **Breaking (fan-out):** `dispatchMany` now requires an `itemKey` on every item
  and refuses duplicates within a batch. `itemKey` is the idempotency key —
  attempts are numbered per key and the aggregate counts one item per key — so a
  fan-out dispatched without one stored fifty items as attempts 1..50 of a
  single item. The aggregate read `total: 1` and an `all-succeeded` batch
  terminated on its first finish, irreversibly and silently. `track()` and
  `dispatch()` are unchanged.
- Added `terminalizeOnCancel`. `cancel()` records the cancellation outcome and
  never terminalized, so under the default `aggregate.terminal: 'manual'` a
  fully acknowledged cancellation left the Task at `cancel_requested` until the
  application noticed. The option cancels the named Executions and then the
  Task, and refuses when any other Execution is still open.
- `BullMQTaskBridge` warns when a second instance shares a `runtimeScope` in
  the same process, and says out loud that the cross-process case is the same
  hazard and invisible from a client library. Acknowledge with
  `allowConcurrentBridges` or `RHINOQ_ALLOW_CONCURRENT_BRIDGES=1`.
- `npx rhinoq` and `npx rhinoq-task` accept discrete PostgreSQL variables
  (`PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`, or `RHINOQ_DB_*`), not
  only a connection URL. `doctor` used to stop at "DATABASE_URL is not set" for
  the projects whose platform hands out discrete variables. Half a discrete
  configuration resolves to nothing rather than falling back to a default host.
- `require('@rhinoq/node/package.json')` no longer throws
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.

### Task schema v3, v4, v5

Applied automatically by `installPostgresTaskProfile` and `npx rhinoq-task`.
Verified against PostgreSQL 16: applies clean, re-runs as a no-op, and the Go
engine harness still passes on the same database.

- **v3 (expand)** adds `executions.superseded_at` and a partial unique index
  covering only live rows. Purely additive: code that never sets the column
  still sees at most one live row per external ID, so a process running the
  previous SDK against this schema behaves identically.
- **v4 (contract)** drops `executions_runtime_ref_unique` — the index that
  forbade the retry row — and adds `retry_execution`. Rollback is recreating
  that index and only succeeds while no external ID has more than one row:
  stop projecting retries first (`retryProjection: 'ignore'`), then roll back.
  Rolling back with superseded rows present fails on the index build, which is
  the correct place to find out.
- **v5** adds `tasks.items_settled_at`, `settle_items` and an index on
  `(state, updated_at)` for the reconciliation query.

### Fan-out, retries and reconciliation

- **A retry of an external job is now a new attempt.** BullMQ reuses its job ID,
  so the first attempt was already terminal when the retry went active, the
  state machine refused the move, and the second run left no record at all —
  `attempt` never advanced past 1 for any external runtime. Open since beta.3.
  The previous row keeps its outcome and reason, so a batch view can finally
  answer "attempt 1 failed with a 502, attempt 2 succeeded".
- Added `onItemsSettled`, delivered exactly once when every item of a fan-out
  reaches a terminal state. Every adopter wrote that themselves as "did I just
  see the last one?", counting in application code — an answer that is wrong
  the moment two workers finish concurrently or an event is re-delivered. The
  decision is one SQL statement, so it survives a crash and several bridges.
- Added `listTasksByState({ states, idleForMs, itemsSettled })` and
  `TaskReconciler`. `bridge.reconcile()` has existed since beta.3 and nothing
  ever called it on a schedule, so a Task stuck at `running` stayed stuck until
  a human noticed. The reconciler is a timer in one process, not a distributed
  scheduler, and says so.
- Added `projectionFailures`, a durable sink for a projection that threw.
  `onError` fires once, in a process that is often being killed — the reason
  the projection failed is frequently the reason the process is going away.
  The sink is application-owned: the Task-only profile promises exactly three
  tables, and the row belongs beside whatever the job was doing.
- Added `objectTransferProviderAdapter` for "fetch from a CDN, put it in S3".
  Stripe and provisioning answer *did it happen?* from a status field; a
  transfer has none. An object whose identity does not match is `failed`, never
  a retry, because overwriting is not undoable on an unversioned bucket — and
  an object with nothing comparable stays `unknown`, because "something is at
  this key" is not proof this operation put it there.

### Evidence and test infrastructure

- `tests/fault` now holds nine fault-injection scenarios: an acknowledgement
  lost after the write committed, a lease expiring under a live worker, a
  partition that heals, a sweep interrupted mid-batch, and a provider
  confirmation lost after the charge went through. `AGENTS.md` forbids a
  reliability claim without fault evidence and the directory was empty. Its
  README lists what the suite does not cover.
- `tests/contract` now holds the cross-language wire tests, including the Rule
  record and the notification message. Regenerating `rule-record-v1.json` from
  Go showed the committed fixture was not a replay of the wire: `writeJSON`
  HTML-escapes, so the Gateway sends `>` where the mock had a literal `>`.
- `go.work` plus an explicit `make test`/`make vet` target: `go test ./...` at
  the repository root compiled none of the fourteen PostgreSQL engine contract
  files and printed PASS. A guard test fails when a module is added without
  being wired into both.
- Coverage on the beta.8 headline features: `application/rules` 28.1% → 81.5%,
  `notificationdelivery` 34.5% → 100%, `domain/attempt` 22.2% → 100%.

### Release provenance

- Every build now stamps `dist/build-info.json` with a hash of the source it
  was produced from, and `npm run verify:installed -- <application>` compares an
  installed copy against the checkout. This closes a failure that had already
  happened: an archive packed at 14:08 kept the name
  `rhinoq-node-0.1.0-beta.8.tgz` while the features it was supposed to contain
  landed at 20:38, and a consuming application installed it and read the
  version as proof. A filename carries a version, never its content.
- `npm run pack` replaces bare `npm pack`: it removes earlier archives first, so
  a path that still names a stale one fails loudly instead of resolving.
- `npm run release:check` now refuses a `dist/` built from different source than
  the checkout, built at a different version, or built from a dirty tree. The
  three checks it had all read `package.json`, so they passed just as happily
  against a `dist/` from weeks earlier.

### Task profiles are not interchangeable

- `RhinoQClient.createTaskExecution` warns the first time it is given an
  `itemKey`. The Gateway stores Executions unique per `(task, attempt)` with no
  column for the item, so it discarded the key silently — the same failure as
  a fan-out dispatched without one, arriving through a different door, and
  invisible until a retry double-charged. `docs/feature-matrix.md` now states
  which per-item guarantees each profile actually has.
- Added `listTaskExecutionRuntimeRefs`: every attempt's runtime job ID for one
  Task, in one query. Cancelling a fan-out had to name the jobs to stop and
  paid one `getTaskExecution` per Execution to learn them.

  It is deliberately **not** a field on `TaskSnapshot`. The first attempt put
  `externalId` there and `TestSnapshotIsVersionedAndExposesOwnershipWithoutRuntimeReferences`
  refused it: the snapshot is polled, and `createTaskRequestHandler` serves it
  to a browser through the owner-scoped routes, so a BullMQ job ID would have
  reached end users for the same reason a storage reference must not. There is
  no owner-scoped variant of the new read, and a test asserts no route reaches
  it.

## 0.1.0-beta.8

The first release whose Node package contains the `verify` onboarding commands.
Three rounds of fixes existed only inside this repository until this tag: the
`beta.7` tarball predates `verify apply`, so a reader following the README got
`FAIL verify requires 'add <rule-name>'`.

The release also publishes `rhinoq` as an unscoped npm alias for
`@rhinoq/node`, so `npm install rhinoq` is a supported install path. The Go
repository remains a Go repository; consumers should not install the Git tag as
an npm package.

### Rule lifecycle

- Added `rhinoq rules delete` and `DELETE /v1/rules/{id}`. Deletion removes the
  definition, its explain evidence, its schedule and its subject outcomes in one
  transaction. It previews by default: the dry run is computed by the same
  transaction that would perform the work and then rolled back, so the plan an
  operator approves is the plan that runs. An enabled Rule is refused and the
  refusal names the version to disable, because deleting one silently stops a
  check nobody decided to stop. A Rule that owns Findings is refused unless
  `--purge-findings` says to discard those operator decisions too.
- Added `rhinoq rules create`, so a Go-only team can register a Rule from a
  `.sql` file without hand-writing HTTP. Registering over an existing Rule
  prints a field and query-line diff and refuses without `--force`.
- `npx rhinoq verify apply` does the same: it reads the current Rule, prints
  what would change, and refuses a changed re-apply without `--force`. An
  identical re-apply now registers nothing instead of silently bumping the
  version. A version bump cuts the link to every Finding recorded against the
  old version, which is not something to do by accident.
- Added `npx rhinoq verify delete` and `GET /v1/rules/{id}`.

### Notifications

- Added `rhinoq notify add|list|remove|test|send`. Destinations were previously
  configurable only by building a `rhinoq.NotificationDestination` in Go and
  embedding it in an application, which a Node or Python team cannot do at all,
  so the README's "Findings reach people" was not true for most of its readers.
- `notify test` sends one synthetic HMAC-signed event and writes nothing: no
  Finding, no delivery ledger row, no database connection. A signed webhook is
  the one part of the system that cannot be verified by reading code.
- The destination registry never stores a secret. It records the name of an
  environment variable and the value is read at send time, so a leaked registry
  is a list of URLs rather than a set of working credentials. `notify list`
  redacts endpoints and reports whether each secret is actually present.

### Correctness

- `FailureReport.RetryAfter` now owns its own JSON contract in milliseconds
  instead of being a `time.Duration` behind a field named `retryAfterMs` that a
  call site had to remember to multiply. This was the last instance of the unit
  ambiguity that produced the Rule Record casing/unit bug, and the conversion
  now exists in exactly one place. Unknown and negative fields are rejected.

### Signals

- The two `doctor` commands no longer look interchangeable. The Node one states
  that it covers the Task profile and local Rule files only and points at the Go
  runtime checks; the Go one names its own scope in its first line.
- Removed `sdks/typescript/`: 24 directories of `.gitkeep` and no code, which
  made the repository look like it had two SDKs when `sdks/node` is the
  TypeScript one.
- Translated `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and `GOVERNANCE.md` to
  English; they are the files GitHub surfaces in the repository sidebar.
- The README now opens with real `scan`/`findings`/`attention` output, the
  Explain gate that answers "why not a cron job", the three observation states
  and the `doctor` timing checks - parts of the product that were already built
  and invisible to anyone who had not run it.

## Unreleased

- Made the security workflow detect whether GitHub Dependency graph is enabled
  before invoking Dependency Review, so unsupported repository configuration is
  reported as an actionable warning instead of failing the whole security run.
- Fixed the Go Gateway Rule Record wire contract: responses now use stable
  camelCase fields and millisecond duration units, with a shared Go/Node golden
  fixture preventing mock drift. `verify run` now explains an empty baseline
  result, and `doctor` validates table Rule parameters `$1`, `$2` and `$3`.
- Documented the full Go CLI/Gateway startup sequence required before the Node
  Verified Tasks loop.

- Fixed the Node Rule onboarding loop: generated table Rules now use the
  canonical `$1` baseline, `$2` cursor and `$3` limit bindings without comments
  or trailing statements; `verify apply` registers them through the Go Gateway
  and `verify run` performs one bounded evaluation. The Node doctor lints local
  Rule files, reports unapplied files and warns on PostgreSQL superuser use.
  Added the shared Rule contract fixture, issue templates, a restricted Rule
  role guide and the missing design-partner kill criteria.

- Added one public, beginner-first Start Here guide that explains the real-world
  failure RhinoQ addresses, every onboarding/demo command and its reason, the
  light Task view versus the full Workbench, BullMQ and ProviderOperation
  integration, safe repair, production boundaries, troubleshooting and a
  primary-source comparison with established queue/workflow products.

- Hardened the official Docker demo against PostgreSQL's temporary-init-server
  healthcheck race by giving the one-shot migration service a bounded restart
  policy; persistent migration failures still stop dependent services.

- Prepared `0.1.0-beta.7` after validating beta.6's public assets. Replaced the
  legacy 96-byte raw Cosign signature output with a Sigstore JSON bundle that
  contains signature, certificate and transparency-log proof, and added an
  identity/issuer verification step to the release job itself.

- Prepared `0.1.0-beta.6` after the first public release drill: npm 12 now runs
  in both verification and publish jobs, CLI `bin` paths use npm's canonical
  package-relative form, and release checks require all three built commands.
  `v0.1.0-beta.5` successfully produced binaries, per-archive SBOMs and
  an attested GHCR image; npm publication remained blocked by missing trusted-
  publisher permission on the `@rhinoq/node` package.

- Repositioned RhinoQ around the customer-visible failure it catches: a queue
  can report technical success while the provider or business outcome is still
  unknown or wrong. Added a single five-minute CLI path and an official
  Next.js/BullMQ/PostgreSQL/Stripe response-loss demo covering controlled
  recheck and repair end to end.

- Completed the ProviderOperation contract across Go, PostgreSQL, Agent and
  Node: Task linkage, `failed`/`uncertain`, explicit confirmation/retry policy,
  append-only evidence, Stripe and provisioning/storage adapters, and a fence
  that prevents repeating an unknown external mutation.

- Added guarded remote repair callbacks. Go still owns plan state, four-eyes
  approval, precondition recheck, idempotency and verification; application
  callbacks are deployment-allowlisted, HMAC-signed and response-bounded.

- Added stored Task Execution aggregates and cursor pages, durable per-
  destination notification deduplication, severity/grace/regression links,
  process rate limits, a non-root container, SBOM/provenance release config and
  a tested PostgreSQL restore drill.

- Prepared `@rhinoq/node@0.1.0-beta.5` with lightweight Task Summary polling
  and stable keyset Execution pagination. The compatibility full Snapshot is
  unchanged, while browser `TaskStore` uses summaries when available and loads
  fan-out detail in bounded pages.

- Added the authoritative Go `ProviderOperation` contract and migration 018.
  Provider/operation/idempotency identity is durable, unknown network results
  fail closed as `uncertain`, and read-back can confirm without reissuing the
  provider call. The credential-free Stripe-shaped response-loss demo verifies
  that repeating one refund still makes exactly one provider call.

- Added explicit signed Finding webhook and Slack delivery. Evidence is
  redacted by default, event IDs are deterministic for receiver deduplication,
  non-loopback delivery requires HTTPS and timeouts are bounded. Automatic
  durable fan-out remains deliberately out of scope for this candidate.

- Added migration 019 and a safe repair workflow: registered handlers, preview,
  four-eyes approval, precondition recheck, plan ID as apply idempotency token,
  and independent verification before resolving the Finding. Stale plans call
  no mutation; unknown apply/verify outcomes are not retried blindly.

- Added a concrete three-seat design-partner playbook for BullMQ fan-out,
  Stripe/billing and provisioning/fulfilment workloads. A lead is not counted
  as a partner until a real workload and evidence-sharing pilot are agreed.

- Added reproducible Node JSON microbenchmarks, Go domain/memory benchmarks and
  a PostgreSQL concurrency/fan-out matrix. Browser fault tests now cover a
  fixed 10,000-event disorder stream plus 32 deterministic concurrent seeds
  mixing duplicates, reordering and transport loss. Scheduled CI exercises
  multiple PostgreSQL concurrency and snapshot sizes without promoting local
  results into production throughput claims.

- Hardened BullMQ `dispatchMany()` with bounded reserve/enqueue workers
  (`dispatchConcurrency`, default 8, range 1..64), removal of the duplicate
  reserve pass, preflight rejection of ambiguous IDs/Task definitions and a
  drained failure boundary. A partial Redis outage can now be retried without
  the prior call continuing in the background; already-dispatched items are
  not added to BullMQ again. Concurrent callers converge when one wins the
  durable bind. Existing runtime job identities must resolve to the same
  Execution, not merely the same Task.

- Hardened browser cancellation against poll/version races with three bounded
  convergence attempts. Subscriber exceptions are isolated and optionally
  reported through `onListenerError`, so one broken component cannot starve
  other views or stop polling.

- Real PostgreSQL repeat testing exposed a time-sensitive assertion that
  compared a 50 ms retry with the application clock after several round trips.
  It now compares `not_before` with PostgreSQL `clock_timestamp()` immediately
  before the failure command. The real-DB suite then passed five shuffled
  repetitions.

- Added a framework-neutral browser `TaskStore` with serialized polling, stale
  revision rejection, reconnect state, bounded backoff and owner-scoped
  cancel/result actions. Browser polling pauses while its tab is hidden and
  resumes immediately on visibility, avoiding background request churn. Tests
  cover reconnect, stale responses, cancellation fencing and stopping with an
  in-flight request.

- Added `createUseRhinoTask()` as a zero-added-dependency React adapter and the
  read-only `rhinoq-task-check` CLI. The hook uses the application's existing
  React runtime; backend-only installs do not pull React. The checker validates
  the owner endpoint, Snapshot v1 shape and non-regressing versions.

- Added fail-closed BullMQ cancellation composition and bounded
  `reconcileMany()` for application-known jobs. `cancel()` persists
  `cancel_requested`, then requires an application callback to prove each job
  stopped. Ambiguous effects become `cannot_cancel_safely`; callback errors
  become `failed` instead of being reported as cancelled.

- Prepared `@rhinoq/node@0.1.0-beta.4` to remove the measured Node adoption
  tax. A fresh Task-only install now creates exactly three tables in the
  dedicated `rhinoq_task` schema and uses the application's existing `pg.Pool`
  through `PostgresTaskClient`; no Gateway process, Go toolchain, operator
  token, owner token or duplicate database URL is required. The package ships
  the `rhinoq-task` migration CLI, owner-scoped application HTTP handler and
  browser client.

- Added `installPostgresTaskProfile(pool)` for one-call, advisory-lock protected
  migration plus embedded client creation. The CLI now serves `--help` and
  `--version` without trying to connect to PostgreSQL.

- Added BullMQ reserve-before-enqueue `dispatch()`/`dispatchMany()`, scoped
  runtime identity, per-item retry identity (`itemKey`, `attempt`), awaitable
  event projection and explicit fan-out aggregation policies. A failed Redis
  add leaves `pending_dispatch`; repeating the same deterministic dispatch
  resumes it without creating another Task or Execution.

- Numeric BullMQ progress is no longer guessed to be an item count. BullMQ
  permits number or object progress and applications commonly use a number as
  a percentage. The default now rejects this ambiguous shape; callers select
  `bullMQCountProgress` or `bullMQPercentageProgress`, while structured
  `{completed,total?,message?}` progress remains automatic.

- Prepared `@rhinoq/node@0.1.0-beta.3` as the first candidate containing the
  real-adopter contract corrections below. Release identity now agrees across
  `package.json`, the lockfile and the Gateway handshake's `SDK_VERSION`, and
  the release check fails if they drift. This entry does not claim that
  `beta.3` has been published.

- Release archives now build both the migration/operations CLI (`rhinoq`) and
  the optional HTTP Gateway (`rhinoq-agent`) for Linux, macOS and Windows on
  amd64/arm64. A Node evaluator no longer has to install Go merely to start the
  Task API after a tagged release. CI validates the GoReleaser configuration
  before a tag can be cut. No container image is published yet.

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
  planned. Unpublished long-range product research is kept outside the public
  tree, so its BullMQ adapter, realtime, frontend and provider proposals cannot
  be mistaken for implemented behavior.

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
