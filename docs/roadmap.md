# Implementation roadmap

The roadmap separates execution maturity from product differentiation. The
native PostgreSQL queue remains part of the core product; v0.1 is not considered
useful until Rules and Findings work on at least one real business subject.

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

## v0.1 — Integrity Slice

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

## v0.2 — Integrity Hardening

- [x] versioned Rule contracts
- [x] crash-safe scheduled Rule evaluation
- [x] durable signal-first Rule evaluation with optional exact-subject query
- [x] tri-state Rule observations: passed, violated and unknown
- [x] finding suppression, deduplication and regression lifecycle
- [x] composite change cursor and bounded drain batches
- [ ] adaptive reconciliation budgets and producer backpressure
- [ ] handler and verifier version evidence

## v0.3 — Safe Recovery

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

Do not start a second adapter, DAG engine, automatic repair, or Outcome Level 2
before three design partners validate the same class of business finding. The
differentiator itself must exist before recruiting those partners.
