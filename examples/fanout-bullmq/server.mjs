// One process: the API, the BullMQ worker, and the RhinoQ bridge that connects
// them. Split them in production — the point here is that the whole loop fits
// on one screen, not that it should ship this way.
import { randomUUID } from 'node:crypto';
import express from 'express';
import IORedis from 'ioredis';
import pg from 'pg';
import { Queue, QueueEvents, Worker } from 'bullmq';
import {
  BullMQTaskBridge,
  PostgresProjectionFailureSink,
  PostgresProjectorLease,
  TaskMetrics,
  TaskReconciler,
  createNodeTaskMiddleware,
  createNodeWorkbenchMiddleware,
  installPostgresTaskProfile,
} from '@rhinoq/node';

const DATABASE_URL = process.env.RHINOQ_DATABASE_URL
  ?? 'postgres://postgres:rhinoq@127.0.0.1:55433/fanout';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:56379';
const QUEUE = 'transcode';
const SCOPE = 'transcode';

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

// installPostgresTaskProfile is async. Anything that reads `tasks` must be
// constructed after it settles — a consumer built in the same tick sees an
// unusable client, decides RhinoQ is not configured, and disables itself.
const tasks = await installPostgresTaskProfile(pool);

const queue = new Queue(QUEUE, { connection });
const events = new QueueEvents(QUEUE, { connection: connection.duplicate() });
const metrics = new TaskMetrics();

// ---------------------------------------------------------------------------
// The worker. RhinoQ does not run it, replace it, or change its signature.
// ---------------------------------------------------------------------------
new Worker(
  QUEUE,
  async (job) => {
    await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 600));
    // One item in twelve fails, so the console has something real to show.
    if (job.data.index % 12 === 7) {
      throw new Error(`source mirror returned 404 for ${job.data.key}`);
    }
    return { storedAt: `s3://transcoded/${job.data.key}.mp4` };
  },
  { connection: connection.duplicate(), concurrency: 4 },
);

// ---------------------------------------------------------------------------
// The bridge. It observes the queue and writes Task state; it dispatches
// through the application's own Queue so the durable identity exists first.
// ---------------------------------------------------------------------------
const bridge = new BullMQTaskBridge({
  client: tasks,
  queue,
  events,
  runtimeScope: SCOPE,
  metrics,
  // A fan-out: one job is never the whole Task. `single-execution` here would
  // drive the batch terminal on its first finished item, silently.
  terminalProjection: 'execution-only',
  aggregate: { progress: 'terminal-items', terminal: 'manual' },

  // Required for a fan-out with retries, and easy to miss. Without it every
  // failure is treated as "the attempt may still retry", so the settled check
  // never runs after a failure — and a batch whose last item fails never
  // settles at all. BullMQ knows when it is out of attempts; ask it.
  isTerminalFailure: async (event) => {
    const job = await queue.getJob(event.jobId);
    return !job || job.attemptsMade >= (job.opts?.attempts ?? 1);
  },

  // Exactly-once, decided by one SQL statement rather than a counter in this
  // process — so it survives a crash, a redelivered event and several bridges.
  onItemsSettled: async (task) => {
    const failed = task.executions.filter((execution) => execution.state === 'failed');
    console.log(
      `[settled] ${task.id}: ${task.executions.length - failed.length} ok, ${failed.length} failed`,
    );
    await tasks.transitionTask(task.id, task.entityVersion, failed.length ? 'failed' : 'succeeded');
  },

  // Only one process may project a scope. The lock lives in a database
  // session, so a failover releases it — and the bridge stops rather than
  // running beside its replacement.
  projectorLease: new PostgresProjectorLease(pool, SCOPE),
  onLeaseLost: () => {
    console.error('[lease] lost projector ownership; exiting so the orchestrator restarts us');
    process.exit(1);
  },

  // A failed projection outlives the process that failed it. onError alone
  // does not: the reason the projection failed is often the reason the process
  // is going away.
  projectionFailures: new PostgresProjectionFailureSink({
    query: (text, values) => pool.query(text, values),
  }),
  onWarning: (warning) => console.warn(warning),
});

