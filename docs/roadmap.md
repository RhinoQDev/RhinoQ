# Implementation roadmap

The roadmap separates the Task Platform entry point, execution backends and the
optional Verified Tasks capability. Native PostgreSQL remains the first runtime
backend; it is not the product identity and existing runtimes may integrate
without migrating their queue.

## Release gates before more surface area

- [x] one-mount BullMQ golden path with owner API, Task Center and Workbench
- [x] operator sign-in that does not expose its token in page markup
- [x] connected Overview/Tasks/Workbench navigation and owner Task detail
- [x] capability-gated retry/result UI with fail-closed result resolution
- [x] publish the tested npm beta and prebuilt CLI artifacts (`v0.1.0-beta.11`)
- [ ] rerun two Tasks in a real adopter and record code/route/process/credential delta
  ([readiness audit](./evidence/adopter-pilot-readiness-2026-08-10.md): no valid beta.10 before/after refs yet)
- [x] wire tenant context through the public HTTP boundary
- [x] extend Flight Recorder through provider/effect confirmation evidence
- [x] explicit At risk/Stuck thresholds, Task verification records and Artifact v1
- [ ] browser acceptance in a real adopter application
- [ ] run a deployment-shaped fault campaign and end-to-end benchmark

The 2026-08-26 single-host Docker campaign now covers PostgreSQL integration,
primary SIGKILL/manual standby promotion, Redis process restart, lost Agent
acknowledgement and local PostgreSQL/adopter-shaped benchmarks. This gate stays
open for a real adopter, multi-host partition/fencing and provider-shaped
end-to-end latency; local containers are not relabeled as production evidence.

The current competitive review is in
[`docs/competitive-landscape.md`](./competitive-landscape.md). These gates take
priority over a DAG engine, another runtime adapter or generic streaming.

## v0.1 — Task Platform foundation

- [x] product baseline and ADR-0014
- [x] independent Task lifecycle, version, progress and result reference domain
- [x] Execution lifecycle with immutable native/external runtime binding
- [x] Task/Execution store ports and memory adapter
- [x] application create, bind and read use cases
- [x] public native/external Execution create/bind with aggregate version bump
- [x] application progress and lifecycle commands with expected-version checks
- [x] versioned snapshot DTO and contract tests
- [x] polling delivery through a public application boundary
- [x] PostgreSQL schema and store implementation after contract tests stabilized
- [x] execute migration 015 and the Task store contract against real PostgreSQL
- [x] persist cancellation outcome with migration 016 and real PostgreSQL coverage
- [x] add the Task store contract to CI's PostgreSQL job
- [x] public Go Task facade
- [x] Node Task client
- [x] framework-neutral Node Task watcher with stale-version rejection,
  terminal stop and abort semantics
- [x] shared Go/Node golden wire fixture for Task Snapshot and Result v1
- [x] version-fenced result-reference read/write through Go, HTTP and Node
- [x] BullMQ lifecycle bridge for explicitly tracked existing jobs
- [x] reserve-before-dispatch and bounded known-job reconciliation for BullMQ
- [x] preview-first adopter generator and BullMQ integration preset
- [x] fail-closed BullMQ cancellation composition through an application callback
- [x] first-class retry command identity and crash-recovery contract for BullMQ
- [x] ProviderOperation domain, PostgreSQL store and Stripe response-loss demo
- [x] lightweight Task Summary and stable Execution keyset pagination
- [x] snapshot-convergent owner Task and inbox SSE with polling fallback
- [x] durable input, approval and webhook waitpoints with version-fenced settlement
- [x] bounded owner waitpoint detail with in-place approval decisions
- [x] bounded owner waiting inbox and “Waiting for me” overview
- [x] Task Group batch dispatch, failed-item retry, pending cancellation and manifests
- [x] atomic retry command and at-least-once dispatch intent publication
- [x] bounded waitpoint expiry scheduler with application-owned escalation hook

SSE, React live hooks and streams remain the zero-configuration delivery path.
An optional dependency-free WebSocket hub now multiplexes many Tasks, coalesces
owner-scoped reads and bounds slow consumers without adding correctness state.
Redis/NATS invalidation and multi-region fan-out remain adapter choices until
measured adopter demand justifies their operational cost.

- [x] bounded worker progress coalescer with terminal flush and fault-visible writes
- [x] read-only TaskEvidencePassport projection with separate technical, external and business statuses
- [x] short `task`/`batch`/`media`/`effect`/`schedule` factories with compiled execution/resource/data-path metadata
- [x] read-only `npx rhinoq adopt --scan` Integration Eraser preview with confidence, file/line evidence, diff and reverse-patch artifacts
- [x] read-only Plan Inspector projection from compiled Task manifest to Workbench, including schedule/resource capsule
- [x] `defineRhinoQProject()` project profile binding pool, identity and operator mount
- [x] generic processor-pack lifecycle contract with bounded FFmpeg adapter
- [x] deterministic Autopilot observe/recommend report and operator-only Workbench panel
- [x] read-only Autopilot simulate/canary approval artifacts with `autoApply: false`

