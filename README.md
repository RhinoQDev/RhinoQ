# RhinoQ

## A BullMQ fan-out with progress, cancellation, per-attempt history and an operator console — in one command.

```bash
npx create-rhinoq-app my-batch && cd my-batch && npm start
```

That brings up PostgreSQL and Redis, applies the schema, runs a 50-item batch
and opens <http://localhost:3000>. Nothing needs to exist first except Docker
and Node 22.

Inside is a live progress bar, a Cancel button that actually stops the queued
jobs, retries recorded as separate attempts, an operator console at `/admin` —
and a button that deletes the output file of a job the queue reported as
`completed`, so you can watch the gap this whole project is about.

```js
const app = await rhinoq({ pool, queue, events, ownerFromRequest });

server.use('/tasks', app.routes());                          // read + cancel
server.use(app.workbench({ token, basePath: '/admin' }));    // operator console

await app.dispatch(taskId, urls.map((url, index) => ({ key: `item-${index}`, data: { url } })));
```

Measured on the code in this repository, the whole loop — API, worker, bridge,
reconciler, both HTTP surfaces and an exactly-once "the batch is done" signal —
is [164 non-comment lines](./examples/fanout-bullmq/server.mjs). Which door you
come through changes that number a lot, and in both directions:
[two doors](./docs/two-doors.md).

**Then, later:** when the queue says `completed` and the object is not in the
bucket, RhinoQ already knows the difference. That is the second half of the
product and you do not have to do anything on day one to have it.

