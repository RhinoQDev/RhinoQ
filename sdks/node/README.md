# RhinoQ for Node.js

Node.js support has two deliberately separate paths:

- `PostgresProducer` enqueues through the application's existing PostgreSQL
  connection. It needs no Gateway and can join the application's transaction.
- `RhinoQWorker` runs Node handlers through the optional RhinoQ HTTP Gateway.
  The Go engine remains responsible for ordering, leases, fencing, retries and
  Effect Ledger transitions.

This package is a development preview. `@rhinoq/node@0.1.0-beta.1` is publicly
available as the first evaluation prerelease; pin that explicit version rather
than depending on a floating dist-tag. It is not a production stability
promise. The preview targets ESM on Node.js 22+.

## Build and install the preview

From the repository:

```bash
cd sdks/node
npm ci                 # install exactly what package-lock.json records
npm run typecheck      # check TypeScript without producing dist/
npm test               # build dist/ and run the SDK tests
npm run pack:check     # show the files that would enter the package
npm pack               # create rhinoq-node-0.1.0-dev.tgz
```

Install the resulting archive and your PostgreSQL driver in the target
application:

```bash
npm install /absolute/path/to/rhinoq-node-0.1.0-dev.tgz pg
```

For an application evaluation, pin the explicit prerelease rather than using
`latest`:

```bash
npm install @rhinoq/node@0.1.0-beta.1 pg
```

Check the [release guide](https://github.com/madebyduy/RhinoQ/blob/main/docs/releasing.md)
for the authoritative publication state and the trusted-publishing setup.

## Choose one integration path

| Need | API | Gateway required |
|---|---|:---:|
| enqueue through the application's PostgreSQL pool | `PostgresProducer` | No |
| enqueue in the current business transaction | `PostgresProducer` with `PoolClient` | No |
| run JavaScript/TypeScript handlers | `RhinoQWorker` | Yes |
| inspect, pause, cancel, replay or triage | `RhinoQClient` | Yes |
| create, update or poll a Task snapshot | `RhinoQClient` | Yes |
| mirror an existing BullMQ job into a Task | `BullMQTaskBridge` | Yes |

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

`watchTask()` is available in the `beta.2` source. It polls immediately,
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
const bridge = new BullMQTaskBridge({ client, events });

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
checked BullMQ's retry policy/attempts. The bridge does not auto-dispatch,
cancel a BullMQ job, create a RhinoQ Execution for a BullMQ retry, or
discover/scan a whole queue after downtime.

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
