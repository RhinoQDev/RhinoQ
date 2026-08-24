# Changelog

## Unreleased

- Fixed discovery metadata verification for the README's background job entry,
  and aligned the PostgreSQL Task-profile integration assertion with schema
  version 21's Durable Step and shared-resource tables.
- Unified canonical plan validation behind `compileRhinoQPlanResult()`. CLI,
  CI and Workbench integrations can now consume stable five-part structured
  compiler diagnostics without catching ad-hoc error strings; the existing
  throwing `compileRhinoQPlan()` API and manifest schema v1 remain compatible.
  Typed application compilers expose the same evidence through
  `compiler.diagnostics()`. Compilation now executes explicit pure
  normalize/validate/link/project phases and reports a phase trace.
- Added deterministic typed capability linking through
  `linkRhinoQCapabilities()` and `capabilityLinks`. Required capabilities must
  resolve to exactly one component; optional gaps remain explicit, and only
  public binding metadata, permissions and secret references enter the
  canonical manifest/plan fingerprint.
- Added `defineRhinoQDeployment()` and `rhinoQDeploymentResource()` for
  deterministic app/stage namespaces. Deployment identity is fingerprinted in
  the canonical manifest/plan, keeps the current single-tenant-process
  boundary explicit and is never treated as authorization or a credential.
- Added `createRhinoQProviderComponent()`, which keeps the pure capability
  declaration separate from explicit provision/validate/cleanup lifecycle
  callbacks. Plan compilation cannot start or mutate a provider.
- Added an SST deployment adapter with separate compile and materialize phases.
  `compileRhinoQSSTDeployment()` emits deterministic worker/migration intent;
  `materializeRhinoQSSTDeployment()` requires adopter-owned factories and
  explicit capability resource links, with no SST dependency in core. The
  narrow `@rhinoq/node/sst` subpath avoids exposing worker/application runtime
  APIs to infrastructure configuration.
- Unified plan validation, diff, compiler doctor and dev preflight through the
  pure `runRhinoQCompilerWorkflow()`. `doctor --plan-from ... --plan-only` runs
  without PostgreSQL; `dev --plan-from ...` validates deployment identity and
  handler metadata before starting the local surface. Diffs now include stage
  and capability-graph identity changes.
- Workbench Plan Inspector now exposes deployment namespace and redacted
  capability-to-provider link evidence alongside Task capsules.

- Added PostgreSQL migrations `020_shared_resource_leases` and
  `021_durable_step_cancellation`. `createRhinoQApp({ resourcePool, workerId
  })` now makes tenant-scoped CPU/memory/disk/network admission available to
  task declarations. PostgreSQL owns capacity fencing and reclaims expired
  leases on later admission; the Node worker renews while a handler runs and
  discards a result after lease loss.
- A persisted Task `cancel_requested` now aborts the Node handler context,
  terminalizes an owned Durable Step and transitions the Task to `cancelled`.
  Generic shutdown/deploy worker signals surface retryable
  `RhinoQWorkerShutdownError` instead. Effects are not force-cancelled after a
  possible provider call; the existing Effect Ledger remains the confirmation
  authority.
- Promoted the existing path/workspace FFmpeg context as the supported first
  heavy-workload adapter. The built-in S3 provider now lets replayable
  `context.artifact.filePath()` and `context.output.*` files resume the
  existing owner/tenant-fenced multipart session after a worker restart,
  reconcile provider parts and preserve the existing readback/`uncertain`
  completion policy. One-shot streams remain backpressured and abortable but
  are intentionally not restartable; stream-to-FFmpeg restart still requires
  its own fixture.

- Added the first-value CLI paths `npx rhinoq dev --demo`, `npx rhinoq up`,
  `npx rhinoq connect`, `npx rhinoq add task` and `npx rhinoq doctor --fix`.
  The demo is explicitly synthetic; the local profile is PostgreSQL-backed and
  writes only ignored files. Task generation remains non-overwriting and keeps
  runtime/owner/security decisions explicit.
- Integration Eraser scans now exclude generated/vendor/nested-repository
  noise, honor `.rhinoqignore`, report skipped evidence and print a
  summary-first preview (`--all` opts into the full finding list).
- Corrected S3 documentation to match the optional peer dependency contract;
  the base Node install no longer claims to ship AWS SDK packages.
- Added the owner-facing `TaskRunHandle` facade for start/refresh/wait/cancel,
  result and credential-free Task Center URLs, composed on the existing
  SSE/polling `TaskStore`.
- Added CI first-value documentation checks so quickstart markers, canonical
  commands and stale beta/PostgreSQL claims cannot silently drift.
- Added a versioned DX comparison source of truth for the website: it uses the
  current `@rhinoq/node` Task/compiler APIs, compares the same full feature
  scope, and forbids unsupported queue/throughput claims.
- `add task --apply` now creates a dependency-free manifest/plan smoke test and
  prints the `/task-center` handoff; the release workflow runs an offline
  clean-room first-value smoke for the preview-first CLI paths.
- Made `TaskCreateRequest.definitionVersion` optional, defaulting to `1` in
  the Gateway and embedded PostgreSQL clients.
- Added `RhinoQClient.openTask(id)` parity with the PostgreSQL Task client so
  both transports expose the version-aware `TaskHandle` lifecycle API.
- PostgreSQL Task clients now turn missing or incomplete Task schemas into an
  actionable `RHINOQ_TASK_SCHEMA_MISSING` error that points to `npx rhinoq-task`.
- Added `reportTaskProgressAutoVersion()` and `completeTask()` as convenience
  compositions; they read once and keep optimistic-concurrency conflicts
  visible instead of retrying them silently.
- `TaskHandle.complete()` now covers the common start, result attachment and
  success path. The typed application compiler remains the high-level worker
  abstraction; lease and retry authority stays with the selected runtime.
- Added `createTaskWorker({ client, type, handler })` for one runtime-selected
  Task job. It validates the Task type, serializes durable progress and records
  the outcome without taking over polling, leases or retry policy.
- Low-level `transitionTask(..., 'running')` now composes the required
  `pending -> queued -> running` commands when the current snapshot and version
  prove the shortcut is safe; Gateway and PostgreSQL clients keep the database
  state machine and optimistic-concurrency fences authoritative.
- Added PostgreSQL schema migration 019 for tenant-fenced durable Steps and
  per-attempt leases. `context.step()` reuses compatible completed results,
  fences stale completion/failure writes and persists bounded inline results or
  Artifact references; existing checkpoints remain separate cursor state.
- `context.step()` now renews a pending Step lease and refuses a stale commit
  if renewal is lost. Independent Steps can run through direct `Promise.all()`;
  their per-async-call effect identity is isolated so a successful sibling
  remains reusable when another sibling fails.
- Added `context.effect()` as a narrow facade over the Go-owned
  ProviderOperation ledger, plus Workbench Flight Recorder and deterministic

## 0.1.0-beta.22

- Refreshed the npm-facing first-value path: package descriptions now lead with
  the durable Task experience, and both package READMEs show the demo, local
  profile and existing-worker onboarding commands before infrastructure detail.
- Synchronized the Node SDK, `rhinoq` alias, lockfile and operator guides on the
  beta.22 release candidate so the npm artifact and GitHub release describe the
  same verified surface.

## 0.1.0-beta.21

- Remediated fan-out contention on the PostgreSQL Task path (migrations 015–017, backward-compatible): the per-item effect claim now takes a narrow advisory lock instead of locking the parent Task row across the business callback; execution-count triggers moved to statement level; execution writes return the new version instead of the full snapshot; and committed Task changes announce over `pg_notify` with a per-process `LISTEN` hub so realtime stops polling per connection.
- Bounded the connection pool for every Go binary (was the `database/sql` defaults of unlimited open and two idle), split the Gateway rate limiter per authenticated caller, and batched the worker's idle rate-limit probe into one query.
- Added a NestJS PostgreSQL-only integration (`RhinoQModule.forPostgresAsync` / `createPostgresTaskIntegration`) that needs no BullMQ `QueueEvents`.
- Added `TaskHandle` and `client.openTask(id)`, a stateful lifecycle API that threads `entityVersion` for a linear worker while leaving optimistic-concurrency conflicts visible.
- Added `getTaskIfNewerThan` for a version-conditional read that skips the O(N) execution aggregation when the caller is current, and richer `RHINOQ_PROGRESS_STATE` errors (migration 018) that name the state, the valid states and the next action.
- Moved the AWS SDK to optional peer dependencies so a PostgreSQL-only install no longer pulls it, and accepted inline S3 configuration via `createRhinoQApp({ artifacts: { s3: { … } } })`.

