import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import IORedis from 'ioredis';
import { Queue, QueueEvents, Worker } from 'bullmq';
import {
  BullMQTaskBridge,
  PostgresProjectorLease,
  installPostgresTaskProfile,
} from '@rhinoq/node';

const databaseUrl = required('RHINOQ_DATABASE_URL');
const redisUrl = required('REDIS_URL');
const container = required('RHINOQ_CHAOS_REDIS_CONTAINER');
if (!container.startsWith('rhinoq-chaos-')) {
  throw new Error('RHINOQ_CHAOS_REDIS_CONTAINER must start with rhinoq-chaos-');
}

const queueName = `rhinoq-chaos-${process.pid}`;
const runtimeScope = queueName;
const taskId = `chaos-${randomUUID()}`;
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
const errors = [];
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
connection.on('error', (error) => errors.push(`redis: ${error.message}`));
const eventsConnection = connection.duplicate();
eventsConnection.on('error', (error) => errors.push(`events-redis: ${error.message}`));
const workerConnection = connection.duplicate();
workerConnection.on('error', (error) => errors.push(`worker-redis: ${error.message}`));
const queue = new Queue(queueName, { connection });
const events = new QueueEvents(queueName, { connection: eventsConnection });
const worker = new Worker(
  queueName,
  async () => {
    await sleep(1_500);
    return { recovered: true };
  },
  { connection: workerConnection, concurrency: 1 },
);
worker.on('error', (error) => errors.push(`worker: ${error.message}`));
events.on('error', (error) => errors.push(`events: ${error.message}`));

let stopped = false;
let bridge;
let outcome;
let exitCode = 0;
const hardTimeout = setTimeout(() => {
  console.error('[chaos] hard timeout: forcing process exit');
  process.exit(2);
}, 60_000);
hardTimeout.unref();
try {
  const tasks = await installPostgresTaskProfile(pool);
  await Promise.all([
    ready('initial QueueEvents connection', () => events.waitUntilReady()),
    ready('initial Worker connection', () => worker.waitUntilReady()),
  ]);
  bridge = new BullMQTaskBridge({
    client: tasks,
    queue,
    events,
    runtimeScope,
    terminalProjection: 'single-execution',
    projectorLease: new PostgresProjectorLease(pool, runtimeScope),
    onWarning: (warning) => errors.push(`bridge: ${warning}`),
  });
  await bridge.start();
  console.error(`[chaos] dispatching ${taskId}`);

  const active = new Promise((resolve) => worker.once('active', resolve));
  await bridge.dispatch({
    task: { id: taskId, type: 'chaos.redis-restart', ownerId: 'chaos', definitionVersion: 1 },
    executionId: `${taskId}-execution`,
    itemKey: 'one',
    jobId: `${taskId}-job`,
    job: { name: 'chaos.redis-restart', data: { taskId }, options: { attempts: 1 } },
  });
  await active;
  console.error('[chaos] worker is active; stopping Redis');

  docker('stop', container);
  stopped = true;
  await sleep(1_000);
  docker('start', container);
  stopped = false;
  console.error('[chaos] Redis restarted; waiting for clients and Task convergence');
  await Promise.all([
    ready('restarted QueueEvents connection', () => events.waitUntilReady()),
    ready('restarted Worker connection', () => worker.waitUntilReady()),
  ]);

  let snapshot = await waitFor(
    async () => tasks.getTask(taskId),
    (value) => value?.state === 'succeeded' || value?.state === 'failed',
    20_000,
  );
  if (snapshot?.state !== 'succeeded' && snapshot?.state !== 'failed') {
    console.error('[chaos] events did not converge; reconciling the known runtime reference');
    await bridge.reconcileTask(taskId, async (reference) => {
      const job = await withTimeout(queue.getJob(reference.externalId), 5_000, 'BullMQ job lookup');
      if (!job) return undefined;
      const state = await job.getState();
      if (state === 'completed') return { jobId: job.id, state, returnvalue: job.returnvalue };
      if (state === 'failed') return {
        jobId: job.id, state, attempt: Math.max(1, job.attemptsMade),
        failedReason: job.failedReason, terminal: true,
      };
      return { jobId: job.id, state };
    });
    snapshot = await tasks.getTask(taskId);
  }
  if (snapshot?.state !== 'succeeded' && snapshot?.state !== 'failed') {
    throw new Error(`Task did not converge after Redis restart: ${snapshot?.state ?? 'missing'}`);
  }
  outcome = {
    schemaVersion: 1,
    scenario: 'redis-bullmq-process-restart',
    taskId,
    state: snapshot.state,
    executionState: snapshot.executions[0]?.state,
    redisContainer: container,
    observedErrors: errors,
  };
} catch (error) {
  exitCode = 1;
  console.error(`[chaos] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  if (stopped) {
    try { docker('start', container); } catch { /* report the original failure */ }
  }
  bridge?.close();
  await withTimeout(worker.close(true), 5_000, 'Worker close').catch(() => undefined);
  await withTimeout(events.close(), 5_000, 'QueueEvents close').catch(() => undefined);
  await withTimeout(queue.close(), 5_000, 'Queue close').catch(() => undefined);
  worker.disconnect?.();
  events.disconnect?.();
  queue.disconnect?.();
  connection.disconnect();
  await withTimeout(pool.query('DELETE FROM rhinoq_task.tasks WHERE id = $1', [taskId]), 5_000, 'Task cleanup').catch(() => undefined);
  await withTimeout(pool.end(), 5_000, 'PostgreSQL pool close').catch(() => undefined);
}
clearTimeout(hardTimeout);
if (outcome) process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
process.exitCode = exitCode;
// BullMQ can retain reconnect timers after a deliberately interrupted Redis
// connection. All owned resources have been closed above; exit explicitly so
// a successful evidence run cannot hang on those library internals.
process.exit(exitCode);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

function docker(command, name) {
  execFileSync('docker', [command, name], { stdio: 'inherit' });
}

async function waitFor(read, done, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await sleep(250);
  }
  return last;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ready(label, operation) {
  try {
    await withTimeout(operation(), 5_000, label);
  } catch (error) {
    errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function withTimeout(operation, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
