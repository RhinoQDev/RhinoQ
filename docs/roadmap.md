# Implementation roadmap

The roadmap separates the Task Platform entry point, execution backends and the
optional Verified Tasks capability. Native PostgreSQL remains the first runtime
backend; it is not the product identity and existing runtimes may integrate
without migrating their queue.

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
- [ ] dispatch/retry/cancel/reconciliation contract for BullMQ adoption
- [ ] ProviderOperation domain foundation

Realtime transports, React hooks, streams and Redis fan-out are not part of the
first persistence slice. They follow only after snapshot convergence semantics
are tested.

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
- [x] embedded read-only developer Workbench with demo/live PostgreSQL modes

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
- [ ] handler and verifier version evidence

## Verified Tasks safe recovery

- [ ] resumable execution checkpoints
- [ ] repair dry-run and precondition checks
- [ ] approval policy and separation of duties
- [ ] signed audit checkpoints or WORM export

## Later, after design-partner evidence

- [ ] guarded, audited browser actions after read-only investigation is validated
- [ ] gRPC/Unix-socket gateway transport, only after real polyglot demand
- [ ] NestJS lifecycle integration after the framework-neutral Node SDK is validated
- [ ] retention and partition sweeper
- [ ] reproducible fault and benchmark suites
- [ ] public release and license decision

Do not start a second external-runtime adapter, DAG engine, automatic repair or
Outcome Level 2 before the Task slice and one BullMQ integration are validated
in a real application. Provider connectors remain examples until repeated
demand proves a reusable contract.