## 0.1.0-beta.20

- Fixed PostgreSQL startup-option merging so tenant binding is preserved when a connection URL already carries options; CLI commands, examples and benchmarks now use tenant-bound pools consistently under forced RLS.
- Corrected PostgreSQL integration coverage to exercise one tenant per application pool while keeping cross-tenant maintenance checks explicit; the beta20 candidate passed Node22/24, PostgreSQL, fan-out, Go, CodeQL and secret scans.

## 0.1.0-beta.19

- Fixed CLI Task/evaluation fixture pools to set `rhinoq.tenant_id=default`
  under forced RLS; the generated report-export demo now binds its tenant
  session explicitly.

## 0.1.0-beta.17

- Restored the `createRhinoQApp` golden-path marker in developer CLI help and
  added a regression assertion matching the clean registry smoke contract.
  `0.1.0-beta.16` published both npm packages with provenance, but its registry
  smoke stopped before GitHub binaries, container and release assets; beta.17
  supersedes that incomplete candidate.

## 0.1.0-beta.16

- Added a canonical deterministic `RhinoQPlan` projection with compiler and
  started-application access, read-only CLI `plan`, `validate` and `diff`
  commands, and an evidence-aware capability ledger exposed by
  `npx rhinoq capabilities --json`. Added bounded `explain` views for plans,
  Tasks and processor modules.

- Added an explicit load/provision/validate/cleanup module lifecycle for
  replaceable runtime and processor boundaries. Processor packs expose their
  lifecycle without moving lease, retry, effect or Task-state correctness out
  of the authoritative Go/Application layers.

- Provider adapter contracts can now carry the same optional lifecycle module
  descriptor across HTTP, Stripe, provisioning and object-transfer boundaries;
  provider readiness remains an explicit target-worker probe.

- Added a bounded application-owned operational settings transaction with
  stage, approval, revision-fenced commit and reverse rollback. It is an
  in-process primitive for canary controllers, not distributed persistence or
  an automatically started Control Plane.

- Added opt-in selective execution checkpoints for deterministic large-work
  units. The PostgreSQL-backed contract bounds state, fences handler version
  and input checksum, supports lost-response-safe replay and keeps checkpoint
  state separate from Task/business outcome state.

- Added an approval-bound, bounded Autopilot canary executor with an
  application-owned observation gate and reverse rollback. It does not mutate
  Task state, retry uncertain effects or start a Control Plane. Added the first
  provider-injected Sharp-compatible processor boundary without bundling a
  native image dependency.

- Completed the next low-code async tranche: `schedule` and resource metadata
  now compile into the read-only execution capsule; setup records detected
  capabilities; in-process Task mutation hooks can automatically invalidate
  owner-scoped realtime subscriptions; Data Path Planner admission now carries
  disk/GPU/region/codec decisions; and the Integration Eraser emits manual-review
  diff plus reverse-patch artifacts without an apply path.

- Joined Evidence Passport into Workbench Task detail and
  `/admin/api/tasks/:id/evidence-passport`; added explicit processor catalog
  statuses and read-only Autopilot simulate/canary approval artifacts. No
  bounded-auto mutation, provider pack implementation or Control Plane claim was
  added without external evidence.

- Added `defineRhinoQProject()` for one project-level pool, identity, execution
  profile and operator mount; added generic processor-pack lifecycle plus the
  bounded FFmpeg adapter; and added deterministic Autopilot observe/recommend
  evidence at Workbench `/admin/api/autopilot`. These surfaces are read-only or
  composition-only and do not move lease, retry, effect or Task-state authority
  out of the Go/runtime boundary.

- Added one canonical Vietnamese low-code upgrade plan with a negative
  complexity budget, short metadata-bearing Task factories, automatic
  realtime/progress paths, Integration Eraser, evidence passports, data-path
  planning and a developer-oriented Console. README states implemented product
  strengths separately from roadmap proposals.

- Added the read-only `npx rhinoq adopt --scan [--json]` Integration Eraser
  preview. It reports bounded file/line evidence for common status, polling,
  BullMQ, upload-proxy and retry-timer glue, separates review findings from
  high-confidence estimates, and never writes or deletes adopter files.

- Added a read-only Plan Inspector projection from the typed application
  manifest into the embedded Workbench at `/admin/api/plan`. It shows factory,
  compiled runtime capsule, data path and `needs-decision` readiness without
  exposing payloads or changing runtime authority.

- Added an optional dependency-free WebSocket hub for one-connection/many-Task
  subscriptions. It coalesces owner/tenant-scoped snapshot reads, serializes
  each new version once, provides indexed event-driven invalidation, bounds
  subscriptions/backpressure and keeps SSE with polling fallback as the
  zero-configuration default.

- Added a bounded worker progress coalescer. Rapid handler, artifact and media
  progress calls keep the newest update, flush on time/delta thresholds and
  always flush before the handler returns; write failures remain visible.

- Added `taskEvidencePassport()` as a bounded, read-only projection of Task
  execution, provider confirmation, business verification, artifacts and
  recovery references. It keeps technical success, external confirmation and
  business outcome as separate statuses.

- Added short application compiler factories for `task`, `batch`, `media` and
  explicit-safety `effect`, plus a bounded compiled data-path plan. The legacy
  callable/object declaration form remains compatible.

- Added `context.io.download()` for HTTPS-host-allowlisted, bounded, timed,
  checksummed streaming downloads; opt-in per-execution workspaces with capacity
  checks and guaranteed cleanup; and `context.media.probe()` via bounded
  FFprobe JSON. Added an explicit ecosystem coverage matrix.

- Added a reproducible Artifact Production Lab covering incremental checksum
  parity/responsiveness, bounded 1,000-session planning load, owner/tenant and
  part-shape security failures, and live S3 process-restart reconciliation with
  cleanup-safe random objects.

- Task-bound browser upload now computes SHA-256 concurrently with multipart
  upload in bounded, event-loop-yielding Blob slices with
  progress and cancellation. Added a non-root FFmpeg worker base image and
  runtime readiness inspection for exact encoders and minimum free workspace,
  plus a cleanup-safe live S3 multipart verification runner.

- Added owner-fenced direct S3 multipart upload with signed browser parts,
  durable resume/reconciliation, adaptive planning, readback verification and
  fail-closed `uncertain` completion. Upload and artifact expiry are separate;
  retention deletion is preview-first and leased.
- Added `context.media.transcode()`/`thumbnail()` with bounded FFmpeg process
  handling and automatic artifact registration, plus an explicitly synthetic
  artifact benchmark.

- Added a Vietnamese beginner documentation path covering first run, one Task
  declaration, large files/ZIP, API/SSE/UI and production checks. Rebuilt the
  documentation index and linked both languages from the root README.
- Aligned multiple-file output with the mounted product surface: separate
  artifacts now share the owner API/Task Center bound of 100 and use bounded
  upload concurrency, while a ZIP may stream up to 1,000 inputs into one
  artifact. This removes an earlier contract/UI mismatch found in integration
  review.
- Added `artifactProvider` composition and the optional
  `@rhinoq/node/artifacts` entry point. S3-compatible and Cloudinary providers
  now connect private upload and short-lived owner download from one server
  configuration, with MIME/size/namespace guards. Task Center renders a
  responsive file panel with availability, expiry, size and checksum actions.
- Added `context.artifact.stream()` and `filePath()` for large outputs. The
  streaming path preserves backpressure, hashes while transferring, validates
  byte counts, forwards cancellation and optionally reports byte progress;
  S3-compatible and Cloudinary providers can delegate multipart/chunked upload
  to their official SDK without buffering the entire object in worker memory.
- Added the high-level async `createAwsS3ArtifactProvider()` factory. Adopters
  now provide a bucket plus standard S3 client configuration while RhinoQ owns
  PutObject, multipart upload, abort cleanup and signed downloads; AWS packages
  remain optional and lazily loaded.
- Added `artifacts: 's3'` environment composition, MIME/name inference and
  `context.output.video/pdf/archive/files/zip` helpers. Multiple files are
  bounded and may remain separate or be streamed into one ZIP through the
  optional `archiver` package without buffering the complete archive.
  Separate-file upload is capped to the owner API's 100-artifact view and uses
  bounded configurable concurrency; ZIP may accept up to 1,000 inputs because
  it produces one registered artifact.
- Added migration 032 and durable five-field cron schedules with IANA
  timezones. Scheduler completion persists the domain-calculated next UTC run;
  spring-forward gaps are skipped and repeated fall-back wall minutes run once.
  Agent and Workbench list views expose cron/timezone without payloads.
