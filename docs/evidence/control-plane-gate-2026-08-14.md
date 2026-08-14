# Control Plane gate — 2026-08-14

## Decision

**P2-03 remains deferred. No Control Plane implementation starts in this
tranche.** RhinoQ keeps the Go runtime and PostgreSQL Task profile authoritative;
the embedded/operator surface remains the supported deployment shape for the
current beta and controlled-pilot stage.

## Evidence reviewed

- The repository already has an embedded project profile, owner/operator
  surfaces, bounded realtime, health/metrics, evidence projections and a
  read-only Autopilot contract.
- Existing local evidence covers PostgreSQL failover, artifact restart/readback
  and bounded queue/runtime behavior, but does not yet prove fleet-wide
  operator-query saturation or a multi-cluster adopter need.
- Tenant/RBAC, retention/restore ownership, deployment-shaped benchmarks and
  independent adopter reports are still release-gate work.
- A remote layer would add another auth, policy, read-model, upgrade and
  rollback surface before those contracts are stable.

## Re-entry criteria

Re-open P2-03 only when a maintainer-approved pilot supplies raw evidence for
all of the following:

1. embedded/operator queries are a measured bottleneck on the target topology;
2. at least one adopter needs fleet-wide policy, history or remote operation;
3. tenant/RBAC and audit contracts pass the security matrix;
4. large bytes still bypass the proposed control-plane data path;
5. an operational owner provides SLO, upgrade, backup and rollback drills.

The first re-entry artifact should be an ADR comparing an optional read/policy
plane with keeping the embedded path. It must explicitly keep queue truth,
leases, retries, effect confirmation and correctness in the existing Go /
PostgreSQL authority.

## Current rollback

There is no Control Plane deployment, migration or credential to roll back.
The safe rollback is to keep the current embedded/operator topology and avoid
adding new process, datastore or network trust edges.

**Evidence level:** L1 repository evidence; not an adopter or production claim.
