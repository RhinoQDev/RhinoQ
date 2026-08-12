# Product positioning

Reviewed: 2026-08-08.

## One sentence

> Install the async-task platform instead of rebuilding queue safety, Task APIs,
> realtime UI, operations and recovery in every application.

RhinoQ gives Node.js and Go teams a configured async-task product surface: use
its PostgreSQL queue or keep an existing runtime, then mount durable Tasks,
attempts, progress, owner APIs, realtime delivery, Task Center, Workbench,
health, metrics, reconciliation, notifications and guarded recovery. The
application supplies its business handler and authenticated identity instead
of rebuilding the surrounding platform.

Outcome verification remains the strongest safety differentiator. It separates
queue completion, provider confirmation and business outcome so a green job
cannot silently become false success, but it is one layer of the platform—not
the whole product story.

## The category trigger RhinoQ should own

> I have background work. Why should every application rebuild the queue,
> status API, realtime UI, operator console and recovery loop?

The adoption promise is a short path from an application handler to a complete
user and operator experience. `init` discovers database/runtime prerequisites;
`adopt` detects supported BullMQ/NestJS structure and generates integration
without overwriting files; `doctor` identifies missing configuration; and
`createRhinoQApp()` mounts the standard product surface.

After that first value, verification answers the harder question: whether a
technically completed job produced the real result. Task convenience and low
integration code earn adoption; outcome evidence and guarded repair distinguish
RhinoQ from a basic queue wrapper.

## First user

The strongest first adopter is a Node.js or Go team that needs background work
but does not want to build the full task platform around it. That includes a
team starting with RhinoQ's PostgreSQL queue and a team retaining BullMQ or
another worker. High-risk asynchronous effects make the verification layer
especially valuable:

- payment, refund, subscription or entitlement;
- provisioning, storage or fulfilment;
- report/media/AI generation whose output can be missing or invalid.

They have experienced, or can reproduce, a case where the handler returned but
the provider result was unknown or the business row was still wrong. A simple
fire-and-forget queue with no customer-visible invariant does not need RhinoQ.

## Two value loops

The everyday platform loop is:

```text
install -> detect/configure -> dispatch -> show progress -> operate/recover
```

The evidence loop for high-risk outcomes is:

```text
detect -> investigate -> decide -> repair -> verify
```

- `ProviderOperation` reserves an idempotent external mutation and treats an
  unknown response as `uncertain`, never as automatic failure.
- Rules and Findings independently check the business outcome.
- Evidence keeps execution, provider and operator facts inspectable.
- Workbench rechecks a subject and drives a preview/approval/precondition/
  callback/verification repair workflow without arbitrary database editing.
- Signed webhook and Slack delivery move Findings outside the dashboard.

## What “automatic setup” means

RhinoQ automates the standard, evidence-backed parts it can know:

- detects PostgreSQL, `pg`, BullMQ and NestJS prerequisites;
- installs or verifies its schema;
- discovers supported queue declarations and producer call sites;
- generates a non-overwriting integration module or example consumer;
- mounts owner API, Task Center, Workbench and operator login together;
- supplies default projector/reconciler leases, health and metrics wiring;
- validates the resulting product surface and prints the next action.

It deliberately cannot infer authenticated owner/tenant identity, business
payload behavior, provider credentials, whether retrying an external mutation
is safe, or what business result counts as correct. Asking for those callbacks
is a correctness boundary, not unfinished setup automation.

## Integration boundary

RhinoQ does not replace BullMQ, Temporal, Restate, DBOS, Inngest, Trigger.dev or
Hatchet. The application keeps its queue, Redis connection, worker handler,
Stripe SDK and business tables. Go remains authoritative for uncertainty,
retry fences, repair state and audit; SDKs only adapt application callbacks and
transport.

The Task support layer adds bounded summary polling, cursor-paginated Execution
history, owner-scoped actions and result references. The native PostgreSQL
runtime is optional.

## Claims supported today

- A provider response timeout is stored as `uncertain` and a repeat does not
  call the mutation again until read-back proves `not_happened`.
- Task and Execution state stay separate; a technically successful Execution
  can leave its Task uncertain.
- Provider evidence is append-only and separate from business mapping.
- Repair requires a dry-run, different approver, reason, fresh precondition,
  idempotent application callback and independent verification.
- Summary polling does not carry all Executions; history uses cursor pages and
  stored aggregate counts.
- Webhook/Slack sends have severity, grace, regression escalation and durable
  per-destination deduplication.
- The official Docker demo reproduces and safely repairs a BullMQ/Stripe-shaped
  response-loss failure end to end.

## Claims not supported yet

- Production readiness or tenant-wide RBAC/isolation.
- Exactly-once external effects; RhinoQ provides idempotency and evidence, not
  a distributed transaction with providers.
- Automatic multi-node notification scheduling.
- Drop-in discovery of every BullMQ job, generic workflow orchestration or a
  provider marketplace.
- Throughput, latency, reliability or code-reduction guarantees beyond the
  published reproducible evidence.
- Proven market demand before three real design-partner pilots finish.

## Validation gates

The positioning wins only if three real applications can keep their handlers,
integrate within a controlled pilot, and produce at least one prevented or
detected mismatch with less operational work than their current scripts. Track
integration time, old plumbing removed, time-to-detect, duplicate prevention,
repair safety and operator confidence. See [Design partners](./design-partners.md)
and the reproducible [benchmarks](./benchmarks.md). Internal market research is
kept outside the public repository.
