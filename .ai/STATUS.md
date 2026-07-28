# Implementation status

This assessment tracks the current v0.1 Integrity Slice in `RHINOQ.md`. It
separates a mature queue foundation from the still-incomplete product
differentiator.

| Area | Status | Evidence and remaining work |
|---|---:|---|
| COMMIT | 4/5 | schema, idempotency, correlation, payload gates and transactional SQL enqueue run in the real PostgreSQL suite; end-to-end business outbox integration remains |
| RUN | 11/11 | claim, lease, heartbeat, retry/jitter, recovery, delay, bounded workers, graceful shutdown, cancellation, DLQ, rate limit, fencing, poison protection and admission control are implemented |
| VERIFY | 4/5 | fenced Effect Ledger plus versioned job/table Rules, read-only evaluation and PostgreSQL Explain gate exist; scheduled execution and external correlation remain |
| RECOVER | 4/6 | Rule observations open/deduplicate/auto-resolve persistent Findings with append-only events; persisted Needs Attention integration and business timeline remain |
| ADOPTION | 0/4 | observe-only ingestion, an existing-queue recipe, business-key verification command and no-cutover quickstart remain |
| DX | 4/7 | doctor, `rhinoq explain`, structured errors, Agent HTTP and a thin TypeScript client exist; scan, Console and framework integration remain |
| Infrastructure | 8/10 | configuration, health, metrics, migrations, real PostgreSQL tests, Rule query budgets, audit chain, DB clock and SQL enqueue exist; fault injection, retention/partitioning, restricted Rule role and benchmark evidence remain |

## Estimates

- Queue/runtime capability implementation: approximately **65–70%** of the
  documented long-term foundation.
- v0.1 Integrity Slice implementation: approximately **55–60%**.
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
- The persistent finding lifecycle now exists, but the current Needs Attention
  view is still derived and has not been switched to the finding inbox.
- Rule table pages expose a cursor but scheduler cursor persistence and
  crash-safe periodic continuation are not implemented.
- No execution adapter yet correlates an existing BullMQ, pg-boss, DBOS or
  custom job with a RhinoQ business subject.
- The race detector cannot run in the current environment because the cgo
  toolchain is unavailable.

## Next priorities

1. Persisted Rule scheduler cursor and crash-safe periodic evaluation.
2. Needs Attention backed by the persistent Finding inbox.
3. Correlation timeline across jobs, attempts, effects, Rules, Findings and current
   business state.
4. Bounded `rhinoq scan` and `init --from-scan` planning workflow.
5. Fault, retention, security and reproducible benchmark evidence.
