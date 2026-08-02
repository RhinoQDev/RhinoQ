# RhinoQ

## Your queue says the job succeeded. RhinoQ checks whether it actually did.

BullMQ can report `completed` while a payment response timed out, a provisioned
resource never became ready, or the database still contains the old business
state. RhinoQ reads your database, tells you which rows contradict a rule you
declared, and keeps the evidence.

<p align="center">
  <img src="./docs/assets/first-finding.svg" alt="rhinoq detect reports one open Finding: report_missing is completed but its outputKey is null" width="880">
</p>

[![CI](https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml/badge.svg)](https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml)
[![Security](https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml/badge.svg)](https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml)
![Go 1.26](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)
![PostgreSQL 16](https://img.shields.io/badge/PostgreSQL-16_tested-4169E1?logo=postgresql&logoColor=white)
![Status](https://img.shields.io/badge/status-prerelease-f59e0b)

## One command, one read-only role

```bash
docker run --rm \
  -e RHINOQ_SUBJECT_DATABASE_URL='postgres://rhinoq_readonly:...@host:5432/app?sslmode=disable' \
  -v "$PWD/rules.json:/etc/rhinoq/rules.json:ro" \
  ghcr.io/madebyduy/rhinoq:next detect --rules /etc/rhinoq/rules.json
```

That is the whole install. No migration against your schema, no RhinoQ table in
your database, no second process to keep alive, and by default nothing written
anywhere — Rules and Findings live in memory for the length of the command.
The only change your database needs is
[one role with `SELECT`](./examples/integrity-only/readonly-role.sql).

Try it end to end on a throwaway database first:

```bash
docker compose -f examples/integrity-only/docker-compose.yml run --rm detect
```

Start a Rule file from the built-in template, then edit the query:

```bash
docker run --rm ghcr.io/madebyduy/rhinoq:next detect --example > rules.json
```

> `detect` is newer than the newest published tag (`v0.1.0-beta.7`, whose image
> still entrypoints the Gateway). `:next` carries it from the following tag
> onward; until then, `docker build -t ghcr.io/madebyduy/rhinoq:next .` from this
> checkout. Signed release binaries for Linux, macOS and Windows are already
> attached to every tag — nothing here requires a Go toolchain.

A Rule is one SQL query returning `subject_id`, `violated` and `evidence`.
`violated` may be `NULL`: a check that could not reach a provider is counted as
`unknown`, never folded into `passed`, because that is exactly how drift hides.
`EXPLAIN` gates every Rule on plan cost, estimated rows and sequential scans
before it is allowed to run, so a Rule that would table-scan your largest table
is rejected with the reason instead of run slowly.

Findings survive the process when you give RhinoQ a database of its own —
never your application's — and add `--store`. Full walkthrough:
[the detector](./examples/integrity-only/).

## The demo that explains the whole product

The [Next.js + BullMQ + PostgreSQL + Stripe sandbox demo](./examples/nextjs-bullmq-stripe/)
reproduces the failure RhinoQ is built for, end to end:

1. BullMQ completes a refund job.
2. Stripe accepts the idempotent request, but the response is lost.
3. The order row is deliberately left unchanged.
4. RhinoQ records the provider result as `uncertain`; it does not retry blindly.
5. A Rule finds the mismatch and the Evidence Rail shows the operation.
6. An operator rechecks Stripe, previews a repair, supplies a reason and obtains
   approval from a second actor.
7. The application callback performs the repair and RhinoQ verifies the outcome.

The demo uses a deterministic Stripe-shaped sandbox so it runs in CI without
secrets and never reads a Stripe key. A real integration supplies Stripe's test
SDK calls through the same reference adapter.

```bash
docker compose -f examples/nextjs-bullmq-stripe/docker-compose.yml up
```

## Two truths, kept apart

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

The detector is the entry point to that pipeline, and it is useful on its own:
a Finding is a statement that something is wrong, and it needs no queue, no
worker and no cutover to produce. Everything below is what you can adopt after
the first Finding convinces someone — none of it is required to get there.

## ProviderOperation — durable identity for an external call

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

> **Phase 2.** In Node this API is reachable only through the `rhinoq-agent`
> Gateway process. There is no embedded PostgreSQL ProviderOperation client, and
> there will not be one until the state machine can be shared rather than
> reimplemented in TypeScript — two correctness authorities is the one outcome
> worth avoiding here. Adopt the detector first; adopt this when you are ready
> to run a second process. See [ProviderOperation](./docs/provider-operations.md)
> and [ADR-0024](./.ai/DECISIONS.md).

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

Task state is delivered by **polling**, and that is a decision rather than a
staging post. Aggregate Execution counts are stored with the Task, history uses
cursor pagination, and every read carries the aggregate version a UI needs to
discard a stale response. No SSE or WebSocket transport is planned for 0.1.
Rationale and the conditions that would reverse it: [ADR-0023](./.ai/DECISIONS.md)
and [Roadmap](./docs/roadmap.md).

## Node.js and BullMQ

```bash
npm install @rhinoq/node@next pg
```

The Node package covers the BullMQ lifecycle bridge and the embedded
PostgreSQL Task client, which needs three tables in the application's own
database and no Gateway process. The detector above is a container and needs
none of this. See [Node.js and BullMQ](./docs/nodejs.md).

> [!WARNING]
> RhinoQ is a prerelease for evaluation and controlled pilots. Tenant-wide
> RBAC, multi-node notification dispatch and deployment-shaped chaos evidence
> still block a production-ready claim. The read-only detector is the part
> designed to be safe to try anyway: it holds no write privilege on your
> database.

## What is implemented

| Capability | Status |
|---|---|
| Read-only detector: Rules, Explain gate, bounded scans, Findings | implemented; ephemeral and stored modes |
| `uncertain` observations kept separate from `passed` | implemented |
| Rules, Findings and Evidence Workbench | implemented |
| Recheck and guarded repair workflow | implemented; callback registration is application-owned |
| ProviderOperation identity, idempotency, evidence and confirmation | implemented in Go; **Node access requires the Gateway** |
| Stripe and provisioning/storage reference adapters | implemented in Node SDK, Gateway-only |
| Summary polling and cursor-paginated Executions | implemented |
| Signed webhook and Slack notifications with durable dedup | implemented |
| BullMQ lifecycle bridge and embedded PostgreSQL Task client | implemented and tested |
| Release archives, verifiable checksum bundle, SBOM and non-root image | beta.7 release pipeline verified in CI |
| Measured code deletion in a third-party application | **not measured** — see [Measuring plumbing](./docs/measuring-plumbing.md) |
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

- [The detector](./examples/integrity-only/) — start here
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
