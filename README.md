# RhinoQ

Documentation: **English** · [Tiếng Việt](./docs/vi/README.md)

## Open-source background jobs and async Tasks for Node.js, NestJS and Go

RhinoQ is an open-source async Task and background-job platform for Node.js,
NestJS and Go. Run jobs with RhinoQ's native PostgreSQL queue or keep an
existing BullMQ runtime. RhinoQ adds durable Task state, progress tracking,
retry history, cancellation, reconciliation, an owner-scoped Task API,
realtime SSE with polling fallback, embeddable React components, a user Task
Center and an operator Workbench around your business handler.

Task Center and Workbench keep the same lightweight, self-contained product
surface while using clearly separated panels, restrained semantic color and a
neutral operator-focused visual hierarchy.

[![CI](https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml/badge.svg)](https://github.com/madebyduy/RhinoQ/actions/workflows/ci.yml)
[![Security](https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml/badge.svg)](https://github.com/madebyduy/RhinoQ/actions/workflows/security.yml)
[![npm @rhinoq/node](https://img.shields.io/npm/v/%40rhinoq%2Fnode/next?label=%40rhinoq%2Fnode)](https://www.npmjs.com/package/@rhinoq/node)
[![npm rhinoq](https://img.shields.io/npm/v/rhinoq/next?label=rhinoq)](https://www.npmjs.com/package/rhinoq)
![Go 1.26](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)
![PostgreSQL 16](https://img.shields.io/badge/PostgreSQL-16_tested-4169E1?logo=postgresql&logoColor=white)
![Status](https://img.shields.io/badge/status-public_beta-f59e0b)

> [!WARNING]
> RhinoQ is a public beta for evaluation and controlled pilots. It does not
> claim a production SLA. Start with the [production status](./docs/production-readiness.md)
> before deploying real workloads.

## Try RhinoQ in one command

Want to see the product before connecting an application?

```bash
npx rhinoq dev --demo
```

This opens a disposable local Workbench with one Task advancing with recorded
progress, one completed result and one failed attempt. It uses no PostgreSQL,
Redis, provider credential or production data. The demo is synthetic evidence;
use `npx rhinoq up` for a real local PostgreSQL Task profile.

![RhinoQ Workbench showing Tasks, execution stages, and evidence detail](./marketing/rhinoq-workbench-quiet-operations.png)

The operator Workbench keeps Tasks, execution state and business evidence in
one inspectable view. The end-user Task Center is a separate, lower-density
surface for progress, results and safe actions.

The Workbench also exposes the operator investigation loop: bounded worker
progress when the source provides it, an Incident Flight Recorder that joins
queue/attempt/effect/outcome/decision facts, Rule test previews against one
subject, and Safe Bulk Actions grouped as Safe / Uncertain / Blocked before a
separate approval. Queue, stage, state and search lenses can be saved locally
or shared as a URL; live snapshot updates use SSE with a polling fallback. A
missing progress record is shown as unavailable, never as a guessed ETA.

The Go Agent remains one-tenant-per-process. Set `RHINOQ_TENANT_ID` and
`RHINOQ_AGENT_ROLE`; owner Task
credentials may include the same `tenantId`, and startup fails if a credential
belongs to another tenant. This is a fail-closed deployment boundary, not a
claim that the Agent is already a public multi-tenant control plane.

The point is not to make every adopter assemble those pieces. `setup` joins the
existing `init`, `adopt`, `doctor` and `createRhinoQApp()` capabilities into one
preview-first golden path. They detect and configure the standard path, install
or verify the schema, generate integration code without overwriting existing
files, and mount the product surface together. The application keeps only the
parts RhinoQ cannot safely invent: authentication, tenant identity, business
handler, provider credentials and the definition of a correct business result.

Outcome verification—catching a technically successful job whose real result
is wrong—is the differentiating safety layer on top of that complete platform,
not the only reason to install RhinoQ.

## Why RhinoQ

See the [async ecosystem coverage matrix](./docs/async-capability-coverage.md)
for an explicit mapping of processing concerns RhinoQ handles, integrates, or
intentionally leaves to a specialist/runtime provider.

| Instead of building… | RhinoQ supplies… |
|---|---|
| queue infrastructure | native PostgreSQL job queue, or BullMQ/runtime adapters |
| job/Task tables and state transitions | durable Tasks, Executions, attempts, progress and version fencing |
| status, history, cancel and result endpoints | owner-scoped Task API |
| browser polling and reconnect code | realtime SSE with polling fallback and stale-snapshot rejection |
| customer background-job screens | mountable Task Center and React components |
| internal job dashboard | authenticated operator login and Workbench |
| missed-event and stuck-job scripts | reconciliation, attention states and queue watchdog |
| ad-hoc health endpoints | readiness, liveness and metrics |
| unsafe manual repair runbooks | preview, separate approval, idempotent execution and post-check |
| “completed means correct” assumptions | optional verification, Rules, Findings and provider evidence |

The shortest integration uses RhinoQ's public Task contract and one mounted
HTTP surface. Existing applications can retain their endpoints through the
lower-level clients, but doing so intentionally keeps more mapping code in the
application.

### Current product strengths

- **One Task contract across runtimes.** Native PostgreSQL queue, BullMQ and
  optional adapters converge on the same versioned Task/Execution lifecycle;
  queue correctness is not reimplemented in application handlers.
- **Correctness beyond technical completion.** Effect identity, `uncertain`,
  reconciliation, outcome verification, Findings and provider evidence keep
  “the worker returned” separate from “the business result is correct”.
- **Large-data paths avoid application memory.** Direct multipart browser
  upload, streaming worker IO, bounded workspaces and private artifact
  references keep multi-GB bytes out of queue payloads and Node buffers.
- **Realtime without a second source of truth.** SSE with polling fallback is
  the default; the optional WebSocket Hub multiplexes Tasks, coalesces
  owner-scoped reads, reuses serialized frames and bounds slow consumers while
  PostgreSQL remains authoritative.
- **Progress without handler-side debounce.** Worker progress keeps only a
  bounded newest update, flushes on time/delta thresholds and always flushes
  before the handler returns; a failed progress write is surfaced instead of
  being treated as Task success.
- **Proof-carrying Task view.** `taskEvidencePassport()` joins technical
  execution, external-effect confirmation, business verification, artifact
  checksums and bounded recovery references without exposing provider secrets
  or storage references.
- **A mounted product surface, not only a queue API.** Owner API, Task Center,
  React components, Workbench, health, metrics, incident evidence and guarded
  repair remove repeated frontend and operator plumbing.
- **Adopt incrementally.** Explicit composition and optional package subpaths
  let an application mount only the Task, artifact, media, realtime or existing
  runtime capabilities it selects. S3 and other specialist provider packages
  remain optional peers, so a base Task install stays small.
- **Evidence before claims.** Code-reduction measurement, fault labs and
  reproducible benchmarks distinguish implemented behavior from production
  evidence; RhinoQ does not promise an SLA in public beta.
- **One project profile.** `defineRhinoQProject()` binds the pool, identity,
  execution profile and operator surface once, while preserving the typed
  registry and fail-closed worker routing.
- **Specialist lifecycle without hidden correctness.** Processor packs provide
  readiness, workspace, cleanup and error classification; Go/runtime adapters
  still own leases, retries and Task state.
- **Selective resumability and guarded tuning.** Large deterministic handlers
  can opt into bounded, checksum/version-fenced checkpoints. Autopilot can
  execute only an explicitly approved application-owned canary with an
  observation gate and rollback; it never mutates Task state or business
  outcomes. A Sharp-compatible processor boundary is available when the
  application injects its own provider package.
- **One canonical read-only plan.** `compiler.plan()` exposes a deterministic
  fingerprint, task requirements, provider/runtime limitations and explicit
  `needs-decision` items. The CLI can show, validate and diff a JSON plan
  artifact without importing application source or changing configuration.
- **Replaceable modules with explicit lifecycle.** Runtime and processor
  boundaries can expose load/provision/validate/cleanup state. Native provider
  packages remain application-owned, and module lifecycle never owns leases,
  retries, effects or Task state.
- **Evidence-aware capability ledger.** `npx rhinoq capabilities --json`
  separates implemented behavior from bounded/provider-required/roadmap status
  and records the evidence level and remaining limit beside each claim.

The next product step is not a larger collection of queue adapters. The
[canonical low-code upgrade plan](./docs/ke-hoach-nang-cap-rhinoq.md) requires a
positive net reduction in adopter-owned code/config/process. Short capability
factories, automatic realtime/progress paths, evidence passports, the first
data-path compiler slice, a read-only Integration Eraser preview and a
read-only Plan Inspector in Workbench are implemented and tested. Project
profile auto-mount, selective checkpoints, a bounded Autopilot executor and
processor-pack catalog boundaries now also exist and are tested; Autopilot
automatic actions, provider-specific runtime evidence, auto-patching and a
multi-cluster Control Plane remain evidence-gated roadmap work.

The extension contract is documented in [module lifecycle](./docs/module-lifecycle.md);
the capability ledger is available from `npx rhinoq capabilities --json`.

## Quick start: add RhinoQ to an existing repository

`@rhinoq/node` is the canonical package: it contains the Node.js SDK, CLI,
framework integrations and exported subpaths such as `/react`, `/nest` and
`/bullmq`. `rhinoq` is only the short unscoped alias. It depends on and
re-exports the exact same `@rhinoq/node` release, and forwards its CLI commands;
it is not a second implementation. Prefer `@rhinoq/node` for application code.
Use `rhinoq` when you specifically want the shorter install or CLI name.

View them on npm: [@rhinoq/node](https://www.npmjs.com/package/@rhinoq/node) ·
[rhinoq](https://www.npmjs.com/package/rhinoq).

`setup` is a preview-first integration planner. It detects Node, NestJS, Go,
PostgreSQL and BullMQ, then prints every proposed change. It does not replace
the browser-first demo above and it does not invent an owner mapping or Task
semantics:

```bash
npm install @rhinoq/node@next pg
npx rhinoq setup
npx rhinoq setup --apply
```

`setup` never writes during preview and never overwrites an existing file. On
apply it reuses the existing init/adopt/doctor/eval implementation and creates
integration shells. BullMQ setup requires an explicit `--mode single` or
`--mode fanout` unless every queue has a `--task` declaration. Use
`--runtime bullmq|postgres|manual` when auto-detection is not the desired
choice. PostgreSQL queue execution remains in the authoritative Go worker; the
generated Node/Go boundary does not duplicate lease or retry logic.
See the [setup guide](./docs/setup.md).

For an existing app that needs a guided adoption preview, use `connect`; for a
new Task declaration, use the non-overwriting vertical-slice generator:

```bash
npx rhinoq connect
npx rhinoq add task report.export
npx rhinoq add task report.export --apply
```

`connect` delegates to the same evidence-based adoption planner, while
`add task` creates a real progress/result handler shell and leaves runtime,
owner identity and security decisions explicit. With `--apply`, the generator
also creates a dependency-free manifest/plan smoke test and points the next
step at `/task-center`; it never silently rewrites an existing file.

For a real local PostgreSQL profile with schema, fixture and Workbench, use:

```bash
npx rhinoq up
```

`up` requires Docker Desktop, uses the tested PostgreSQL 16 image, writes only
ignored local files, waits for health, applies the Task schema, creates a
bounded fixture and starts the local Workbench. Use `npx rhinoq up --dry-run`
to inspect the plan without starting Docker.

## Background jobs for Node.js and NestJS: compile one Task application

```ts
const rhinoq = defineRhinoQApplication({
  profile: { name: 'reports', adapters: [bullmqAdapter] },
  tasks: (task) => ({
    exportReport: task({
      name: 'report.export',
      retry: { mode: 'runtime', maxAttempts: 3 },
      run: async ({ reportId }, context) => generateReport(reportId, context.progress),
      result: ({ url }) => ({ ref: url, mediaType: 'application/pdf' }),
    }),
  }),
});

const application = await rhinoq.start({
  pool, ownerFromNodeRequest,
  http: { operatorToken: process.env.RHINOQ_OPERATOR_TOKEN },
});
await application.tasks.exportReport.dispatch({
  id: 'report-42', ownerId: user.id, payload: { reportId: '42' },
});
```

The typed registry supplies dispatchers, worker handlers, a static manifest and
one middleware mounting the owner API, Task Center and Workbench. Its execution
profile removes repeated adapter/runtime/scope fields. Existing runtime adapters
retain lifecycle authority; retry defaults to `never`, and external effects
still require explicit idempotency and confirmation policy. The lower-level
`app.task()` remains supported. See [Task application compiler](./docs/application-compiler.md).

When application code already has a Task ID, `TaskRunHandle` removes the
remaining observe plumbing without introducing another source of truth:

```ts
const run = new TaskRunHandle(ownerClient, taskId);
run.start();
const terminal = await run.wait({ timeoutMs: 60_000 });
console.log(terminal.state, run.url('/app/tasks'));
```

It uses the existing SSE/polling fallback, exposes `cancel()` and `result()`,
and rejects unsafe URLs. It does not invent an ETA or retry an uncertain
external effect. See [TaskRunHandle](./docs/task-run-handle.md).

<details>
<summary>Advanced integration and operator reference</summary>

For a deterministic large unit, opt into a bounded checkpoint without moving
Task state-machine authority into the handler:

```ts
run: async (input, context) => {
  const inputChecksum = await sha256RhinoQCheckpointInput(input);
  const prior = await context.checkpoint.load<{ offset: number }>('segments');
  const offset = prior?.state.offset ?? 0;
  // Process one deterministic segment, then persist only bounded resume state.
  await processSegment(input, offset);
  await context.checkpoint.save('segments', { offset: offset + 1 }, { inputChecksum });
}
```

Checkpoint state is version/checksum fenced, capped at 64 KiB and separate from
external-effect confirmation. Delete or retain it according to the adopter's
cleanup policy after the execution is terminal.

For the shortest project setup, bind the shared composition once:

```ts
const project = defineRhinoQProject({
  pool, profile: { name: 'reports', adapters: [bullmqAdapter] },
  identity: { ownerFromNodeRequest },
  http: { operatorToken: process.env.RHINOQ_OPERATOR_TOKEN },
  tasks: (rhinoq) => ({
    exportReport: rhinoq.task('report.export', async (input) => generateReport(input)),
  }),
});
const application = await project.start();
```

This mounts the owner API, Task Center and Workbench from one project profile;
the application still supplies authenticated identity, business handlers and
provider credentials. See the [project profile guide](./docs/project-profile.md).

For a shared runtime worker, the registry also removes the handwritten routing
switch while continuing to reject undeclared names and mismatched versions:

```ts
const worker = new Worker('reports', application.workerHandler(), connection);
```

For a dedicated worker process, RhinoQ can also own signal handling and the
bounded close lifecycle:

```ts
await application.runWorker({
  create: (handler) => new Worker('reports', handler, { connection }),
});
```

`runWorker()` routes only registered Task names, handles SIGINT/SIGTERM and
waits for `close()` with a configurable deadline. Queue lease/retry correctness
still belongs to the selected runtime adapter.

Bounded fan-out uses the same declaration instead of a second batch wrapper:

```ts
const resizeImages = task.batch({
  name: 'image.resize', maxItems: 500,
  run: async ({ imageId, width }, context) => resize(imageId, width, context.progress),
});
await application.tasks.resizeImages.dispatchBatch({
  id: batchId, ownerId: user.id,
  items: images.map((image) => ({ itemKey: image.id, payload: image })),
});
```

Measure consumer-owned source before making a code-reduction claim:

```bash
npx rhinoq measure --before ./before --after ./with-rhinoq --out ./rhinoq-measure.json
```

## Realtime job progress with SSE and React

```tsx
const { RhinoQTaskList, RhinoQTaskDetail, RhinoQProgress } =
  createRhinoQComponents(React);
```

These optional React components include loading/error/empty states, accessible
progress, cancel/retry/result actions, theme tokens and the existing SSE to
polling fallback. React is dependency-injected, so server-only installs do not
pull it in. See [embeddable React UI](./docs/react-ui.md).

SSE remains the zero-configuration default. Applications that already operate
a WebSocket server, or need many simultaneous Task subscriptions on one browser
connection, can add the dependency-free multiplexing hub:

```ts
import { createTaskWebSocketHub } from '@rhinoq/node/server';

const realtime = createTaskWebSocketHub(app.tasks);
const channel = realtime.accept(socket, { ownerId: sessionUser.id, tenantId });
socket.on('message', (data) => channel.receive(data));
socket.on('close', () => channel.close());
```

The application still owns the HTTP upgrade, authentication and origin policy.
RhinoQ owns the versioned subscribe protocol, one-connection/many-Task
multiplexing, owner/tenant-scoped reads, coalesced snapshot fan-out, heartbeat,
limits and slow-consumer protection. No Socket.IO, Redis or second source of
truth is required. See [realtime transports](./docs/realtime.md).
Pass `realtime: { invalidate: realtime.invalidate }` to `createRhinoQApp()` and
in-process producer dispatch/runtime projection writes automatically push through
the indexed group. The explicit `realtime.invalidate(taskId, identity, version)`
call remains available for external writes or LISTEN/NOTIFY signals; the interval
scan is only a missed-signal recovery path.

## Return files without building an artifact subsystem

Configure one application-owned S3-compatible or Cloudinary provider, then use
the handler context:

```ts
const report = task({
  name: 'report.export',
  run: async ({ reportId }, context) => context.artifact.file(
    await generateReport(reportId),
    { name: `${reportId}.pdf`, contentType: 'application/pdf' },
  ),
});
```

`context.artifact.file()` uploads through `artifactProvider`, computes SHA-256,
registers size/content type/expiry/lineage, and makes owner-safe metadata and
short-lived download resolution available through the existing Task API and
the file-card UI in Task Center. RhinoQ stores metadata and a private reference,
not the binary itself. Use `createAwsS3ArtifactProvider({ bucket, clientConfig })`
for a batteries-included AWS SDK integration; R2, MinIO and Spaces use the same
factory with a custom endpoint. Use
`createCloudinaryArtifactProvider()` for Cloudinary. See the
[artifact storage guide](./docs/artifact-storage.md).

Large outputs use `context.artifact.stream()` or `filePath()`: RhinoQ computes
integrity and progress while the provider's multipart/chunked uploader consumes
the stream with backpressure, so a multi-gigabyte video is not buffered in
worker memory. Large browser inputs upload directly to private cloud storage;
the queue carries only the object reference, never the file bytes.

For the shortest path, set `artifacts: 's3'` and the documented
`RHINOQ_ARTIFACT_*` variables, then return
`context.output.video(path)`, `pdf(path)`, `archive(path)`, `files(paths)` or
`zip(paths)`. File name, common MIME types, byte progress and streaming are
automatic; explicit provider and low-level stream APIs remain available when
an application needs custom policy.

```ts
const app = await createRhinoQApp({
  pool, adapters, ownerFromNodeRequest,
  artifacts: 's3',
});

return context.output.video('/work/output.mp4');
return context.output.files(paths, { concurrency: 4 });
return context.output.zip(paths, { name: 'all-results.zip', maxItems: 500 });
```

`files()` registers up to 100 separately downloadable artifacts with bounded
concurrency, matching the owner API and Task Center view. `zip()` can stream up
to 1,000 bounded inputs into one artifact through the optional `archiver`
package. Neither path puts file bytes in PostgreSQL, BullMQ or Redis.

For browser inputs, `uploadArtifactFile()` uses an owner-scoped durable
multipart session and signed part URLs, so multi-GB bytes travel directly to
AWS S3 instead of through the Node server. It resumes from provider state,
adapts its multipart plan to a memory budget, verifies the completed object,
and only then registers the Task artifact. Task-bound uploads automatically
compute SHA-256 concurrently with upload in bounded Blob slices, with progress and cancellation; callers
may supply a trusted digest to avoid the extra read. RhinoQ never invents
integrity evidence. Session expiry and
artifact retention are separate, and cleanup requires preview plus an explicit
`sweep({ delete: true })`.

Declared Tasks also receive `context.media.transcode()` and
`context.media.thumbnail()`: bounded FFmpeg wrappers with cancellation,
timeouts, output validation and automatic artifact registration. FFmpeg stays
an application-installed runtime dependency. See the
[artifact storage guide](./docs/artifact-storage.md#direct-resumable-browser-upload).

Interactive Tasks use the same handler context; RhinoQ binds the current Task,
persists the checkpoint and exposes the already-mounted owner route and UI:

```ts
const approval = await context.waitForApproval({
  id: `approve-${invoiceId}`,
  key: 'finance-approval',
  payloadVersion: 1,
  deadline: new Date(Date.now() + 86_400_000).toISOString(),
});
if (approval.status !== 'resolved') return approval;
```

`waitForInput()` and `waitForWebhook()` follow the same durable re-entry
contract; no worker lease remains open while the Task waits.

Optional `trace` hooks on `createRhinoQApp` wrap `rhinoq.task.dispatch` and
`rhinoq.task.run` and propagate a bounded string carrier through the runtime
envelope. An application may bridge these hooks to OpenTelemetry; RhinoQ does
not add a mandatory telemetry dependency or treat a trace as correctness data.

For repeated mechanical patterns, `rhinoqPresets.exportFile()` supplies staged
progress, artifact upload and result metadata, while `importData()` supplies a
safe no-retry baseline. `rhinoqPresets.external()` is available for email,
webhook or provider work but refuses construction without explicit idempotency
and confirmation policy; presets never guess whether a business effect is safe.

## What RhinoQ is for

RhinoQ fits long-running and failure-prone work such as report export, media
processing, email delivery, data import, batch processing, provider operations
and cross-system synchronization. It is useful when users need progress and
results while operators need attempt history, failed-job recovery and evidence
before retrying an external effect.

RhinoQ is not a general workflow-language replacement. It does not invent
business retry safety, authentication, tenant identity, provider credentials
or the definition of a correct result. Those boundaries remain explicit in the
application. See [what you still write](./docs/what-you-still-write.md).
The [async Task capability map](./docs/async-task-capabilities.md) distinguishes
implemented behavior from recurring/DAG work that still requires durable engine
state and fault evidence.

## PostgreSQL job queue without Redis

The native queue stores enqueue, claim, fenced lease, retry, cancellation and
recovery state in PostgreSQL. Go is the authoritative execution runtime for
this path. Read the [native PostgreSQL queue guide](./docs/postgres-queue.md).

### Durable recurring Tasks (experimental)

Migration 031 adds interval schedules claimed with PostgreSQL database time,
`SKIP LOCKED` and owner/epoch leases. Each occurrence has a deterministic,
tenant-scoped identity so dispatch callbacks can enqueue idempotently across
replica takeover:

```go
client.CreateRecurringTask(ctx, rhinoq.RecurringTaskRequest{
    ID: "daily-report", TaskName: "report.export",
    TenantID: tenantID, OwnerID: ownerID,
    Payload: payload, Every: 24 * time.Hour,
})

client.CreateRecurringTask(ctx, rhinoq.RecurringTaskRequest{
    ID: "weekday-report", TaskName: "report.export",
    TenantID: tenantID, OwnerID: ownerID, Payload: payload,
    Cron: "0 8 * * 1-5", Timezone: "Asia/Ho_Chi_Minh",
})

dispatch, err := client.NativeRecurringDispatcher(rhinoq.NativeRecurringDispatchConfig{
    QueueForTask: map[string]string{"report.export": "reports"},
})
if err != nil { return err }
client.RunRecurringTaskScheduler(ctx, rhinoq.RecurringTaskSchedulerConfig{
    Owner: replicaID, Dispatch: dispatch,
})
```

The native dispatcher uses `OccurrenceID` as its idempotency identity and fails
closed when a Task has no explicit queue mapping. Custom runtime callbacks must
preserve the same identity. Get/list, version-fenced pause/resume/update/delete
are available on the same `Client`.
Interval scheduling and real-PostgreSQL lease takeover are tested. The Go
Workbench exposes a payload-free recurring-schedule table at
`/?tenant=<tenant-id>` with version-fenced pause/resume controls when actions
are enabled. Five-field cron expressions use IANA timezones. Spring-forward
gaps are skipped and repeated fall-back wall minutes run once; migration 032
persists the calendar contract and the scheduler calculates the next UTC run
before its fenced completion. The surface remains beta pending adopter evidence.

The authenticated Agent `/metrics` endpoint exports bounded
`rhinoq_recurring_schedules{state="enabled|paused|due|leased|failed"}` gauges;
the aggregate query never reads schedule payloads.
`rhinoq_recurring_oldest_due_lag_seconds` reports how long the oldest due
schedule has waited beyond its intended dispatch time; zero means no due backlog.
The Go `rhinoq doctor` command reports the same aggregate and warns when a
dispatch error is recorded or the oldest due schedule is later than one worker
lease, so dashboards and deployment checks use one database calculation.
The Agent operator surface provides bounded `GET /v1/recurring-schedules` and
version-fenced pause/resume commands. List responses intentionally omit payloads.

## BullMQ dashboard and Task API

Existing BullMQ applications keep their Queue, QueueEvents and workers. RhinoQ
adds the durable owner-scoped Task API, progress aggregation, reconciliation,
Task Center and operator Workbench without scanning or mutating application
Redis. Start with the [BullMQ example](./examples/fanout-bullmq/README.md).

## New here? Get one green run first

Start with the [five-minute quickstart](./docs/quickstart.md). It needs only
Node.js and Docker: no Redis, queue, worker, Go build or provider credentials.
The shortest path is:

```text
start PostgreSQL -> install the pinned SDK -> set RHINOQ_DATABASE_URL -> npx rhinoq eval
```

The quickstart tells you exactly which `PASS` results to expect and how to fix
the common first-run errors. After it passes, choose only the integration that
matches your application:

| You have | Read next |
|---|---|
| BullMQ | [BullMQ example](./examples/fanout-bullmq/README.md) |
| another queue/custom runtime | [portable Node adapter guide](./sdks/node/README.md) |
| no existing queue; use PostgreSQL as the queue | [native PostgreSQL queue](./docs/postgres-queue.md) |
| PostgreSQL business checks, no queue adoption | [integrity-only example](./examples/integrity-only/README.md) |
| a deployment decision | [production checklist](./docs/production-checklist.md) |

RhinoQ is currently a prerelease. Use it for evaluation and controlled pilots;
the [production status](./docs/production-readiness.md) explains the remaining
deployment-specific gates without presenting local tests as a production SLA.

Choose the execution path that matches your system. RhinoQ can keep an existing
queue through a runtime adapter, **or run jobs itself on its native
PostgreSQL-backed Go queue**. BullMQ currently has the deepest Node adapter
coverage; the native queue provides transactional enqueue, fenced leases,
retries, cancellation and recovery without Redis.

## Choose your queue path

| Your application | Recommended path | What runs the job |
|---|---|---|
| already uses BullMQ | [BullMQ adapter example](./examples/fanout-bullmq/README.md) | your existing BullMQ workers |
| already uses another queue | [portable adapter guide](./sdks/node/README.md) | your existing runtime |
| wants a queue without adding Redis/broker infrastructure | [native PostgreSQL queue](./docs/postgres-queue.md) | RhinoQ Go workers using PostgreSQL |
| uses a Node producer with a Go execution worker | [Node + PostgreSQL queue example](./examples/nodejs/README.md) | application-registered RhinoQ Go worker |
| only needs Task status around existing work | [runtime-neutral guide](./docs/start-here.md) | the application’s existing worker |

“PostgreSQL Task storage” and “PostgreSQL queue” are different choices. The
Node Task profile can store Task views while BullMQ still executes jobs. In the
native queue path, PostgreSQL also owns enqueue, claiming, leases and retry
state, and Go is the authoritative runtime.

Task Center and Workbench use the same plain-language Task explanation: what is
happening, how much finished, whether repeating the work needs review, and the
next recommended action. Generic failures never claim that retry is safe when
RhinoQ has no evidence about the external result.

Frontend applications do not need to write SSE parsing, polling fallback,
reconnect timers or stale-snapshot handling. See
[what you do not build](./docs/what-you-do-not-build.md), the
[live UI contract](./docs/live-task-ui.md), and the explicit
[adopter responsibilities](./docs/adopter-responsibilities.md).

The operator token is exchanged for an HttpOnly, SameSite cookie scoped to
`/admin`; it is not embedded in the page or URL. This complete manual-runtime
example creates and finishes one durable Task without BullMQ:

> [!IMPORTANT]
> The runtime-neutral APIs below are available in the verified
> `v0.1.0-beta.22` prerelease. Install the `next` channel or pin that exact
> version; the stable `latest` channel may still point to an older release.

For a reproducible evaluation, pin the verified prerelease explicitly:

```bash
npm install @rhinoq/node@0.1.0-beta.22 pg
```

Or generate the fail-closed consumer shell without overwriting existing files:

```bash
npx rhinoq init --example report-export
npx rhinoq doctor --product-surface
npx rhinoq eval
npx rhinoq demo transport-fallback
```

The transport demo is explicitly simulated. It is a teaching aid, not
service-backed reliability evidence.

`rhinoq eval` performs a bounded local product check against the configured
PostgreSQL database: it installs or verifies the Task profile, creates a
durable technical-success/business-uncertain fixture, starts both UI surfaces
on an ephemeral loopback port and exercises them over HTTP. Browser behavior,
external-provider readback and deployment faults remain `NOT VERIFIED`; the
command does not manufacture production evidence from a local smoke test.

```js
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { createManualRuntimeAdapter, createRhinoQApp } from '@rhinoq/node';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = createManualRuntimeAdapter('manual', 'reports');
const ref = { runtime: 'manual', scope: 'reports', externalId: 'report-42' };
const app = await createRhinoQApp({
  pool, adapters: [adapter], ownerFromNodeRequest: () => 'demo',
});
await app.runtime.track({
  task: { id: 'report-42', type: 'report.export', ownerId: 'demo', definitionVersion: 1 },
  executionId: 'report-42:attempt-1', ref,
});
await adapter.emit({ type: 'succeeded', ref, occurredAt: new Date().toISOString() });
const http = app.http({ operatorToken: process.env.RHINOQ_OPERATOR_TOKEN });
createServer((req, res) => http(req, res)).listen(8787, '127.0.0.1');
console.log('Task Center: http://127.0.0.1:8787/task-center/report-42');
```

`definitionVersion` on a Task request is optional and defaults to `1` for both
the Gateway and embedded PostgreSQL clients. If the PostgreSQL Task profile has
not been installed, the client reports `RHINOQ_TASK_SCHEMA_MISSING` and points
to `npx rhinoq-task`.

For a direct client lifecycle, `openTask()` hides version threading while
preserving optimistic-concurrency errors. `reportTaskProgressAutoVersion()`
reads the current version once, and `completeTask(id, { resultRef })` composes
start, result attachment and success; neither helper silently retries a race.
Low-level `transitionTask(id, version, 'running')` also verifies the current
snapshot and composes the fenced `pending -> queued -> running` path when that
shortcut is valid; the database state machine remains authoritative.
For runtime-backed workers, use the typed `defineRhinoQApplication()` path
below so lease and retry correctness remain with the selected runtime.

For a direct client worker that already receives one selected Task job:

```ts
const worker = createTaskWorker({
  client,
  type: 'report.export',
  handler: async (payload, { progress }) => {
    await progress({ completed: 1, total: 2 });
    return generateReport(payload);
  },
});
await worker({ taskId: 'report-42', payload: { reportId: '42' } });
```

The helper validates the registered type, carries versions and records the
one-attempt outcome. The selected runtime still owns polling/claim, lease,
heartbeat and retry policy.

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

## Release status

RhinoQ is currently in public beta.

- Latest verified public prerelease: `v0.1.0-beta.22`.

Use RhinoQ for evaluation and controlled pilots. Production use is not yet
recommended. The beta.10 release was superseded after its partial npm publish;
beta.13 published both npm packages but its post-publish smoke used an invalid
OpenAPI path, so it did not produce GitHub binaries, a container or a complete
GitHub Release. Beta.17 supersedes it with the corrected end-to-end release
gate.

> [!WARNING]
> RhinoQ is a prerelease for evaluation and controlled pilots. The full Go and embedded Node Task
> profiles enforce tenant isolation in PostgreSQL. The embedded Node Task
> profile additionally requires tenant context at its HTTP boundary and binds it to a tenant-scoped PostgreSQL pool;
> owner-scoped SQL predicates remain a second application check. The code-reduction numbers are a
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
| running RhinoQ for the first time | [the five-minute quickstart](./docs/quickstart.md) |
| using PostgreSQL as the job queue | [the native PostgreSQL queue guide](./docs/postgres-queue.md) |
| evaluating the runtime-neutral Task layer | [the beginner guide](./docs/start-here.md) |
| adding this around async work you already run | [the two integration doors](./docs/two-doors.md) |
| using BullMQ specifically | [the BullMQ adapter example](./examples/fanout-bullmq/) |
| deciding whether it will save you code | [two doors](./docs/two-doors.md) |
| deciding whether to trust it | [what RhinoQ does, and what you still write](./docs/what-you-still-write.md) |
| checking tested dependency versions | [the compatibility matrix](./docs/compatibility-matrix.md) |
| running an external usability evaluation | [the no-coaching pilot protocol](./docs/usability-pilot.md) |
| completely new to all of it | [the beginner guide](./docs/start-here.md) |
| ready to inspect a production-shaped consumer | [the report export example](./examples/report-export/) |
| integrating owner API actions | [the owner Task API contract](./docs/task-api.md) |
| adding business outcome checks | [business verification onboarding](./docs/business-verification.md) |
| reviewing failure evidence | [the fault evidence matrix](./docs/fault-matrix.md) |

On Windows, the disposable two-container PostgreSQL failover drill can be run
with `./scripts/run-failover-drill.ps1`. It starts an isolated primary and
streaming standby, kills the primary, promotes the standby, verifies that it
accepts writes and checks acknowledged Task rows plus forced RLS before
removing its containers and volumes. This is single-host fault evidence, not a
split-brain or production-availability claim.

The [`report.export` consumer example](./examples/report-export/) is the
recommended first real application after the five-minute fixture. It installs
the verified npm package rather than importing this checkout and demonstrates
two server-side owner sessions, tenant-scoped owner queries, an authorized
result resolver, storage readback, a verified success and a runtime-success/missing-
output Task that remains `uncertain`.

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
| [`@rhinoq/node`](https://www.npmjs.com/package/@rhinoq/node) | npm | canonical Node SDK and CLI, including `/react`, `/nest`, `/bullmq`, `/sqs`, `/browser` and `/server` exports; recommended for application imports |
| [`rhinoq`](https://www.npmjs.com/package/rhinoq) | npm | short alias that depends on and re-exports the matching `@rhinoq/node`; useful for `npm install rhinoq` and the same CLI commands |
| `@rhinoq/nest` | **not published** — `npm install ./sdks/nest` from a checkout | an optional NestJS module |
| `rhinoq` (Go CLI) | `go build ./cmd/rhinoq` | Rules, Findings, the Gateway, full migrations |

The Node SDK and the Go engine are two planes, not two versions of one thing.
The Node SDK owns portable runtime adapters, Tasks and the Workbench; the Go
engine owns Rules, Findings and ProviderOperation. Node talks to those Go-owned
capabilities through the Gateway when an application needs them.

Do not install both npm packages in one application: that adds no capability.
Their versions are released together so the alias always targets the matching
canonical SDK version.

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
npx rhinoq adopt --scan                 # read-only integration inventory
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
npx rhinoq lab run completed-but-missing-output --recover --confirm-disposable
```

Failure Lab creates an additive completed-but-wrong Task, explains why it is
`uncertain`, previews and separately approves a disposable repair, records
output plus verified evidence, and post-checks the Task as
`succeeded`. It prints the complete recovery chain and a JSON incident summary.
The command refuses before connecting to PostgreSQL unless disposable-database
confirmation is explicit; omit `--recover` to stop at the incident.

The production-shaped `examples/report-export` consumer exposes the same
guarded recovery as a two-browser-session reference journey: support previews,
a separate approver executes, provider readback closes the Task, and repeating
the approval demonstrates lost-response replay without a second provider
mutation.

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

Before choosing a migration boundary, run the read-only Integration Eraser
preview. It reports file/line evidence for status routes, polling, BullMQ
lifecycle listeners, upload proxies and retry timers. High-confidence matches
are only a static estimate; uncertain matches require review, and auth,
handlers and business verification remain application-owned:

```bash
npx rhinoq adopt --scan
npx rhinoq adopt --scan --json
```

It never writes, patches or deletes the scanned repository. See the
[Integration Eraser guide](./docs/integration-eraser.md).

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
tenant is then carried through list/detail/history/waitpoint/result/SSE reads
and owner-scoped Execution-by-ID reads/transitions; missing tenant context is
refused. Single-tenant applications use the explicit `default` tenant. Operator
Workbench reads remain deliberately cross-tenant and must stay behind
`requireOperator`. The Node Task profile also requires `rhinoq.tenant_id` in the PostgreSQL pool connection options and one tenant per pool; use `inspectTaskRls()` or `requireTaskRls()` in deployment checks.

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
application-owned HMAC capabilities scoped to one waitpoint, task, tenant, owner
and action. The token schema is version 2; tokens without tenant scope are
rejected. RhinoQ never stores the signing secret. Resolution bodies are bounded
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

Workbench Safe Bulk Actions follow the same boundary: select a bounded set,
preview the evidence grouping, approve with a different operator, execute only
registered safe handlers and post-verify. Unknown or blocked effects remain
untouched. `rhinoq workbench --demo --actions` provides a disposable in-memory
walkthrough of this flow; live deployments must supply an Application-owned
`BulkOperator`.

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

RhinoQ does not require replacing an existing queue. It also includes an
optional native PostgreSQL queue for teams that want RhinoQ to execute jobs:

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
- **Native Go runtime:** PostgreSQL-backed queue with transactional enqueue,
  registered handlers, fenced leases, retries, cancellation, admission control
  and recovery. See the [dedicated queue guide](./docs/postgres-queue.md).
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
| Workbench progress, Flight Recorder, Rule test preview, saved views and SSE fallback | implemented; bounded Reader/Application capabilities |
| Workbench Safe Bulk Actions | implemented; preview is bounded read, approval/execute require an application BulkOperator |
| Recheck and guarded repair workflow | implemented; callback registration is application-owned |
| Summary polling and cursor-paginated Executions | implemented |
| Explicit At risk/Stuck policy and owner-scoped view | implemented in Node Task profile |
| Task verification records and Recently verified | implemented in Node Task profile |
| Artifact v1 metadata/checksum/expiry/refresh/lineage | implemented in Node Task profile |
| Task-to-provider Flight Recorder correlation | implemented; compare-attempt diffs, supplied waterfall spans and bounded diagnostic export are available |
| Node Task tenant HTTP/SQL boundary | implemented with owner/tenant scope, tenant-fenced waitpoint settlement and owner-scoped Execution guards, plus optional deny-by-default authorization hook; full-profile Gateway RBAC remains separate |
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
| Release archives, npm provenance, registry smoke, checksum bundle, SBOM and non-root image | beta.22 release candidate; verified only after the tag workflow passes |
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
- [TaskRunHandle: start, wait, cancel and result](./docs/task-run-handle.md)
- [NestJS integration package](./sdks/nest/README.md)
- [ProviderOperation](./docs/provider-operations.md)
- [Safe repair](./docs/safe-repair.md)
- [Notifications](./docs/notifications.md)
- [Failure semantics: why unknown is not a pass](./docs/failure-semantics.md)
- [Benchmarks, with their limits](./docs/benchmarks.md)
- [DX comparison source of truth](./docs/dx-comparison.md)
- [First Value / README / DX master plan](./docs/vi/ke-hoach-tong-the-first-value-readme-dx.md)
- [Retention](./docs/retention.md)
- [Architecture](./ARCHITECTURE.md)
- [Release process](./docs/releasing.md)
- [Roadmap and honest blockers](./docs/roadmap.md)

</details>

RhinoQ is licensed under Apache-2.0. Contributions should follow
[CONTRIBUTING.md](./CONTRIBUTING.md), [SECURITY.md](./SECURITY.md) and
[AGENTS.md](./AGENTS.md).
