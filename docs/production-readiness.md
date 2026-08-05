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

- Organization membership and tenant-wide RBAC are not implemented across the
  full runtime/verification schema. Task owner credentials are not tenant RBAC.
- Durable notification scheduling is implemented with PostgreSQL row leases,
  backoff and dead-letter state. The repository now tests the takeover against
  a real PostgreSQL instance in `tests/postgres`; PostgreSQL failover and a
  longer deployment campaign are still required.
- The official BullMQ demo includes a disposable Redis stop/start harness, and
  one local run is recorded in
  [`docs/evidence/redis-bullmq-chaos-2026-08-05.md`](evidence/redis-bullmq-chaos-2026-08-05.md).
  This is local process-restart evidence, not a production reliability claim;
  deployment-shaped benchmarks and design-partner measurements remain open.