- Added `context.artifact.file()` for declared Node Tasks. One configured
  storage adapter now handles upload while RhinoQ computes SHA-256 and registers
  artifact identity, size, content type, expiry and lineage for the existing
  owner API and Task Center.
- Added `context.waitForInput()`, `context.waitForApproval()` and
  `context.waitForWebhook()` to declared Task handlers. They bind the current
  Task automatically and reuse the durable PostgreSQL waitpoint, owner routes
  and Task Center UI without holding a worker lease open.
- Added dependency-free optional trace hooks to `createRhinoQApp`. RhinoQ emits
  dispatch/run spans and carries a bounded string trace carrier through the
  runtime envelope, allowing an OpenTelemetry adapter without forcing telemetry
  dependencies on every SDK install.
- Added conservative `rhinoqPresets.exportFile`, `importData` and `external`
  helpers. They remove mechanical progress/artifact wiring while retaining
  no-retry defaults and requiring explicit effect safety for provider work.
- Added `application.runWorker()`, which installs the compiled fail-closed Task
  router, handles AbortSignal/SIGINT/SIGTERM and bounds runtime worker shutdown
  without duplicating adapter lease or retry logic.
- Bound the Go Agent and owner Task credentials to one explicit tenant through
  `RHINOQ_TENANT_ID` / credential `tenantId`; a credential for another tenant
  now fails startup instead of being silently loaded into the process.
- Added `RHINOQ_AGENT_ROLE` and a deny-by-default route policy that maps Agent
  Task, Job, Queue, Rule, Finding, Repair and ProviderOperation requests through
  the existing tenant role matrix before any handler executes.
- Began the durable recurring-Task engine behind an unexported boundary: bounded
  interval definitions, deterministic occurrence IDs, owner/epoch lease
  validation and a claim/dispatch/complete scheduler with failure backoff. It is
  not advertised as public until PostgreSQL storage and failover tests land.
- Added migration 031, tenant-scoped PostgreSQL schedule storage, database-time
  `SKIP LOCKED` claims, fenced complete/failure backoff and the experimental Go
  `CreateRecurringTask` / `RunRecurringTaskScheduler` facade. Occurrence IDs are
  deterministic across lease takeover; production promotion still requires the
  real-PostgreSQL failover gate and schedule lifecycle controls.
- Added bounded get/list and version-fenced pause, resume, interval/next-run
  update and delete for recurring schedules. Lifecycle changes clear stale
  leases and concurrent stale versions fail instead of overwriting an operator.
- Added a real-PostgreSQL recurring scheduler gate proving live leases are not
  stolen, expired leases are taken over with a higher epoch, occurrence identity
  survives takeover, stale completion is fenced, and failure backoff preserves
  the original occurrence.
- Added bounded recurring schedule aggregates and Prometheus
  `rhinoq_recurring_schedules{state=...}` gauges for enabled, paused, due,
  leased and failed schedules without reading payloads.
- Added `rhinoq_recurring_oldest_due_lag_seconds`, distinguishing a momentary
  due schedule from a scheduler backlog that has been late for minutes or hours.
- Extended the Go `rhinoq doctor` database gate with migration/store visibility,
  bounded recurring counts, recorded-dispatch-failure warnings and a backlog
  warning when the oldest due schedule exceeds one configured worker lease.
- Added operator-token-protected Agent endpoints to list recurring schedules
  without payloads and pause/resume them with tenant and version fencing.
- Added optional Workbench recurring reader/operator contracts and bounded
  no-store list plus version-fenced pause/resume endpoints. Existing Workbench
  compositions remain compatible until they opt into the capability.
- Wired the live Go Workbench composition directly to the public recurring
  facade, removing application-owned mapping for list and fenced pause/resume.
- Added a payload-free Recurring schedules view to the Go Workbench with tenant
  selection through `?tenant=`, bounded search, next-run/interval visibility and
  confirmed version-fenced pause/resume actions.
- Added `NativeRecurringDispatcher`, removing native PostgreSQL enqueue
  boilerplate while preserving explicit Task-to-queue routing and using the
  deterministic occurrence ID as the queue idempotency key.
- Added `defineRhinoQApplication()` and execution profiles: one typed Task
  registry now produces bound dispatchers/worker handlers, a stable manifest
  and one owner API + Task Center + Workbench mount without moving execution
  correctness out of the Go engine/runtime adapters.
- Added generated worker handler maps and a fail-closed multi-Task worker router,
  removing another registration switch while preserving declaration/version
  envelope checks.
- Added bounded `task.batch()` / `dispatchBatch()` with unique item keys and
  deterministic execution/idempotency identities, plus `task.external()` that
  requires effect safety policy at the type and runtime boundary.
- Added capability-gated delayed and priority dispatch policies. BullMQ applies
  both; SQS/custom adapters must explicitly advertise support or dispatch fails
  before reserving work.
- Added `dispatchAfter()` and `dispatchAt()` for one-off scheduled work without
  asking applications to calculate delay values or introducing a process-local
  recurring timer.
- Added `RhinoQModule.forApplicationAsync()` so NestJS starts/closes one compiled
  application and injects its typed Tasks, manifest and combined HTTP surface.
- Added `rhinoq measure --before --after [--out]` to report reproducible
  consumer-owned source reduction without presenting LOC as reliability or
  throughput evidence.
- Updated generated manual setup code to use the application compiler while
  keeping `createRhinoQApp()` and `app.task()` compatible.
- Refined Task Center and Workbench presentation without changing their
  structure or behavior: clearer visual sections, readable UI/monospace type
  hierarchy, stronger panel depth and a restrained blue graphite palette.

## 0.1.0-beta.15

- Corrected the published-package evaluation assertions to match the CLI's
  stable checklist output after beta.14 proved the PostgreSQL evaluation path
  passed but the release gate searched for URL labels that command does not
  print.

## 0.1.0-beta.14

- Fixed the installed-package registry smoke to resolve the exported OpenAPI
  contract through the package export map instead of a nonexistent root file.
- Corrected release-status and tenancy documentation, documented the temporary
  prerelease dist-tag policy, and synchronized repository discovery metadata.
- Extended registry smoke to run the published CLI against PostgreSQL and
  verify the installed package READMEs, Task Center and Workbench entry points.

## 0.1.0-beta.13

- Added direct npm package badges and links to the repository and packaged
  READMEs, and documented that `@rhinoq/node` is the canonical SDK while
  `rhinoq` is its synchronized short alias rather than a separate product.

- Reworked the repository entry point around the terms adopters actually use:
  background jobs, async Tasks, PostgreSQL queue, BullMQ, Task API, realtime
  SSE and job dashboards. Added matching npm discovery metadata without
  changing the product's beta or production-readiness claims.

- Fixed the compatibility gate on clean CI checkouts: it now reads the tracked,
  exactly pinned BullMQ example manifest instead of an intentionally ignored
  local lockfile.

- Added preview-first `npx rhinoq setup`, combining framework/database/runtime
  detection, existing init/adopt flows, schema/evaluation checks and
  non-overwriting integration/environment generation into one golden path.
- Added `app.task()` / `defineRhinoQTask()` so one declaration drives dispatch,
  a registered worker handler, progress and result metadata. Retry is disabled
  by default and external effects require explicit safety policy.
- Added dependency-injected React `RhinoQTaskList`, `RhinoQTaskDetail` and
  `RhinoQProgress` components with accessible states, actions, theme tokens and
  the existing SSE/polling fallback.

- Reframe the product documentation around RhinoQ's complete, low-code async
  platform and automated setup path; keep outcome verification as the safety
  differentiator instead of presenting it as the product's only purpose.
- Record a fresh Node, Go and PostgreSQL local benchmark baseline, including
  the observed Execution-page scaling trend and the missing native-queue load
  evidence instead of turning local numbers into a production claim.
- Promote the native PostgreSQL-backed Go queue to a first-class onboarding
  path, with a dedicated guide covering runtime choice, minimal registered
  worker code, Node-producer interoperability, operations and production gates.
- Add a copy/paste beginner quickstart with one bounded success criterion,
  platform-specific environment setup, cleanup and first-run troubleshooting;
  reorganize production guidance into explicit go/no-go gates.
- Add a Windows orchestration command for the disposable PostgreSQL
  primary/streaming-standby failover drill, with configurable collision-free
  ports and automatic container/volume cleanup.
