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

## What it actually does

Four commands against a real database. No queue, no worker, no cutover — a Rule
and a connection string are enough.

```console
$ rhinoq rules enable completed-report-has-output
PASS Rule completed-report-has-output@v3 enabled · plan cost 29.31

$ rhinoq scan completed-report-has-output
Rule:              completed-report-has-output
Pages:             1
Observed:          3
Passed:            1
Violated:          2
Unknown:           0
Findings touched:  2
Duration:          20ms
Status:            complete

Inspect what was found:
  rhinoq findings list --rule completed-report-has-output

$ rhinoq findings
RULE                         SUBJECT      STATUS  SEEN  LAST OBSERVED         OWNER
completed-report-has-output  report/2@v3  open    2     2026-08-03T03:14:34Z  —
completed-report-has-output  report/3@v3  open    2     2026-08-03T03:14:34Z  —

$ rhinoq attention
KIND               JOB / REFERENCE                          REASON
integrity_finding  completed-report-has-output/report/3@v3  business invariant is violated
integrity_finding  completed-report-has-output/report/2@v3  business invariant is violated
```

Two reports that a queue reported as completed have no output. They are named,
versioned against the Rule that found them, and waiting in an inbox. Reproduce
this on a disposable database with the
[integrity-only example](./examples/integrity-only/).

### "I could write a cron job that runs that SQL"

You could. It would not have a gate.

`plan cost 29.31` is printed **before** the Rule is allowed to run. Enabling a
Rule first runs `EXPLAIN` against your database and refuses the Rule if the plan
exceeds `MaxPlanCost` or `MaxSeqScanRows`. The query then executes in a
`READ ONLY` transaction under a `statement_timeout`, paged, with a hard row
limit. An integrity checker that can table-scan production at 3am is not a
safety net; it is a second outage.

```console
$ rhinoq explain completed-report-has-output
```

### Three outcomes, not two

Every observation is `passed`, `violated` or **`unknown`** — and an unknown
carries a reason: `provider_timeout`, `permission_denied`, `evidence_missing`,
`awaiting_confirmation`.

This is the difference between "we looked and it was wrong" and "we could not
look". Forced into a boolean, a provider timeout reads as *this subject is
fine*, and drift disappears because a network hiccup voted for it. RhinoQ keeps
SQL's `NULL` as `unknown` and applies the Rule's own policy: retry quietly, or
open a Finding after a grace period. See
[failure semantics](./docs/failure-semantics.md).

### The preflight is written by someone who has been paged

```console
$ rhinoq doctor
Fencing
  WARN RHINOQ_WORKER_NAME is empty
       The worker falls back to hostname-pid. Epoch fencing still protects
       writes, but an explicit unique name makes logs and incidents clearer.
       Fix: set RHINOQ_WORKER_NAME uniquely per process.
Timing
  PASS heartbeat has room to renew before the lease expires
  PASS expired leases are swept at least once per lease period
```

It checks whether the heartbeat can renew before the lease expires, and whether
the reaper sweeps at least once per lease period. Both are how a job silently
gets executed twice. Every failure carries a `Fix:` line.

Any `FAIL` exits non-zero, so putting `rhinoq doctor` in a pipeline is enough to
stop a deployment. Add `--report` when a person wants the diagnosis without the
exit code.

`npx rhinoq doctor` is a different, smaller command: it checks the isolated Task
profile and local Rule files, not the runtime. Before a pilot, run both.

**New here?** Read the [complete beginner guide](./docs/start-here.md): the
failure story, every setup command and why it exists, the two dashboards,
BullMQ/ProviderOperation integration, safe repair, troubleshooting, and an
honest comparison with established alternatives.

## Try it in under five minutes

Node.js 22 and PostgreSQL are the only requirements for the shortest path. The
GitHub release archive is used until npm trusted publishing is enabled:

