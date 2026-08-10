// The whole application. Split it up in production; the point here is that the
// loop fits on one screen.
//
// A batch of items goes through BullMQ, each job writes an output file, and
// RhinoQ answers the question the queue cannot: did the work actually happen,
// and which item did not?
import { randomUUID, timingSafeEqual } from 'node:crypto';
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

import { operatorLoginPage, page } from './ui.mjs';

const PORT = Number(process.env.PORT ?? 3000);
const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN ?? 'let-me-in';
const STORAGE = join(import.meta.dirname, 'storage');

const pool = new pg.Pool({ connectionString: process.env.RHINOQ_DATABASE_URL });
const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
await mkdir(STORAGE, { recursive: true });
await pool.query(VERIFICATION_TABLE_SQL);

const queue = new Queue('render', {
  connection,
  // Retry is an application/runtime policy. Put it on the Queue once so every
  // dispatch path—including a future one—has the same explicit behavior.
  defaultJobOptions: { attempts: 2, backoff: { type: 'fixed', delay: 500 } },
});
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
server.use(express.urlencoded({ extended: false }));

// Local evaluation login. The token is exchanged for an HttpOnly, SameSite
// cookie scoped to /admin, so it is neither embedded in the page nor put in a
// URL. A real application should use its existing operator session/auth.
server.get('/operator-login', (_request, response) => {
  response.type('html').send(operatorLoginPage());
});
server.post('/operator-login', (request, response) => {
  if (!sameSecret(String(request.body?.token ?? ''), OPERATOR_TOKEN)) {
    response.status(403).type('html').send(operatorLoginPage(true));
    return;
  }
  response.setHeader(
    'set-cookie',
    `rhinoq_operator=${encodeURIComponent(OPERATOR_TOKEN)}; HttpOnly; SameSite=Strict; Path=/admin`,
  );
  response.redirect(303, '/admin');
});
server.use((request, _response, next) => {
  if ((request.path === '/admin' || request.path.startsWith('/admin/')) &&
      sameSecret(cookie(request, 'rhinoq_operator'), OPERATOR_TOKEN)) {
    request.headers['x-operator-token'] = OPERATOR_TOKEN;
  }
  next();
});

// One mount gives the application three connected surfaces: the owner API at
// /tasks, the owner-facing Task Center at /task-center, and the protected
// cross-owner Workbench at /admin.
server.use(app.http({
  operatorToken: OPERATOR_TOKEN,
  overviewPath: '/',
  workbenchPath: '/operator-login',
}));

server.post('/batches', async (request, response) => {
  const size = Math.min(Number(request.body?.size ?? 50), 500);
  const taskId = `batch-${randomUUID().slice(0, 8)}`;
  await app.dispatch(taskId, Array.from({ length: size }, (_, index) => ({
    key: `item-${index}`,
    data: { index, key: `item-${index}` },
  })), {
    ownerId: 'demo-user',
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

server.get('/overview', (_request, response) => response.redirect(302, '/'));
server.get('/', (_request, response) => response.type('html').send(page()));

const listening = server.listen(PORT, '127.0.0.1', async () => {
  console.log(`app on http://localhost:${PORT}  ·  operator sign-in on /operator-login`);
  const seed = Number(process.env.RHINOQ_SEED_BATCH ?? 0);
  if (seed > 0) {
    const taskId = `batch-${randomUUID().slice(0, 8)}`;
    await app.dispatch(taskId, Array.from({ length: seed }, (_, index) => ({
      key: `item-${index}`,
      data: { index, key: `item-${index}` },
    })), {
      ownerId: 'demo-user',
    });
    console.log(`seeded a ${seed}-item batch: ${taskId}`);
  }
});

function cookie(request, name) {
  for (const part of String(request.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) {
      try { return decodeURIComponent(value.join('=')); } catch { return ''; }
    }
  }
  return '';
}

function sameSecret(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    listening.close();
    app.close();
    void pool.end();
    process.exit(0);
  });
}