[![CI](https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml/badge.svg)](https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml)
[![Security](https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml/badge.svg)](https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml)
![Go 1.26](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)
![PostgreSQL 16](https://img.shields.io/badge/PostgreSQL-16_tested-4169E1?logo=postgresql&logoColor=white)
![Status](https://img.shields.io/badge/status-prerelease-f59e0b)

> [!WARNING]
> RhinoQ is a prerelease for evaluation and controlled pilots. The tenant
> boundary is enforced in PostgreSQL ([`docs/tenancy.md`](docs/tenancy.md)), but
> the HTTP surface is not yet wired to it; the code-reduction numbers are a
> reproducible local benchmark rather than a design-partner count; and chaos
> evidence is local drills rather than a deployment-shaped campaign. Those still
> block a production-ready claim.

> [!IMPORTANT]
> Upgrading past migration 026 changes what a working connection needs, and
> running as a PostgreSQL superuser silently disables tenant isolation. Read
> [`docs/migration-rollback.md`](docs/migration-rollback.md) before applying,
> and verify with `rhinoq doctor`.

## Start here

| If you are… | Read |
|---|---|
| starting a new project | `npx create-rhinoq-app`, above |
| adding this to a BullMQ fan-out you already have | [`examples/fanout-bullmq/`](./examples/fanout-bullmq/) — the long form, every decision visible |
| deciding whether it will save you code | [two doors](./docs/two-doors.md) |
| deciding whether to trust it | [what RhinoQ does, and what you still write](./docs/what-you-still-write.md) |
| completely new to all of it | [the beginner guide](./docs/start-here.md) |

### Four things a fan-out has to get right

These cost an afternoon each when you find them yourself. The example
[gets them right on purpose](./examples/fanout-bullmq/README.md), and
`rhinoq()` makes all four for you.

1. **`itemKey` is the idempotency key.** Omit it on a fan-out and fifty items
   become attempts 1..50 of a single item, the aggregate reads `total: 1`, and
   the batch terminates on the first finish — silently, and irreversibly.
2. **`jobId` may not contain `:`.** BullMQ rejects a custom job ID containing
   one unless it splits into exactly three parts, so the natural
   `` `${taskId}:${itemKey}` `` is refused.
3. **`isTerminalFailure` is required for a fan-out with retries.** Without it
   every failure is "the attempt may still retry", the settled check never runs
   after a failure, and a batch whose last item fails never settles at all.
4. **Do not drive `queued` or `running` by hand.** The bridge owns them; setting
   them from a route races the projector and loses.

### Which package

| Package | Install from | For |
|---|---|---|
| `@rhinoq/node` | npm | the Node SDK. This is the one you want. |
| `rhinoq` | npm | a distribution alias for the same code, so `npm install rhinoq` works |
| `create-rhinoq-app` | npm, via `npx` | the scaffolder above |
| `@rhinoq/nest` | **not published** — `npm install ./sdks/nest` from a checkout | an optional NestJS module |
| `rhinoq` (Go CLI) | `go build ./cmd/rhinoq` | Rules, Findings, the Gateway, full migrations |

The Node SDK and the Go engine are two planes, not two versions of one thing.
Fan-out, Tasks and the Workbench are Node-only and need no Go binary. Rules,
Findings and ProviderOperation are the Go engine's, and Node talks to them
through the Gateway.

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

### A Rule can only see PostgreSQL. Something has to go and look.

That gate is also a limit, and it is better said out loud than discovered. A
Rule is SQL in a `READ ONLY` transaction under a role that is required not to
have network or filesystem functions ([`docs/rules.md`](./docs/rules.md)), so no
Rule will ever HEAD an object in a bucket or read a provider back.

The going-and-looking ships with the SDK, and runs in your process with your
credentials:

```ts
import { objectExists, recordVerification } from '@rhinoq/node';

const check = objectExists({ head: ({ bucket, key }) => s3Head(bucket, key) });
await recordVerification(pool, 'output-exists', await check({ bucket, key }));
```

`objectExists`, `httpReadBack` and `rowMatches` each return `present`, `missing`
or `unknown`-with-a-reason, and `recordVerification` writes that into a table a
Rule can read. RhinoQ stores and classifies findings; the trip to the bucket is
yours, and the scaffold has a working one you can run.

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

## Adding it to an application you already have

`create-rhinoq-app` writes a new project. To put RhinoQ into an existing one,
the Rules half of the product starts from a database you already have — no
queue, no worker, no cutover:

```bash
npm install rhinoq pg
npx rhinoq init
npx rhinoq verify add completed-report-has-output
npx rhinoq doctor
npx rhinoq fixture failure
npx rhinoq dev
```

For the fan-out half, [`examples/fanout-bullmq/`](./examples/fanout-bullmq/) is
the same feature set as the scaffold with every decision written out rather than
made for you, and `npm run smoke` in that directory is the test that proves a
batch finishes.

Set `DATABASE_URL` before `init`. The CLI detects PostgreSQL and BullMQ, previews
what is missing, refuses to overwrite generated Rules, and prints a next action
for every failure. Open the Workbench URL printed by `rhinoq dev` to see a
technically successful Execution whose real-world Task is `uncertain`. The
Node-only path mounts the same self-contained, read-only Task Workbench used by
the SDK, including live state buckets and per-attempt detail; it binds to
loopback and does not enable operator actions.

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

For a NestJS/BullMQ application there is an optional `@rhinoq/nest` module. It
is **not published to npm**: install it from a checkout. Its async module
factory installs the embedded Task profile before injection, acquires a
PostgreSQL projector lease by default, starts a separately leased reconciliation
sweep when a runtime observer is provided, and exposes health/metrics wiring.
The application still supplies the BullMQ state reader; RhinoQ never scans or
mutates the application's Redis:

```bash
npm install @rhinoq/node pg
# From this checkout only — @rhinoq/nest has no npm release and `npm install
# @rhinoq/nest` will 404.
npm install ./sdks/nest
```

```ts
RhinoQModule.forRootAsync({
  inject: [Pool, BullMQEvents],
  useFactory: (pool, events) => ({
    pool, events, runtimeScope: 'reports',
    terminalProjection: 'execution-only',
    reconciliation: { observe: readBullMQState },
  }),
});
```

This reduces lifecycle glue; it does not claim that an adopter's old status
routes or SSE code have been deleted. That requires a before/after pilot count.

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
for HTTP mutations, Stripe and provisioning/storage providers. The HTTP adapter
injects the ledger idempotency key and requires application-owned read-back
confirmation; non-2xx responses remain fail-closed.

See [ProviderOperation](./docs/provider-operations.md).

For the common case, Effect Ledger Lite derives a stable key from command
identity and fingerprints the JSON request before calling the same Go ledger:

```ts
await rhinoq.effect({
  taskId, provider: 'storage', operation: 'upload', commandId: downloadId,
  request: { key: objectKey, size: expectedSize },
  execute: (key) => uploadToStorage(objectKey, { idempotencyKey: key }),
  confirm: (operation) => checkObjectExists(operation),
});
```

Reusing one key with a different request fingerprint is rejected. This keeps
the convenient API from weakening the existing unknown-result contract.

## Stop duplicate application writes across BullMQ retries

For a fan-out item, a retry can be a second handler run even when the business
write from the first run already committed. The embedded Task profile provides
an item-scoped transaction gate without replacing BullMQ:

```ts
const result = await tasks.onceForItem(executionId, 'deduct-credits', async (tx) => {
  await tx.query(
    'INSERT INTO credit_logs (item_id) VALUES ($1)',
    [itemId],
  );
  return 'written';
});
// A later BullMQ retry receives { executed: false } for this item/effect key.
```

The claim and the application write commit together in PostgreSQL, and the
claim spans RhinoQ attempt history per `itemKey`. If the callback rolls back,
the next retry may try again. This protects transactional application writes;
it is not an exactly-once promise for an external HTTP/provider call, which
still needs ProviderOperation, idempotency and confirmation.

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
durable delivery ledger deduplicates destination/event pairs. Go applications
can queue a delivery and run the built-in PostgreSQL lease scheduler; failed
attempts use bounded exponential backoff and end in an explicit `dead` state.
The destination resolver remains application-owned so secrets do not enter the
ledger.

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
  showing one row that changed its mind. Failed events close the current
  attempt even when BullMQ will retry; a terminal-failure classifier decides
  whether the parent Task also fails. One projector owns each `runtimeScope`;
  use the Node SDK's PostgreSQL advisory lease when that scope spans processes.
  Failed projections can also be recorded through the application-owned
  PostgreSQL failure sink before process-local error handling runs.
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
| Effect Ledger Lite with request fingerprinting | implemented; Node and Go contract tested |
| Transactional per-item application effect gate | implemented in the embedded Task profile; callback must use its supplied PostgreSQL transaction |
| `uncertain` Task state linked to provider uncertainty | implemented |
| HTTP, Stripe and provisioning/storage reference adapters | implemented in Node SDK; HTTP transport and fail-closed tests included |
| Rules, Findings and Evidence Workbench | implemented |
| Recheck and guarded repair workflow | implemented; callback registration is application-owned |
| Summary polling and cursor-paginated Executions | implemented |
| Signed webhook and Slack notifications with durable dedup | implemented |
| Failure inbox with claim/replay/retry/ignore states | implemented in Node source checkout; application-owned table |
| Notification destinations configurable from the CLI, with a delivery probe | implemented |
| Durable multi-node notification scheduler | implemented in Go; SQL, real PostgreSQL lease takeover and memory failover tested |
| Rule lifecycle: create, explain, enable, disable, delete, from Go or Node | implemented |
| Bounded, previewable retention for observation and delivery evidence | implemented |
| BullMQ lifecycle bridge and embedded PostgreSQL Task client | implemented and tested |
| Standard NestJS/BullMQ integration with default projector/reconciler leases | implemented in prerelease; adopter remeasurement pending |
| Release archives, verifiable checksum bundle, SBOM and non-root image | beta.8 release pipeline verified in CI |
| Tenant-wide RBAC and isolation across every subsystem | not implemented |
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
- [NestJS integration package](./sdks/nest/README.md)
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