```bash
npm install rhinoq pg
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

The five-minute path uses the isolated Task profile. To continue into the
Verified Tasks loop, build the Go CLI and Gateway from the same checkout, apply
the full schema, and start the authenticated Gateway. The Node-only `init`
command does not install these components:

```bash
go build -o rhinoq ./cmd/rhinoq
go build -o rhinoq-agent ./cmd/rhinoq-agent
export RHINOQ_DATABASE_URL='postgres://user:pass@127.0.0.1:5432/app?sslmode=disable'
./rhinoq migrate apply
export RHINOQ_AGENT_TOKEN="$(openssl rand -hex 32)"
RHINOQ_AGENT_TOKEN="$RHINOQ_AGENT_TOKEN" ./rhinoq-agent
```

In another shell, apply and run the Rule you edited. `beta.8` is the first
release whose Node package contains these commands:

```bash
export RHINOQ_AGENT_URL=http://127.0.0.1:8080
export RHINOQ_AGENT_TOKEN="$(openssl rand -hex 32)"
npx rhinoq verify apply completed-report-has-output --subject-type report
npx rhinoq verify run completed-report-has-output
npx rhinoq verify delete completed-report-has-output   # preview; --apply removes it
```

`verify apply` reads `.rhinoq/rules/<name>.sql`, sends it through the Go Rule
boundary and leaves it disabled. Applying a Rule that already exists prints the
query diff and refuses without `--force`, because a new version does not reopen
Findings recorded against the old one. `verify run` enables it only for a
bounded evaluation, prints violated subjects/evidence, then disables it again.
`verify delete` previews what it would remove and needs `--apply`. The Go
Gateway and full migrations are required because Node remains an SDK/CLI
producer and does not reimplement Rule correctness.

A Go-only team does not need the Node package at all:

```bash
./rhinoq rules create completed-report-has-output \
  --query-file .rhinoq/rules/completed-report-has-output.sql \
  --subject-type report --every 5m
