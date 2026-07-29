# Product positioning

Reviewed: 2026-07-29.

This is the short, public product narrative. It is authoritative for product
messaging together with `README.md`. Implementation truth remains the Task
Platform contract, tests and `.ai/STATUS.md`. The long
[`RHINOQ_PRODUCT_DIRECTION_v3.md`](../RHINOQ_PRODUCT_DIRECTION_v3.md) is design
research: it contains useful proposals, not promises.

## One sentence

> RhinoQ adds a durable, user-facing task lifecycle to applications that already
> run background work, without making the frontend depend on queue internals.

The future adapter promise is intentionally narrower:

> Your queue stays. Your workers stay. RhinoQ adds the user-facing task layer.

The first implementation is a deliberately narrow BullMQ lifecycle bridge: it
observes application-owned, explicitly tracked jobs and persists their Task /
Execution lifecycle. It is not queue migration, auto-dispatch, cancellation,
retry orchestration or a full outage reconciler.

## The user and the problem

The first target user is a Node.js/NestJS or Go team that already has BullMQ or
another worker, has two or more user-visible long-running operations, and is
rebuilding the same glue for each one:

```text
create a job → persist ownership → expose status → poll or push progress
             → handle reload/retry → cancel → retry → fetch result → show history
```

BullMQ already provides job execution primitives such as workers, progress,
results, retries, cancellation signals and queue events. A product team still
has to make those primitives safe and useful for its own users: task identity,
ownership, an application-facing snapshot, result delivery, UI state
convergence and authorization. RhinoQ's Task is that product boundary.

## Product layers

| Layer | Job | Current status |
|---|---|---|
| Task Platform | Task ownership, lifecycle, progress, result reference, history and versioned snapshot | first polling slice implemented |
| Execution backends | Native runtime or adapter to a current worker | native runtime plus a narrow BullMQ lifecycle bridge; broader adapters planned |
| Delivery | Polling first; later realtime, frontend hooks and Task Center | versioned HTTP polling implemented; realtime/UI not implemented |
| Verified Tasks | Effect evidence, outcome observation, Rules and Findings for high-risk work | optional foundation implemented |

Verified Tasks is a capability, not the onboarding ceremony. A report export
that only needs a status and result should not require Rules or Findings. A
payment, provisioning action or provider request with an uncertain outcome may
enable that stronger evidence layer.

## Competitive boundary

RhinoQ is not trying to be a better durable workflow platform than Temporal,
Restate, DBOS, Trigger.dev, Inngest or Hatchet. Those products are mature in
their own execution/programming models. RhinoQ also is not a replacement for
BullMQ or an operator dashboard such as Bull Board.

The hypothesis is narrower: an application with an existing runtime should be
able to add a user-facing Task contract without moving its entire workload or
hand-building the backend/frontend lifecycle for every feature.

That hypothesis is plausible, not proven. Trigger.dev and Inngest already
offer rich frontend/realtime task experiences; RhinoQ must demonstrate lower
migration cost for existing-worker teams, not claim feature parity. See
[Product evidence](./product-evidence.md) and the
[competitive landscape](./competitive-landscape.md).

## Claims we can make today

- Go, HTTP and Node share a versioned Task snapshot contract.
- A stale Task mutation fails closed rather than overwriting a newer aggregate
  version.
- Task state is distinct from Execution, Job, Effect and Outcome state.
- Result references are read separately from a polling snapshot.
- Native Go/PostgreSQL runtime and the optional verification foundation have
  tests and real-PostgreSQL coverage.
- The source-only Node SDK has a tested BullMQ lifecycle bridge for explicitly
  tracked, application-owned jobs.

## Claims we must not make yet

- “Drop-in BullMQ integration”, automatic dispatch, cancellation or retry
  orchestration for BullMQ jobs.
- “React Task Center”, realtime streaming or browser reconnect safety.
- Tenant-scoped end-user authorization.
- Code-reduction, reliability, latency or throughput figures.
- A generic provider platform or exactly-once external effects.
- Production readiness.

## Validation gates

The positioning earns its place only when RhinoQ can show all of the following:

1. Three applications integrate without rewriting their business handlers.
2. A real application with two Task types removes meaningful status/result/UI
   plumbing instead of adding another layer of glue.
3. A browser reload, delayed response and retry cannot regress the visible Task
   state.
4. A user can only read or act on Tasks within an authorized scope.
5. An asynchronous provider outcome can remain `uncertain` rather than being
   blindly retried or called successful.

Until then, product material must say “intended adoption path” or “planned”
where appropriate.
