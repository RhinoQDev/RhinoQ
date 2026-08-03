# RhinoQ for Node.js

Catch background jobs that succeeded technically but failed in the real world.

```bash
npm install https://github.com/madebyduy/RhinoQ/releases/download/v0.1.0-beta.8/rhinoq-node-0.1.0-beta.8.tgz pg
npx rhinoq init
npx rhinoq verify add completed-report-has-output
npx rhinoq doctor
```

The Node `init` path creates the isolated Task profile. `beta.8` is the first
archive that contains the complete Verified Rule loop; an older tarball answers
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

Node.js support has two deliberately separate paths:

- `PostgresProducer` enqueues through the application's existing PostgreSQL
  connection. It needs no Gateway and can join the application's transaction.
- `RhinoQWorker` runs Node handlers through the optional RhinoQ HTTP Gateway.
  The Go engine remains responsible for ordering, leases, fencing, retries and
  Effect Ledger transitions.

This package is a development preview. npm `next` still points to the older
`0.1.0-beta.2`; trusted-publisher permission blocked the beta.5 npm upload.
Use the beta.8 GitHub release archive or a local beta.8 tarball for the current
contract. No prerelease is a production stability promise. The preview targets
Node.js 22+.

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
npm pack               # create rhinoq-node-0.1.0-beta.8.tgz
```

Install the resulting archive and your PostgreSQL driver in the target
application:

```bash
npm install /absolute/path/to/rhinoq-node-0.1.0-beta.8.tgz pg
```

For an application evaluation without a source checkout, pin the release
archive rather than the stale npm `next` tag:

```bash
npm install https://github.com/madebyduy/RhinoQ/releases/download/v0.1.0-beta.8/rhinoq-node-0.1.0-beta.8.tgz pg
```

That beta.8 archive contains the embedded Task profile and BullMQ contracts.
It must not be used as evidence that the current source's Verified Rule CLI is
published; verify an archive with `grep -c "verify apply" package/dist/cli/rhinoq.js`
or build from this checkout.

## Fastest Task-only setup

```bash
RHINOQ_DATABASE_URL='postgres://...' npx rhinoq-task
```

This creates three tables in `rhinoq_task`, not the native runtime or Verified
Tasks tables. The application reuses its pool:

```ts
import { installPostgresTaskProfile } from '@rhinoq/node';

const tasks = await installPostgresTaskProfile(pool);
```

No Gateway, Go toolchain or RhinoQ credential is involved. Use
`createTaskRequestHandler()` behind the application's existing authentication
and `ApplicationTaskClient` in the browser; the operator token never enters
this path.

For large fan-outs, poll `getTaskSummary()` and load attempts with
`listTaskExecutions(taskId, cursor, limit)`. `TaskStore` selects the summary
automatically when the supplied browser client supports it. `getTask()` remains
compatible but includes every Execution and therefore grows with the batch.

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
RhinoQ does not elect a leader between them and will not: coordination belongs
to your deployment, not to a client library.

The rule is one live bridge per scope. Scale by giving each queue its own
`runtimeScope`, not by running the same scope in six replicas.

Constructing a second bridge with a scope already live **in this process**
logs a warning naming the scope. Across processes RhinoQ cannot see the
duplicate at all, so the warning is a floor, not a guarantee — a six-replica
deployment stays silent and still races.

```ts
new BullMQTaskBridge({
  client, events, runtimeScope: 'reports',
  terminalProjection: 'single-execution',
  // Route the warning into your logger instead of console.warn.
  onWarning: (warning) => logger.warn({ warning }),
  // Acknowledge a deliberate duplicate. Changes no behaviour.
  // RHINOQ_ALLOW_CONCURRENT_BRIDGES=1 does the same process-wide.
  allowConcurrentBridges: false,
});
```

Duplicate projection is wasteful rather than corrupting: every write carries an
expected version and the second bridge finds the target state already reached.
That is why this warns instead of throwing. It still doubles the round trips
and can spend the bridge's version-convergence budget under load.

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
