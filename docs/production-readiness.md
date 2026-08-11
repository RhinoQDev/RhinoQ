# Production readiness

RhinoQ remains a prerelease. A green unit suite is not enough to call it
production-ready.

## Implemented trust controls

- Go race tests run on Linux CI; PostgreSQL contracts run against PostgreSQL 16.
- Release tags build cross-platform archives, checksums, keyless signatures,
  SPDX SBOMs, provenance attestations and a non-root GHCR image.
- Gateway request bodies, tokens and per-process request rate are bounded.
- Provider timeouts fail closed as `uncertain`; external mutations are not
  retried until confirmation proves `not_happened`.
- Safe repairs require preview, fresh precondition, a different approver,
  idempotent callback token and post-apply verification.
- `scripts/restore-drill.sh` compares migration and Finding counts after a
  PostgreSQL custom-format restore.

## Deployment obligations

- Put the Gateway behind TLS, a network policy and a distributed edge limiter.
- Use separate PostgreSQL roles for runtime writes, Rule reads and backups.
- Test restore against the same PostgreSQL major version before every release.
- Configure retention/partitioning from [the retention guide](./retention.md).
- Follow [migration recovery](./migration-rollback.md); migrations are forward
  fixes, never edited history.

## Still blocking a production-ready claim

- **The full Go Gateway is still not a tenant-wide public RBAC surface. The
  Node Task HTTP profile now carries owner/tenant predicates and an explicit
  `authorize` hook with deny-by-default mounting. The storage boundary remains
  enforced by the storage migrations, which give every tenant-owned row a
  `tenant_id` and force row-level policies on twelve tables, making
  cross-tenant *references*
  unrepresentable through composite foreign keys. `internal/domain/authz`
  holds the role matrix and a single decision point, and
  `tests/postgres/tenant_isolation_test.go` proves the boundary by trying to
  cross it. What is **not** done: `internal/interfaces/agent/server.go` still
  authorises with one operator token plus a list of per-owner Task
  credentials, and no test exercises cross-tenant access over HTTP. One
  process also serves one tenant, because the tenant is a property of the
  connection pool. See [`docs/tenancy.md`](tenancy.md).
- **Isolation is off by default on a common setup, and RhinoQ now says so.**
  PostgreSQL exempts superusers and `BYPASSRLS` roles from row-level security,
  and the official `postgres` image makes `POSTGRES_USER` a superuser.
  `rhinoq doctor` reports this as a FAIL rather than letting a green test suite
  imply isolation that is not in force.
- **PostgreSQL failover has one measured drill, not a campaign.**
  `scripts/failover-drill.sh` runs a real primary/standby pair, kills the
  primary with SIGKILL, promotes the standby and compares surviving rows
  against acknowledged writes. One run is recorded in
  [`docs/evidence/postgres-failover-2026-08-05.md`](evidence/postgres-failover-2026-08-05.md):
  150 of 150 acknowledged writes survived and policies stayed forced after
  promotion. That is one run, on one host, with no witness and no fencing —
  split brain is untested and a deployment-scale campaign remains open.
- **Benchmarks are shaped like the adopter workload but are not from an
  adopter.** `tests/postgres/adopter_workload_bench_test.go` measures Task
  summary polling and Execution paging at fan-out 100/1,000/5,000, which is
  the only form in which design-partner seat A's "polling stays bounded" can
  be checked. It found and closed a real unbounded page cost (migration 028).
  The numbers are synthetic rows on one machine; a benchmark against a real
  adopter workload still requires a real adopter.
- **No code-reduction claim exists, and none is fabricated.**
  `scripts/code-reduction.sh` measures an adopter repository between two refs
  and emits a report with the process, datastore and credential rows left
  blank, because those are not derivable from a diff. Three real integrations
  have to run it. Until then `docs/adoption-gap.md` stands: 0 lines removed.
- The official BullMQ demo includes a disposable Redis stop/start harness, and
  one local run is recorded in
  [`docs/evidence/redis-bullmq-chaos-2026-08-05.md`](evidence/redis-bullmq-chaos-2026-08-05.md).
  This is local process-restart evidence, not a production reliability claim.
