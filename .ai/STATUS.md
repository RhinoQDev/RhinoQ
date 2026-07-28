# Implementation status

This assessment tracks the current v0.1 Integrity Slice in `RHINOQ.md`. It
separates a mature queue foundation from the still-incomplete product
differentiator.

| Area | Status | Evidence and remaining work |
|---|---:|---|
| COMMIT | 4/5 | schema, idempotency, correlation, payload gates and transactional SQL enqueue run in the real PostgreSQL suite; end-to-end business outbox integration remains |
| RUN | 11/11 | claim, lease, heartbeat, retry/jitter, recovery, delay, bounded workers, graceful shutdown, cancellation, DLQ, rate limit, fencing, poison protection and admission control are implemented |
| VERIFY | 2/5 | fenced Effect Ledger and Outcome Level 1 domain foundation exist; ORM-aware verifier, query-cost gate and external execution correlation remain |
| RECOVER | 2/6 | finding lifecycle domain rules and guarded replay/audit exist; persistent storage, incremental reverse reconciliation, persisted Needs Attention and business search remain |
| ADOPTION | 0/4 | observe-only ingestion, an existing-queue recipe, business-key verification command and no-cutover quickstart remain |
| DX | 3/7 | doctor, structured errors, Agent HTTP and a thin TypeScript client exist; integrity-focused CLI, Console and framework integration remain |
| Infrastructure | 7/10 | configuration, health, metrics, migrations, real PostgreSQL tests, audit chain, DB clock and SQL enqueue exist; fault injection, retention/partitioning, security boundary and benchmark evidence remain |

## Estimates

- Queue/runtime capability implementation: approximately **65–70%** of the
  documented long-term foundation.
- v0.1 Integrity Slice implementation: approximately **35–40%**.
- Production release readiness: approximately **30–35%**.

These are planning estimates, not product KPIs. A capability only advances when
its code, tests, documentation and evidence agree.

## Known debt

- Attempt history is append-only but has no partition/retention policy and does
  not yet record handler or contract versions.
- `maxDistinctWorkersFailed` and overflow modes `route`/`sample` are not
  implemented.
- The Agent lacks gRPC/Unix-socket transport, tenant isolation and HTTP-layer
  job RBAC.
- The current Needs Attention view is derived; it does not replace a persistent
  finding lifecycle.
- No execution adapter yet correlates an existing BullMQ, pg-boss, DBOS or
  custom job with a RhinoQ business subject.
- The race detector cannot run in the current environment because the cgo
  toolchain is unavailable.

## Next priorities

1. Persistent finding store/API for open, acknowledge, suppress, resolve and
   regressed transitions.
2. External source/job/business-key correlation and observe-only ingestion.
3. Incremental reverse reconciliation for one non-financial subject.
4. ORM-aware Outcome Level 1 verifier and query-cost gate.
5. One BullMQ or pg-boss no-cutover integration recipe.
6. Fault, retention, security and reproducible benchmark evidence.