The project profile, processor-pack and Autopilot slices are implemented as
bounded composition contracts. Sharp/LibreOffice/malware/AI packs, automatic
patch application and Autopilot auto-apply remain intentionally unimplemented
until their provider and adopter evidence exists. In-process realtime
invalidation is automatic when the application supplies the optional invalidator;
cross-process invalidation remains an adapter/pilot concern.
See the dated [low-code upgrade status evidence](./evidence/low-code-upgrade-status-2026-08-14.md)
for the implementation/evidence split.

## Foundation — COMMIT and RUN

- [x] enqueue, idempotency and correlation
- [x] claim, lease, heartbeat and epoch fencing
- [x] classified retry and delayed execution
- [x] bounded worker concurrency and lease recovery
- [x] cancellation, pause/resume and queue rate limits
- [x] priority, FIFO and starvation aging
- [x] admission control and poison-job protection
- [x] six-step graceful shutdown
- [x] database time as clock authority
- [x] PostgreSQL adapter, migrations and real-database contract suite
- [x] append-only execution-attempt timeline
- [x] transactional SQL enqueue
- [x] queue-filtered claims for heterogeneous worker processes
- [x] Node.js producer/worker/operator SDK preview with automated tests
- [x] embedded loopback developer Workbench with read-only default and opt-in guarded actions
- [x] generic Async Flight Recorder projection for the Node Task Workbench
- [x] domain-neutral async onboarding fixture with failed attempt and expired waitpoint

## Verified Tasks foundation — previously v0.1 Integrity Slice

The release demonstration must detect one real business mismatch without
requiring the application's current queue to be replaced.

### Rules and effects

- [x] explicit Effect Ledger states and fenced transitions
- [x] explicit effect confirmation policy
- [x] legacy Outcome Level 1 domain foundation
- [x] one canonical, append-only Rule contract with `job` and `table` scopes
- [x] parameterized SQL executor with read-only transaction, statement timeout and
  bounded results
- [x] persisted scheduler cursor, fenced claims and crash recovery between bounded pages
- [x] query-cost, result-shape and large sequential-scan gate
- [x] external execution correlation:
  `source_system`, `source_job_id`, `business_key`

### RECOVER

- [x] finding domain lifecycle and deduplication rules
- [x] canonical per-subject Outcome state with Finding as the operational projection
- [x] configurable continuous-unknown grace escalation
- [x] persistent memory/PostgreSQL finding store and public Go/Agent API
- [x] manual table-scoped Rule evaluation folds violations/passes into Findings
- [x] Needs Attention backed by persistent findings
- [x] acknowledge, suppress, resolve and regressed operations with append-only events
- [x] guarded manual replay and transactional audit hash chain
- [x] business-subject investigation timeline
- [ ] reverse business-key/external-job search into a subject

### Adoption

- [x] bounded `rhinoq scan` over enabled table Rules
- [ ] `rhinoq init --from-scan` plan with baseline by default
- [x] one non-financial reference workload: a completed report whose
  output object is missing
- [x] no-cutover quickstart that produces the first Finding
- [ ] tagged npm release and prebuilt CLI binaries for Node adopters

## Verified Tasks hardening

- [x] versioned Rule contracts
- [x] crash-safe scheduled Rule evaluation
- [x] durable signal-first Rule evaluation with optional exact-subject query
- [x] tri-state Rule observations: passed, violated and unknown
- [x] finding suppression, deduplication and regression lifecycle
- [x] composite change cursor and bounded drain batches
- [ ] adaptive reconciliation budgets and producer backpressure
- [x] handler and verifier version evidence in operator Flight Recorder events

## Verified Tasks safe recovery

- [x] checksum/handler-version-fenced resumable execution checkpoints
- [x] repair preview and precondition checks
- [x] approval policy and separation of duties
- [x] apply idempotency token and post-repair verification
- [ ] signed audit checkpoints or WORM export

## Later, after design-partner evidence

- [x] guarded, audited recheck and safe-repair browser actions through Application callbacks
- [ ] gRPC/Unix-socket gateway transport, only after real polyglot demand
- [x] NestJS lifecycle integration through the `@rhinoq/node/nest` subpath
- [ ] retention and partition sweeper
- [x] Node SDK and Go domain/memory microbenchmarks plus fixed-seed browser disorder test
- [x] reproducible PostgreSQL concurrency and Task fan-out snapshot benchmarks
- [ ] runtime fault-campaign and end-to-end benchmarks
- [ ] public release and license decision
- [ ] multi-process/multi-cluster Control Plane design-partner pilot; this is
  deliberately not part of the data path and must not proxy large payload bytes

Do not start a second external-runtime adapter, DAG engine, automatic repair or
Outcome Level 2 before the Task slice and one BullMQ integration are validated
in a real application. Provider connectors remain examples until repeated
demand proves a reusable contract.