await bridge.start();   // required whenever a lease is configured

// Events stop arriving if nobody is listening. A sweep is the fallback, not
// the mechanism: it decides what a stuck batch means, which RhinoQ will not.
const reconciler = new TaskReconciler({
  tasks,
  metrics,
  query: { states: ['running'], idleForMs: 60_000, itemsSettled: false },
  everyMs: 30_000,
  reconcile: async (task) => {
    console.warn(`[reconcile] ${task.id} has not moved in a minute; leaving it for a human`);
  },
});
reconciler.start();

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// The end-user API: owner-scoped, no runtime identity, safe for a browser.
app.use(createNodeTaskMiddleware({
  tasks,
  basePath: '/tasks',
  // A Fetch Request, not the Express one: use Headers.get().
  ownerFromRequest: (request) => request.headers.get('x-user') ?? 'demo-user',
}));

// The operator console: reads across owners and shows BullMQ job IDs. Behind
// real authentication in anything that is not a demo.
app.use(createNodeWorkbenchMiddleware({
  tasks,
  basePath: '/admin/rhinoq',
  actions: true,
  requireOperator: (request) =>
    (process.env.OPERATOR_TOKEN ?? 'let-me-in') === request.headers.get('x-operator-token'),
}));

app.post('/batches', async (request, response) => {
  const size = Math.min(Number(request.body?.size ?? 50), 500);
  const taskId = `batch-${randomUUID().slice(0, 8)}`;

  await tasks.createTask({
    id: taskId,
    type: 'transcode.batch',
    ownerId: request.headers['x-user'] ?? 'demo-user',
    definitionVersion: 1,
  });

  // No manual `queued` or `running` here. dispatchMany ensures `queued`, and
  // the bridge moves the Task to `running` when the first job goes active —
  // driving those by hand races the projector and loses.
  //
  // itemKey is the idempotency key: attempts are numbered per key and the
  // aggregate counts one item per key. A row ID, not a storage path — it is
  // on the snapshot a browser polls. jobId avoids ':', which BullMQ rejects.
  await bridge.dispatchMany(
    Array.from({ length: size }, (_, index) => ({
      task: { id: taskId, type: 'transcode.batch', definitionVersion: 1 },
      itemKey: `clip-${index}`,
      executionId: `${taskId}:clip-${index}`,
      jobId: `${taskId}__clip-${index}`,
      job: {
        name: 'transcode',
        data: { index, key: `clip-${index}` },
        options: { attempts: 2, backoff: { type: 'fixed', delay: 500 } },
      },
    })),
  );

  response.json({ taskId, items: size, watch: `/admin/rhinoq` });
});

app.get('/', (_request, response) => {
  response.type('html').send(`<!doctype html><meta charset="utf-8">
<title>RhinoQ fan-out example</title>
<body style="font:15px/1.6 system-ui;max-width:44rem;margin:3rem auto;padding:0 1rem">
<h1>RhinoQ fan-out example</h1>
<button id="go" style="font:inherit;padding:.6rem 1rem">Start a 50-item batch</button>
<pre id="out" style="margin-top:1rem"></pre>
<p>Operator console:
<a href="/admin/rhinoq">/admin/rhinoq</a> (send <code>x-operator-token: let-me-in</code>).</p>
<script>
document.getElementById('go').onclick = async () => {
  const out = document.getElementById('out');
  out.textContent = 'starting…';
  const response = await fetch('/batches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ size: 50 }),
  });
  out.textContent = JSON.stringify(await response.json(), null, 2);
};
</script>`);
});

const server = app.listen(3000, () => {
  console.log('example on http://localhost:3000  ·  console on /admin/rhinoq');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    reconciler.stop();
    bridge.close();
    void pool.end();
    process.exit(0);
  });
}