- Add `rhinoq eval`, a bounded PostgreSQL, durable-fixture, owner API, Task
  Center and Workbench check that reports explicit PASS/FAIL/NOT VERIFIED
  results and refuses to turn loopback checks into browser, provider or
  failover claims.
- Complete the `report-export` guarded-recovery example with separate browser
  sessions for support preview and approver execution, including an explicit
  lost-response replay path that reuses the idempotent recorded result.
- Add a CI-gated compatibility matrix derived from the Node CI matrix, service
  images, BullMQ lockfile and Go toolchain, with migration-026/non-superuser
  rehearsal boundaries stated explicitly.
- Add a real-PostgreSQL HTTP isolation test proving owner Task reads return 404
  across tenant and owner boundaries, complementing the full-profile
  non-superuser/non-BYPASSRLS storage harness.
- Add a browser notification transport fixture covering 204, 429, 503, 403 and
  timeout outcomes with bounded retry counts and stable event-ID evidence,
  explicitly labelled as local rather than external-provider proof.
- Record a local remediation campaign covering `rhinoq eval`, two-actor
  recovery replay, notification outcomes, HTTP tenant isolation, 450-item
  BullMQ settlement and Redis restart, with external-provider, multi-host and
  design-partner evidence kept explicitly open.
- Add a browser-usable `/operator-login` reference flow to the runtime-neutral
  app composition. It exchanges the configured token for an opaque HttpOnly,
  SameSite cookie scoped to `/admin`, while retaining header authentication for
  non-browser operator clients. The BullMQ fan-out example now provides the
  same browser journey at its `/admin/rhinoq` mount.
- Synchronize current installation and operator guides with beta.12, and make
  the release-documentation CI gate reject stale prerelease references across
  those guides instead of checking only package READMEs.
- Fix the `report-export` example test to import `GuardedRecovery` from the
  installed `@rhinoq/node` package instead of the repository-relative SDK
  build, so the example remains testable when copied outside this checkout.
- Fixed the release-documentation CI gate so branch builds validate against
  the package manifest version instead of treating the branch name as a
  release version. Tag builds and explicit release-version checks are
  unchanged.
- Mark Failure Lab output as simulated workflow evidence with no external
  provider call, and distinguish workflow verification from provider outcome.
- Add deterministic runtime identity validation, machine-readable adoption
  checklist diagnostics, and owner/tenant-aware local, proxy and S3-compatible
  result adapters.
- Add production, live UI, first-real-app, adopter responsibility and honest
  code-reduction guides.
- Add a shared runtime event parity fixture and bounded webhook transport retry
  that preserves the notification event ID. Durable delivery remains owned by
  the Go ledger.
- Extend `TaskUIModel` with explicit result availability and business
  verification status, including `not_configured`.
- Add fail-closed `init --example report-export`, explicitly simulated transport
  and missing-output demos, and an acceptance-first LOC benchmark harness that
  refuses to emit a claim until both real implementations pass.

- Corrected root and packaged README release status for the verified beta.12
  artifacts. CI now rejects version drift across package manifests,
  `SDK_VERSION`, release documentation and generated build metadata; registry
  smoke also validates the README and build information from the installed
  package.
- Added a production-shaped `report.export` consumer using the published npm
  package, stable server-side owner/tenant sessions, authorized result
  resolution, real filesystem readback and separate technical/business
  outcomes. `createRhinoQApp().http()` now forwards tenant authorization and
  application-owned cancellation hooks so unsupported actions can be rejected
  before Task mutation.
- Portable applications now advertise owner cancellation only when an
  application-owned `cancelTask` composition is configured; a runtime
  capability alone is insufficient to select references and handle unknown
  external outcomes. Otherwise the API returns structured
  `RHINOQ_UNSUPPORTED` before any Task store read or write. Invalid
  cancellation fences now include the field, expected shape, next action and
  contract link.
- Added a packaged OpenAPI 3.1 owner API contract at
  `@rhinoq/node/openapi.json`, with a build-time consistency gate for version,
  all 25 owner operations and capability fields. OpenAPI and contract build
  inputs are included in artifact provenance hashing. Browser-client
  `RhinoQError` now retains
  `field`, `expectedShape`, `nextAction` and `docs`; retry and result
  configuration failures provide actionable structured responses.
- Added business-verification onboarding and a production-shaped report
  recovery composition with preview, separate approval, idempotency fencing,
  provider readback and mandatory post-check. Unknown readback consumes the
  fence as `uncertain` and replay performs no second provider write.
- Shadow Mode reports now include a machine-readable eight-item checklist for
  identity, tenant/owner boundaries, result resolution, verification,
  cancellation, reconciliation and durable multi-replica reporting.
- Added a gated 15-scenario fault evidence inventory spanning transport,
  duplicate delivery, provider uncertainty, authorization, secret redaction
  and PostgreSQL/projector interruption. It is explicitly local evidence, not
  a production-readiness claim.

## 0.1.0-beta.12

- Added the runtime-neutral `createRhinoQApp()` composition root. It installs
  the Task profile, starts portable adapters and mounts the owner Task API,
  Task Center and operator Workbench from one middleware, including runtime
  capability reports. The manual example now opens this same UI surface.
- Completed the disposable Failure Lab loop with `--recover`: deterministic
  preview, separate approval, guarded repair, simulated output evidence,
  verified evidence, post-check and a shareable incident summary.
- Added `rhinoq adopt --adapter <name> --observe` preview/apply. It generates a
  non-overwriting generic composition with durable adoption facts and an
  explicit identity resolver; unresolved identities remain visible.

- Fixed the portable BullMQ public type contract: observe/track configuration
  cannot supply a Queue, while dispatch configuration requires `queue`,
  `jobName` and stable `jobId` together. Constructor errors now identify the
  missing dispatch field instead of failing later with an adapter-level error.
- Fixed runtime-neutral `single-execution` success projection so terminal Task
  progress is synchronized before the Task becomes immutable. A successful
  Task with no prior progress now reports `1/1`; an explicit total is completed
  while retaining its progress message.
- Reworked Node CLI help around user goals before adapter choice, and made
  Workbench action labels distinguish actions available in the page, external
  tool links and workflows that are not configured.
- Marked the portable APIs as main-only while beta.12 was being prepared; the
  release documentation is updated after its registry publication smoke.

- Added the first public runtime-neutral Node adapter contracts for durable
  `(runtime, scope, externalId)` identity, portable lifecycle events,
  observations and capability-based optional operations. Boundary validators
  fail closed when failure terminality, unknown-state reasons, timestamps,
  attempts or progress are ambiguous. Added a portable, per-reference serialized
  projector, generic Observe/Track/Control integration and manual adapter proof.
  Reserve/bind can resume after a crash, and a dispatch accepted by the runtime
  but not durably bound becomes non-retryable `RHINOQ_RUNTIME_DISPATCH_UNCERTAIN`
  with its receipt. Existing BullMQ APIs and behavior are unchanged. Generic
  inspection reconciliation, guarded cancellation, health/capability gap
  reports and a read-only adapter conformance testkit are included. Added a
  development-preview BullMQ
  runtime adapter that translates QueueEvents, explicit terminal failure,
  progress/results, dispatch receipts, inspection, cancellation and health into
  portable contracts. Translation failures degrade health instead of being
  silently swallowed; the legacy BullMQ facade remains the supported path
  during parity migration.
- Added `GuardedRecovery` with deterministic repair IDs, preview/precondition
  enforcement, separate approval, a memory/PostgreSQL idempotency ledger and a
  mandatory post-check that leaves unknown evidence `uncertain`. A lost execute
  response consumes the idempotency fence as `uncertain` instead of permitting
  a blind second mutation; reusing a key with a different repair payload is
  rejected. The existing Go repair service remains the mutation authority.
- Added resolver-backed observe-only Shadow Mode. An event for an unknown
  runtime reference may be mapped to stable Task/Execution identity, bound
  durably and replayed once through the portable projector without changing the
  producer or worker. Mismatched identity fails before writes; unresolved work
  remains counted rather than becoming a guessed Task. Added an in-process
  adoption report containing only observed events, references, bindings,
  retries, uncertain/terminal outcomes and capability gaps. Added an explicit
  PostgreSQL adoption-event profile with event-id deduplication and aggregate
  reports across replicas; process-local reporting remains the safe default.
- Added the SQS proof adapter. It models polling/redelivery and unknown
  readback, keeps cancellation unsupported, and accepts host-owned send/inspect
  callbacks without importing the AWS SDK. Added
  `createBullMQPortableIntegration()` as the compatibility-facade migration
  composition over the portable adapter/projector.
