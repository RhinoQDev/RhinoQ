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
- [x] reserve-before-dispatch and bounded known-job reconciliation for BullMQ
- [x] fail-closed BullMQ cancellation composition through an application callback
- [ ] first-class retry command identity and crash-recovery contract for BullMQ
- [x] ProviderOperation domain, PostgreSQL store and Stripe response-loss demo
- [x] lightweight Task Summary and stable Execution keyset pagination

**Realtime is settled, not deferred.** Polling versioned snapshots is the
delivery model for 0.1; SSE, WebSocket, streams and Redis fan-out are not
planned, and "realtime later" no longer appears on this roadmap as an unfinished
item. What makes polling sufficient is the shape of the data, not the interval:
an Execution-free Summary, keyset-paginated history, and an aggregate version on
every read so a UI can discard a stale response. The single measurement that
would reopen the decision is stated in [ADR-0023](../.ai/DECISIONS.md).

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
- [x] `rhinoq detect`: one command, a read-only role, no migration against the
  application's database and no write anywhere by default (ADR-0022)
- [x] prebuilt signed CLI binaries for Linux/macOS/Windows on every tag
- [x] container image carrying the CLI as its entrypoint
- [ ] **npm publish is stuck.** `@rhinoq/node` on the registry is
  `0.1.0-beta.2` (`next`) and `0.1.0-beta.1` (`latest`) while this repository is
  at `0.1.0-beta.7`. The release workflow is configured for trusted publishing;
  the package still has to be linked to this repository and workflow in the npm
  UI, which is a manual account action nobody has taken. Until then the docs
  point at the release tarball and this stays open.
- [ ] measured code deletion in a real application
  ([Measuring plumbing](./measuring-plumbing.md)) — harness specified, subject
  repository not available here

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
- [x] repair preview and precondition checks
- [x] approval policy and separation of duties
- [x] apply idempotency token and post-repair verification
- [ ] signed audit checkpoints or WORM export

## Later, after design-partner evidence

- [x] guarded, audited recheck and safe-repair browser actions through Application callbacks
- [ ] gRPC/Unix-socket gateway transport, only after real polyglot demand
- [ ] NestJS lifecycle integration after the framework-neutral Node SDK is validated
- [ ] retention and partition sweeper
- [x] Node SDK and Go domain/memory microbenchmarks plus fixed-seed browser disorder test
- [x] reproducible PostgreSQL concurrency and Task fan-out snapshot benchmarks
- [ ] runtime fault-campaign and end-to-end benchmarks
- [ ] public release and license decision

Do not start a second external-runtime adapter, DAG engine, automatic repair or
Outcome Level 2 before the Task slice and one BullMQ integration are validated
in a real application. Provider connectors remain examples until repeated
demand proves a reusable contract.

## Explicitly not started until a design partner exists

Tenant-wide RBAC, the multi-node notification scheduler, deployment-shaped chaos
evidence and further benchmarks. None of them is what stops a team adopting
RhinoQ today, and each adds surface to a product whose problem is that it
already asks for too much before first value.

Node ProviderOperation is in the same category for a different reason: it works,
but only through the Gateway, and an embedded client would require copying a
state machine whose failure mode is charging a customer twice
([ADR-0024](../.ai/DECISIONS.md)).
