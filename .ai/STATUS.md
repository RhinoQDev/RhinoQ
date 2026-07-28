# Implementation status

This assessment tracks the current v0.1 Integrity Slice in `RHINOQ.md`. It
separates a mature queue foundation from the still-incomplete product
differentiator.

| Area | Status | Evidence and remaining work |
|---|---:|---|
| COMMIT | 4/5 | schema, idempotency, correlation, payload gates and transactional SQL enqueue run in the real PostgreSQL suite; end-to-end business outbox integration remains |
| RUN | 11/11 | claim, lease, heartbeat, retry/jitter, recovery, delay, bounded workers, graceful shutdown, cancellation, DLQ, rate limit, fencing, poison protection and admission control are implemented |
| VERIFY | 4/5 | fenced Effect Ledger, versioned Rules, Explain gate, bounded evaluation and crash-safe periodic scheduling exist; external execution correlation and signal-first verification remain |
| RECOVER | 5/6 | Rule observations manage persistent Findings and Needs Attention merges live Findings with execution/effect/outcome attention; the business-key timeline remains |
| ADOPTION | 0/4 | observe-only ingestion, an existing-queue recipe, business-key verification command and no-cutover quickstart remain |
| DX | 6/8 | embedded quickstart, direct PostgreSQL migration/doctor/operations CLI, `rhinoq explain`, optional HTTP Gateway and thin TypeScript client exist; scan, Console and framework integration remain |
| Infrastructure | 9/11 | configuration, health, metrics, checksum-tracked migration runner, real PostgreSQL tests, Rule budgets, audit chain, DB clock and SQL enqueue exist; fault injection, retention/partitioning, restricted Rule role and benchmark evidence remain |

## Estimates

- Queue/runtime capability implementation: approximately **70–75%** of the
  documented long-term foundation.
- v0.1 Integrity Slice implementation: approximately **65–70%**.
- Production release readiness: approximately **35–40%**.

These are planning estimates, not product KPIs. A capability only advances when
its code, tests, documentation and evidence agree.

## Known debt

- Attempt history is append-only but has no partition/retention policy and does
  not yet record handler or contract versions.
- `maxDistinctWorkersFailed` and overflow modes `route`/`sample` are not
  implemented.
- The optional HTTP Gateway lacks gRPC/Unix-socket transport, tenant isolation
  and HTTP-layer job RBAC.
- Needs Attention is unified, but business Findings still have no explicit
  source-system/job/queue correlation and therefore cannot be safely included
  in a queue-filtered view.
- No execution adapter yet correlates an existing BullMQ, pg-boss, DBOS or
  custom job with a RhinoQ business subject.
- Existing pre-runner RhinoQ schemas require a manual baseline workflow; the
  migration runner intentionally refuses to infer one.
- The race detector cannot run in the current environment because the cgo
  toolchain is unavailable.

## Next priorities

1. External execution correlation and a stable business-key identity contract.
2. Correlation timeline across jobs, attempts, effects, Rules, Findings and
   current business state.
3. Bounded `rhinoq scan` and `init --from-scan` planning workflow.
4. One no-cutover reference integration against an existing queue.
5. Fault, retention, security and reproducible benchmark evidence.
