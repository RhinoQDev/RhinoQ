# Implementation roadmap

## Milestone 0 — Queue foundation

- [x] enqueue/idempotency/correlation
- [x] claim/lease/heartbeat
- [x] retry classification
- [x] worker concurrency
- [x] lease reaper
- [x] effect ledger/outcome foundation
- [x] PostgreSQL adapter and migration
- [x] PostgreSQL integration harness
- [x] lease epoch fencing
- [x] cancellation
- [x] pause/resume
- [x] global per-queue rate limit
- [x] priority, FIFO and aging scheduling
- [x] poison-job protection
- [x] six-step graceful shutdown
- [x] database time as clock authority
- [x] admission control
- [x] DLQ and derived Needs Attention read API
- [x] guarded manual replay with transactional audit
- [x] append-only attempt timeline for claim, release, completion, failure and lease expiry
- [x] transactional SQL enqueue executed by the PostgreSQL contract suite
- [ ] persistent finding acknowledge/resolve/regressed lifecycle (domain state machine implemented)

## Milestone 1 — Developer experience

- [x] Agent HTTP surface with protocol negotiation (gRPC/proto generation pending)
- [ ] runnable CLI
- [ ] `rhinoq init` plan/apply
- [x] `rhinoq doctor` configuration, fencing and timing checks (runtime and database checks pending)
- [ ] Console queue view
- [x] single-file TypeScript Agent client
- [ ] NestJS module

## Milestone 2 — Evidence and release

- [ ] fault-test harness
- [ ] benchmark harness
- [x] replay audit hash chain
- [ ] signed audit checkpoints / WORM export
- [ ] retention/partition sweeper
- [ ] public release decision and license
