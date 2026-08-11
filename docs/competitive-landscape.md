# Competitive landscape

> Last reviewed: 2026-08-10. This document compares product boundaries, not
> benchmark performance. Recheck primary sources before publication.

RhinoQ does not enter an empty category. Queue libraries, durable execution
runtimes and workflow platforms already solve large parts of reliable
background execution. RhinoQ's primary hypothesis is narrower:

> A team with existing async work can add a durable, user-facing Task
> contract without rebuilding status/result/UI plumbing or migrating its whole
> execution model.

The optional Verified Tasks layer has a second hypothesis: effect evidence,
outcome observation and Findings help the smaller set of tasks where technical
completion is not enough. Neither hypothesis means competitors cannot implement
the behavior in application code.

## Category map

| Category | Established strengths | RhinoQ boundary |
|---|---|---|
| [BullMQ](https://github.com/taskforcesh/bullmq) | Redis queue, workers, progress, results, retry, cancellation, events and operations ecosystem | RhinoQ's bridge adds Task/evidence projection; it must not claim queue replacement or higher throughput |
| [Bull Board](https://github.com/felixmosh/bull-board) | queue/job inspection and operator actions | operator UI, not a user-facing Task ownership/snapshot layer |
| [pg-boss](https://github.com/timgit/pg-boss), [Graphile Worker](https://worker.graphile.org/docs) and [PGMQ](https://github.com/pgmq/pgmq) | PostgreSQL queue primitives, transactional enqueue and workers | PostgreSQL and ACID enqueue are table stakes, not differentiation |
| [Trigger.dev](https://trigger.dev/docs/introduction) and [Inngest](https://www.inngest.com/docs) | managed task/runtime models, retries, observability and frontend/realtime tooling | RhinoQ cannot win on generic task features; it must show lower migration cost for current-worker teams |
| [Hatchet](https://github.com/hatchet-dev/hatchet), [Temporal](https://docs.temporal.io/), [Restate](https://docs.restate.dev/) and [DBOS](https://docs.dbos.dev/) | durable execution/workflows, state, retries and broad operational systems | use these when durable workflow semantics or their execution model is the central need |
| transport products | channels, messages and subscriptions | transport does not own Task lifecycle, attempts, history or business authorization |

## Primary-source check: where RhinoQ is behind

This is the comparison an evaluator should see before choosing RhinoQ, not
after integration:

| Alternative | Documented strength RhinoQ should not imitate or minimize | Honest RhinoQ answer |
|---|---|---|
| [BullMQ](https://docs.bullmq.io/guide/flows/) | queue runtime, job schedulers, flow trees, concurrency, rate limits, retries, telemetry and a large operational ecosystem | Keep it. RhinoQ adds a user-safe Task contract and outcome evidence; it is not a better queue. |
| [Trigger.dev](https://trigger.dev/docs/introduction) | hosted/self-hosted task runtime, dashboard, schedules, waits, retries, queues and [typed Realtime React hooks](https://trigger.dev/docs/realtime/overview) | Trigger.dev has the stronger integrated execution and frontend experience. RhinoQ only wins when retaining the current worker/runtime is more valuable than that integration. |
| [Inngest](https://www.inngest.com/docs/learn/inngest-functions) | durable step results, event waits, step retries, concurrency controls, dashboard operations and [realtime channels](https://www.inngest.com/docs/examples/realtime) | Inngest has the stronger event-driven workflow product. RhinoQ should compete on no handler migration and explicit post-execution verification. |
| [Temporal](https://docs.temporal.io/temporal) | a durable-execution runtime with event-history replay; Workflows can recover state and continue after crashes | Choose Temporal when workflow durability is the main problem. RhinoQ does not provide equivalent deterministic workflow replay. |
| [Restate](https://docs.restate.dev/tour/workflows) | durable steps, promises/signals, timers, parallel execution, retries, sagas and execution traces | Choose Restate when adopting durable services/workflows is acceptable. RhinoQ is the overlay choice for an execution runtime that must remain in place. |

RhinoQ is currently also behind mature products in hosted onboarding, team/RBAC
administration, polished framework examples, ecosystem breadth and production
evidence. The repository has strong local correctness tests; that is not the
same evidence as several teams operating it under real load.

## Where RhinoQ must be materially better

Feature parity is a losing plan. RhinoQ has to be unusually good at these four
things together:

1. **Adopt without moving execution.** A team keeps its runtime, workers,
   payload and retry policy. Door 1 should delete more status/progress/cancel/UI
   plumbing than it adds, with no business-handler rewrite. BullMQ is the
   adapter currently used to prove this path, not the product definition.
2. **Give product users a Task, not a queue job.** Ownership, stable item
   identity, attempts, results, cancellation outcome and snapshot-convergent
   live delivery must arrive as one contract and one mount.
3. **Explain uncertainty instead of hiding it.** “The handler returned” must
   remain separate from “the provider confirmed” and “the business outcome is
   correct.” Flight Recorder, evidence and Findings should make that difference
   easier to investigate than logs plus a queue dashboard.
4. **Make operational safety visible.** Fail-closed cancellation, bounded
   reconciliation, read-only Rule execution, version fences and guarded repair
   must be understandable in the UI—not merely correct in internal code.

Today, item 2 is demonstrable in the BullMQ integration example and item 4 has
substantial local test coverage. Items 1 and 3 are still only partially proven: item 1 needs a
real adopter before/after deletion count, and item 3 still lacks a single
provider/effect-wide timeline in the Node Workbench.

## Current go-to-market verdict

- **Recommend RhinoQ now:** controlled BullMQ pilot where the current worker
  must stay and the team wants a reusable owner-facing Task API plus operator
  investigation.
- **Do not recommend it yet:** a production-wide task platform requiring hosted
  operations, uniform tenant RBAC, several runtime adapters, or published
  deployment/fault evidence.
- **Recommend an alternative:** Trigger.dev/Inngest for an integrated hosted
  developer experience; Temporal/Restate for durable workflow execution;
  BullMQ alone when only queue/runtime primitives are needed.

BullMQ itself has progress, result, retry and cancellation primitives. The gap
is not “BullMQ cannot model a job.” The application still has to decide task
identity, user/tenant ownership, UI-safe state, result delivery and how to
converge after reload or out-of-order responses.

Trigger.dev and Inngest already offer rich frontend/realtime task experience.
RhinoQ's wedge is keeping an existing execution runtime—not feature parity.
The tested BullMQ bridge reserves identity before `Queue.add`, supports bounded
fan-out dispatch, observes lifecycle events and reconciles application-known
jobs. It deliberately does not own Redis, rewrite handlers, scan a whole queue
after downtime or guess whether an active side effect can be cancelled safely.

## RhinoQ product boundary

| Layer | Boundary | Status |
|---|---|---|
| Task Platform | Task identity, versioned summary, progress, result reference, lifecycle and execution history | summary polling, stored aggregates and cursor-paginated Executions implemented |
| Existing-runtime adoption | lifecycle bridge observes an existing worker | BullMQ bridge dispatches/reserves or tracks known jobs; no outage-wide queue discovery |
| Delivery | snapshot-convergent SSE with polling fallback | owner-scoped Task/inbox SSE, TaskStore/TaskListStore convergence and zero-added-dependency React adapter implemented |
| Verified Tasks | effect evidence, outcome observation, Rules and Findings | optional foundation implemented |

The external Execution reference alone is not an adapter. The BullMQ bridge
can reserve before enqueue, track existing jobs, project events and compose
application-owned cancellation. It still does not own BullMQ retry policy,
discover unknown jobs after downtime or prove that an active side effect can be
cancelled safely.

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
