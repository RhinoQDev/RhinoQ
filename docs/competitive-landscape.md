# Competitive landscape

> Last reviewed: 2026-07-29. This document compares product boundaries, not
> benchmark performance. Recheck primary sources before publication.

RhinoQ does not enter an empty category. Queue libraries, durable execution
runtimes and workflow platforms already solve large parts of reliable
background execution. RhinoQ's primary hypothesis is narrower:

> A team with an existing queue or worker can add a durable, user-facing Task
> contract without rebuilding status/result/UI plumbing or migrating its whole
> execution model.

The optional Verified Tasks layer has a second hypothesis: effect evidence,
outcome observation and Findings help the smaller set of tasks where technical
completion is not enough. Neither hypothesis means competitors cannot implement
the behavior in application code.

## Category map

| Category | Established strengths | RhinoQ boundary |
|---|---|---|
| [BullMQ](https://github.com/taskforcesh/bullmq) | Redis queue, workers, progress, results, retry, cancellation, events and operations ecosystem | RhinoQ must not claim queue replacement, higher throughput or an existing adapter it does not have |
| [Bull Board](https://github.com/felixmosh/bull-board) | queue/job inspection and operator actions | operator UI, not a user-facing Task ownership/snapshot layer |
| [pg-boss](https://github.com/timgit/pg-boss), [Graphile Worker](https://worker.graphile.org/docs) and [PGMQ](https://github.com/pgmq/pgmq) | PostgreSQL queue primitives, transactional enqueue and workers | PostgreSQL and ACID enqueue are table stakes, not differentiation |
| [Trigger.dev](https://trigger.dev/docs/introduction) and [Inngest](https://www.inngest.com/docs) | managed task/runtime models, retries, observability and frontend/realtime tooling | RhinoQ cannot win on generic task features; it must show lower migration cost for current-worker teams |
| [Hatchet](https://github.com/hatchet-dev/hatchet), [Temporal](https://docs.temporal.io/), [Restate](https://docs.restate.dev/) and [DBOS](https://docs.dbos.dev/) | durable execution/workflows, state, retries and broad operational systems | use these when durable workflow semantics or their execution model is the central need |
| transport products | channels, messages and subscriptions | transport does not own Task lifecycle, attempts, history or business authorization |

BullMQ itself has progress, result, retry and cancellation primitives. The gap
is not “BullMQ cannot model a job.” The application still has to decide task
identity, user/tenant ownership, UI-safe state, result delivery and how to
converge after reload or out-of-order responses.

Trigger.dev and Inngest already offer rich frontend/realtime task experience.
RhinoQ's future wedge is keeping an existing execution runtime—not feature
parity. The first intended proof is a BullMQ adapter that does not require a
business-handler rewrite. That adapter is not implemented today.

## RhinoQ product boundary

| Layer | Boundary | Status |
|---|---|---|
| Task Platform | Task identity, versioned snapshot, progress, result reference, lifecycle and execution history | first polling slice implemented |
| Existing-runtime adoption | adapter dispatches and observes an existing worker | external runtime reference exists; adapter is planned |
| Delivery | polling now; frontend/realtime later | HTTP polling and typed Node client implemented; no React/realtime |
| Verified Tasks | effect evidence, outcome observation, Rules and Findings | optional foundation implemented |

The external Execution reference is deliberately not called an adapter. It
records a stable runtime ID but does not enqueue to BullMQ, listen to its events
or provide its liveness/cancellation semantics.

## Verification boundary

DBOS, Hatchet, Restate and Temporal weaken any broad claim that a queue cannot
recover from a crash or that RhinoQ alone can protect an external side effect.
External APIs still need provider idempotency, a suitable durable-call protocol,
explicit evidence/confirmation or reconciliation. RhinoQ's Effect Ledger is one
explicit evidence model; it is not exactly-once external execution.

## How to validate or falsify the product

| Workload | Strong alternative | RhinoQ must demonstrate |
|---|---|---|
| two user-visible tasks on an existing queue | hand-written status endpoints/UI, Trigger.dev or Inngest | no business-handler rewrite and materially less durable task plumbing |
| database-only workflow | DBOS transaction or application transaction | no advantage is expected; document when not to use RhinoQ |
| external provider with idempotency | durable step plus provider key | clearer evidence without weakening safety |
| completed execution with inconsistent business state | application cron, SQL alert or monitoring rule | optional Finding lifecycle is worth adopting |

The primary thesis fails if teams must rewrite handlers, retain per-feature
status glue, or prefer an execution-platform migration. The optional Verified
Tasks thesis fails if teams keep verification entirely inside their application.

## Positioning rules

- Do not describe other queues as “blind retry” systems.
- Do not use PostgreSQL, transactional enqueue, checkpointing or worker resume
  as unique claims.
- Do not call the external Execution boundary an adapter until it dispatches and
  observes a runtime.
- Do not publish throughput, latency or reliability comparisons without a
  reproducible benchmark.
- Recommend the better-fitting product for a queue-only, workflow-only, hosted
  runtime or stream-throughput need.
