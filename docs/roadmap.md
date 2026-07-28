# Implementation roadmap

The roadmap separates execution maturity from product differentiation. A
native queue remains a reference execution adapter; v0.1 is not considered
useful until VERIFY and RECOVER work on at least one real business subject.

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

### VERIFY

- [x] explicit Effect Ledger states and fenced transitions
- [x] explicit effect confirmation policy
- [x] Outcome Level 1 domain foundation
- [ ] ORM/metadata-aware indexed verifier API
- [ ] explicit `notBefore`, deadline and finality behavior end to end
- [ ] query-cost and index gate
- [ ] external execution correlation:
  `source_system`, `source_job_id`, `business_key`

### RECOVER

- [x] finding domain lifecycle and deduplication rules
- [ ] persistent finding store and public API
- [ ] incremental reverse reconciliation for one business subject
- [ ] Needs Attention backed by persistent findings
- [ ] acknowledge, suppress, resolve and regressed operations with audit
- [x] guarded manual replay and transactional audit hash chain
- [ ] business-key and external-job search

### Adoption

- [ ] observe-only ingestion/API for an existing execution system
- [ ] one production-quality BullMQ or pg-boss integration recipe
- [ ] `rhinoq verify --business-key <id>`
- [ ] one non-financial reference workload, such as a completed report whose
  output object is missing
- [ ] no-cutover quickstart that produces the first finding

## v0.2 — Integrity Hardening

- [ ] invariant DSL and versioned contracts
- [ ] signal-first and batched verification
- [ ] finding suppression, deduplication and regression hardening
- [ ] reconciliation cursors, budgets and backpressure
- [ ] handler and verifier version evidence

## v0.3 — Safe Recovery

- [ ] resumable execution checkpoints
- [ ] repair dry-run and precondition checks
- [ ] approval policy and separation of duties
- [ ] signed audit checkpoints or WORM export

## Later, after design-partner evidence

- [ ] second execution adapter
- [ ] Console integrity workspace
- [ ] gRPC/Unix-socket Agent transport
- [ ] NestJS integration
- [ ] retention and partition sweeper
- [ ] reproducible fault and benchmark suites
- [ ] public release and license decision

Do not start a second adapter, DAG engine, automatic repair, or Outcome Level 2
before three design partners validate the same class of business finding. The
differentiator itself must exist before recruiting those partners.
