# Control Plane boundary

RhinoQ does not claim a production multi-cluster Control Plane in this
release. The current project profile and Workbench are application-local
composition surfaces. They do not proxy large payload bytes, replace the Go
engine, or become a second Task state store.

A future Control Plane may coordinate bounded metadata such as cluster health,
compiled plans, recommendations and operator permissions. It must preserve the
following boundaries before implementation:

- Task state, leases, retries, effects and uncertain outcomes remain owned by
  the authoritative cluster/Go engine;
- large files and media continue through the Data Path Planner and storage
  provider, never through a Control Plane proxy;
- cross-cluster actions require explicit actor, scope, idempotency, audit and
  rollback contracts;
- a design-partner multi-process/multi-cluster pilot must provide fault,
  latency, access-control and operational evidence first.

The roadmap therefore marks the Control Plane as deferred, not as an
implemented capability hidden behind the Node SDK.

Before reopening that boundary, a design-partner pilot must attach these
artifacts: a multi-process/cluster topology and identity matrix; a compiled
plan/admission snapshot; fault traces for missed invalidation, stale reads,
lease loss and provider uncertainty; access-control/audit records; a bounded
rollback runbook; and measured latency/resource data from the deployment-shaped
run. A local or single-process demo is not sufficient evidence for a Control
Plane claim.
