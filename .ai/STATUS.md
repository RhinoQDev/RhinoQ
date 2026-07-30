# Implementation status

This assessment tracks the current Task Platform baseline and separates the
existing runtime/Verified Tasks foundation from the incremental Task facade.

| Area | Status | Evidence and remaining work |
|---|---:|---|
| TASK | 5/6 | Domains, PostgreSQL contract, owner-visible aggregate-versioned HTTP polling, owner-scoped read/cancel credentials, monotonic progress, cancellation outcome, a version-safe Node polling watcher, public Execution binding, result-reference API, typed Node client and single/fan-out-safe BullMQ lifecycle projection are tested; organization/RBAC authorization, runtime dispatch, composed retry, result payload/realtime delivery and ProviderOperation remain |
| COMMIT | 4/5 | schema, idempotency, correlation, payload gates and transactional SQL enqueue run in the real PostgreSQL suite; end-to-end business outbox integration remains |
| RUN | 11/11 | claim, handler-filtered lease, heartbeat, retry/jitter, recovery, delay, bounded workers, graceful shutdown, cancellation, DLQ, rate limit, fencing, poison protection and admission control are implemented |
| VERIFY | 4/5 | fenced Effect Ledger, versioned Rules, Explain gate, bounded evaluation and crash-safe periodic scheduling exist; external execution correlation and signal-first verification remain |
| RECOVER | 5/6 | Rule observations manage persistent Findings, Needs Attention merges execution/effect/outcome attention, and the business-subject timeline exists; reverse search from an external execution remains |
| ADOPTION | 1/4 | bounded scan and observe-only integrity evaluation exist; existing-queue recipe, business-key verification command and no-cutover Task quickstart remain |
| DX | 9/10 | embedded Go quickstart, direct CLI tooling, `rhinoq explain`, a published Node preview, the three-table embedded Node Task candidate, application HTTP/browser helpers and a local read-only Workbench exist; beta.4 publication, business-key timeline and framework-specific integration remain |
| Infrastructure | 9/11 | configuration, health, metrics, checksum-tracked migration runner, real PostgreSQL tests, Rule budgets, audit chain, DB clock and SQL enqueue with invoking-login authorization exist; fault injection, retention/partitioning, restricted Rule role and benchmark evidence remain |

## Estimates

- Task Platform foundation has passed **5/6 tracked gates**. This is not a
  product-readiness percentage: public adoption and delivery are still absent.
- Queue/runtime capability implementation: approximately **70–75%** of the
  documented long-term foundation.
- Verified Tasks foundation implementation: approximately **65–70%**.
- Production release readiness: approximately **35–40%**.

These are planning estimates, not product KPIs. A capability only advances when
its code, tests, documentation and evidence agree.

## Known debt

- Attempt history is append-only but has no partition/retention policy and does
  not yet record handler or contract versions.
- `maxDistinctWorkersFailed` and overflow modes `route`/`sample` are not
  implemented.
- The optional HTTP Gateway lacks gRPC/Unix-socket transport, tenant isolation
  and HTTP-layer job RBAC. It now defaults to loopback, enforces a 32-byte
  bearer-token minimum and refuses unauthenticated non-loopback binding, but
  TLS termination, rate limiting, credential rotation and failed-auth audit
  remain release blockers.
- Codex Security CLI 0.1.1/plugin 0.1.14 reached analysis but failed to seal an
  empty output directory with the same missing `scan-manifest.json` error on
  native Windows and a Linux volume. This is tool failure, not zero findings.
  `docs/security-audit-2026-07-29.md` records the fallback audit and remaining
  coverage.
- The Node SDK has an npm evaluation prerelease, but no tagged GitHub release;
  the next release is configured to archive both `rhinoq` and `rhinoq-agent`,
  but those prebuilt binaries do not exist publicly until that tag succeeds.
- The Go module path now matches the hosting repository, so `go get` resolves
  without a local `replace`, but no semver tag exists yet. Consumers resolve a
  branch pseudo-version and have no stability guarantee.
- Needs Attention is unified, but business Findings still have no explicit
  source-system/job/queue correlation and therefore cannot be safely included
  in a queue-filtered view.
- The BullMQ lifecycle bridge uses durable scoped runtime/external-ID identity.
  The Task-only path reserves all Execution identities before `Queue.add()`,
  resumes partially dispatched fan-out after a crash and models retries by
  stable `itemKey` plus increasing `attempt`. It does not discover arbitrary
  queue work after an outage or guess whether an active side effect is safe to
  cancel; pg-boss, DBOS and custom runtime adapters do not exist.
- Existing pre-runner RhinoQ schemas require a manual baseline workflow; the
  migration runner intentionally refuses to infer one.
- The race detector cannot run in the current environment because the cgo
  toolchain is unavailable.

## Next priorities

1. Measure code/endpoints removed in one real two-task application.
2. Measure the BullMQ lifecycle bridge in a two-Task application before adding
   dispatch, retry, cancellation or reconciliation contracts.
3. ProviderOperation domain with idempotency, confirmation and `uncertain`.
4. Reconnect/stale-version property and browser tests before realtime.
