# Implementation roadmap

## Milestone 0 — Queue foundation

- [x] enqueue/idempotency/correlation
- [x] claim/lease/heartbeat
- [x] retry classification
- [x] worker concurrency
- [x] lease reaper
- [x] effect ledger/outcome foundation
- [x] PostgreSQL adapter and migration
- [ ] PostgreSQL integration harness
- [ ] lease epoch fencing
- [ ] cancellation/pause/resume
- [ ] rate limit and admission control
- [ ] DLQ and Needs Attention API

## Milestone 1 — Developer experience

- [ ] stable protocol generation
- [ ] runnable CLI
- [ ] `rhinoq init` plan/apply
- [ ] `rhinoq doctor`
- [ ] Console queue view
- [ ] Node/NestJS SDK adapter

## Milestone 2 — Evidence and release

- [ ] fault-test harness
- [ ] benchmark harness
- [ ] audit hash chain
- [ ] retention/partition sweeper
- [ ] public release decision and license

