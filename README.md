# RhinoQ

<p align="center">
  <img src="./docs/assets/rhinoq-hero.png" alt="RhinoQ — user-facing task infrastructure for existing workers" width="100%" />
</p>

<p align="center">
  <strong>Your queue stays. Your workers stay. RhinoQ adds the user-facing task layer.</strong>
</p>

<p align="center">
  Durable task lifecycle · existing-runtime adapters · optional business verification
</p>

<p align="center">
  <a href="https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml"><img src="https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml"><img src="https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml/badge.svg" alt="Security" /></a>
  <img src="https://img.shields.io/badge/Go-1.25%2B-00ADD8?logo=go&logoColor=white" alt="Go 1.25+" />
  <img src="https://img.shields.io/badge/PostgreSQL-16_tested-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL 16 tested" />
  <img src="https://img.shields.io/badge/status-active_development-f59e0b" alt="Active development" />
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0" /></a>
</p>

> [!WARNING]
> RhinoQ is in active development. Public APIs, migrations and protocols are not
> stable, no release has been tagged, and it is not production-ready. Use it for
> evaluation and controlled environments only. See [the roadmap](./docs/roadmap.md)
> and [security audit](./docs/security-audit-2026-07-29.md) for release blockers.

## The product in one sentence

RhinoQ is user-facing task infrastructure for products that already run
background work. It gives a task an owner, lifecycle, progress, cancellation,
retry, result and history contract without making the frontend depend on queue
internals.

The intended adoption path is to keep the application's business logic and,
when an adapter exists, keep its current queue and worker. RhinoQ is **not** a
claim to replace BullMQ, Temporal, Inngest, Hatchet or a team's workflow model.
Read the concise [product positioning](./docs/product-positioning.md) before
evaluating the longer [product-direction research](./RHINOQ_PRODUCT_DIRECTION_v3.md).

## Why a task layer exists

A queue can tell an operator that a job is waiting, active, completed or
failed. A product still has to build the user-facing contract around it:

```text
create work → own it → show progress → survive reload/retry → cancel/retry
            → fetch a result → show history → protect access
```

For one feature, teams often write this glue by hand. With several long-running
features—imports, exports, generation, provisioning or media processing—the
same status endpoints, polling reducers, ownership checks and result handling
are rebuilt repeatedly. RhinoQ's Task is the reusable boundary for that work.

```text
Task (user-facing identity, lifecycle, progress, result, history)
  └── Execution (one attempt)
        └── Native Job or external runtime reference

Verified Tasks (optional): Effect Ledger, outcome observation, Rules, Findings
```

`Task`, `Execution`, runtime state, external-effect state and business-outcome
state are deliberately separate. A worker returning successfully is not proof
that an external provider completed work or that a business invariant holds.

## Why inspect RhinoQ instead of another dashboard

- **A browser-safe Task revision:** every Task and child Execution mutation
  advances one aggregate version, so a stale browser/worker update fails closed
  rather than silently replacing newer state.
- **Three explicit truths:** request acceptance, external-effect confirmation
  and business outcome are separate states. The Evidence Rail makes that
  distinction inspectable instead of showing one misleading green “done”.
- **Existing BullMQ stays owned by the application:** the narrow bridge observes
  explicitly tracked jobs without importing BullMQ into RhinoQ, taking over
  Redis, or copying worker correctness into the SDK.
- **Verification is optional:** ordinary Task progress does not require Rules;
  high-risk work can add independent evidence and Findings when technical
  completion is insufficient.

These are implementation facts, not throughput, code-reduction or production
claims. Their current limits are documented below and in
[Product strengths](./docs/product-strengths.md).

## What exists today

| Capability | Status |
|---|---|
| Go Task facade; Task and Execution domains | implemented and tested |
| PostgreSQL Task store and migration 015 | implemented; real-PostgreSQL contract tested |
| Versioned HTTP polling snapshots | implemented and integration tested |
| Typed Node Task client | implemented from source; package not published to npm |
| Result-reference read/write API | implemented; payload proxy/download is not |
| Native Go/PostgreSQL job runtime | implemented and tested |
| Effect Ledger, Rules, Findings and read-only investigation | implemented as optional Verified Tasks foundation |
| BullMQ lifecycle bridge V1 | implemented and Node SDK-tested; observes tracked existing jobs only |
| pg-boss/custom runtime adapter | **not implemented** |
| React hook, Task Center, SSE/WebSocket/streams | **not implemented** |
| Tenant-scoped user authorization | **not implemented** |
| Generic ProviderOperation | **not implemented** |

The BullMQ bridge creates/binds a durable external Execution for an existing
BullMQ job and projects its `waiting`, `active`, `progress`, `completed` and
confirmed-terminal `failed` events into the Task lifecycle. It deliberately
does **not** enqueue jobs, own Redis connections, change a worker handler,
cancel a job, create a new Execution for a BullMQ retry, or discover every job
after an outage. The application calls `track()` when it adds the job; the
durable runtime/external-ID lookup makes repeating that call safe after a
bridge restart. This is a narrow lifecycle bridge, not drop-in BullMQ support.