- Added `rhinoq lab run completed-but-missing-output --confirm-disposable` and
  the reusable Failure Lab service. The deterministic scenario records a
  succeeded Execution without output evidence, leaves its Task uncertain and
  returns an evidence-backed incident explanation with affected scope and one
  read-only recheck action. The CLI refuses before connecting to PostgreSQL
  unless disposable-database confirmation is explicit.
- Added a deterministic Incident Explainer to Workbench Task detail and a
  focused operator-authorized endpoint. It separates technical Task/Execution
  state from verified/violated/unknown business outcome and returns bounded
  evidence, affected scope, evidence-backed causes and guarded actions. Runtime
  capability reports now hide unsupported cancellation in the UI and make the
  backend refuse it before Task mutation.
- Refreshed the embedded Task Center and Node Workbench with one responsive
  mineral/ink visual system, clearer page and section hierarchy, denser
  operator tables, calmer user-facing Task cards, consistent status language,
  visible keyboard focus and polished light/dark modes. Their authorization,
  payload boundaries and server contracts are unchanged.
- Fixed `PostgresProjectorLease` handling for an asynchronously terminated
  checked-out `pg` client. The lease now consumes the client `error` event,
  invalidates ownership immediately and destroys the broken session instead
  of allowing PostgreSQL `57P01` to escape as an uncaught exception.
- Added a provider-neutral Runtime Health contract, a bounded read-only BullMQ
  inspector, and an operator-only Workbench overview for queue counts, pause
  state and worker visibility. Added safe optional queue/job deep links while
  deliberately keeping runtime mutation controls out of RhinoQ. Runtime health,
  Task buckets and open Task detail now travel in the same authorized
  SSE/polling snapshot so the interface cannot present disconnected moments.
- Synchronized release documentation after the verified beta.11 publication
  and added a no-coaching external usability pilot with explicit activation,
  ease and incident-resolution gates.

## 0.1.0-beta.11

- Fixed a fan-out settlement race where a progress synchronization could retain
  a pre-terminal PostgreSQL snapshot (for example `49/50`) and the settlement
  callback could then close the Task before progress converged to `50/50`.
- Fixed the npm release workflow so `@rhinoq/node` and `rhinoq` use GitHub OIDC
  trusted publishing and never fall back to a token that can trigger an
  interactive OTP challenge. Added a release-workflow regression check.
- Removed the unreleased `create-rhinoq-app` scaffold. Evaluation now starts
  from an existing Node.js/BullMQ application and the supported integration
  example.
- Added Task schema v10 durable notification outbox with lease-based claim,
  complete and retry/failure transitions; custom delivery callbacks remain
  optional and application-owned.
- Added tenant authorization hooks for the Node Task HTTP surface, owner/tenant
  fenced artifact refresh, Flight Recorder attempt comparisons, source-authored
  waterfall spans and bounded diagnostic download.
- Added queue-control row locking for concurrent admission, a default Go queue
  watchdog for at-risk/stuck/growing backlog and reaper health, plus a real
  recovery sidecar entrypoint at `cmd/rhinoq-worker`.

## 0.1.0-beta.10

- Release candidate for the connected Async Operations Hub, including the
  owner waiting inbox, Task discovery/detail polish and the two-package npm
  release matrix. Prerelease packages publish under `next`; `latest` is not
  moved until a stable release decision.
- Added explicit owner-scoped At risk/Stuck policy, append-only Task
  verification records and Recently verified, tenant-aware Node HTTP/SQL
  reads, and Artifact v1 metadata with checksum, expiry, versioned refresh and
  lineage. Private artifact references remain application-only.
- Connected Task-correlated ProviderOperations to the Flight Recorder and
  added a fail-closed verification-to-Finding-to-durable-notification helper
  with operator deep links.
- Added the two-package prerelease publish and registry smoke pipeline for
  `@rhinoq/node` and `rhinoq`.

- Added a bounded owner-scoped waitpoint list route and browser client method.
  Task detail now explains pending input/webhook waits and resolves approval
  waitpoints in-place with version fencing and deterministic resolution identity.
  A bounded `GET /tasks/_waitpoints` inbox now powers the owner-facing
  “Waiting for me” Overview bucket without per-Task reads.
- Added responsive Task Center search, attention/active/finished filters and
  sorting with bookmarkable URL state. Owner Task detail now makes result
  availability, cancellation posture and recorded verification uncertainty
  explicit without claiming that a completed runtime outcome is verified. Long
  attempt histories can now be loaded incrementally through the owner cursor API.
- Connected the Task Center and operator Workbench with same-tab product
  navigation, added evidence-based Overview counts, and added an owner-facing
  `/task-center/{taskId}` detail with progress, next action and an attempt
  timeline. Runtime job identity remains in Workbench only.
- Added `GET /tasks/_capabilities` so Task Center does not render retry or result
  actions whose application handlers are absent. Result reads now fail closed
  with `RHINOQ_RESULT_NOT_CONFIGURED` when no authorized resolver is configured,
  instead of returning a durable storage reference to the browser.

- Added one plain-language Task explanation contract across Task Center and the
  Node Workbench: status headline, progress, retry-safety posture and next
  action. Workbench now opens on Needs attention and shows guidance in both the
  list and detail view. Generic and partial failures no longer claim retry is
  safe without external-effect evidence; tests cover every Task state and
  latest-attempt item counting.

- Reframed the product message around the people using async work—end users,
  developers and operators—rather than the first runtime adapter. BullMQ is now
  described as the production-shaped adapter available today, not RhinoQ's
  identity or headline.

- Fixed the Node operator journey: the Workbench link now opens a local sign-in
  form instead of a guaranteed 403. The token is exchanged
  for an HttpOnly, SameSite cookie scoped to `/admin`, is no longer embedded in
  page markup, and the evaluation server binds to loopback. Updated the current
  competitive review and release priorities from official product docs.
  The generated Queue now declares its retry policy once at construction, so
  first-run output does not show a misleading missing-retry warning.

- Added `app.http({ operatorToken })`, the default one-mount HTTP journey for
  async tasks: owner-scoped API at `/tasks`, user Task Center at
  `/task-center`, and protected operator Workbench at `/admin`. Updated the
  Node onboarding narrative so first value is one initialization, one
  middleware and one dispatch call; lower-level composition remains available.

- Added a generic Node Task Workbench Async Flight Recorder. It joins Task,
  Execution, result and durable waitpoint observations into a versioned,
  operator-gated timeline with deterministic attention explanations, including
  fail-closed handling for uncertain results and expired approvals. Added the
  domain-neutral `npx rhinoq fixture async` onboarding scenario.

- Added a bounded `WaitpointExpiryScheduler` for the Node Task profile. It runs
  the database-time expiry command without overlapping sweeps, reports expired
  counts to an application-owned escalation hook, and fails closed on scheduler
  errors. It does not invent notification or retry policy.

- **Fixed (correctness): a BullMQ fan-out could hang forever, and usually did.**
  On a 50-item batch the example settled on roughly one run in three. Every
  stuck item had `completed` in BullMQ and a non-terminal Execution in RhinoQ,
  and the stuck indexes always clustered at the front of the batch. Three
  separate causes, all in the dispatch window:
  - A job whose worker finished between `Queue.add` and the durable bind
    produced its entire event sequence against an attempt still at
    `pending_dispatch`. The state machine refused those events and the bridge
    dropped them silently, so the item stayed non-terminal permanently.
    `pending_dispatch -> running|succeeded|failed|stalled` is now legal for an
    attempt that already carries its runtime identity, and `bind_execution` is a
    no-op rather than an error when its first event won the race.
  - `complete()` moved the *Task* to running before closing the attempt, and
    that command fences on the Task version — which every concurrent dispatch,
    bind and completion is advancing. The read-modify-write lost repeatedly, the
    projection threw, and the item was never marked succeeded. The attempt is
    now closed first, on its own per-attempt fence.
  - Fan-out progress was a read-modify-write per completion, and the
    exactly-once settled signal ran downstream of it, so a lost progress write
    took the batch signal with it. `rhinoq_task.sync_item_progress` recomputes
    progress under the Task row lock in one statement with no fence to lose, and
    the settled signal now fires even when the aggregate write did not survive.
- **Fixed (correctness): two events for one job could be applied in either
  order.** QueueEvents delivers a job's events in order, but the listener
  started each projection without waiting for the previous one. On a fast job
  the `active` of a retry and the `failed` of the attempt before it overlap, and
  applying them backwards made the bridge open an attempt the runtime had
  already finished with — which then sat `dispatched` forever waiting for events
  that were delivered before it existed. Roughly one item in a hundred: frequent
  enough to hang a batch, rare enough to look like something else. Projections
  are now chained per job id, so different items still project concurrently.
  Added `bridge.drain()` for the shutdown window between an event arriving and
  being written down.
