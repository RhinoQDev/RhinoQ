# RhinoQ for Node.js

[View `@rhinoq/node` on npm](https://www.npmjs.com/package/@rhinoq/node) ·
[GitHub repository](https://github.com/madebyduy/RhinoQ)

Open-source background jobs and async Tasks for Node.js and NestJS. Add durable
Task state, progress, retry history, cancellation, realtime SSE, embeddable
React components, a user Task Center and an operator Workbench without building
that application plumbing yourself.

RhinoQ can keep your existing BullMQ workers or run its native PostgreSQL queue
through the authoritative Go worker. Your execution runtime and business logic
stay yours; RhinoQ does not invent authentication, tenant identity, provider
credentials or business retry safety.

## Install and get one working path

```bash
npm install @rhinoq/node@next pg
npx rhinoq setup
npx rhinoq setup --apply
```

`setup` previews before writing, detects Node.js/NestJS/Go, PostgreSQL and
BullMQ, recommends a runtime path, generates non-overwriting integration files,
checks the schema and prints the Task Center and Workbench URLs. Start with the
[five-minute quickstart](https://github.com/madebyduy/RhinoQ/blob/main/docs/quickstart.md)
if you want a guided first green run.

The Node SDK exposes one portable adapter contract. BullMQ currently has the
deepest Node coverage; manual/custom adapters and the SQS proof adapter exercise
the same core without making BullMQ the product boundary.

For custom runtimes, the development-preview `createRhinoQ()` API exposes
Observe, Track and capability-gated Control over portable runtime events:

> This portable surface is available in the verified `v0.1.0-beta.15`
> prerelease. Install the `next` channel or pin that exact version; the stable
> `latest` channel may still point to an older release.

Latest verified npm prerelease: `v0.1.0-beta.15`.

```ts
const adapter = createManualRuntimeAdapter('manual', 'reports');
const app = createRhinoQ({
  client: new PostgresTaskClient(pool),
  terminalProjection: 'single-execution',
  adapters: [adapter],
});

await app.track({ task, executionId, ref });
await app.start();
await adapter.emit({ type: 'started', ref, occurredAt: new Date().toISOString() });
```

Use the product composition when the host also needs the owner API, Task Center
and operator Workbench from the same mount:

```ts
const rhino = await createRhinoQApp({ pool, adapters: [adapter], ownerFromRequest });
server.use(rhino.http({ operatorToken: process.env.RHINOQ_OPERATOR_TOKEN }));
await rhino.runtime.track({ task, executionId, ref });
```

`app.http()` also accepts the application-owned `authorize`,
`requireTenantAuthorization`, `resolveResult` and `cancelTask` boundaries. The
complete [`report.export` consumer](https://github.com/madebyduy/RhinoQ/tree/main/examples/report-export) shows two
owners, provider readback and unsupported cancellation without Task mutation.

Frontend and framework integrations can load the packaged OpenAPI 3.1 owner
contract from `@rhinoq/node/openapi.json`. The build fails if its version,
complete operation inventory or capability fields drift from the package
implementation. Contract inputs are included in build provenance hashing.

`createRhinoQ()` remains the lower-level runtime primitive;
`createRhinoQApp()` is the generic golden path for every adapter.

Files produced by handlers can use one provider configuration instead of
application-owned upload, metadata and download routes:

```ts
const app = await createRhinoQApp({
  pool, adapters, ownerFromNodeRequest,
  artifacts: 's3',
});

const exportTask = app.task({
  name: 'report.export',
  run: async (input, context) => context.output.pdf(await makePDFOnDisk(input)),
});
```

Set `RHINOQ_ARTIFACT_BUCKET`, region and policy variables. RhinoQ wires
streaming/multipart upload, checksum, progress, metadata, owner API, signed
download and Task Center. `output.video()`, `archive()`, `files()` and `zip()`
cover common outputs; explicit S3-compatible and Cloudinary providers remain
available from `@rhinoq/node/artifacts`. Credentials remain server-side. Read
the complete [artifact guide](https://github.com/madebyduy/RhinoQ/blob/main/docs/artifact-storage.md).

Large remote inputs use the same Task context without hand-written stream,
temporary-file and FFprobe glue:

```ts
const processVideo = app.task({
  name: 'video.process',
  workspace: { minimumFreeBytes: 20 * 1024 ** 3 },
  run: async ({ url }, context) => {
    const input = context.workspace!.path('input.mp4');
    await context.io.download(url, input, {
      allowedHosts: ['media.example.com'], maxBytes: 5 * 1024 ** 3,
    });
    await context.media.probe(input);
    return context.media.transcode(input, context.workspace!.path('output.mp4'));
  },
});
```

The downloader is HTTPS-only, redirect-allowlisted, bounded, timed,
checksummed and cancellation-aware. The workspace checks capacity and is
removed in `finally`; `probe()` uses bounded FFprobe JSON. Network egress policy
and business retry remain application-owned.

An adapter that implements `inspect` can reconcile one already-known reference
without scanning its runtime:

```ts
const observation = await app.reconcile('custom', ref);
const runtimes = await app.runtimeReports(); // health, capabilities, guarantee gaps
```

`app.cancel(taskId, adapterName, ref)` checks capability and verifies that the
server-side reference belongs to the Task before requesting cancellation.
`unsupported` fails before mutation; `best_effort` results such as
`cannot_cancel_safely` are persisted as evidence rather than reported as
success. Adapter authors can run the read-only
`checkRuntimeAdapterContract(adapter, ref)` testkit without invoking dispatch
or cancel.

BullMQ can use the same portable path explicitly:

```ts
const adapter = createBullMQRuntimeAdapter({
  scope: queue.name,
  queue,
  events,
  jobName: 'report.export',
  jobId: ({ idempotencyKey }) => `rhinoq-${idempotencyKey}`,
  terminalFailure: async (event) => isTerminal(queue, event.jobId),
});
const app = createRhinoQ({ client: tasks, terminalProjection: 'single-execution', adapters: [adapter] });
```

The adapter refuses BullMQ custom IDs containing `:` before enqueue, requires
the returned job ID to equal the reserved ID, defaults failed events to
non-terminal, and degrades health when event translation/projection fails.
Applications migrating the compatibility facade can use
`createBullMQPortableIntegration()`. It composes the same Queue/QueueEvents
objects through `BullMQRuntimeAdapter -> createRhinoQ()`; the legacy
`rhinoq()` preset remains available while its older lease/fan-out surface is
kept byte-compatible.

Passing `queue` enables dispatch and therefore requires both `jobName` and a
stable `jobId` callback at compile time. Omit all three for an observe/track-only
integration. A successful `single` execution synchronizes Task progress to a
terminal value before the Task becomes `succeeded`.

The SQS proof adapter is available from `@rhinoq/node/sqs`. It models
`ApproximateReceiveCount` as an observed redelivery attempt, reports missing
readback as `unknown`, and always fails closed for cancellation. It does not
import or own the AWS SDK; the host supplies send/inspect callbacks.

### Observe-only Shadow Mode

For work the host application already dispatches, provide a deterministic
identity resolver. RhinoQ does not enqueue or cancel anything:

```ts
const app = createRhinoQ({
  client: tasks,
  terminalProjection: 'single-execution',
  adapters: [adapter],
  resolveUnboundEvent: (event) => ({
    task: {
      id: `task-${event.ref.externalId}`,
      type: 'report.export',
      ownerId: ownerFor(event.ref),
      definitionVersion: 1,
    },
    executionId: `execution-${event.ref.externalId}`,
    ref: event.ref,
  }),
});
```

The resolver must return the exact event reference. RhinoQ creates and binds
the Task attempt idempotently, then replays the original event so a first-seen
`succeeded` job does not remain queued. Returning `undefined` leaves the event
unresolved and creates no guessed Task. `await app.adoptionReport()` returns
measured counts for observed events/references, bound Tasks, retry attempts,
uncertain/terminal failures, unresolved identity and capability gaps. For
multi-replica adoption, pass `adoptionStore: new PostgresAdoptionReportStore(pool)`
and a stable `adoptionReplicaId`, then install `ADOPTION_REPORT_SCHEMA_SQL`;
events are deduplicated by event ID and the report is aggregated from all
replicas rather than process memory.

### Guarded recovery

`GuardedRecovery` wraps the Gateway repair API with a deterministic repair ID,
preview/precondition checks, a separate approver, an idempotency ledger and a
mandatory post-check. `execute()` is preview-only unless `confirm: true` is
supplied; an unknown post-check remains `uncertain` and is never retried
blindly. A lost execute response consumes the fence as `uncertain` instead of
leaving a retryable running record. Use `PostgresRecoveryLedger` for a
multi-process idempotency fence.

### Failure Lab

Run the completed-but-wrong rehearsal only against disposable resources:

```bash
npx rhinoq lab run completed-but-missing-output --recover --confirm-disposable
```

The lab writes one additive fixture, previews and separately approves a guarded
disposable repair, attaches simulated output evidence, records verified
verification and post-checks the Task as `succeeded`. It prints the complete
`break -> detect -> explain -> preview -> repair -> recheck -> verified` chain
and a shareable JSON incident summary. It does not delete, drain, pause, retry
or call an external provider. Omit `--recover` to stop at the incident.

Generate observe-only adoption without taking runtime control:

```bash
npx rhinoq adopt --adapter custom --observe
npx rhinoq adopt --adapter custom --observe --apply
```

The generated composition installs the durable adoption report and leaves
application identity in an explicit `resolveIdentity(ref)` callback. Returning
`undefined` is fail-closed and counted in `unresolvedEvents`.

### Incident Explainer

The authorized Workbench detail and
`GET /rhinoq/api/tasks/{taskId}/incident-explanation` expose a deterministic
model containing summary, technical state, business outcome, bounded evidence,
affected scope, evidence-backed cause hypotheses and guarded actions. Technical
success without verification remains `unknown`.

Supply `runtimeReports: () => app.runtimeReports()` to the Workbench handler to
make runtime actions capability-aware. If any matching runtime reports cancel
as `unsupported`, the cancellation button is hidden and the POST endpoint
returns `RHINOQ_UNSUPPORTED` before requesting Task cancellation. Missing
capability evidence remains `unknown`; it is never upgraded to supported.

Failures must carry adapter-owned `terminal`; unknown results must carry a
reason. Dispatch capability is checked before use. If a runtime accepts a
dispatch but PostgreSQL binding fails, RhinoQ throws
`RHINOQ_RUNTIME_DISPATCH_UNCERTAIN` with the receipt and explicitly marks it
non-retryable, so callers reconcile and bind rather than dispatching twice.
See the [manual runtime example](../../examples/manual-runtime/).

## A concrete adapter path: BullMQ

If the application already has a `pg.Pool`, a BullMQ `Queue` and its
`QueueEvents`, the compatibility preset gives a low-friction starting point:

```ts
import { rhinoq } from '@rhinoq/node';

const app = await rhinoq({
  pool, queue, events,
  ownerFromRequest: (request) => request.headers.get('x-user'),
});

server.use(app.http({ operatorToken })); // /tasks + /task-center + /admin

await app.dispatch(taskId, urls.map((url, index) => ({
  key: `item-${index}`,          // the idempotency key: attempts are numbered per key
  data: { url },                 // your BullMQ job payload, unchanged
})), { ownerId, jobOptions: { attempts: 3 } });
```

`rhinoq()` makes the decisions that have one right answer for a queue-backed
fan-out and are silent when wrong: `terminalProjection` (`single-execution`
closes a batch on its first finished item), the retry projection, the projector
lease, the terminal-failure classifier, cancellation of the underlying jobs, and
the reconciliation sweep — which is on by default, because "you were supposed to
configure a reconciler" is not something anyone learns before the batch that
needed it is stuck.

Nothing is hidden: `app.bridge` and `app.tasks` are the same
`BullMQTaskBridge` and `PostgresTaskClient` the long-form API gives you.
[`examples/fanout-bullmq/`](https://github.com/madebyduy/RhinoQ/tree/main/examples/fanout-bullmq)
is the same feature set with every decision written out.

| Call | What it is |
|---|---|
| `app.dispatch(taskId, items, options?)` | create the Task, reserve every item durably, enqueue |
| `app.getTask(taskId)` | state, progress, `itemCounts` and `executionCounts` |
| `app.cancel(taskId)` | stop the jobs that can be stopped; say which could not |
| `app.audit(taskId)` | every attempt whose stored state disagrees with the queue |
| `app.reconcile(taskId)` | re-read the runtime for one batch and write down what it finds |
| `app.http({ operatorToken })` | mount owner API, Task Center and Workbench together |
| `app.routes()` | the owner-scoped read/cancel HTTP surface |
| `app.workbench({ token })` | the operator console |

`app.http()` is the default product path. Use the separate middleware builders
when custom paths, custom operator authentication or framework registration
requires them.

**Items are not attempts.** `TaskSummary.executionCounts` counts attempts, so a
200-URL batch with three retries reads `total: 203`. Render `itemCounts`, which
counts items and carries `retries` separately.

## The Rules half

```bash
npm install @rhinoq/node pg
npx rhinoq init
npx rhinoq adopt --mode single        # preview queues and infrastructure
npx rhinoq adopt --mode single --queue mail-queue \
  --owner-property user.id --apply
# Add --queue repeatedly for multiple queues.
# Add --local-postgres only for a generated local evaluation service.
npx rhinoq verify add completed-report-has-output
npx rhinoq doctor
```

The owner property is read from the original Nest/Express request after host
authentication has populated it. It mounts `/tasks`, `/tasks/*` and
`/task-center`. RhinoQ refuses owner middleware without an explicit resolver;
it never trusts an owner header by default.

The Node `init` path creates the isolated Task profile. `beta.15` is the current
release that contains the complete Verified Rule loop; an older tarball answers
`FAIL verify requires 'add <rule-name>'`. For Verified Rules, start the full Go
Gateway, set `RHINOQ_AGENT_URL` and a token of at least 32 bytes, then run:

```bash
npx rhinoq verify apply completed-report-has-output --subject-type report
npx rhinoq verify run completed-report-has-output
```

`apply` reads the local SQL file through the Go Rule boundary and leaves it
disabled. `run` performs one bounded evaluation, prints violations/evidence and
disables the Rule again. Node does not reimplement Rule correctness.

The embedded PostgreSQL Task client and BullMQ bridge reduce onboarding cost;
the Go Gateway remains authoritative for ProviderOperation uncertainty,
evidence and guarded repair.

### Verifiers: the trip a Rule cannot make

A Rule is SQL in a `READ ONLY` transaction under a role that is required not to
have network or filesystem functions, so no Rule will HEAD an object in a bucket
or read a provider back. That check has to run in your process, with your
credentials. It is the same loop every time, so it ships here:

```ts
import { objectExists, recordVerification, VERIFICATION_TABLE_SQL } from '@rhinoq/node';

await pool.query(VERIFICATION_TABLE_SQL);

const outputExists = objectExists({
  head: async ({ bucket, key }) => {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (error) {
      if (error.$metadata?.httpStatusCode === 404) return false;
      throw error;   // anything else is "we could not look", not "it is gone"
    }
  },
});

await recordVerification(pool, 'output-exists', await outputExists({ bucket, key }));
```

`objectExists`, `httpReadBack` and `rowMatches` all return one of three answers
— `present`, `missing`, or `unknown` with a reason. Collapsing `unknown` into
`missing` opens a Finding every time the network hiccups; collapsing it into
`present` is worse, because drift then disappears whenever the check itself is
broken. `recordVerification` writes the answer into `rhinoq_verifications`,
keeping the three timestamps apart, where a Rule can read it.

### Effect Ledger Lite

`RhinoQClient.effect()` is the short path for a provider mutation. Give it a
task or command identity and a JSON request; it derives the idempotency key,
fingerprints the request and delegates the state machine to Go:

```ts
await rhinoq.effect({
  taskId, provider: 'storage', operation: 'upload', commandId: downloadId,
  request: { key: objectKey, size: expectedSize },
  execute: (key) => uploadToStorage(objectKey, { idempotencyKey: key }),
  confirm: (operation) => checkObjectExists(operation),
});
```

The timeout rule is unchanged: unknown is not failed, and a different request
under the same key is rejected by the Go ledger. The full
`providerOperation()` API remains available when a team needs explicit
provider-operation control.

For a provider exposed through HTTP, `httpProviderAdapter()` injects the
ledger's idempotency key and requires the application to supply read-back
confirmation. A non-2xx response is kept fail-closed; it is not an automatic
permission to repeat a mutation:

```ts
await rhinoq.providerOperation({
  name: 'billing.refund', idempotencyKey,
  ...httpProviderAdapter({
    request: (key) => ({ input: refundUrl, init: { method: 'POST', body, headers } }),
    parse: (response) => response.json(),
    confirm: (operation) => readRefundBack(operation),
  }),
});
```

Node.js support has two deliberately separate paths:

- `PostgresProducer` enqueues through the application's existing PostgreSQL
  connection. It needs no Gateway and can join the application's transaction.
- `RhinoQWorker` runs Node handlers through the optional RhinoQ HTTP Gateway.
  The Go engine remains responsible for ordering, leases, fencing, retries and
  Effect Ledger transitions.

This package is a development preview. The beta.15 release workflow publishes
the prerelease on `next`; `latest` may remain on an older release. Pin an exact
version after publication if that matters to you. The preview targets Node.js
22+.

The package ships both an ESM and a CommonJS build, so a NestJS application —
which still compiles to CommonJS by default — can `require('@rhinoq/node')` in
a constructor instead of routing every touch point through `await import()`.
Types are shared by both entry points.

## Build and install the preview

From the repository:

```bash
cd sdks/node
npm ci                 # install exactly what package-lock.json records
npm run typecheck      # check TypeScript without producing dist/
npm test               # build dist/ and run the SDK tests
npm run pack:check     # show the files that would enter the package
npm run pack           # rebuild, drop earlier archives, create the .tgz
```

Install the resulting archive and your PostgreSQL driver in the target
application:

```bash
npm install /absolute/path/to/rhinoq-node-0.1.0-beta.15.tgz pg
```

#### Confirm what the application actually installed

An archive's filename carries its version and nothing else. Source moves on
beneath it, and an archive packed before a feature landed keeps installing
cleanly under a version that implies the feature is present — the version
number matching proves nothing. Every build therefore stamps
`dist/build-info.json` with a hash of the source it came from, and one command
compares it against this checkout:

```bash
npm run verify:installed -- /absolute/path/to/the-application
```

Use `npm run pack` rather than `npm pack` directly: it removes earlier archives
first, so a stale one cannot be picked up by a path that still names it.

For an application evaluation without a source checkout, install from npm and
pin the exact version rather than a moving tag:

```bash
npm install @rhinoq/node@0.1.0-beta.15 pg
```

A published copy carries the same provenance a locally packed one does. It is
not in the `exports` map, so read it by path:

```bash
node -p "require('./node_modules/@rhinoq/node/dist/build-info.json')"
```

## Fastest Task-only setup

```bash
RHINOQ_DATABASE_URL='postgres://...' npx rhinoq-task
```

This creates the isolated Task tables in `rhinoq_task`, including durable
waitpoints, not the native runtime or Verified Tasks tables. The application
reuses its pool:

```ts
import { installPostgresTaskProfile } from '@rhinoq/node';

const tasks = await installPostgresTaskProfile(pool);
```

No Gateway, Go toolchain or RhinoQ credential is involved. Use
`createTaskRequestHandler()` behind the application's existing authentication
and `ApplicationTaskClient` in the browser; the operator token never enters
this path.

### Standard BullMQ integration

For a BullMQ application, start with the preset. It installs the Task profile,
uses `queue.name` as the runtime scope, acquires projector/reconciliation
leases and reads only jobs already referenced by RhinoQ:

```ts
import { createBullMQIntegration } from '@rhinoq/node';

const rhinoq = await createBullMQIntegration({
  pool, queue, events: queueEvents,
  mode: 'single', // use 'fanout' when one Task owns several jobs
});
await rhinoq.start();
```

For NestJS, the same package exposes lifecycle wiring through a versioned
subpath; no separate `@rhinoq/nest` installation is required:

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

The module starts the bridge only after the async factory and Task schema are
ready. A process that does not own the projector lease stays unowned and does
not subscribe to `QueueEvents`; a lost session is reported as degraded. This
is orchestration, not a second Task state machine: transitions continue to be
decided by the versioned PostgreSQL commands.

### Complete application and React slice

`createTaskRequestHandler()` mounts owner-scoped list, detail, execution
history, cancel, command-identified retry, authorized result and health routes.
Pair it with `signedResult()` so durable storage references become short-lived
URLs only with authenticated owner context.

`createUseRhinoTasks(React)` provides the inbox. `createUseRhinoTask(React)`
also exposes `retry`, `downloadResult`, `listAttempts`, `canCancel`, `canRetry`
and `attentionReason`. `taskUIModel()` is the headless progress/result/cancel
contract. Its `explanation` gives every UI a plain-language `headline`,
`explanation`, `progressText`, `retrySafety` (`safe`, `unsafe` or `review`) and
an optional `recommendedAction`. Generic failure and partial-failure states are
review-before-retry; only explicit effect evidence should upgrade that answer.
`mountRhinoTaskCenter()` is a dependency-free reference UI with a notification
callback that can map to the host toast system.

The self-contained Task Center also serves `/task-center/{taskId}` with the
owner-facing summary, cancellation guidance and attempt timeline. The owner API
publishes UI support at `GET /tasks/_capabilities`; retry and result controls
stay hidden until `retryTask` and `resolveResult` are configured. Without a
resolver, `GET /tasks/{id}/result` returns
`RHINOQ_RESULT_NOT_CONFIGURED` instead of exposing the stored reference.
Task detail reads the lightweight Summary plus the first bounded Execution page;
large histories continue through the existing cursor API rather than loading an
unbounded Snapshot.

The reference page also provides client-side search, attention/active/finished
filters and updated-time/task-name sorting over the bounded owner inbox page.
The selected controls live in `?q=`, `?view=` and `?sort=`, making useful views
bookmarkable while keeping authorization and Task selection on the server. Task
detail distinguishes result availability, cancellation posture and recorded
verification uncertainty; “completed” is never relabelled “verified”.
Attempt history initially reads 100 rows and continues through the cursor-backed
“Load more attempts” control instead of asking the owner to call the API manually.

`GET /tasks/{id}/waitpoints?limit=100` and
`ApplicationTaskClient.listTaskWaitpoints()` expose a bounded owner-scoped view
of durable requests. The reference detail page resolves approval waitpoints with
their `entityVersion` and deterministic `resolutionId`. Generic input remains in
the host application's typed form, and webhook waits remain external/read-only;
the reference UI does not guess either payload.
`GET /tasks/_waitpoints?limit=50` and
`ApplicationTaskClient.listWaitingTaskWaitpoints()` provide the corresponding
bounded owner inbox without reading every Task separately. Host UIs can keep
webhook waits in a separate system-owned view.

`integration.defineTask({ type, jobName, mode })` removes repeated Task,
Execution, runtime and stable job-id wiring. `bullMQCancellation()` removes
queued jobs and refuses to claim an active job was cancelled without a durable
cooperative acknowledgement.

Nest adoption accepts repeated per-queue declarations such as
`--task mail-queue=mail.send:single`. The generated module exports
`RHINOQ_TASK_MANIFEST`, uses each queue's cardinality and warns about detected
queues left uncovered. Preview/apply locates raw `queue.add()` calls by file and
line. Once the app is running, `rhinoq adopt --verify-url` checks health and the
Task Center; authenticated applications pass headers through the
`RHINOQ_ADOPT_VERIFY_HEADERS` JSON environment variable.

The retry route intentionally does not turn `queue.add()` into a durable
command. Its application callback must atomically persist command identity and
the Task transition plus an outbox/enqueue intent. Never retry an `uncertain`
provider effect blindly.

For the Go-owned retry outbox, mount
`createBullMQRetryDispatchHandler({ secret, queues })` on an internal POST
route. Pass the raw request bytes to the returned Fetch handler. It verifies
the HMAC signature, accepts only `task.retry.dispatch_requested`, refuses queue
names outside the supplied registry, checks for an existing BullMQ job and
enqueues with the immutable `executionId` as `jobId`. Configure the Go Agent
with `RHINOQ_RETRY_DISPATCH_URL` and the same
`RHINOQ_RETRY_DISPATCH_SECRET`.

For large fan-outs, poll `getTaskSummary()` and load attempts with
`listTaskExecutions(taskId, cursor, limit)`. `TaskStore` selects the summary
automatically when the supplied browser client supports it. `getTask()` remains
compatible but includes every Execution and therefore grows with the batch.

### Projection failure inbox

The bridge can write the application-owned `rhinoq_projection_failures` table
through `PostgresProjectionFailureSink`. The source checkout now also exports
`PostgresProjectionFailureInbox`: list failures, claim one with a lease, replay
through the application's runtime adapter, then mark it `replayed`, schedule
another attempt or `ignored`. `replayProjectionFailure()` fails closed when the
lease is lost after the callback, so a network error is never turned into a
blind second replay. Apply `PROJECTION_FAILURE_TABLE_SQL` for a new table or
`PROJECTION_FAILURE_TABLE_MIGRATION_SQL` for the original sink-only shape.

### Mounting the Task routes

`createTaskRequestHandler()` is Fetch-compatible, which is the right shape for
Next.js route handlers, Hono and Deno. Express, Fastify and NestJS need a
translation, and all three share one trap: **their wildcard does not match the
bare collection path**. Registering only `/tasks/*` loses `listTasks` and the
only symptom is a 404.

`createNodeTaskMiddleware()` and `registerFastifyTaskRoutes()` cover both paths
so the second route is not something to rediscover.

```ts
// Express — one mount, both routes.
import express from 'express';
import { createNodeTaskMiddleware } from '@rhinoq/node';

const app = express();
app.use(express.json());
app.use(createNodeTaskMiddleware({
  tasks,
  ownerFromRequest: (request) => authenticate(request),
}));
```

The middleware calls `next()` for any path outside `basePath`, so it composes
with the application's other routes. Mounting it under a prefix
(`app.use('/api', middleware)`) works too: it reads Express's `originalUrl`, so
`basePath` stays the full public path.

```ts
// Fastify — both patterns registered for you.
import { registerFastifyTaskRoutes } from '@rhinoq/node';

registerFastifyTaskRoutes(fastify, {
  tasks,
  ownerFromRequest: (request) => authenticate(request),
});
```

```ts
// NestJS (Express platform) — the same middleware, no controller needed.
export class TaskModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(createNodeTaskMiddleware({ tasks, ownerFromRequest }))
      .forRoutes('*');
  }
}
```

Registering the routes by hand is still fine — `taskRoutePatterns(basePath)`
returns the two patterns in the order a router must declare them:

```ts
const [collection, items] = taskRoutePatterns('/tasks'); // ['/tasks', '/tasks/*']
```

Both adapters accept a body that a JSON parser has already consumed, so
`express.json()` or Fastify's built-in parser does not hang the cancel route.

### Initialising under a DI framework

`installPostgresTaskProfile()` is async. Under NestJS, InversifyJS or any
container that constructs eagerly, that creates a window in which the RhinoQ
client exists as a field but is not usable yet.

The failure is quiet. A consumer built in the same tick reads the half-built
provider, decides RhinoQ is not configured, and disables its own bridge — the
application starts, logs nothing, and simply stops projecting.

Do not initialise in `onModuleInit` while other providers read the value from
their constructor:

```ts
// Wrong: TaskConsumer is constructed before onModuleInit resolves.
@Injectable()
export class RhinoQService implements OnModuleInit {
  tasks?: PostgresTaskClient;
  async onModuleInit() {
    this.tasks = await installPostgresTaskProfile(this.pool);
  }
}
```

Use an async factory provider instead. The container awaits it and injects
nothing until it settles, so there is no half-built state to read:

```ts
@Module({
  providers: [{
    provide: 'RHINOQ_TASKS',
    inject: [Pool],
    useFactory: (pool: Pool) => installPostgresTaskProfile(pool),
  }],
  exports: ['RHINOQ_TASKS'],
})
export class RhinoQModule {}
```

The same rule applies to `BullMQTaskBridge`: build it in a factory that
depends on `RHINOQ_TASKS`, so the bridge and its scope registration happen once
the client is real. If a readiness flag is unavoidable, make the unready state
**throw** rather than read as "disabled" — a startup crash is recoverable, a
silently disabled bridge is not noticed until someone asks where the Tasks went.

### Notification destinations from Node

`npx rhinoq notify` reads and writes the same `.rhinoq/notifications.json` the
Go CLI uses, so a Node team can configure and prove a destination without
building a `NotificationDestination` in Go and embedding it — which was the
only path before, and not one a Node team has.

```bash
npx rhinoq notify add ops \
  --webhook https://example.com/hooks/rhinoq \
  --secret-env RHINOQ_NOTIFY_SECRET_OPS
npx rhinoq notify test ops
npx rhinoq notify list --json
npx rhinoq notify remove ops
```

The registry never stores a secret. An entry records the **name** of an
environment variable and the value is read at send time, so a leaked registry
is a list of URLs rather than a set of working credentials. `notify list`
redacts URL paths, because a Slack incoming-webhook URL *is* the credential.

`notify test` sends one synthetic signed event and writes nothing — no Finding,
no delivery record. It answers "is this reachable and does the receiver verify
my signature" without inventing a fake Finding somebody then has to triage.

A configured-but-empty `--secret-env` variable refuses the send. Falling back
to unsigned would silently weaken a destination somebody chose to sign.

`notify send` is **Go-only**. A real Finding delivery is recorded in the
durable delivery ledger, and reimplementing that deduplication in TypeScript
would put correctness in two languages. The Node CLI refuses and names the Go
command.

The payload is pinned to the Go engine's by
[`tests/contract`](https://github.com/madebyduy/RhinoQ/blob/main/tests/contract/README.md),
so one receiver implementation works for events sent from either language.

### Metrics and health without a Gateway

The Gateway exposes `/metrics` and `/healthz`. An application on the embedded
PostgreSQL Task client has no Gateway, so it had no equivalent.

```ts
import { TaskMetrics, checkEmbeddedHealth, TASK_SCHEMA_VERSION } from '@rhinoq/node';

const metrics = new TaskMetrics();
const bridge = new BullMQTaskBridge({ client, events, terminalProjection, metrics });

app.get('/metrics', (_req, res) => res.type('text/plain').send(metrics.render()));
app.get('/healthz', async (_req, res) => {
  const health = await checkEmbeddedHealth(pool, TASK_SCHEMA_VERSION);
  res.status(health.status === 'ok' ? 200 : 503).json(health);
});
```

The bridge counts projected events, version conflicts and — the one that
matters — projections that threw. A listener failure is otherwise invisible,
because nothing awaits that promise; a bridge that has quietly stopped
projecting looks identical to an idle one.

`checkEmbeddedHealth` reports rather than throws, and separates `down` (the
database is unreachable) from `degraded` (the Task schema is a version behind).
Those are different pages: one is an outage, the other is a migration.

**These are counters only.** There is no latency, rate or percentile, and that
is deliberate rather than unfinished: shipping a p99 gauge would publish a
performance number without the benchmark behind it, which RhinoQ's Definition
of Done forbids. Measured figures and their limits live in
[Benchmarks](https://github.com/madebyduy/RhinoQ/blob/main/docs/benchmarks.md).

Check the [release guide](https://github.com/madebyduy/RhinoQ/blob/main/docs/releasing.md)
for the authoritative publication state and the trusted-publishing setup.

## Choose one integration path

| Need | API | Gateway required |
|---|---|:---:|
| enqueue through the application's PostgreSQL pool | `PostgresProducer` | No |
| enqueue in the current business transaction | `PostgresProducer` with `PoolClient` | No |
| run JavaScript/TypeScript handlers | `RhinoQWorker` | Yes |
| inspect, pause, cancel, replay or triage | `RhinoQClient` | Yes |
| create, update or poll a Task snapshot | `PostgresTaskClient` | No |
| standard existing BullMQ integration | `createBullMQIntegration()` | No |
| reserve and dispatch a BullMQ job as a Task | `BullMQTaskBridge.dispatch()` | No |
| reserve a bounded BullMQ fan-out | `BullMQTaskBridge.dispatchMany()` | No |
| mirror a job through the legacy full platform | `BullMQTaskBridge` + `RhinoQClient` | Yes |

## Task polling

```ts
const task = await client.createTask({
  id: "report_01",
  type: "report.export",
  definitionVersion: 1,
});

const withExecution = await client.createTaskExecution(task.id, {
  id: "exec_01",
  runtime: "bullmq",
});
const bound = await client.bindTaskExecution("exec_01", {
  runtime: "bullmq",
  externalId: "bull_job_01",
});
const queued = await client.transitionTask(
  bound.id,
  bound.entityVersion,
  "queued",
);
const latest = await client.getTask(queued.id);
const result = await client.attachTaskResult(
  latest.id,
  latest.entityVersion,
  "s3://reports/report_01.pdf",
);
```

Use `entityVersion` as the optimistic write precondition and ignore a polling
response older than the highest version already rendered.
Result methods exchange a reference only; downloading or authorizing the
payload remains the application's responsibility.

### Watch a Task without framework lock-in

`watchTask()` is available in `beta.2` and later. It polls immediately,
serializes requests and yields only a strictly newer `entityVersion`. Terminal
Tasks stop the iterator by default.

```ts
import { watchTask } from '@rhinoq/node';

const stopping = new AbortController();

for await (const snapshot of watchTask(client, 'report_01', {
  pollIntervalMs: 1_000,
  signal: stopping.signal,
})) {
  renderTask(snapshot);
}
```

An HTTP/authentication error is thrown to the caller instead of being hidden.
Set `stopOnTerminal: false` only for a mounted history view. This helper does
not add React state, SSE, WebSocket or Redis.

For a mounted browser view use the framework-neutral `TaskStore`. Its
`subscribe()` and `getSnapshot()` methods fit React `useSyncExternalStore`; it
also exposes reconnect state, bounded backoff, `cancel()` and `getResult()`:

```ts
const store = new TaskStore(applicationTaskClient, taskId);
const unsubscribe = store.subscribe(render);
store.start();
// On unmount: unsubscribe(); store.stop();
```

React applications can create the hook once without adding another RhinoQ
package or duplicating React in the dependency graph:

```ts
import * as React from 'react';
import { createUseRhinoTask } from '@rhinoq/node';

export const useRhinoTask = createUseRhinoTask(React);

function TaskProgress({ client, taskId }) {
  const { snapshot, status, cancel } = useRhinoTask(client, taskId);
  return <button onClick={() => void cancel()}>
    {snapshot?.progress.completed ?? 0} · {status}
  </button>;
}
```

After wiring the application-owned endpoint, check it without mutating state:

```bash
RHINOQ_TASK_HEADERS_JSON='{"authorization":"Bearer app-session"}' \
  npx rhinoq-task-check http://localhost:3000/tasks report_01
```

## BullMQ lifecycle bridge (V1)

Use this only after the application has added its own BullMQ job. The bridge
does not import BullMQ, enqueue work, own the Redis connection or rewrite a
worker; pass the application's `QueueEvents` instance and call `track()` beside
the application's `queue.add()` call.

```ts
import { BullMQTaskBridge, RhinoQClient } from '@rhinoq/node';
import { Queue, QueueEvents } from 'bullmq';

const queue = new Queue('reports', { connection });
const events = new QueueEvents('reports', { connection });
const bridge = new BullMQTaskBridge({
  client,
  events,
  // One job is the whole Task here. See the fan-out section below.
  terminalProjection: 'single-execution',
});

const job = await queue.add('generate-report', { reportId: 'report_01' });
await bridge.track({
  task: { id: 'report_01', type: 'report.export', definitionVersion: 1 },
  executionId: 'report_01:attempt:1',
  jobId: job.id!,
});
```

The bridge projects `waiting`, `active`, `progress`, `completed` and a failure
that the application explicitly classifies as terminal. It is restart-safe for
a repeated `track()` call because it looks up the durable runtime/external-ID
binding. It re-reads a bounded number of times after a Gateway optimistic
version conflict, then reports the error rather than dropping the event. After
an offline gap, read a known job from the application's BullMQ
Queue and reconcile that one observation:

```ts
const state = await job.getState();
if (state === 'waiting' || state === 'active' || state === 'completed') {
  await bridge.reconcile({ jobId: job.id!, state });
}
```

For a terminal failure, pass `terminal: true` only after the application has
checked BullMQ's retry policy/attempts. The bridge dispatches only through an
application-supplied Queue and reconciles only application-supplied jobs. It
does not discover/scan a whole queue after downtime or invent retry identity.

When `dispatch()` or `dispatchMany()` receives a BullMQ Queue whose
`defaultJobOptions` has no `attempts`, the bridge emits one warning. This does
not override per-job options; it makes an implicit “no retries by default”
policy visible before a failed job is mistaken for a retried one.

Cancellation is application-owned and fail-closed. Configure `cancelJob` to
remove a waiting job or cooperate with a running worker, then pass the known
job IDs. Return `acknowledged` only after stop is durable; return
`cannot_cancel_safely` when an external effect may already have happened:

```ts
const bridge = new BullMQTaskBridge({
  client, queue, events, runtimeScope: 'reports',
  terminalProjection: 'single-execution',
  cancelJob: async (jobId) => {
    const job = await queue.getJob(jobId);
    if (!job) return { status: 'acknowledged' };
    if (await job.isActive()) return {
      status: 'cannot_cancel_safely',
      reason: 'worker has already started the external effect',
    };
    await job.remove();
    return { status: 'acknowledged' };
  },
});
await bridge.cancel(taskId, [jobId]);
```

#### Collecting the job IDs to cancel

`cancel()` needs the runtime job IDs of every open item, and reading them back
one `getTaskExecution` at a time costs a round trip per item.
`listTaskExecutionRuntimeRefs` answers it in one query:

```ts
const { executions } = await tasks.listTaskExecutionRuntimeRefs(taskId);
const jobIds = executions
  .filter((ref) => ref.state === 'running' || ref.state === 'dispatched')
  .map((ref) => ref.externalId)
  .filter((id): id is string => Boolean(id));

await bridge.cancel(taskId, jobIds);
```

`externalId` is absent until dispatch reserves it, so filter before use — an
attempt that never reached the runtime has no job to stop, and passing
`undefined` would silently shorten the list that `cancel()` treats as complete.

**This is a server-side read and has no owner-scoped variant.** Runtime job
identity is deliberately absent from `TaskSnapshot`, for the same reason the
storage reference is: the snapshot is polled, and `createTaskRequestHandler`
serves it to a browser. Do not add a route for this one.

#### An acknowledged cancellation does not end the Task

`cancel()` records the cancellation *outcome*. It does not move the Task to a
terminal state, and under `aggregate.terminal: 'manual'` — the default —
nothing else does either. After a fully acknowledged cancellation the Task
reads:

```text
state        cancel_requested
cancellation acknowledged
```

and stays there. That is deliberate: `jobIds` is application-supplied, only the
application knows whether those jobs were the whole Task, and a terminal Task
is never reopened. It is also the single most common surprise in this API, so
pick one of these two:

```ts
// 1. Finish it yourself. Works in every mode.
const task = await bridge.cancel(taskId, jobIds);
if (task.cancellation.status === 'acknowledged') {
  await client.transitionTask(task.id, task.entityVersion, 'cancelled');
}
```

```ts
// 2. Let the bridge finish it, when the job list is complete.
const bridge = new BullMQTaskBridge({
  client, events, terminalProjection: 'execution-only',
  cancelJob,
  terminalizeOnCancel: true,
});
```

`terminalizeOnCancel` cancels the named Executions and then the Task — an
acknowledged job that leaves its attempt at `running` is a lie the batch view
keeps telling. It refuses, and warns through `onWarning`, when any other
Execution is still open: an incomplete `jobIds` list would otherwise close a
Task whose remaining items are running.

A Task that already refused the request (`too_late`) is left untouched by both
paths.

`terminalProjection` is required and has no default: only the application knows
whether one BullMQ job is the whole user-facing Task. For a fan-out queue,
`single-execution` would drive the batch to a terminal `succeeded` as soon as
its first item finishes, and a terminal Task is never reopened. Pick
`execution-only` there:

```ts
const bridge = new BullMQTaskBridge({
  client,
  events,
  terminalProjection: 'execution-only',
});
```

In this mode each item still reaches a terminal Execution state. The
application completes/fails the parent Task only when its aggregate business
outcome is known — including after a crash between the last item and that call.
The bridge refuses to guess: constructing it without `terminalProjection`
throws.

### One bridge per `runtimeScope`

A bridge subscribes to `QueueEvents`. Two bridges on the same `runtimeScope`
therefore see every job event twice and contend for the same Task version.
RhinoQ fails fast when it can see a duplicate in the same process. Across
processes, use the PostgreSQL advisory-lock lease shown below.

The rule is one live bridge per scope. Scale by giving each queue its own
`runtimeScope`, not by running the same scope in six replicas.

Constructing a second bridge with a scope already live **in this process**
throws before subscribing. Across processes each process has its own memory, so
the in-process check is not enough for a six-replica deployment.

```ts
new BullMQTaskBridge({
  client, events, runtimeScope: 'reports',
  terminalProjection: 'single-execution',
  // Explicitly acknowledge duplicate projection when this is intentional.
  allowConcurrentBridges: true,
});
```

For multiple processes, hold a database-backed owner lease before subscribing:

```ts
import { PostgresProjectorLease } from '@rhinoq/node';

const bridge = new BullMQTaskBridge({
  client, events, runtimeScope: 'reports',
  terminalProjection: 'single-execution',
  projectorLease: new PostgresProjectorLease(pool, 'reports'),
});
await bridge.start(); // only the lock holder subscribes to QueueEvents
```

`PostgresProjectorLease` uses a session advisory lock, adds no table to the
three-table Task profile, and releases ownership when its database session
ends. `allowConcurrentBridges` (or `RHINOQ_ALLOW_CONCURRENT_BRIDGES=1`) is an
explicit escape hatch; it does not provide ownership or improve correctness.

The session ending is the case worth planning for. A failover, a restart or a
`pg_terminate_backend` drops the lock in the database while this process still
holds a connection object and keeps projecting — and the next process to call
`start()` is told, correctly, that nobody owns the scope. Two projectors, each
believing it is the only one, is what the lease exists to prevent.

The bridge therefore re-checks ownership every 15 seconds
(`leaseVerifyIntervalMs`, `0` disables it). On loss it unsubscribes, stops
projecting, increments `rhinoq_bridge_lease_lost_total`, warns, and calls
`onLeaseLost`:

```ts
const bridge = new BullMQTaskBridge({
  client, events, runtimeScope: 'reports',
  terminalProjection: 'single-execution',
  projectorLease: new PostgresProjectorLease(pool, 'reports'),
  onLeaseLost: () => process.exit(1),   // let the orchestrator restart it
});
```

Events produced while nobody owned the scope are not replayed. Run
`TaskReconciler` after a takeover before trusting the aggregate.

A custom lease that does not implement `verify()` cannot report this, and the
bridge warns at `start()` rather than pretending the check happened.

**PgBouncer in transaction mode breaks this**, along with every other session
advisory lock: the lock and the queries that rely on it can land on different
backends. Give the lease a direct connection or a session-mode pool.

`close()` releases the scope, so a rolling replacement — construct the new
bridge after closing the old one — does not warn.

When the application owns enqueueing through the bridge, `dispatchMany()`
reserves the complete item set before the first `Queue.add`. Reservation and
enqueue pressure are bounded by `dispatchConcurrency` (default `8`, valid
`1..64`). Duplicate job/Execution IDs or inconsistent Task definitions fail
before any side effect. On a partial Queue outage the bridge drains its bounded
workers before returning; repeat the same deterministic IDs to recover.
Executions already past `pending_dispatch` are not sent to `Queue.add` again,
and concurrent callers converge if one wins the durable bind.

#### `itemKey` is the idempotency key

`itemKey` decides whether two Executions are *the same work, retried* or *two
different things*. Attempts are numbered per `itemKey`, and the aggregate counts
one item per key.

Omitting it stores the key `default`. That is correct for a Task that is one
item, and wrong for every fan-out:

```text
50 items, no itemKey  →  attempts 1..50 of one item
                      →  aggregate reads { completed: 1, total: 1 }
                      →  all-succeeded terminates on the first finish
```

A terminal Task is never reopened, so that is unrecoverable and silent.
`dispatchMany` therefore requires an `itemKey` on every item and refuses
duplicates within a batch, before any durable or Queue work happens.

Use the business identity of the item — an invoice number, a row ID. It must be
the same across retries of that item and different for every other item:

```ts
await bridge.dispatchMany(files.map((file) => ({
  task,
  itemKey: file.id,               // stable across retries of this file
  executionId: `${task.id}:${file.id}`,
  // Not `:` — BullMQ rejects a custom job ID containing one unless it splits
  // into exactly three parts. executionId is RhinoQ's own and is unaffected.
  jobId: `${task.id}__${file.id}`,
  job: { name: 'transcode', data: { key: file.storageKey } },
})));
```

**Pick a value you are willing to poll.** `itemKey` and `executionId` both
appear on `TaskSnapshot`, which `createTaskRequestHandler` serves to a browser
and which a UI re-reads every second. That is the same payload the storage
reference is deliberately kept out of — `hasResult` is a boolean and the
location is read once through `getTaskExecutionResults` — so a storage key,
signed URL or file path used as the item identity defeats that separation. The
job payload is a different matter: it never enters a snapshot.

`track()` and `dispatch()` accept an omitted `itemKey` for a single-item Task.
`track()` refuses a second job without a key once the Task already has an
unkeyed item, because silently turning that job into attempt 2 of `default`
would corrupt the batch total. Give every fan-out item a stable key or use
`dispatchMany()`.

#### Transactional application effects

When a BullMQ retry must not write the same business row twice, use the
embedded client’s transaction gate:

```ts
const result = await tasks.onceForItem(executionId, 'deduct-credits', async (tx) => {
  await tx.query('INSERT INTO credit_logs (item_id) VALUES ($1)', [itemId]);
  return 'written';
});
```

The claim is stored through `rhinoq_task.claim_item_effect` and is checked
across all attempts for that `itemKey`. The callback must use the supplied
connection. A committed repeat returns `{ executed: false }`; a callback
failure rolls back the claim. This is for writes in the same PostgreSQL
transaction, not for external provider calls; those still require
ProviderOperation and an idempotency/confirmation policy.

**`itemKey` requires the embedded PostgreSQL client.** The Gateway profile
stores Executions as unique per `(task, attempt)`, with no column for the item,
so it discards the key and numbers attempts per Task instead — which is the
`50 items, no itemKey` failure above, arriving through a different door.
`RhinoQClient.createTaskExecution` warns the first time it sees an `itemKey`,
but a warning is not a guarantee: choose the embedded client when a Task fans
out. The full comparison is in
[`docs/feature-matrix.md`](../../docs/feature-matrix.md).

#### A retry of an external job is a new attempt

BullMQ reuses its job ID across retries. The first attempt was already terminal
by the time the retry went active, the Execution state machine refused the
move, and the second run left no record at all — `attempt` never advanced past
1 for any external runtime.

The bridge now supersedes the finished attempt and opens the next one for the
same `itemKey`. The previous row keeps its outcome and its reason, which is the
answer to the only question anyone asks about a retried job:

```text
item-a  attempt 1  failed     "upstream returned 502"
item-a  attempt 2  succeeded
```

`lookupTaskExecution` returns the live attempt; superseded rows are history and
never come back as current. The aggregate counts one item per `itemKey`, so a
retried item is still one item.

Every BullMQ `failed` event closes the current RhinoQ Execution attempt.
`isTerminalFailure` only decides whether that failure also ends the user-facing
Task, so a `failed` → `active` sequence keeps its retry history. If a restart
missed both events, pass the one-based runtime attempt in a reconciliation
observation; the bridge closes the missing attempt before opening the current
one.

Set `retryProjection: 'ignore'` to restore the old silent behaviour — needed
while rolling the Task schema back past v4, where the retry row cannot exist.
`retryExecutionId` overrides the default `<previous id>#<attempt>`, which is
deterministic so a repeated projection converges instead of forking.

This needs the embedded PostgreSQL client. The Gateway client owns attempt
identity for the runtimes it runs itself; the bridge says so once rather than
silently never recording a retry.

#### "Every item finished", delivered once

`aggregate.progress: 'terminal-items'` writes progress on every completion.
The single moment the batch became complete is a different question, and every
adopter answered it in application code as *did I just see the last one?* —
which is wrong the moment two workers finish concurrently or an event is
re-delivered.

```ts
const bridge = new BullMQTaskBridge({
  client, events, terminalProjection: 'execution-only',
  aggregate: { progress: 'terminal-items', terminal: 'manual' },
  onItemsSettled: async (task) => {
    await emailTheUser(task.ownerId, task.id);
  },
});
```

Exactly-once is decided by one SQL statement, not by this process, so it
survives a crash, a re-delivered event and several bridges. A stalled attempt
blocks it: calling a batch complete while one item is stuck is the failure this
replaces.

#### Finding Tasks that stopped moving

```ts
const stuck = await tasks.listTasksByState({
  states: ['running'],
  idleForMs: 60 * 60_000,
  itemsSettled: false,
  limit: 100,
});
```

`idleForMs` filters `updated_at`, not `created_at`: a Task still making
progress is not stuck, however long it has been going.

`TaskReconciler` runs that query on a schedule and hands each result to a
callback. With the embedded client, `reconcileTask()` reads the latest runtime
reference for each item in one bounded query, so the application does not need
a second Task-to-job table:

```ts
const reconciler = new TaskReconciler({
  tasks,
  query: { states: ['running'], idleForMs: 60 * 60_000 },
  everyMs: 5 * 60_000,
  reconcile: async (task) => bridge.reconcileTask(task.id, async (ref) => {
    const job = await queue.getJob(ref.externalId!);
    if (!job) return undefined;
    return {
      jobId: job.id!,
      state: await job.getState(),
      attempt: job.attemptsMade + 1,
      terminal: job.failedReason !== undefined &&
        job.attemptsMade >= (job.opts.attempts ?? 1) - 1,
    };
  }),
  onError: (error, task) => logger.error({ error, taskId: task?.id }),
});
reconciler.start();
```

`bridge.reconcile()` has existed since beta.3 and nothing ever called it on a
schedule, so a batch stuck at `running` — a bridge that died mid-projection, a
worker killed between the last item and the aggregate call — stayed stuck until
a human noticed.

This is **not** a distributed scheduler. It is a timer in one process. Several
processes running it is safe but wasteful: each does the same read and calls
`reconcile` for the same Tasks, so the callback must be idempotent. The
QueueEvents projector itself should have one owner per scope; use
`PostgresProjectorLease` for cross-process ownership. One failing Task never
aborts the sweep, and a sweep still running when the next tick arrives skips
rather than overlapping.

#### A failed projection that survives the process

`onError` fires once, in the process that failed — and that process is often
being killed, because the reason the projection failed is frequently the reason
the process is going away. The event is then gone and nothing knows the job
ever happened.

```ts
import { PostgresProjectionFailureSink } from '@rhinoq/node';

const bridge = new BullMQTaskBridge({
  client, events, terminalProjection: 'single-execution',
  projectionFailures: new PostgresProjectionFailureSink(pool),
});
```

The sink is application-owned on purpose: the Task-only profile keeps its
authoritative tables isolated, replaying a projection is a business decision, and the
row belongs beside whatever the job was doing.
Apply `PROJECTION_FAILURE_TABLE_SQL` through the application's migration, then
use `PostgresProjectionFailureSink` as above. It performs the parameterized,
idempotent upsert; `InMemoryProjectionFailureSink` is for tests and says out
loud that it is not durable. Use the application's scheduled reconciliation
callback to read the runtime and retry with its own backoff policy — the SDK
does not scan or mutate an application-owned queue automatically.

Recording happens **before** `onError`, and the record must be idempotent on
`(runtime, runtimeScope, externalId, event)` — the same projection can fail
repeatedly, and a sink that inserts a row each time turns one broken job into
an unbounded table.

The current Task Snapshot includes every Execution summary. For large batches,
run `npm run benchmark:postgres` with `RHINOQ_BENCH_FANOUT_SIZES` before choosing
a batch size; bounded dispatch does not make an unbounded snapshot free.

Each item also carries its own outcome, so a batch view does not need a
parallel per-item store:

```ts
const bridge = new BullMQTaskBridge({
  client,
  events,
  terminalProjection: 'execution-only',
  // Recorded on the Execution that produced it.
  resultReference: async (event) => event.returnvalue?.s3Key,
  // Defaults to BullMQ's failedReason; return undefined to record none.
  failureReason: (event) => event.failedReason,
});

// Storage references never travel in the polled snapshot. Read them once,
// when the user opens the batch:
const { executions } = await client.getTaskExecutionResults(taskId);
```

`TaskSnapshot` exposes `hasResult` and `failureReason` per execution so the
list can render without a second call; only the references themselves require
`getTaskExecutionResults`, which is owner-scoped like the Task result.

## Operator Workbench

The Go `rhinoq workbench` needs the full engine schema and a process of its own.
An application on the three-table Task profile had neither, which meant the
quickest way to adopt RhinoQ was also the one with nothing to look at.

`createWorkbenchHandler` is the same Fetch shape as `createTaskRequestHandler`,
so it mounts on the application's own server — no extra process, no Go
toolchain, no new table:

```ts
import { createNodeWorkbenchMiddleware } from '@rhinoq/node';

app.use(createNodeWorkbenchMiddleware({
  tasks,
  requireOperator: (request) => isOperator(request),
  basePath: '/admin/rhinoq',
  navigation: { overviewPath: '/', tasksPath: '/task-center' },
}));
```

It shows Task counts by state, the list behind each one, and — per Task — every
item with its attempt number, state, runtime job ID and failure reason.
Selecting a Task writes `?task={id}` into browser history, so a detail can be
linked directly and Back/Forward preserves operator context.

### It is not the owner-scoped API

`requireOperator` is required and has no default. This console reads **across
owners** and shows **runtime job identity**, both of which the owner-scoped
routes deliberately withhold. Mount it on an internal route, behind operator
authentication, and never expose it to end users. A gate that throws is a
refusal, and the reason never reaches the response.

`actions` is off by default. A console that can only look is a different risk
from one that can cancel, and that should be a decision rather than something
inherited. With it on, cancellation still carries the `entityVersion` fence.

### Realtime, without a reload

`GET {basePath}/api/stream` is a server-sent event stream. The server re-reads
the store every second (`streamIntervalMs`) and writes **only when something
changed**; an idle console costs one keep-alive comment. A batch moving through
its items updates in place, and rows that changed flash once.

The page shows skeletons until the first payload arrives, so "loading" never
looks like "nothing there", and a status dot reports `live`, `reconnecting`,
`polling` or `disconnected`.

Use `createNodeWorkbenchMiddleware`, not `createNodeTaskMiddleware`, for the
Express/NestJS mount. The Task middleware finishes a response with
`await result.text()` — correct for JSON, and for a stream that never finishes
it means the request hangs instead of failing. The Workbench middleware pumps
the body instead.

If the mount still cannot stream, the page falls back to polling on its own:
after three connection errors, or after eight seconds with the stream open and
nothing delivered, which is what a buffering proxy looks like from the browser.
The status reads `polling` in that case. Behind Nginx the handler already sends
`X-Accel-Buffering: no`; without it the stream is buffered and the console
looks frozen.

## Owner-scoped Task client

Keep the operator/runtime token in backend workers. A browser-facing backend
may use a separately configured owner token for polling and cancellation:

```ts
const taskClient = new RhinoQClient({
  url: 'http://127.0.0.1:8080',
  token: process.env.RHINOQ_TASK_OWNER_TOKEN,
});

const task = await taskClient.getTask(taskId);
await taskClient.requestTaskCancellation(task.id, task.entityVersion);
```

An owner token cannot read another owner's Task/result, call queue/operator
APIs or use the generic state transition endpoint. RhinoQ does not yet model
organizations, roles or membership; do not expose a Task Center directly
without the application's own authentication and authorization.
Configure the Gateway's `RHINOQ_TASK_CREDENTIALS_JSON` as an array of
`{"ownerId":"...","token":"..."}` objects with random tokens of at least
32 bytes; never bundle those tokens into browser JavaScript.

## Producer-only

```ts
import pg from 'pg';
import { PostgresProducer } from '@rhinoq/node';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});
const producer = new PostgresProducer({
  query: (text, values) => pool.query(text, values),
});

const jobId = await producer.enqueue({
  name: 'generate-report',
  payload: { reportId: 'report_01' },
  idempotencyKey: 'report:report_01',
  correlationId: 'report_01',
});
```

Pass a checked-out `PoolClient` instead of the pool when the business write and
job must commit atomically.

`enqueue()` resolves when the job intent commits. It does not mean the handler
ran or that the business outcome was achieved.

## Node worker

```ts
import {
  RhinoQClient,
  RhinoQWorker,
  dependencyDown,
} from '@rhinoq/node';

const client = new RhinoQClient({
  url: process.env.RHINOQ_GATEWAY_URL!,
  token: process.env.RHINOQ_GATEWAY_TOKEN,
});

const worker = new RhinoQWorker({
  client,
  name: `reports-${process.pid}`,
  concurrency: 4,
  onError: console.error,
});

worker.handle<{ reportId: string }>('generate-report', async (job) => {
  try {
    await reports.generate(job.data.reportId, { signal: job.signal });
  } catch (error) {
    throw dependencyDown(error);
  }
});

const stopping = new AbortController();
process.once('SIGTERM', () => stopping.abort());
process.once('SIGINT', () => stopping.abort());
await worker.run({ signal: stopping.signal });
```

The worker sends its registered job names with every claim. It cannot take work
for a handler it does not own. On shutdown it stops claiming, keeps heartbeats
alive during the grace period, then cooperatively aborts handlers that overrun.

## Where to find each answer

- [`docs/nodejs.md`](../../docs/nodejs.md): end-to-end installation, every
  repository command, producer/worker/client API reference, environment
  variables, effects and troubleshooting.
- [`docs/cli.md`](../../docs/cli.md): every `rhinoq` command, flag, write
  behavior and example.
- [`docs/agent.md`](../../docs/agent.md): optional Gateway deployment and HTTP
  protocol boundary.
- [`examples/nodejs`](../../examples/nodejs): minimal producer and worker
  processes.
