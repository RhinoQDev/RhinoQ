# RhinoQ — Product baseline

## Status

**Accepted baseline:** Task Platform with an optional Verified Tasks capability.

[`docs/product-positioning.md`](../docs/product-positioning.md) is the concise
public messaging source. `RHINOQ_PRODUCT_DIRECTION_v3.md` remains long-range
design research. Neither is an implementation contract unless a decision below
is explicitly updated in this file, `DECISIONS.md`, the architecture documents
and tests.

## Product promise

RhinoQ gives an application a durable, user-facing lifecycle for asynchronous
work without requiring the application to rebuild status APIs, progress
delivery, cancellation, retry, history and result handling for every feature.

The application keeps its business logic and may keep its existing queue and
workers. RhinoQ owns reusable task infrastructure around that work.

## Product model

```text
Task 1:N Execution
Execution 0:1 Job
Execution 0:N ProviderOperation
Task 0:1 VerifiedTaskPolicy
Task 0:N OutcomeObservation
```

- **Task** is the user-facing unit: ownership, lifecycle, progress, result and
  history.
- **Execution** is one attempt to perform a Task through a runtime.
- **Job** is the current native queue/runtime primitive. It is not renamed or
  deleted during the first Task slice.
- **ProviderOperation** tracks an asynchronous external provider request when
  a task needs polling, webhook confirmation, timeout or idempotency.
- **Verified Tasks** adds Effect Ledger, outcome verification, Findings and
  reconciliation only where the application needs stronger correctness.

## Runtime policy

1. Native Go/PostgreSQL runtime remains the first implementation backend.
2. Existing runtimes, starting with BullMQ, are adapters; RhinoQ must not
   require a queue migration to prove the Task layer.
3. Go remains authoritative for state transitions, leases, retries,
   idempotency and correctness. SDKs expose contracts and lifecycle helpers.
4. PostgreSQL is durable truth for Task state, execution history and outcome
   evidence. Redis is optional and is not required for the first Task slice.

## First product slice

The first end-to-end slice must support one real long-running use case:

- create a Task;
- enqueue or bind an Execution;
- claim/run/heartbeat/complete/fail;
- report progress;
- cancel and retry with explicit command identity;
- read a versioned snapshot and history;
- store and retrieve a result reference;
- survive worker restart and client reload;
- expose an optional ProviderOperation with idempotency and `uncertain` state.

Polling is the first delivery transport. Realtime transport, streams, Redis
fan-out and additional frontend SDKs are follow-up capabilities, not reasons
to distort the first durable state model.

## Verified Tasks boundary

Verified Tasks is not mandatory ceremony for every Task. It is enabled when a
task has a business invariant or an irreversible external effect that must be
proved beyond technical execution success.

Required semantics:

- provider `accepted` is not provider `confirmed`;
- unknown external results fail closed or become `uncertain`;
- irreversible effects require explicit idempotency and confirmation policy;
- business outcome remains owned by the application database and is observed,
  not silently rewritten by RhinoQ.

## Explicit non-goals for the first slice

- replacing BullMQ, Temporal, Inngest or Hatchet;
- a visual workflow/DAG builder;
- a provider marketplace;
- generic support for every provider;
- WebSocket, multi-region or horizontally scaled realtime;
- AI root-cause analysis;
- deleting the existing Job, Rule, Finding or Effect Ledger foundations.

## Completion gate

The first slice is complete only when one real application can adopt it for a
second long-running feature without rebuilding status, retry and result
plumbing, and the failure paths have unit, contract, integration and fault
evidence. Feature count alone is not completion evidence.