- **Fixed (correctness): a BullMQ retry was never recorded as a second
  attempt.** BullMQ emits no `failed` QueueEvent for an attempt it is about to
  retry — the sequence is `active -> delayed -> waiting -> active -> failed` —
  so the retried run was projected onto attempt 1 and the per-attempt history
  claimed every item ran exactly once. The bridge now reads `delayed` and ends
  the attempt as `stalled`, which is also the one state the settled signal
  refuses to count, so a batch cannot be declared complete in the gap between an
  attempt ending and its replacement starting.
- **Fixed (correctness): cancelling a fan-out stopped at the first job it could
  not stop.** One item that happened to be running left the other 199 queued
  jobs to run to completion after the user pressed Cancel. Every job is now
  asked, the outcome reports the worst result, and the attempts that did stop
  are closed — so a removed job cannot strand its Execution at `dispatched`
  forever, which would have made cancelling the reason a batch never finishes.
- **Fixed: `POST /tasks/:id/cancel` rejected almost every cancellation of a busy
  batch.** `expectedVersion` is the right fence for a read-modify-write and the
  wrong one for an intent: a fan-out advances the Task version several times a
  second, so a version a browser read was already stale when the request landed,
  and the busier the batch the more reliably Cancel returned 409. The field is
  now optional; omitting it converges server-side. Callers who want the fence
  keep it by sending it.
- **Added: `rhinoq({ pool, queue, events })`.** A high-level entry point that
  makes the decisions with one right answer for a queue-backed fan-out —
  `terminalProjection`, the retry projection, the projector lease, the terminal
  failure classifier, the reconciliation sweep and cancellation — and exposes
  `dispatch`, `cancel`, `audit`, `reconcile`, `routes()` and `workbench()`. The
  long-form API is unchanged and reachable through `app.bridge`/`app.tasks`.
- **Added: `objectExists`, `httpReadBack`, `rowMatches` and
  `recordVerification`.** A Rule is SQL under a role that may not have network
  functions, so no Rule can HEAD an object or read a provider back. These are
  the loop every adopter was writing, with `unknown` kept as a third outcome so
  a timeout cannot vote that a subject is fine.
- **Added: `npm run smoke` in `examples/fanout-bullmq`, gating in CI.** Runs
  batches in two shapes — zero-length jobs at high concurrency, then the
  example's normal timings — and exits non-zero unless every item reaches a
  terminal state and the settled signal fires exactly once per batch. The
  defects above survived every manual review, the author's included, because a
  green run is not evidence about a race.
- **Added: `TaskSummary.itemCounts`.** `executionCounts` counts attempts, so a
  200-URL batch with three retries reads `total: 203` on the screen next to the
  200 URLs the user pasted in. `itemCounts` counts items and carries `retries`.
  Show `itemCounts` to users and keep `executionCounts` for operators.
- **Added: `dispatchMany(items, { awaitEnqueue: false })`.** Returns once every
  item is durably reserved, without holding the request open for the whole
  enqueue. On a 200-item batch a measurable share of the work used to be done
  before the caller had the Task id, so the first progress bar a browser drew
  started around 45%.
- **Added: `bridge.auditTask()` / `app.audit()`.** Lists every attempt whose
  stored state disagrees with the queue — the join that previously had to be
  written by hand while a batch was stuck. Read-only.
- **Changed: version conflicts now say what happened.** `RhinoQError.message`
  was the bare entity id, so a log line named neither the command nor either
  version. It now reads
  `transitionTaskExecution(job-x:item-7): expected Execution version 41, current version 58`.
- **Added: `RHINOQ_WRONG_VERSION_SCOPE`.** Passing `TaskSnapshot.entityVersion`
  to an Execution command used to raise `RHINOQ_VERSION_CONFLICT` —
  indistinguishable from real contention, so the reasonable response is to
  re-read and retry, which never terminates. The two axes are also now named
  apart in the TypeScript signatures: `expectedTaskVersion` and
  `expectedExecutionVersion`.
- **Added: `dispatched -> succeeded|failed`.** A runtime that reports a result
  without ever reporting a start — a webhook, a batch callback, or two events
  delivered out of order — was refused and its item stranded at `dispatched`,
  which also means its batch never settles.
- **Changed:** Task schema migration 007. It redefines functions only, adds no
  columns and takes no long locks; `settle_items` moves from the stored attempt
  counters to the live attempts, which is what makes it correct in the presence
  of a superseded `stalled` attempt.
- Added [`docs/two-doors.md`](docs/two-doors.md) and
  [`docs/what-you-still-write.md`](docs/what-you-still-write.md). The first
  names the one architectural decision that flips the code-reduction number from
  −37% to +8% and was previously mentioned nowhere; the second is the list an
  adopter had to assemble themselves, one surprise at a time.
- Added durable Task waitpoints for input, approval and webhook pauses: Go
  authoritative state machine, memory/PostgreSQL persistence, isolated Node
  Task schema v7 commands, owner-scoped application routes/client, bounded
  expiration scheduler, React input store/hook and signed HMAC capability token
  primitive. Duplicate resolution identity replays the committed answer;
  mismatched payloads fail closed. Full-profile settlement also appends one
  `task.waitpoint.resolved` outbox intent atomically for crash-safe resume.
- Added the first Task Group layer: `dispatchBatch()` with admission bounds,
  latest-attempt parent/child view, partial-failure counts, bounded
  `retryFailed()`/`cancelPending()` command composition, failed-item CSV/JSON
  export and per-item result manifest generation. Per-item retries carry each
  committed aggregate version forward with stable source/next Execution IDs,
  avoiding optimistic-lock races between durable child commands. Active work is never selected
  by `cancelPending()`.

- Added owner-scoped Task SSE for individual Tasks and Task inbox pages. Streams
  emit versioned authoritative snapshots, honor `Last-Event-ID` for one Task,
  send heartbeats, clean up on disconnect and enforce a per-handler connection
  budget.
- `ApplicationTaskClient`, TaskStore, TaskListStore, React live hook aliases and
  both Task Center variants now prefer SSE, reject stale versions and fall back
  to snapshot polling before retrying a lost stream. Node/Nest and Fastify raw
  adapters pipe response bodies instead of buffering an infinite stream.
- Task Center now has loading skeletons, action busy states, live/fallback
  connection status, explicit Finished/Not-finished badges and accessible
  terminal completion/failure announcements.

- Added bounded, oldest-first ProviderOperation attention queries through the
  Go Application, memory/PostgreSQL stores, Agent HTTP API and Node client.
- Added `ProviderOperationReconciler`, which can only run registered read-back
  verifiers and never receives the provider mutation callback. Missing
  verifiers fail closed by skipping the operation.
- Added `effectCapabilityReport()` so applications can claim
  effectively-exactly-once per declared effect only when stable identity,
  provider idempotency, confirmation and proof-gated retry are all present.

- Nest adoption now supports a per-queue manifest through repeated
  `--task queue=task.type:single|fanout`, reports uncovered queues, locates raw
  `queue.add()` producers by file/line and exports the generated manifest.
- Added `adopt --verify-url` to distinguish generated/imported code from a live
  vertical slice. It verifies application health and Task Center reachability;
  optional authentication headers come from an environment variable.
- Integration startup now awaits BullMQ `QueueEvents.waitUntilReady()` when
  available and health reports `ready`, `down`, `unverified` or `closed`.
- Multi-queue Nest modules now use isolated integration tokens. The generated
  owner health route aggregates every queue integration instead of silently
  reporting whichever shared token Nest resolved last.
- Added narrow `browser`, `react`, `bullmq` and `server` package subpaths with
  ESM and CommonJS smoke tests. Browser adopters no longer need to import the
  root surface that also exposes PostgreSQL and Nest lifecycle APIs.

- Added an authoritative durable Task retry boundary in Go/PostgreSQL.
  Migration 029 atomically persists command identity, the Task transition, a
  new Execution and a `task.retry.dispatch_requested` outbox event. Duplicate
  commands resolve to the same Execution; runtime publication remains
  explicitly at-least-once and must enqueue with that stable identity.
- Retry dispatch intents now carry and fingerprint queue, job name and JSON
  data. The Go Agent can recover them through an HTTPS/HMAC outbox publisher,
  and Node provides a registered-queue BullMQ receiver that converges a lost
  HTTP response on the immutable Execution `jobId`.
