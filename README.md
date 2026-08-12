# RhinoQ

## Make async work visible, understandable and recoverable.

RhinoQ is a runtime-independent reliability layer for asynchronous work. It
turns runtime signals into durable Tasks, makes uncertain outcomes visible,
and gives users and operators evidence-guided recovery. You keep the system
that executes the work; RhinoQ supplies the Task, evidence and recovery layer
around it.

Choose the adapter that matches the system you already run: BullMQ currently
has the deepest Node coverage, while manual/custom adapters and an SQS proof
adapter exercise the same portable contracts. Start with the
[runtime-neutral integration guide](./docs/start-here.md), then choose a
[concrete BullMQ example](./examples/fanout-bullmq/) only if that is your
runtime.

Task Center and Workbench use the same plain-language Task explanation: what is
happening, how much finished, whether repeating the work needs review, and the
next recommended action. Generic failures never claim that retry is safe when
RhinoQ has no evidence about the external result.

The operator token is exchanged for an HttpOnly, SameSite cookie scoped to
`/admin`; it is not embedded in the page or URL. The following is the
runtime-neutral boundary; `tasks`, `runtimeAdapter` and `runtimeEvent` come
from the application or its chosen adapter.

```js
import { createRhinoQ } from '@rhinoq/node';

const app = createRhinoQ({
  client: tasks,
  adapters: [runtimeAdapter], // BullMQ, SQS, manual or another adapter
  terminalProjection: 'execution-only',
});
await app.observe(runtimeEvent);
```

That small portable boundary replaces the generic plumbing around your business handler:

| You keep | RhinoQ supplies |
|---|---|
| worker handler and payload | durable Task and per-item attempt state |
| runtime retry/backoff policy | retry history and aggregate progress |
| application authentication | owner-scoped API, SSE with polling fallback, and Task Center |
| business rules for external effects | cancellation, reconciliation and operator Workbench |

This is the lowest-cost integration path: adopt RhinoQ's versioned Task API as
your frontend contract. Existing applications can keep their own HTTP shape and
map `app.tasks` underneath it, at the cost of retaining that adapter code. The
trade-off and reproducible local line counts are documented in
[two doors](./docs/two-doors.md); they are benchmark evidence, not yet a claim
about savings in real adopter repositories.

Start with async task delivery. Later, add verification Rules when “the worker
returned successfully” is not enough to prove the real-world effect happened.
That second layer is optional on day one and uses the same operator workflow.

