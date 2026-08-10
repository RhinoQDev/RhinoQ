# Async Flight Recorder

RhinoQ's Async Flight Recorder is the generic Task-profile explanation surface.
It is not an application-specific dashboard and it does not assume video,
payments or any other business domain.

## What it shows

The Node Task Workbench joins the authoritative reads already available in the
Task profile:

```text
Task accepted → Task state → Execution attempts → Result recorded
                         ↘ durable waitpoint → attention decision
```

The operator detail response includes:

```text
GET /rhinoq/api/tasks/{taskId}/flight-recorder
```

The projection is versioned (`schemaVersion: 1`) and contains:

- `events`: task, execution and waitpoint observations;
- `attention`: uncertain, partial-failure, failed, waiting and expired states;
- `explanation`: the first deterministic reason an operator should act;
- `safeToRetry`: only where the available state makes that decision safe.

The projection never copies storage references or runtime job IDs into the
flight events. Runtime identity remains available only in the operator-gated
Workbench detail read.

## Timestamp boundary

Task snapshots are not an append-only event log. The projection therefore names
its timestamp `observedAt`; it does not invent queue-start or provider-return
times. A future audit/event source can add richer evidence without changing the
operator shape.

## Waitpoint expiry

`WaitpointExpiryScheduler` runs bounded, database-time expiry sweeps. The local
`npx rhinoq dev` command starts a 30-second development sweep and reports the
expired count in the terminal. Production applications must provide their own
notification/escalation policy through the scheduler hook; RhinoQ does not
guess who should be paged or whether an expired waitpoint should be retried.

## Security boundary

The owner Task API must continue to use the application's `ownerFromRequest`
authentication. The Workbench reads across owners and runtime identities, so it
requires an explicit `requireOperator` gate and should remain loopback/internal
unless the host application adds its own authentication and authorization.

This is a normalized Task-profile view, not yet the complete API-to-effect-
provider trace. Full effect evidence, compare-attempt diffs, diagnostic bundles,
OpenTelemetry propagation and tenant-wide RBAC remain separate roadmap work.