- Retry-dispatched BullMQ jobs now explicitly disable automatic removal on
  completion and failure, so a fast job cannot disappear in the interval
  between enqueue and durable outbox acknowledgement.
- Added real PostgreSQL/Redis/BullMQ fault evidence: after `Queue.add()` the
  test drops the HTTP acknowledgement and lets the first Agent stop; a second
  Agent redelivers the unpublished outbox event and converges on one retained
  BullMQ job. The PostgreSQL harness also races two identical retry commands.

- Hardened the NestJS adopter after an external pilot: `adopt` now discovers
  registered queue names, refuses ambiguous multi-queue apply, accepts repeated
  `--queue`, generates a TypeScript Nest module with one shared PostgreSQL pool
  and owned `QueueEvents` lifecycles, patches `AppModule`, and verifies the
  import instead of reporting success for an unused root `.mjs` file.
- The Nest API is also exported from the package root for older Nest TypeScript
  projects using legacy Node module resolution. BullMQ's concrete Queue type is
  now structurally accepted without casts.
- Adoption no longer calls PostgreSQL "existing" when no connection is
  configured. `--local-postgres` can generate a loopback-only, non-overwriting
  Compose service for evaluation.
- Node/Nest middleware can resolve an authenticated owner from the original
  framework request such as `request.user.id`. Nest adoption can mount the
  owner Task API and a self-contained Task Center when `--owner-property` is
  explicitly supplied; no client-controlled owner header is invented.

- Added an adopter-facing Task vertical slice: owner-scoped list/detail/history,
  cancel, command-identified retry, authorized result resolution and health
  routes; `useRhinoTasks()`/expanded `useRhinoTask()` hooks; framework-neutral
  UI state semantics; and a ready-to-use Task Center.
- Added declared BullMQ Task definitions, a fail-closed BullMQ cancellation
  adapter and owner-aware signed result URLs. Retry execution remains an
  application-owned durable command/outbox boundary; the SDK does not claim
  crash safety for an arbitrary enqueue callback.

- Added the low-friction `createBullMQIntegration` preset and preview-first
  `npx rhinoq adopt` generator. The preset reuses the application's PostgreSQL
  and BullMQ objects, enables bounded known-job reconciliation by default and
  still requires explicit single-job versus fan-out semantics.
- Tightened the preset and adopter CLI after an onboarding audit: Queue names
  now supply the default runtime scope, `adopt --apply` refuses to guess Task
  semantics, missing dependencies remain a useful preview instead of an early
  failure, and an existing generated file is reported as unchanged.
- Added `@rhinoq/node/nest`, so Nest lifecycle wiring ships from the same
  versioned package instead of requiring a separately installed local package.

- **Breaking (deployment):** migrations 026 and 027 introduce the tenant
  boundary and change what a working connection needs. **Put
  `?options=-c%20rhinoq.tenant_id%3Dtnt_system` on `RHINOQ_DATABASE_URL` and
  deploy that first, before applying the migrations.** On the old schema the
  parameter is ignored, so it ships safely on its own; after 026 every
  `tenant_id` column is `NOT NULL` and defaults to the session tenant, so an
  older binary keeps writing normally without ever naming the column. A
  connection that announces no tenant reads nothing and cannot write. Full
  procedure in [`docs/migration-rollback.md`](docs/migration-rollback.md).
- **Breaking (deployment):** `rhinoq doctor` now FAILs when the database role
  holds `SUPERUSER` or `BYPASSRLS`. PostgreSQL exempts both from row-level
  security including `FORCE`, and the official `postgres` image makes
  `POSTGRES_USER` a superuser — so that configuration silently ignores every
  tenant policy while every test still passes. Connect the runtime as a role
  created `NOSUPERUSER NOBYPASSRLS`; migrations still run as the owner.
- **Breaking (multi-environment):** `rhinoq_queue_controls` is now keyed by
  `(tenant_id, queue_name)`. Pausing a queue no longer affects a queue of the
  same name in another tenant. Single-tenant deployments see no change.
- Added tenant isolation enforced by PostgreSQL rather than by application SQL.
  Every tenant-owned row carries `tenant_id`; twelve tables carry forced
  row-level policies keyed on one session variable; and
  `rhinoq_task_executions` and `rhinoq_provider_operation_evidence` reference
  their parent by `(id, tenant_id)`, so a child row in the wrong tenant is a
  constraint violation rather than a policy question. A forgotten `WHERE` now
  reads zero rows instead of another tenant's data.
- Added `internal/domain/authz`: tenants, principals, memberships, six built-in
  roles and one decision point. The role gate and the tenant gate are
  independent — an `owner` of one tenant holds every permission and still
  cannot read another tenant's Task — and cross-tenant denials are concealed as
  not-found, so an endpoint cannot be used to test whether an id exists
  elsewhere. The agent's HTTP surface is **not yet** wired to this and still
  authorises with one operator token plus a per-owner credential list. See
  [`docs/tenancy.md`](docs/tenancy.md).
- Added `scripts/failover-drill.sh` and a two-node streaming-replication rig.
  It kills the primary with SIGKILL, promotes the standby with `pg_promote()`,
  confirms recovery ended and writes to the promoted node before reporting
  anything. One run recorded: 150 of 150 acknowledged writes survived and
  policies stayed forced after promotion. One host, no witness, no fencing —
  split brain is untested and this is not a high-availability claim.
- Added `tests/postgres/adopter_workload_bench_test.go`, which measures Task
  summary polling and Execution paging at fan-out 100/1,000/5,000 — the only
  form in which "polling stays bounded" can be falsified. Summary is flat.
  Paging was not: migration 028 adds the index matching the keyset order,
  taking a page of fifty at fan-out 5,000 from 6.84 ms to 1.92 ms and flat.
  Both the index and current table statistics are needed; with stale statistics
  the planner picks a bitmap scan and sorts everything anyway.
- Added `scripts/code-reduction.sh`, which measures an adopter repository
  between two refs and leaves the process, datastore and credential rows blank
  because those are not derivable from a diff. RhinoQ still has **no**
  code-reduction claim; `docs/adoption-gap.md` stands at 0 lines removed.
- Added the standard Node/BullMQ integration boundary and the standalone
  `@rhinoq/nest` package. Its async module factory waits for Task schema
  readiness, defaults the BullMQ projector and reconciliation scheduler to
  PostgreSQL advisory leases, wires health/metrics and starts/stops the bridge
  with the host lifecycle. It still requires an application-owned BullMQ
  runtime observer and does not move Task correctness into TypeScript.
- `TaskReconciler` now supports an owner lease, fails closed when it cannot
  acquire or verify that lease, exposes ownership/freshness diagnostics and
  reports lease contention/loss counters.
- BullMQ projectors expose ownership state for readiness checks. A scoped
  integration reports an unowned or lost projector as degraded rather than
  presenting a healthy database as a healthy projection path.
- Standby integrations retry projector ownership after contention; database
  or subscription errors remain visible through health and a counter instead
  of becoming an unhandled timer rejection.
- `npx rhinoq dev` now mounts the self-contained read-only Task Workbench at
  `/rhinoq`, so the Node-only onboarding path shows live state buckets and
  per-attempt detail instead of a latest-25-Tasks table.
- `BullMQTaskBridge.track()` now fails closed when a second job omits
  `itemKey` after an unkeyed item already exists. A missing key otherwise turns
  fan-out items into attempts of one `default` item and corrupts settlement.
- BullMQ dispatch bridges warn when the supplied Queue exposes no default
  `attempts` retry policy. Per-job options remain supported; the warning makes
  an intentional policy explicit before a production failure hides retries.
- The embedded Task-only PostgreSQL profile adds `onceForItem()`, which claims
  a named effect across BullMQ attempts in the same transaction as the
  application write and returns `{ executed: false }` for a committed repeat.
- BullMQ retries now close the current RhinoQ Execution on every `failed`
  event, while `isTerminalFailure` controls only parent-Task terminalization.
  A one-based attempt in a reconciliation observation also repairs a gap where
  both the failed and active events were missed. `reconcileTask()` reads the
  latest embedded Task runtime references in one bounded query.
- Duplicate BullMQ projectors now fail fast within one process. The Node SDK
  also exports `PostgresProjectorLease`, a session advisory-lock owner for
  cross-process `runtimeScope` coordination; it adds no Task-profile table.
- `TaskReconciler` contains throwing error reporters, so a broken logger cannot
  abort the rest of a reconciliation sweep.
