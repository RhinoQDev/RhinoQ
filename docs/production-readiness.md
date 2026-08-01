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
- A multi-node durable notification dispatcher is not implemented; delivery is
  explicit with a durable dedup ledger.
- Redis/BullMQ chaos and deployment-shaped benchmarks still require evidence
  from the official demo and design partners.
