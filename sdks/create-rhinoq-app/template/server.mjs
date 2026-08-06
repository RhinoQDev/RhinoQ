// The whole application. Split it up in production; the point here is that the
// loop fits on one screen.
//
// A batch of items goes through BullMQ, each job writes an output file, and
// RhinoQ answers the question the queue cannot: did the work actually happen,
// and which item did not?
import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import IORedis from 'ioredis';
import pg from 'pg';
import { Queue, QueueEvents, Worker } from 'bullmq';
import {
  latestAttemptPerItem,
  objectExists,
  recordVerification,
  rhinoq,
  VERIFICATION_TABLE_SQL,
} from '@rhinoq/node';

import { page } from './ui.mjs';

const PORT = Number(process.env.PORT ?? 3000);
const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN ?? 'let-me-in';
const STORAGE = join(import.meta.dirname, 'storage');

const pool = new pg.Pool({ connectionString: process.env.RHINOQ_DATABASE_URL });
const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
await mkdir(STORAGE, { recursive: true });
await pool.query(VERIFICATION_TABLE_SQL);

const queue = new Queue('render', { connection });
const events = new QueueEvents('render', { connection: connection.duplicate() });

// ---------------------------------------------------------------------------
// The worker. RhinoQ does not run it, replace it, or change its signature.
// ---------------------------------------------------------------------------
new Worker('render', async (job) => {
  await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 450));
  // One item in twelve fails on purpose, so the console has something real to
  // show instead of a wall of green.
  if (job.data.index % 12 === 7) {
    throw new Error(`source returned 404 for ${job.data.key}`);
  }
  const path = join(STORAGE, `${job.data.key}.txt`);
  await writeFile(path, `rendered ${job.data.key} at ${new Date().toISOString()}\n`);
  return { storedAt: path };
}, { connection: connection.duplicate(), concurrency: 4 });

// ---------------------------------------------------------------------------
// RhinoQ. Three objects the app already has; everything else has one right
// answer for a queue-backed fan-out and the library makes it.
// ---------------------------------------------------------------------------
const app = await rhinoq({
  pool,
  queue,
  events,
  ownerFromRequest: (request) => request.headers.get('x-user') ?? 'demo-user',
  onSettled: (task) => console.log(`[settled] ${task.id} -> ${task.state}`),
  onWarning: (warning) => console.warn(warning),
  onError: (error, event) => console.error('[projection]', event?.jobId, error),
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const server = express();
server.use(express.json());

// The end-user API: owner-scoped, no runtime identity, safe for a browser.
server.use('/tasks', app.routes());
// The operator console: reads across owners and shows queue job IDs. Mounted
// without a path prefix — it matches on the full path and chooses its own.
server.use(app.workbench({ token: OPERATOR_TOKEN, basePath: '/admin' }));

server.post('/batches', async (request, response) => {
  const size = Math.min(Number(request.body?.size ?? 50), 500);
  const taskId = `batch-${randomUUID().slice(0, 8)}`;
  await app.dispatch(taskId, Array.from({ length: size }, (_, index) => ({
    key: `item-${index}`,
    data: { index, key: `item-${index}` },
  })), {
    ownerId: 'demo-user',
    jobOptions: { attempts: 2, backoff: { type: 'fixed', delay: 500 } },
  });
  response.json({ taskId, items: size });
});

/**
 * Real cancellation, not just a flag.
 *
 * `POST /tasks/:id/cancel` records the intent — that is the browser-safe API
 * and it does not touch Redis. This also stops the jobs: queued ones are
 * removed, and a job that is already running is reported
 * `cannot_cancel_safely` rather than pretended away.
 */
server.post('/cancel/:taskId', async (request, response) => {
  const task = await app.cancel(request.params.taskId);
  response.json({ state: task.state, cancellation: task.cancellation });
});

/**
 * The demo that is the actual product.
 *
 * Deletes the output of an item the queue reported as completed. Nothing in
 * BullMQ changes: the job is still `completed`, its return value still names
 * the file, and every dashboard built on queue state still says the work is
 * done. This is what "succeeded technically, failed in the real world" looks
 * like when you can see both sides at once.
 */
server.post('/break/:taskId', async (request, response) => {
  const results = await app.tasks.getTaskExecutionResults(request.params.taskId);
  // latestAttemptPerItem, because the list contains retries: without it a
  // 50-item batch with four retries looks like 54 items.
  const done = latestAttemptPerItem(results.executions)
    .filter((execution) => execution.state === 'succeeded');
  const victim = done[Math.floor(done.length / 2)];
  if (!victim) {
    response.status(409).json({ error: 'nothing has finished yet' });
    return;
  }
  await rm(join(STORAGE, `${victim.itemKey}.txt`), { force: true });
  response.json({ deleted: victim.itemKey });
});

/**
 * The verification pass. A Rule is SQL in a READ ONLY transaction under a role
 * with no network functions, so no Rule can stat a file or HEAD an object —
 * something has to go and look. That is this. It writes what it found into
 * `rhinoq_verifications`, where a Rule can read it.
 */
server.post('/verify/:taskId', async (request, response) => {
  const verify = objectExists({
    head: async ({ key }) => {
      try {
        await stat(join(STORAGE, `${key}.txt`));
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        // Anything else is "we could not look", not "it is not there".
        throw error;
      }
    },
  });
  const results = await app.tasks.getTaskExecutionResults(request.params.taskId);
  const items = latestAttemptPerItem(results.executions);
  const findings = [];
  let checked = 0;
  for (const execution of items) {
    if (execution.state !== 'succeeded') continue;
    const outcome = await verify({ bucket: 'storage', key: execution.itemKey });
    await recordVerification(pool, 'output-file-exists', outcome);
    checked += 1;
    if (outcome.status !== 'present') findings.push({ item: execution.itemKey, ...outcome });
  }
  response.json({ items: items.length, checked, findings });
});

server.get('/', (_request, response) => response.type('html').send(page(OPERATOR_TOKEN)));

const listening = server.listen(PORT, async () => {
  console.log(`app on http://localhost:${PORT}  ·  operator console on /admin`);
  const seed = Number(process.env.RHINOQ_SEED_BATCH ?? 0);
  if (seed > 0) {
    const taskId = `batch-${randomUUID().slice(0, 8)}`;
    await app.dispatch(taskId, Array.from({ length: seed }, (_, index) => ({
      key: `item-${index}`,
      data: { index, key: `item-${index}` },
    })), {
      ownerId: 'demo-user',
      jobOptions: { attempts: 2, backoff: { type: 'fixed', delay: 500 } },
    });
    console.log(`seeded a ${seed}-item batch: ${taskId}`);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    listening.close();
    app.close();
    void pool.end();
    process.exit(0);
  });
}
