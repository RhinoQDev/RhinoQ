import { performance } from 'node:perf_hooks';
import * as pg from 'pg';

import { PostgresTaskClient, migrateTaskSchema } from '../dist/index.js';

const databaseUrl = process.env.RHINOQ_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set RHINOQ_TEST_DATABASE_URL for the disposable benchmark database');
const iterations = positiveInteger(process.env.RHINOQ_BENCH_ITERATIONS, 1_000);
const concurrencies = integerList(
  process.env.RHINOQ_BENCH_CONCURRENCIES ?? process.env.RHINOQ_BENCH_CONCURRENCY,
  [1, 8, 16, 32],
);
const fanoutSizes = integerList(process.env.RHINOQ_BENCH_FANOUT_SIZES, []);
const fanoutConcurrencies = integerList(
  process.env.RHINOQ_BENCH_FANOUT_CONCURRENCIES,
  [8],
);
const fanoutReads = positiveInteger(process.env.RHINOQ_BENCH_FANOUT_READS, 100);
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: Math.max(...concurrencies, ...fanoutConcurrencies),
});
const prefix = `bench-${process.pid}-${Date.now()}`;

try {
  await migrateTaskSchema(pool);
  const client = new PostgresTaskClient(pool);
  const results = [];
  for (const concurrency of concurrencies) {
    const ids = Array.from(
      { length: iterations },
      (_, index) => `${prefix}-c${concurrency}-${index}`,
    );

    const create = await measureConcurrent(ids, concurrency, (id) => client.createTask({
      id, type: 'benchmark', ownerId: prefix, definitionVersion: 1,
    }));

    const read = await measureConcurrent(ids, concurrency, (id) => client.getTask(id));
    results.push(
      result('postgres-task-create-with-snapshot', iterations, create, { concurrency }),
      result('postgres-task-read-snapshot', iterations, read, { concurrency }),
    );
  }

  const fanout = [];
  for (const size of fanoutSizes) {
    for (const concurrency of fanoutConcurrencies) {
      fanout.push(await measureFanout(
        client,
        `${prefix}-fanout-${size}-c${concurrency}`,
        size,
        concurrency,
      ));
    }
  }

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runtime: { node: process.version, postgres: await postgresVersion(pool) },
    configuration: {
      iterations, concurrencies, fanoutSizes, fanoutConcurrencies, fanoutReads,
    },
    results,
    fanout,
  }, null, 2)}\n`);
} finally {
  await pool.query('DELETE FROM rhinoq_task.tasks WHERE owner_id = $1', [prefix]).catch(() => undefined);
  await pool.end();
}

async function measureConcurrent(values, size, operation) {
  const latencies = [];
  const wallStarted = performance.now();
  for (let offset = 0; offset < values.length; offset += size) {
    await Promise.all(values.slice(offset, offset + size).map(async (value) => {
      const started = performance.now();
      await operation(value);
      latencies.push(performance.now() - started);
    }));
  }
  latencies.sort((left, right) => left - right);
  return { wallMs: performance.now() - wallStarted, latencies };
}

async function postgresVersion(executor) {
  const result = await executor.query('SHOW server_version');
  return result.rows[0]?.server_version ?? 'unknown';
}

async function measureFanout(client, taskId, size, concurrency) {
  await client.createTask({
    id: taskId, type: 'benchmark-fanout', ownerId: prefix, definitionVersion: 1,
  });
  const executionIds = Array.from({ length: size }, (_, index) => index);
  const boundedConcurrency = Math.min(concurrency, size);
  const reserve = await measureConcurrent(executionIds, boundedConcurrency, (index) =>
    client.createTaskExecution(taskId, {
      id: `${taskId}-exec-${index}`,
      itemKey: `item-${index}`,
      runtime: 'benchmark',
      runtimeScope: prefix,
      // Runtime identity is queue-scoped, not Task-scoped. Include the Task so
      // the fan-out size matrix cannot collide across successive cases.
      externalId: `${taskId}-job-${index}`,
    }));
  const snapshot = await client.getTask(taskId);
	const summary = await client.getTaskSummary(taskId);
  const read = await measureConcurrent(
    Array.from({ length: fanoutReads }),
    Math.min(16, fanoutReads),
    () => client.getTask(taskId),
  );
	const summaryRead = await measureConcurrent(
		Array.from({ length: fanoutReads }),
		Math.min(16, fanoutReads),
		() => client.getTaskSummary(taskId),
	);
	const pageStarted = performance.now();
	let cursor = ''; let pagedExecutions = 0; let pages = 0;
	do {
		const page = await client.listTaskExecutions(taskId, cursor, 100);
		pagedExecutions += page.executions.length; pages++;
		cursor = page.nextCursor ?? '';
	} while (cursor);
  return {
    executions: size,
    concurrency: boundedConcurrency,
    snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
	summaryBytes: Buffer.byteLength(JSON.stringify(summary)),
	executionPages: { pageSize: 100, pages, executions: pagedExecutions, durationMs: round(performance.now() - pageStarted) },
    reserve: result('postgres-fanout-reserve-with-growing-snapshot', size, reserve, {
      concurrency: boundedConcurrency,
    }),
    read: result('postgres-fanout-read-snapshot', fanoutReads, read, {
      concurrency: Math.min(16, fanoutReads),
    }),
	summaryRead: result('postgres-fanout-read-summary', fanoutReads, summaryRead, {
		concurrency: Math.min(16, fanoutReads),
	}),
  };
}

function result(name, count, measurement, dimensions = {}) {
  return {
    name,
    ...dimensions,
    operations: count,
    durationMs: round(measurement.wallMs),
    operationsPerSecond: Math.round(count / (measurement.wallMs / 1_000)),
    latencyMs: {
      p50: round(percentile(measurement.latencies, 0.50)),
      p95: round(percentile(measurement.latencies, 0.95)),
      p99: round(percentile(measurement.latencies, 0.99)),
    },
  };
}

function percentile(values, value) {
  return values[Math.min(values.length - 1, Math.ceil(values.length * value) - 1)];
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function positiveInteger(raw, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new RangeError('benchmark values must be positive integers');
  return value;
}

function integerList(raw, fallback) {
  if (raw === undefined || raw.trim() === '') return fallback;
  const values = [...new Set(raw.split(',').map((item) => Number(item.trim())))];
  if (values.length === 0 || values.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new RangeError('benchmark lists must contain comma-separated positive integers');
  }
  return values;
}