./rhinoq explain completed-report-has-output
./rhinoq rules enable completed-report-has-output
./rhinoq scan completed-report-has-output
./rhinoq rules delete probe-rule --apply
```

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

Configure a destination from the terminal and prove it before you trust it:

```bash
export RHINOQ_NOTIFY_SECRET_OPS="$(openssl rand -hex 32)"
rhinoq notify add ops --webhook https://example.com/hooks/rhinoq --secret-env RHINOQ_NOTIFY_SECRET_OPS
rhinoq notify test ops
rhinoq notify list
```

`notify test` sends one synthetic HMAC-signed event and writes nothing — no
Finding, no delivery record, no database connection — so a receiver's signature
check and TLS can be proven before a real incident depends on them. The registry
never stores a secret: it records the *name* of an environment variable, and the
value is read at send time.

The same commands work from Node — `npx rhinoq notify add|list|remove|test` —
reading and writing the same `.rhinoq/notifications.json`. A Node team
previously had no way to configure a destination at all: the only path was a
`NotificationDestination` built in Go and embedded in an application.

`notify send` stays Go-only. A real delivery is recorded in the durable
delivery ledger, and reimplementing that deduplication in a second language
would put correctness in two places; the Node CLI refuses and names the Go
command.

Findings are delivered to signed generic webhooks or Slack with severity, grace
period, regression escalation, stable event IDs and direct Workbench links. A
durable delivery ledger deduplicates destination/event pairs. Automatic
multi-node scheduling remains a deployment responsibility in this prerelease:
call `rhinoq notify send` from your own scheduler.

Applications on the embedded PostgreSQL Task client have no Gateway and
therefore no `/metrics` or `/healthz`. `TaskMetrics` and `checkEmbeddedHealth`
in the Node SDK fill that gap with counters and a reachability probe — counters
only, no latency or rate, because a performance number without its benchmark is
not a claim this project makes.

See [Notifications](./docs/notifications.md).

## Evidence does not accumulate forever

Every scan writes one row per observed subject, per Rule, per Rule version.
`rhinoq_subject_outcomes` is the largest table RhinoQ owns, and it needs a
decision rather than a paragraph of advice:

```bash
rhinoq retention prune --older-than 90d           # preview; changes nothing
rhinoq retention prune --older-than 90d --apply
```

Prune previews by default, deletes in bounded batches, and refuses a cutoff
younger than 24h. It reclaims passing observations, the lifecycle history of
Findings already resolved, and settled delivery-ledger entries. It never removes
an open Finding, a pending delivery, a repair or a ProviderOperation, at any
age. RhinoQ does not choose a legal retention period for the adopter.

See [Retention](./docs/retention.md).

## The Workbench tells you what it can reach

```text
Access   loopback only · read-only · payloads omitted
source   {"mode": "live", "label": "127.0.0.1/rhinoq_full", "readOnly": true}
```

That header is on the page, not in a policy document. The server binds only to
127.0.0.1, is read-only unless `--actions` is passed, never exposes job payloads
and never accepts SQL from the browser. A team that handles payments should be
able to read what a new tool can touch without reading its source.

See [Workbench](./docs/workbench.md).

## Existing infrastructure stays in place

RhinoQ is not another queue and does not require rewriting handlers:

- **BullMQ bridge:** observes explicitly tracked jobs and reconciles known jobs;
  the application still owns Redis, enqueueing and worker code. A retry of a
  job the runtime reuses becomes a new attempt with its own outcome, so a batch
  view can say "attempt 1 failed with a 502, attempt 2 succeeded" instead of
  showing one row that changed its mind.
- **Fan-out signals:** `onItemsSettled` fires exactly once when every item of a
  batch reaches a terminal state — decided in one SQL statement, so it survives
  a crash and several bridges rather than being counted in application code.
- **TaskReconciler:** runs `listTasksByState({ states, idleForMs })` on a
  schedule and hands each stuck Task to the application. It is a timer in one
  process, not a distributed scheduler, and the callback must be idempotent.
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
| Notification destinations configurable from the CLI, with a delivery probe | implemented |
| Rule lifecycle: create, explain, enable, disable, delete, from Go or Node | implemented |
| Bounded, previewable retention for observation and delivery evidence | implemented |
| BullMQ lifecycle bridge and embedded PostgreSQL Task client | implemented and tested |
| Release archives, verifiable checksum bundle, SBOM and non-root image | beta.8 release pipeline verified in CI |
| Tenant-wide RBAC and isolation across every subsystem | not implemented |
| Durable multi-node notification scheduler | not implemented |
| Production-shaped design-partner evidence | not yet collected |

No throughput, latency or reliability promise is made without the matching
evidence. Reproducible measurements and their limits live in
[Benchmarks](./docs/benchmarks.md).

Reliability evidence lives in [`tests/fault`](./tests/fault/README.md): a lost
acknowledgement after the write committed, a lease expiring under a worker that
is still alive, a partition that heals, a sweep interrupted mid-batch, and a
provider confirmation lost after the charge went through. Its README also lists
what those tests do **not** cover, because a green suite that implies more than
it proves is the failure this project is about.

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

Questions and pilot requests can use the repository's [integration question](https://github.com/madebyduy/RhinoQ/issues/new?template=integration-question.yml)
or [design partner](https://github.com/madebyduy/RhinoQ/issues/new?template=design-partner.yml)
forms. Please report vulnerabilities through [SECURITY.md](./SECURITY.md), not
through a public issue.

## Documentation

- [Start here: complete beginner guide](./docs/start-here.md)
- [Five-minute setup](./docs/getting-started.md)
- [Node.js and BullMQ](./docs/nodejs.md)
- [ProviderOperation](./docs/provider-operations.md)
- [Safe repair](./docs/safe-repair.md)
- [Notifications](./docs/notifications.md)
- [Failure semantics: why unknown is not a pass](./docs/failure-semantics.md)
- [Benchmarks, with their limits](./docs/benchmarks.md)
- [Retention](./docs/retention.md)
- [Architecture](./ARCHITECTURE.md)
- [Release process](./docs/releasing.md)
- [Roadmap and honest blockers](./docs/roadmap.md)

RhinoQ is licensed under Apache-2.0. Contributions should follow
[CONTRIBUTING.md](./CONTRIBUTING.md), [SECURITY.md](./SECURITY.md) and
[AGENTS.md](./AGENTS.md).
