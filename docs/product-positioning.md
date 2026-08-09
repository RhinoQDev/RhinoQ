# Product positioning

Reviewed: 2026-08-08.

## One sentence

> Catch background jobs that succeeded technically but failed in the real world.

RhinoQ is an outcome-verification and safe-recovery layer for existing
background workers. It separates queue completion, provider confirmation and
the business outcome so a green job cannot silently become a false success.

TaskStore, the BullMQ bridge, Gateway and native Go runtime reduce integration
cost. They support the product; they are not the central product promise.

## The category trigger RhinoQ should own

> The queue says completed. Is the real-world outcome actually true?

RhinoQ should be the first product a team recalls when `completed` is not
enough evidence: money may not have moved, a resource may not be ready, or an
output may be absent. The memorable unit is not a queue, workflow or dashboard;
it is the evidence-backed path from ambiguous completion to a verified outcome.

Every quickstart, demo and integration should therefore reach one visible
`completed != verified` example before introducing the broader platform. Task
convenience earns adoption, while outcome evidence and guarded repair provide
the reason to choose RhinoQ over another status table.

## First user

The strongest first adopter is a Node.js or Go team that already runs BullMQ or
another worker and has at least one high-risk asynchronous effect:

- payment, refund, subscription or entitlement;
- provisioning, storage or fulfilment;
- report/media/AI generation whose output can be missing or invalid.

They have experienced, or can reproduce, a case where the handler returned but
the provider result was unknown or the business row was still wrong. A simple
fire-and-forget queue with no customer-visible invariant does not need RhinoQ.

## Value loop

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