[![CI](https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml/badge.svg)](https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml)
[![Security](https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml/badge.svg)](https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml)
![Go 1.26](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)
![PostgreSQL 16](https://img.shields.io/badge/PostgreSQL-16_tested-4169E1?logo=postgresql&logoColor=white)
![Status](https://img.shields.io/badge/status-prerelease-f59e0b)

## Release status

RhinoQ is currently in public beta.

- Latest verified public prerelease: `v0.1.0-beta.11`.

Use RhinoQ for evaluation and controlled pilots. Production use is not yet
recommended. The beta.10 release was superseded after its partial npm publish;
beta.11 passed both npm publishes, registry smoke, binary/container publication
and GitHub Release creation.

> [!WARNING]
> RhinoQ is a prerelease for evaluation and controlled pilots. The full Go
> profile enforces tenant isolation in PostgreSQL, while the embedded Node Task
> profile now requires tenant context at its HTTP boundary and includes it in
> every owner-scoped SQL predicate. The code-reduction numbers are a
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
| evaluating the runtime-neutral Task layer | [the beginner guide](./docs/start-here.md) |
| adding this around async work you already run | [the two integration doors](./docs/two-doors.md) |
| using BullMQ specifically | [the BullMQ adapter example](./examples/fanout-bullmq/) |
| deciding whether it will save you code | [two doors](./docs/two-doors.md) |
| deciding whether to trust it | [what RhinoQ does, and what you still write](./docs/what-you-still-write.md) |
| running an external usability evaluation | [the no-coaching pilot protocol](./docs/usability-pilot.md) |
| completely new to all of it | [the beginner guide](./docs/start-here.md) |

### Four things a runtime-backed fan-out has to get right

These rules are runtime-independent unless marked otherwise. The
[BullMQ example](./examples/fanout-bullmq/README.md) makes the adapter-specific
parts explicit, and `rhinoq()` provides them for that compatibility path.

1. **`itemKey` is the idempotency key.** Omit it on a fan-out and fifty items
   become attempts 1..50 of a single item, the aggregate reads `total: 1`, and
   the batch terminates on the first finish — silently, and irreversibly.
2. **External identity belongs to the adapter.** For BullMQ this is `jobId`,
   while SQS uses a message ID and other runtimes have their own scoped
   identity. Never assume an external ID is globally unique.
3. **`isTerminalFailure` is required for a fan-out with retries.** Without it
   every failure is "the attempt may still retry", the settled check never runs
   after a failure, and a batch whose last item fails never settles at all.
4. **Do not drive `queued` or `running` by hand.** The portable projector owns
   those transitions; setting them from a route races the projector and loses.

For `terminal-items` aggregation, the bridge performs one final durable
progress synchronization after settlement succeeds and before invoking
`onItemsSettled`. The callback can therefore close the Task without leaving a
finished batch at a stale aggregate such as `49/50`.

### Which package

| Package | Install from | For |
|---|---|---|
| `@rhinoq/node` | npm | the Node SDK. This is the one you want. |
| `rhinoq` | npm | a distribution alias for the same code, so `npm install rhinoq` works |
| `@rhinoq/nest` | **not published** — `npm install ./sdks/nest` from a checkout | an optional NestJS module |
| `rhinoq` (Go CLI) | `go build ./cmd/rhinoq` | Rules, Findings, the Gateway, full migrations |

The Node SDK and the Go engine are two planes, not two versions of one thing.
The Node SDK owns portable runtime adapters, Tasks and the Workbench; the Go
engine owns Rules, Findings and ProviderOperation. Node talks to those Go-owned
capabilities through the Gateway when an application needs them.

The Node package also exports a development-preview, runtime-neutral adapter
contract, `RuntimeTaskProjector` and `createRhinoQ()` integration for Observe,
Track and capability-gated Control. Its validators reject incomplete runtime
identity, ambiguous failure terminality and unexplained unknown observations
before they reach projection. A [manual/custom runtime example](./examples/manual-runtime/)
drives Task lifecycle, progress, retry attempts, results and uncertainty without
BullMQ. The manual adapter is a contract proof; SQS is an observe/inspect proof;
neither is presented as a production deployment claim. Custom adapters with
`inspect` can reconcile a known runtime reference; runtime reports list exact
capability gaps, and unsupported cancellation is rejected before Task state
changes.

BullMQ now also has a development-preview `BullMQRuntimeAdapter` that translates
QueueEvents, dispatch receipts and bounded inspection into those portable
contracts. BullMQ currently has the deepest Node coverage; the supported
`rhinoq()` and `createBullMQIntegration()` entry points
retain their compatibility facade while the portable composition is adopted.

The migration target is available as `createBullMQPortableIntegration()`, which
composes Queue/QueueEvents through the portable adapter and projector while
keeping the existing facade export stable. The second-runtime proof is the
development-preview SQS adapter: it models redelivery attempts, unknown
readback and unsupported cancellation without importing the AWS SDK.

### Runtime adapters

All adapters implement the same identity and evidence contract:

| Adapter | Role | Current boundary |
|---|---|---|
| Manual/custom | contract and lifecycle proof | application supplies events and optional inspection |
| SQS | second-runtime proof | polling/inspect semantics; cancellation is unsupported |
| BullMQ | deepest Node coverage today | compatibility facade plus portable migration path |

The Task projector, Workbench, verification model and recovery guardrails do
not branch on the adapter name. Runtime-specific retry, dispatch, inspection
and cancellation semantics stay inside the adapter.

Observe-only Shadow Mode is available through `resolveUnboundEvent` for any
adapter.
Existing runtime events can be mapped to stable Task/Execution identity without
changing producer or worker code; RhinoQ binds the reference durably and replays
the first event after binding. `adoptionReport()` reports only measured events,
references, retries, uncertain/terminal outcomes and unresolved identities. It
does not estimate removable code or operational savings. Pass a
`PostgresAdoptionReportStore` and install its explicit SQL profile to aggregate
the facts durably across replicas; without that store the report is intentionally
process-local.

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
yours, and the integration example has a working one you can run.

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
runtime adapters, ProviderOperation integration, safe repair, troubleshooting,
and an honest comparison with established alternatives.

## Adding it to an application you already have

To put RhinoQ into an existing project, start from a database and worker you
already have — no queue replacement, no worker rewrite, no cutover:

```bash
npm install @rhinoq/node@next pg
npx rhinoq init
npx rhinoq adopt --mode single        # preview
npx rhinoq adopt --mode single --apply
npx rhinoq verify add completed-report-has-output
npx rhinoq doctor
npx rhinoq fixture async
npx rhinoq fixture failure
npx rhinoq dev
```

For a BullMQ fan-out, [`examples/fanout-bullmq/`](./examples/fanout-bullmq/) is
the concrete adapter example with every decision written out rather than made
for you, and `npm run smoke` in that directory is the test that proves a batch
finishes. Other runtimes use the same Task contract through their adapter.

Set `DATABASE_URL` before `init`. The CLI detects PostgreSQL and configured
runtime prerequisites (including BullMQ when present), previews what is
missing, refuses to overwrite generated Rules, and prints a next action for
every failure. Open the Workbench URL printed by `rhinoq dev` to see a
technically successful Execution whose real-world Task is `uncertain`. For the
generic async control-loop demo, use `npx rhinoq fixture async`: it creates a
completed step, a failed attempt and an expired approval waitpoint so the
Workbench's Async Flight Recorder has something real to explain. The Node-only
path mounts the same self-contained, read-only Task Workbench used by the SDK,
including live state buckets, per-attempt detail and Flight Recorder attention;
it binds to loopback and does not enable operator actions.

To rehearse the completed-but-wrong hero flow on a disposable database:

```bash
npx rhinoq lab run completed-but-missing-output --confirm-disposable
npx rhinoq dev
```

Failure Lab creates one additive Task through public commands: its Execution is
technically `succeeded`, no result evidence is attached, and the Task is
`uncertain`. It prints deterministic evidence, affected scope and the only safe
next action (`recheck-output`). The command refuses before connecting to
PostgreSQL unless disposable-database confirmation is explicit.

Workbench Task detail now includes a deterministic Incident Explainer answering
what happened, why, affected Task/item/owner scope and which next actions are
eligible. It derives `verified`, `violated` or `unknown` only from stored
verification/runtime/provider evidence. Portable runtime capability reports
gate cancellation in both the page and backend; `unsupported` is not rendered
as an actionable button and a direct request is refused before store mutation.

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

For existing prerelease NestJS/BullMQ adopters, the compatibility package
`@rhinoq/nest` remains available from a checkout. New applications should use
the `/nest` subpath of `@rhinoq/node`. Its async module
factory installs the embedded Task profile before injection, acquires a
PostgreSQL projector lease by default, starts a separately leased reconciliation
sweep when a runtime observer is provided, and exposes health/metrics wiring.
The application still supplies the BullMQ state reader; RhinoQ never scans or
mutates the application's Redis:

```bash
npm install @rhinoq/node@next pg
# From this checkout only — @rhinoq/nest has no npm release and `npm install
# @rhinoq/nest` will 404.
npm install ./sdks/nest

```

For an existing BullMQ application, `adopt` detects prerequisites and generates
one non-overwriting integration module. In NestJS it lists every statically
registered queue, requires explicit selection when several exist, writes
`src/rhinoq.module.ts` and patches `AppModule`:

```bash
npx rhinoq adopt --mode single \
  --queue mail-queue --queue notification-queue \
  --owner-property user.id --apply
```

Queues may declare different contracts instead of sharing one global mode:

```bash
npx rhinoq adopt \
  --task mail-queue=mail.send:single \
  --task export-queue=report.export:fanout \
  --owner-property user.id --apply
```

Preview lists every detected raw `queue.add()` location; apply prints the exact
file and line that still needs stable business identity and authenticated owner
identity. After startup, verify the live slice rather than generated source:

```bash
RHINOQ_ADOPT_VERIFY_HEADERS='{"authorization":"Bearer ..."}' \
  npx rhinoq adopt --verify-url https://app.example.com
```

This checks application health, PostgreSQL/projector state, QueueEvents
readiness and the mounted Task Center.

Generated multi-queue Nest modules use one integration token per queue and
aggregate every queue's health. A healthy final queue can no longer hide a
failed QueueEvents connection from another queue.

Frontend bundles can import `@rhinoq/node/browser` or `@rhinoq/node/react`
without entering the PostgreSQL/Nest lifecycle graph. Server integrations can
use `@rhinoq/node/server`; runtime-specific code can use
`@rhinoq/node/bullmq` or `@rhinoq/node/sqs`. ESM and CommonJS smoke tests cover
every subpath.

`--owner-property` points at the principal installed by upstream application
authentication. It mounts the owner API at `/tasks` and the self-contained Task
Center at `/task-center`. Without it, both remain deliberately unmounted rather
than trusting a client-controlled owner header. Override the paths with
`--routes-path` and `--task-center-path`.

If the application has no PostgreSQL service, add `--local-postgres` to generate
a loopback-only Compose service for evaluation. Production database ownership,
credentials and backups remain deployment responsibilities.

The BullMQ preset `createBullMQIntegration` reuses the application's
PostgreSQL pool, Queue and QueueEvents, enables bounded known-job
reconciliation, and requires the application to choose `single` or `fanout`
semantics explicitly. It never scans or mutates the application's Redis. This
is one adapter preset, not the Task platform boundary.

For NestJS, the same `@rhinoq/node` package exposes a `/nest` subpath. Its async
module factory installs the embedded Task
profile before injection, acquires a PostgreSQL projector lease by default,
starts a separately leased reconciliation sweep when a runtime observer is
provided, and exposes health/metrics wiring:

```bash
npm install @rhinoq/node@next pg
```

```ts
import { RhinoQModule } from '@rhinoq/node/nest';

RhinoQModule.forBullMQAsync({
  inject: [Pool, ReportsQueue, ReportsQueueEvents],
  useFactory: (pool, queue, events) => ({
    pool, queue, events,
    mode: 'fanout',
  }),
});
```

The owner-facing slice can now replace old status routes and hand-written SSE
UI as one unit. `createTaskRequestHandler()` covers list, detail, execution history,
cancel, command-identified retry, authorized result resolution and health.
`createUseRhinoTasks()` supplies the React inbox; the expanded
`createUseRhinoTask()` supplies retry, result download, history and safe action
state. `mountRhinoTaskCenter()` is a ready-to-use dependency-free reference UI.
The shared headless model handles progress, partial failure, `uncertain`, cancel
too late and work that cannot be cancelled safely.

Task Center renders an accessible loading skeleton, reports `Live` versus
`Polling fallback`, labels every Task `Finished` or `Not finished` (including
failed/cancelled outcomes), and announces terminal transitions through an
`aria-live` region. Actions expose an explicit busy state instead of appearing
unresponsive while cancel, retry or result resolution is in flight. Its list
links to an owner-facing `/task-center/{taskId}` detail with plain-language
guidance and an attempt timeline; runtime job identity remains operator-only.
The default integration connects Overview, Tasks and Workbench in one same-tab
product shell instead of presenting three isolated pages.
Both embedded surfaces share a responsive light/dark visual system and product
navigation, while preserving different information density: Task Center uses
plain-language cards for end users; Workbench uses compact evidence tables and
an operator-first attention hierarchy.

The embedded Node Workbench also shows a read-only **Runtime health** card when
the supplied BullMQ Queue supports `getJobCounts()`. It reports bounded queue
counts, pause state and connected-worker evidence; a waiting queue with no
workers is degraded, while unavailable worker visibility is explicitly
unknown. It never exposes Redis errors, credentials or job payloads. Optional
operator links can connect a Task attempt to an existing runtime inspector:

```ts
server.use(app.http({
  operatorToken,
  runtimeDashboardURL: '/admin/queues/reports',
  runtimeJobLink: ({ externalId }) => `/admin/queues/reports/${encodeURIComponent(externalId)}`,
}));
```

Links are operator-only and restricted to application-relative or HTTP(S)
destinations. RhinoQ does not add pause, retry, empty or delete controls; queue
mutation remains with the application and its existing runtime tooling.

The self-contained Task Center includes responsive search, evidence-based views
for attention/active/finished work, and updated-time or task-name sorting. These
controls are reflected in the query string, so a filtered view can be bookmarked
or shared without adding server-side saved-view state. Task detail reports result
availability, cancellation posture and whether a verification issue is actually
recorded; it does not equate runtime completion with business verification.
Long attempt histories remain bounded and can be continued in-place with the
cursor-backed “Load more attempts” control.

Task detail also reads a bounded, owner-scoped durable waitpoint list. Pending
approvals can be approved or declined in-place using the waitpoint version and
a deterministic resolution identity; duplicate submissions therefore converge
on the stored resolution. Input waitpoints direct the user back to the host
application form, while webhook waitpoints remain read-only instead of offering
an action RhinoQ cannot complete safely.
The bounded `GET /tasks/_waitpoints` owner inbox powers a real “Waiting for me”
bucket on the generated Overview. It includes input and approval requests while
excluding webhook waits that the user cannot act on.

The owner API exposes `GET /tasks/_capabilities`. Task Center renders retry and
result actions only when the application configured their handlers. Result
download now fails closed with `RHINOQ_RESULT_NOT_CONFIGURED` when no authorized
resolver exists; RhinoQ never falls back to returning a durable storage
reference directly to the browser.

Applications may supply `tenantFromRequest` beside `ownerFromRequest`. The
tenant is then carried through list/detail/history/waitpoint/result/SSE reads;
missing tenant context is refused. Single-tenant applications use the explicit
`default` tenant. Operator Workbench reads remain deliberately cross-tenant and
must stay behind `requireOperator`.

An explicit `riskPolicy: { atRiskAfterMs, stuckAfterMs }` enables the bounded
`GET /tasks/_risk` view. Risk means no Task update crossed a declared threshold;
it is never inferred from total runtime. The generated Overview puts these
Tasks in Needs attention with a concrete next action.

Business verification is append-only Task evidence. `GET /tasks/_verified`
powers Recently verified, while each verification may carry the exact Finding
key and operator deep link. `recordTaskVerificationChain()` connects a mismatch
to the Go-owned Finding writer and writes a durable Task notification outbox
record. A custom `queueNotification` callback is still supported when an
application already has a delivery system; recipients and transport remain
application-owned, while the handoff itself is retryable and lease-fenced.

Artifact v1 stores browser-safe metadata, SHA-256 checksum, expiry, refresh
version and lineage. Owner/tenant-authorized refresh is available at
`POST /tasks/{taskId}/artifacts/{artifactId}/refresh`. Private storage
references are available only to the application's `resolveArtifact` callback
and never appear in list/detail JSON.

The Go worker starts a queue watchdog by default. It reports transition-only
At risk, Stuck, backlog-growth and reaper-health alerts using explicit
thresholds; concurrent enqueue admission is serialized at the queue-control
row. `go run ./cmd/rhinoq-worker` is a recovery/health sidecar and does not
pretend to know application handlers. A business worker still registers its
handlers and calls `Client.Run`.

The same owner-authenticated surface now exposes `GET /tasks/{id}/events` and
`GET /tasks/_events` as SSE. `ApplicationTaskClient` uses Fetch streaming, so
applications may keep their normal cookie or authorization headers. TaskStore,
TaskListStore and Task Center prefer the stream, reject stale entity versions,
fall back to authoritative snapshot polling on loss and retry the stream.

```ts
const client = new ApplicationTaskClient({
  url: '/api/tasks',
  headers: () => ({ authorization: `Bearer ${sessionToken}` }),
});
const useTask = createUseRhinoTaskLive(React);
const task = useTask(client, taskId); // task.transport: live | polling_fallback
```

SSE is delivery, not truth: every event is an owner-scoped Task snapshot from
PostgreSQL and carries `entityVersion`. `Last-Event-ID` resumes a single Task;
an inbox reconnect sends its current page again and the client converges by
version. Streams have heartbeat, abort cleanup and a bounded connection budget.
The default implementation performs bounded server-side snapshot reads; large
deployments should measure this load before lowering intervals or adding a
shared fan-out transport.

### Durable input, approval and webhook waits

RhinoQ Task schema now includes durable waitpoints for work that cannot finish
until a user or provider responds. The authoritative states are `waiting`,
`resolved`, `expired` and `cancelled`; every settlement is version-fenced.
Repeating the same `resolutionId` and JSON answer returns the committed result,
while changing the answer fails closed.

The application routes expose create/read/resolve under
`/tasks/{taskId}/waitpoints`, and `ApplicationTaskClient` plus
`createUseRhinoTaskInput()` remove the corresponding frontend request and UI
state boilerplate. `createWaitpointTokenSigner()` creates short-lived,
application-owned HMAC capabilities scoped to one waitpoint, task, owner and
action. RhinoQ never stores the signing secret. Resolution bodies are bounded
to 64 KiB; large files belong in result/artifact storage.

`waitForInput()`, `waitForApproval()` and `waitForWebhook()` are durable
re-entry checkpoints, not promises that keep a worker alive. A first entry
returns `waiting`; after settlement the same stable id/key returns the typed
answer. The full Go/PostgreSQL profile writes one
`task.waitpoint.resolved` outbox event in the settlement transaction so a
publisher can resume work at-least-once with the waitpoint identity.

For fan-out work, `dispatchBatch()` adds a pre-dispatch size bound while
retaining reserve-before-enqueue identity. `TaskGroupController` derives the
latest attempt per item, composes bounded stable child commands for failed
retry and pending-only cancellation, and never selects active work for blind
cancellation. The owner routes also provide a failed-item CSV/JSON download
and a per-item result manifest.

```ts
import { bullMQCancellation, createTaskRequestHandler, signedResult } from '@rhinoq/node';

const handler = createTaskRequestHandler({
  tasks: rhinoq.tasks,
  ownerFromRequest: requireApplicationUser,
  retryTask: retryThroughYourDurableCommandOutbox,
  resolveResult: signedResult({
    resolve: (reference, ownerId) => storage.signedUrl(reference, ownerId),
  }),
  health: () => rhinoq.health(),
});

const cancellation = bullMQCancellation({ queue, cooperativeSignal });
const reports = rhinoq.defineTask({
  type: 'report.generate', jobName: 'generate-report', mode: 'single',
});
await reports.dispatch({ id: reportId, ownerId: userId, data });
```

Retry carries the aggregate version and a command id. Its callback must persist
the command identity, Task transition and enqueue/outbox intent durably; a bare
`queue.add()` callback is not crash recovery. Authentication, storage policy,
toast renderer and visual design remain application-owned. A before/after
adopter pilot is still required before making a code-reduction claim.

The authoritative Go `tasks.Service.Retry` and PostgreSQL `TaskRetryStore` now
provide that atomic boundary. Migration 029 records the command, creates a new
immutable Execution and appends `task.retry.dispatch_requested` in the same
transaction. Delivery is at-least-once: the runtime publisher must enqueue
with the stable command/execution identity and fail closed for an unknown
external outcome.

The dispatch intent includes the queue, job name and JSON data and stores a
fingerprint beside the command identity, so reusing a command id with changed
work is rejected. To run the recovery publisher in `rhinoq-agent`, configure:

```bash
export RHINOQ_RETRY_DISPATCH_URL=https://app.example.com/internal/rhinoq/retry-dispatch
export RHINOQ_RETRY_DISPATCH_SECRET='a-separate-random-secret'
```

The application endpoint uses `createBullMQRetryDispatchHandler({ secret,
queues })`. It verifies the exact HMAC-signed body, refuses unregistered queues
and uses `executionId` as BullMQ `jobId`. Mount this endpoint where the raw
request body is available; JSON parsing and re-serialization invalidates the
signature. Retry dispatch explicitly sets `removeOnComplete: false` and
`removeOnFail: false`, preserving BullMQ's duplicate observation through a lost
acknowledgement. Apply an operator retention cleanup only after the matching
outbox event has settled; do not override those flags at enqueue time.

In another shell, apply and run the Rule you edited. `beta.9` is the first
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
uses BullMQ as a concrete runtime adapter to reproduce the failure RhinoQ is
built for:

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

For operations completed asynchronously or left `uncertain`, run the bounded
read-back reconciler. It receives verifier callbacks only; the original
mutation callback is deliberately unavailable during a sweep:

```ts
const reconciliation = new ProviderOperationReconciler({
  client: rhinoq,
  verifiers: {
    'stripe.refund': (operation) => lookupRefundWithoutRepeatingTheMutation(operation),
  },
  minimumAgeMs: 30_000,
});
reconciliation.start();
```

Before describing an effect as effectively exactly-once, applications can
produce a machine-readable capability report:

```ts
effectCapabilityReport({
  stableIdentity: true,
  providerSupportsIdempotency: true,
  confirmation: 'readback',
  verifierRegistered: true,
  retryPolicy: 'when-not-happened',
}); // level: 'effectively-exactly-once', blockers: []
```

This label applies to that declared effect, not to arbitrary code in the Task.
Missing identity, provider idempotency, independent verification or retry proof
downgrades the report instead of producing a misleading exactly-once claim.

## Stop duplicate application writes across runtime retries

For a fan-out item, a retry can be a second handler run even when the business
write from the first run already committed. The embedded Task profile provides
an item-scoped transaction gate without replacing the execution runtime:

```ts
const result = await tasks.onceForItem(executionId, 'deduct-credits', async (tx) => {
  await tx.query(
    'INSERT INTO credit_logs (item_id) VALUES ($1)',
    [itemId],
  );
  return 'written';
});
// A later runtime retry receives { executed: false } for this item/effect key.
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

The Node SDK also exposes `GuardedRecovery` for application/operator clients.
It derives a deterministic repair identity from an idempotency key, refuses to
execute without a preview and separate approval, and requires a post-check;
`PostgresRecoveryLedger` supplies the cross-process idempotency fence.

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

Operational details for Task notification handoff, tenant authorization and
queue protection live in [Task profile operations](./docs/task-profile-operations.md).

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

- **Runtime adapters:** translate runtime-specific lifecycle facts into the
  portable Task contract; the application still owns its queue, broker,
  enqueueing and worker code. The BullMQ bridge is the first production-shaped
  adapter, while manual/custom and SQS proof adapters use the same projector.
  A retry of work that the runtime reuses becomes a new attempt with its own
  outcome, so a batch view can say "attempt 1 failed with a 502, attempt 2
  succeeded" instead of showing one row that changed its mind. One projector
  owns each `runtimeScope`; use the Node SDK's PostgreSQL advisory lease when
  that scope spans processes. Failed projections can also be recorded through
  the application-owned PostgreSQL failure sink before process-local error
  handling runs.
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
| Explicit At risk/Stuck policy and owner-scoped view | implemented in Node Task profile |
| Task verification records and Recently verified | implemented in Node Task profile |
| Artifact v1 metadata/checksum/expiry/refresh/lineage | implemented in Node Task profile |
| Task-to-provider Flight Recorder correlation | implemented; compare-attempt diffs, supplied waterfall spans and bounded diagnostic export are available |
| Node Task tenant HTTP/SQL boundary | implemented with owner/tenant scope plus optional deny-by-default authorization hook; full-profile Gateway RBAC remains separate |
| Durable Task verification notification handoff | implemented in Task schema v10 with claim/complete/fail leases; recipient/transport stays application-owned |
| Queue admission and watchdog | admission race fenced; at-risk/stuck/backlog/no-worker/reaper signals are available through WorkerConfig |
| Signed webhook and Slack notifications with durable dedup | implemented |
| Failure inbox with claim/replay/retry/ignore states | implemented in Node source checkout; application-owned table |
| Notification destinations configurable from the CLI, with a delivery probe | implemented |
| Durable multi-node notification scheduler | implemented in Go; SQL, real PostgreSQL lease takeover and memory failover tested |
| Rule lifecycle: create, explain, enable, disable, delete, from Go or Node | implemented |
| Bounded, previewable retention for observation and delivery evidence | implemented |
| Runtime-neutral adapter contracts and portable Task projector | implemented; manual/custom, SQS proof and BullMQ compositions tested |
| Durable multi-replica adoption report | implemented as an opt-in PostgreSQL profile; measured facts only |
| Guarded recovery preview/idempotency/post-check | implemented; Go repair service remains mutation authority |
| BullMQ lifecycle bridge and embedded PostgreSQL Task client | implemented and tested |
| Standard NestJS/BullMQ integration with default projector/reconciler leases | implemented in prerelease; adopter remeasurement pending |
| Release archives, npm provenance, registry smoke, checksum bundle, SBOM and non-root image | beta.11 verified public prerelease published |
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
- [Node.js adapters and BullMQ integration](./docs/nodejs.md)
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