- The Node SDK now exports `PostgresProjectionFailureSink`, the parameterized
  idempotent writer for the application-owned projection-failure table. Replay
  remains a scheduled application reconciliation decision; the Task profile
  still owns exactly three tables.
- The Node failure sink now has a standard inbox workflow with pending,
  replaying, replayed and ignored states, row-level claim leases, retry timing
  and a fail-closed replay helper. The table remains application-owned and the
  runtime-specific replay callback remains outside RhinoQ.
- Added Effect Ledger Lite to the Node Gateway client. It derives a stable
  command key, hashes the JSON request and sends the fingerprint to the Go
  ProviderOperation ledger, which rejects reuse of one key for a different
  request shape.
- Added a durable Go notification scheduler. Findings can be queued without a
  network call; PostgreSQL `FOR UPDATE SKIP LOCKED` plus a row lease elects a
  sender, exponential backoff records retry timing and bounded attempts end in
  an explicit `dead` state. Destination resolution and secrets remain
  application-owned.
- Added a Node HTTP ProviderOperation adapter. It injects the durable ledger
  idempotency key, rejects conflicting caller headers, bounds non-2xx response
  evidence and requires application-owned read-back confirmation.
- Added real PostgreSQL notification-lease takeover and projector-session-loss
  integration tests, plus a disposable BullMQ/Redis restart harness for the
  official fan-out example. These are local reproducibility evidence, not
  production reliability claims.

- `sdks/rhinoq/bin/` is tracked. The repository's `bin/` ignore rule was meant
  for Go build output at the root, but it is unanchored, so it also swallowed
  the three hand-written CLI shims of the `rhinoq` distribution alias. They
  existed on one machine and in no clone: publishing that package from a fresh
  checkout would have shipped three `bin` entries pointing at files that were
  not in the tarball, and the failure would only have appeared at `npx rhinoq`.
  The rule is now anchored to `/bin/`. Verified by installing the package into
  a scratch project and running all three commands.

## 0.1.0-beta.9

Published to npm as `@rhinoq/node@0.1.0-beta.9` on both `latest` and `next`,
alongside the `rhinoq` CLI distribution alias at the same version — the first
time that alias has been published at all. `latest` had been stranded on
`0.1.0-beta.1`, a build from before the Task profile existed, so a bare
`npm install @rhinoq/node` had been silently installing it.

The published tarball reports `commit 2623a96` with a clean tree and
`sourceHash 2ebe7a22`, which is what this checkout hashes to. That is the first
release whose contents can be checked against a commit rather than trusted.

Follow-up to the beta.8 audit. Every item here closes a gap the release left
open, or a claim it made that the repository could not back.

### Upgrading

1. Apply migration 023 **before** rolling out the new binary. It clears
   `evidence` on passing subject outcomes, adds a `CHECK` that keeps it clear,
   and drops a foreign key. A new binary is compatible with the old schema; an
   old binary against the new schema fails every scan on the `CHECK`. See
   [Migration recovery](./docs/migration-rollback.md#023_subject_outcome_hot_path)
   for the row-rewrite cost and how to export what it clears.
2. `rhinoq doctor` now exits 1 on any FAIL. A pipeline that already runs it and
   has been passing may start failing — that is the point, but expect it at the
   moment you deploy rather than later. `--ci` still works and prints a
   deprecation note, so no existing pipeline breaks.

### Rule evaluation performance

Measured against a production-shaped schema — cal.com's real 102-table Prisma
schema, 40 300 bookings and payments, 17 seeded drifts — a full scan took 138
seconds and stopped incomplete on its two-minute budget. The Rule's own SQL for
the same rows takes about 0.26 s. The rest was RhinoQ's own bookkeeping.

- Evaluation now folds a page in three phases — read the page's state, decide in
  memory, write the page — instead of deciding one subject at a time.
  `SubjectOutcomeStore` gained `GetSubjectOutcomes`/`SaveSubjectOutcomes` and
  `FindingStore` gained `GetFindingsForSubjects`, each one statement per page.
- A passing subject with no Finding no longer opens a transaction, takes an
  advisory lock and issues a `SELECT ... FOR UPDATE` to discover there is
  nothing to resolve. `finding.ApplyPass` always returned "no change" for that
  case, which is nearly every subject in a system worth running this against.
- The same 40 000-subject scan now completes in **2.4 s** in a single run, with
  the same 17 Findings and no false positives. PostgreSQL transactions for a
  2 500-subject run fell from 7 519 to 36.
- Subject outcomes no longer store evidence for passing subjects. Evidence
  explains why something is wrong; keeping it for everything made the
  materialized state larger than the business table it observes (16 MB against
  a 13 MB `Booking`). `rhinoq_subject_outcomes` is now 10 MB for the same data,
  and a `CHECK` enforces it. Migration 023 clears existing rows.
- Dropped the `rhinoq_subject_outcomes → rhinoq_rules` foreign key, which cost
  one index probe per written row — 40 099 lookups of a value constant for the
  whole page. `DeleteRule` now removes outcomes explicitly in the same
  transaction instead of relying on `ON DELETE CASCADE`.
- Added `BenchmarkScanHealthy` and `BenchmarkScanHalfViolated` to
  `tests/postgres`. The existing benchmarks measure domain functions at
  nanosecond scale, where RhinoQ was never slow; nothing in the suite could
  observe the cost above.

### Retention

- Added `rhinoq retention prune`. It previews by default like `rules delete`,
  deletes in bounded batches, and refuses a cutoff younger than 24h. It
  reclaims passing observations, lifecycle history of already-resolved Findings
  and settled delivery-ledger entries; it never touches an open Finding, a
  pending delivery, a repair or a ProviderOperation.
- Rewrote `docs/retention.md`. It previously gave fifteen lines of advice
  without naming `rhinoq_subject_outcomes`, the largest and fastest-growing
  table RhinoQ owns.

### Preflight

- **Breaking:** `rhinoq doctor` now exits 1 when any check FAILs. `--report` is
  the opt-out for a human reading the output. A preflight whose default is to
  exit 0 while printing FAIL is one a pipeline quietly passes, and the README
  documented `doctor` as the gate without ever mentioning the flag that made it
  one.
- `--ci` is deprecated but still accepted, so a pipeline that passes it keeps
  working and gets exactly the behaviour it asked for. It prints a note.
- Any other argument to `doctor` is now a usage error (exit 2). It used to be
  ignored, which meant a mistyped `--report` silently became a gate — and, once
  `--report` existed, a mistyped one could silently disable it.

### Workbench

- Fixed the subject investigation panel returning HTTP 500 with "rhinoq effect
  store is not configured". `NewPostgres` built the Effect Ledger store and then
  omitted it from the embedded `IntegrityClient`, so every fully configured
  PostgreSQL deployment failed to open the panel. `NewWithStore` had the same
  omission.
- `SubjectDetail` no longer treats a missing Effect Ledger as fatal. An
  integrity-only deployment — a Rule and a connection string, the path the
  README leads with — has no ledger by design, and the Findings, evidence and
  decision history were being hidden behind that failure. The gap is now a
  notice on the page.
- The interface is dark-only. The light theme, its toggle and the stored
  preference are gone: a theme switch is one more thing that can be wrong during
  an incident.
- Replaced the palette and the type. The stylesheet asked for `Inter` at the top
  and overrode it with `Bahnschrift` at the bottom, and shipped neither, so the
  same build rendered differently on macOS and Windows. It now uses the
  platform's own UI face. The gold accent is replaced by one blue accent, with
  amber, red and green reserved for state, and status badges carry enough
  contrast to be read at a glance.

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

## 0.1.0-beta.18


- Bundled the AWS S3 SDK as a runtime dependency of `@rhinoq/node`, so `artifacts: 's3'` and `createAwsS3ArtifactProvider()` work after the normal package install. The adapter remains lazy-loaded and the measured workspace cost is about 7.7 MiB.
- Added Task schema migration 014 with forced PostgreSQL RLS across every tenant-owned Node Task table, tenant-bearing child rows, composite parent references, artifact/execution tenant guards, live RLS inspection helpers, and direct SQL cross-tenant integration coverage. Node RLS deployments bind one tenant to each pool and use a NOSUPERUSER NOBYPASSRLS role.

- Security: tenant-fenced waitpoint settlement now requires tenant context;
  legacy unscoped resolution calls fail closed, waitpoint capabilities are
  schema version 2, and owner-scoped Execution reads/transitions reject
  cross-tenant access. Runtime-only unscoped Execution primitives are now
  documented as non-tenant APIs.
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
  1.25 and prefers patched toolchain 1.26.6; pgx is upgraded to 5.9.2 and
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
