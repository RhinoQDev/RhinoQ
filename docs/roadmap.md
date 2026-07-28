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
- [ ] external execution correlation:
  `source_system`, `source_job_id`, `business_key`

### RECOVER

- [x] finding domain lifecycle and deduplication rules
- [x] persistent memory/PostgreSQL finding store and public Go/Agent API
- [x] manual table-scoped Rule evaluation folds violations/passes into Findings
- [x] Needs Attention backed by persistent findings
- [x] acknowledge, suppress, resolve and regressed operations with append-only events
- [x] guarded manual replay and transactional audit hash chain
- [ ] correlation timeline and business-key/external-job search

### Adoption

- [ ] bounded `rhinoq scan` over tables with job/correlation references
- [ ] `rhinoq init --from-scan` plan with baseline by default
- [ ] one non-financial reference workload, such as a completed report whose
  output object is missing
- [ ] no-cutover quickstart that produces the first finding

## v0.2 — Integrity Hardening

- [x] versioned Rule contracts
- [x] crash-safe scheduled Rule evaluation
- [ ] signal-first Rule evaluation
- [x] finding suppression, deduplication and regression lifecycle
- [ ] reconciliation cursors, budgets and backpressure
- [ ] handler and verifier version evidence

## v0.3 — Safe Recovery

- [ ] resumable execution checkpoints
- [ ] repair dry-run and precondition checks
- [ ] approval policy and separation of duties
- [ ] signed audit checkpoints or WORM export

## Later, after design-partner evidence

- [ ] Console Queues and Findings screens with correlation timeline
- [ ] gRPC/Unix-socket gateway transport, only after real polyglot demand
- [ ] NestJS integration
- [ ] retention and partition sweeper
- [ ] reproducible fault and benchmark suites
- [ ] public release and license decision

Do not start a second adapter, DAG engine, automatic repair, or Outcome Level 2
before three design partners validate the same class of business finding. The
differentiator itself must exist before recruiting those partners.
