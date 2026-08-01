# RhinoQ

## Catch background jobs that succeeded technically but failed in the real world.

BullMQ can report `completed` while a payment response timed out, a provisioned
resource never became ready, or the database still contains the old business
state. RhinoQ keeps those truths separate, preserves the evidence, and gives an
operator a controlled path from detection to repair.

```text
queue/runtime says completed
            |
            v
provider operation: accepted | confirmed | failed | uncertain
            |
            v
business rule: pass | finding
            |
            v
detect -> investigate -> decide -> repair -> verify
```

[![CI](https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml/badge.svg)](https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml)
[![Security](https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml/badge.svg)](https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml)
![Go 1.26](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)
![PostgreSQL 16](https://img.shields.io/badge/PostgreSQL-16_tested-4169E1?logo=postgresql&logoColor=white)
![Status](https://img.shields.io/badge/status-prerelease-f59e0b)

> [!WARNING]
> RhinoQ is a prerelease for evaluation and controlled pilots. Tenant-wide
> RBAC, multi-node notification dispatch and deployment-shaped chaos evidence
> still block a production-ready claim.

**New here?** Read the [complete beginner guide](./docs/start-here.md): the
failure story, every setup command and why it exists, the two dashboards,
BullMQ/ProviderOperation integration, safe repair, troubleshooting, and an
honest comparison with established alternatives.

## Try it in under five minutes

Node.js 22 and PostgreSQL are the only requirements for the shortest path. The
GitHub release archive is used until npm trusted publishing is enabled:

```bash
npm install https://github.com/madebyduy/RhinoQ/releases/download/v0.1.0-beta.7/rhinoq-node-0.1.0-beta.7.tgz pg
npx rhinoq init
npx rhinoq verify add completed-report-has-output
npx rhinoq doctor
npx rhinoq fixture failure
npx rhinoq dev
```

Set `DATABASE_URL` before `init`. The CLI detects PostgreSQL and BullMQ, previews
what is missing, refuses to overwrite generated Rules, and prints a next action
for every failure. Open the URL printed by `rhinoq dev` to see a technically
successful Execution whose real-world Task is `uncertain`.

## The demo that explains the product

The official [Next.js + BullMQ + PostgreSQL + Stripe sandbox demo](./examples/nextjs-bullmq-stripe/)
reproduces the failure RhinoQ is built for:

1. BullMQ completes a refund job.
2. Stripe accepts the idempotent request, but the response is lost.
3. The order row is deliberately left unchanged.
4. RhinoQ records the provider result as `uncertain`; it does not retry blindly.
5. A Rule finds the mismatch and the demo Evidence Rail shows the operation.
6. An operator rechecks Stripe, previews a repair, supplies a reason and obtains
   approval from a second actor.
7. The application callback performs the repair and RhinoQ verifies the outcome.

The demo uses a deterministic Stripe-shaped sandbox so it can run in CI without
secrets and never reads a Stripe key. A real integration supplies Stripe's test
SDK calls through the same reference adapter.

## The core contract

```ts
const operation = await rhinoq.providerOperation({
  taskId,
  name: 'stripe.refund',
  idempotencyKey,
  execute: (key) => stripe.refunds.create(
    { payment_intent: paymentIntentId },
    { idempotencyKey: key },
  ),
  confirm: (record) => lookupRefundWithoutRepeatingTheMutation(record),
});
```

The Go core reserves a durable provider-operation identity before external code
runs. A timeout is not treated as failure. Retry is allowed only after
confirmation proves `not_happened`. Request evidence is append-only and kept
separate from application-specific business mappings. Reference adapters exist
for Stripe and provisioning/storage providers.

See [ProviderOperation](./docs/provider-operations.md).

## Safe recovery, not arbitrary database editing

Workbench supports subject recheck and the full guarded repair flow:

```text
propose -> preview/dry-run -> approve -> fresh precondition
        -> application callback -> automatic re-verify -> audit
```

A repair requires an operator reason, a different approver, a stable
precondition/version and a registered application callback. RhinoQ never accepts
arbitrary SQL from the browser. A changed precondition makes the plan stale; an
unknown callback result becomes `uncertain`.

See [Safe repair](./docs/safe-repair.md) and [Workbench](./docs/workbench.md).

## Findings reach people

Findings can be delivered to signed generic webhooks or Slack with severity,
grace period, regression escalation, stable event IDs and direct Workbench
links. A durable delivery ledger deduplicates destination/event pairs. Automatic
multi-node scheduling remains a deployment responsibility in this prerelease.

See [Notifications](./docs/notifications.md).

## Existing infrastructure stays in place

RhinoQ is not another queue and does not require rewriting handlers:

- **BullMQ bridge:** observes explicitly tracked jobs and reconciles known jobs;
  the application still owns Redis, enqueueing and worker code.
- **TaskStore:** browser-friendly summary polling, owner-scoped actions and lazy
  Execution history.
- **Native Go runtime:** optional PostgreSQL-backed runtime for teams that need
  one; it is not the product's central promise.
- **Gateway:** typed bridge for Node and other languages while Go remains the
  authoritative correctness engine.

Task summary polling is bounded: aggregate Execution counts are stored with the
Task, and history uses cursor pagination. The compatibility full Snapshot still
exists but is not the default browser polling shape.

## What is implemented

| Capability | Status |
|---|---|
| ProviderOperation identity, idempotency, evidence and confirmation | implemented; memory/PostgreSQL tested |
| `uncertain` Task state linked to provider uncertainty | implemented |
| Stripe and provisioning/storage reference adapters | implemented in Node SDK |
| Rules, Findings and Evidence Workbench | implemented |
| Recheck and guarded repair workflow | implemented; callback registration is application-owned |
| Summary polling and cursor-paginated Executions | implemented |
| Signed webhook and Slack notifications with durable dedup | implemented |
| BullMQ lifecycle bridge and embedded PostgreSQL Task client | implemented and tested |
| Release archives, verifiable checksum bundle, SBOM and non-root image | beta.7 release pipeline verified in CI |
| Tenant-wide RBAC and isolation across every subsystem | not implemented |
| Durable multi-node notification scheduler | not implemented |
| Production-shaped design-partner evidence | not yet collected |

No throughput, latency or reliability promise is made without the matching
evidence. Reproducible measurements and their limits live in
[Benchmarks](./docs/benchmarks.md).

## Production trust

Tagged releases build Linux/macOS/Windows binaries, checksums, keyless
signatures, SPDX SBOMs, provenance and a non-root container image. CI exercises
Go, Node.js, PostgreSQL contracts and Linux race tests. Operators still need to
run restore drills, choose retention/partitioning and deploy a distributed edge
limiter.

Read [Production readiness](./docs/production-readiness.md),
[Migration recovery](./docs/migration-rollback.md) and
[Retention](./docs/retention.md) before a controlled pilot.

## Design partners

RhinoQ needs three real workloads, not more marketing benchmarks. The best
first partners are teams with payments/refunds, provisioning/storage, or
generated reports where a green queue status can still hide a customer-visible
failure. The concrete recruiting channels, outreach message, pilot scope and
success/kill metrics are in [Design partners](./docs/design-partners.md).

## Documentation

- [Start here: complete beginner guide](./docs/start-here.md)
- [Five-minute setup](./docs/getting-started.md)
- [Node.js and BullMQ](./docs/nodejs.md)
- [ProviderOperation](./docs/provider-operations.md)
- [Safe repair](./docs/safe-repair.md)
- [Notifications](./docs/notifications.md)
- [Architecture](./ARCHITECTURE.md)
- [Release process](./docs/releasing.md)
- [Roadmap and honest blockers](./docs/roadmap.md)

RhinoQ is licensed under Apache-2.0. Contributions should follow
[CONTRIBUTING.md](./CONTRIBUTING.md), [SECURITY.md](./SECURITY.md) and
[AGENTS.md](./AGENTS.md).
