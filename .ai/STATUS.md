# Implementation status

This assessment tracks RhinoQ's outcome-verification product and separates its
supporting Task/runtime layers from the detect-investigate-repair loop.

| Area | Status | Evidence and remaining work |
|---|---:|---|
| TASK | 5/6 | Aggregate-versioned Task Summary, keyset Execution pages, owner-scoped polling/cancel, Node browser store, result references and BullMQ projection are tested; organization/RBAC, first-class BullMQ retry and realtime remain |
| COMMIT | 4/5 | schema, idempotency, correlation, payload gates and transactional SQL enqueue run in the real PostgreSQL suite; end-to-end business outbox integration remains |
| RUN | 11/11 | claim, handler-filtered lease, heartbeat, retry/jitter, recovery, delay, bounded workers, graceful shutdown, cancellation, DLQ, rate limit, fencing, poison protection and admission control are implemented |
| VERIFY | 4/5 | fenced Effect Ledger, HTTP/Stripe/provisioning ProviderOperation adapters with explicit uncertain/read-back, versioned Rules, Explain gate and bounded scheduling exist; provider outcome evidence still needs real design-partner validation |
| RECOVER | 6/6 | Findings, Needs Attention, durable-dedup signed notifications, queued multi-node delivery and preview/four-eyes/precondition/verify repair exist; design-partner evidence remains |
| ADOPTION | 3/4 | one-command initialization, Rule generator, health checker, failure fixture and an official BullMQ/Stripe demo exist; three real design-partner pilots remain |
| DX | 9/10 | embedded Go/Node paths, direct CLI tooling, ProviderOperation/repair Node APIs, application HTTP/browser helpers and action-enabled loopback Workbench exist; beta.5 binaries/image are public, npm trusted-publisher permission remains |
| Infrastructure | 10/11 | configuration, health, process rate limit, metrics, migrations, real PostgreSQL lease-loss/takeover tests, non-root image, SBOM/provenance config, restore drill and local Redis/BullMQ restart harness exist; PostgreSQL failover, deployment-shaped chaos and full tenant RBAC remain |

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
- The optional HTTP Gateway lacks tenant isolation and HTTP-layer job RBAC. It
  defaults to loopback, enforces a 32-byte bearer-token minimum, refuses
  unauthenticated non-loopback binding and has a per-process limiter. TLS,
  distributed edge limiting, credential rotation and failed-auth audit remain
  deployment/release work.
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

1. Recruit three real design partners: BullMQ fan-out, Stripe/billing and provisioning/fulfilment.
2. Measure code/endpoints removed and time-to-detect on each pilot.
3. Run Redis/PostgreSQL chaos and restore drills in a deployment-shaped environment.
4. Add tenant-wide RBAC and deployment-shaped chaos evidence.