## First Task contract

The first public slice is polling-first and explicit about concurrency. Every
write uses the latest `EntityVersion`, so a stale browser or worker response is
rejected rather than overwriting a newer snapshot.

```go
client := rhinoq.NewInMemory() // use NewPostgres(db) after migrations for durable state

task, err := client.CreateTask(ctx, rhinoq.TaskCreateRequest{
    ID: "report_01", Type: "report.export", DefinitionVersion: 1,
})
if err != nil { /* handle */ }

task, err = client.QueueTask(ctx, task.ID, task.EntityVersion)
if err != nil { /* re-read on ErrTaskVersionConflict */ }

task, err = client.StartTask(ctx, task.ID, task.EntityVersion)
if err != nil { /* handle */ }

total := int64(10)
task, err = client.ReportTaskProgress(ctx, task.ID, task.EntityVersion,
    rhinoq.TaskProgress{Completed: 4, Total: &total, Message: "Rendering"})
if err != nil { /* handle */ }

result, err := client.AttachTaskResult(ctx, task.ID, task.EntityVersion,
    "s3://reports/report_01.pdf")
_ = result
```

`TaskSnapshot` contains lifecycle, progress, result availability and execution
summaries. `GetTaskResult` reads the result reference separately, so normal
polling does not expose or repeat a storage location. The Gateway exposes the
same contract at `POST /v1/tasks` and `GET /v1/tasks/{id}`; stale writes return
typed `409` conflicts.

For a complete, accurate setup and the current external-runtime boundary, see
[Getting started](./docs/getting-started.md) and the [Task Platform contract](./docs/task-platform.md).

## Choose RhinoQ deliberately

Use RhinoQ when your product has multiple user-visible background operations
and you want one durable task contract across backend and frontend—especially
when queue status is not a safe or usable UI contract.

Use another tool, or no additional tool, when the problem is different:

| Need | Better first choice |
|---|---|
| One simple fire-and-forget job | the queue you already use |
| A mature hosted task/runtime platform today | Trigger.dev or Inngest |
| Durable multi-step workflow orchestration | Temporal, Restate or DBOS |
| Raw message throughput or event streaming | Kafka or a specialized queue/stream |
| Queue-operator visibility only | Bull Board or the queue's operations tooling |

RhinoQ's optional Verified Tasks layer is for cases where technical completion
is insufficient: an irreversible effect, an asynchronous provider result or a
business invariant needs independent evidence. It is not required for a normal
progress bar. See [Verified Tasks](./docs/rules.md), [recovery boundaries](./docs/recovery.md)
and the [integrity-only example](./examples/integrity-only/).

## Runtime and security boundaries

Go is the authoritative engine/runtime. The Node.js/TypeScript SDK is a tested
development preview for producers, worker lifecycle and the typed Gateway API;
it has no tagged npm release. PostgreSQL is the durable store for Task state,
execution history and verification evidence. Redis is not required by the
current Task slice.

The optional HTTP Gateway binds to loopback by default and requires a bearer
token of at least 32 bytes. It is not a multi-tenant product API: remote TLS,
credential rotation, rate limits, tenant isolation and role-based
authorization remain release blockers.

## Evidence, not marketing

RhinoQ has not yet shown that it reduces integration code or wins adoption.
Those are product hypotheses, with explicit failure conditions, in
[Product evidence](./docs/product-evidence.md). The next proof points are a
real two-task application, a BullMQ reference adapter with no handler rewrite,
and browser/reconnect tests before realtime transport is added.

## Documentation

| Read this | Purpose |
|---|---|
| [Product positioning](./docs/product-positioning.md) | intended user, boundary and allowed claims |
| [Getting started](./docs/getting-started.md) | current Task-first evaluation path |
| [Task Platform](./docs/task-platform.md) | implemented contract and explicit gaps |
| [Product evidence](./docs/product-evidence.md) | validation hypotheses and kill signals |
| [Product strengths](./docs/product-strengths.md) | evidence-backed implementation strengths |
| [Native runtime](./docs/getting-started.md#native-runtime-is-a-separate-optional-path) | PostgreSQL queue/worker path |
| [Workbench](./docs/workbench.md) | local, read-only Evidence Ledger for operational investigation |
| [Node.js integration](./docs/nodejs.md) | source-only Node preview |
| [Releasing](./docs/releasing.md) | npm trusted publishing and first prerelease checklist |
| [Architecture](./ARCHITECTURE.md) | module, dependency and runtime boundaries |
| [Roadmap](./docs/roadmap.md) | next implementation and release gates |

## Contributing

Please read [CONTRIBUTING.md](./CONTRIBUTING.md), [SECURITY.md](./SECURITY.md)
and [AGENTS.md](./AGENTS.md). RhinoQ is Apache-2.0 licensed.
