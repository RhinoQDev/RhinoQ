import { performance } from 'node:perf_hooks';

import {
  TaskStore,
  bullMQCountProgress,
  bullMQPercentageProgress,
} from '../dist/index.js';

const DEFAULT_ITERATIONS = 100_000;
const iterations = positiveInteger(process.env.RHINOQ_BENCH_ITERATIONS, DEFAULT_ITERATIONS);
const samples = positiveInteger(process.env.RHINOQ_BENCH_SAMPLES, 7);
let checksum = 0;

const benchmarks = [
  {
    name: 'task-store-newer-snapshot',
    asynchronous: true,
    iterations,
    setup() {
      let version = 0;
      const store = new TaskStore(client(() => snapshot(++version)), 'bench-task');
      return () => store.refresh();
    },
  },
  {
    name: 'task-store-stale-rejection',
    asynchronous: true,
    iterations,
    async setup() {
      let version = 2;
      const store = new TaskStore(client(() => snapshot(version-- > 1 ? 2 : 1)), 'bench-task');
      await store.refresh();
      return () => store.refresh();
    },
  },
  {
    name: 'bullmq-count-progress-map',
    asynchronous: false,
    iterations: iterations * 10,
    setup() {
      const event = { jobId: 'job-1', data: 42 };
      return () => bullMQCountProgress(event);
    },
  },
  {
    name: 'bullmq-percentage-progress-map',
    asynchronous: false,
    iterations: iterations * 10,
    setup() {
      const event = { jobId: 'job-1', data: 73 };
      return () => bullMQPercentageProgress(event);
    },
  },
];

const results = [];
for (const benchmark of benchmarks) {
  const durations = [];
  const operation = await benchmark.setup();
  await run(operation, Math.min(10_000, benchmark.iterations), benchmark.asynchronous);
  for (let sample = 0; sample < samples; sample++) {
    const started = performance.now();
    await run(operation, benchmark.iterations, benchmark.asynchronous);
    durations.push(performance.now() - started);
  }
  durations.sort((left, right) => left - right);
  const medianMs = percentile(durations, 0.5);
  const p95Ms = percentile(durations, 0.95);
  results.push({
    name: benchmark.name,
    iterations: benchmark.iterations,
    samples,
    medianMs: round(medianMs),
    p95Ms: round(p95Ms),
    medianOpsPerSecond: Math.round(benchmark.iterations / (medianMs / 1_000)),
    p95NanosecondsPerOperation: Math.round(p95Ms * 1e6 / benchmark.iterations),
  });
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  configuration: { iterations, samples },
  checksum,
  results,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function run(operation, count, asynchronous) {
  if (asynchronous) {
    for (let index = 0; index < count; index++) consume(await operation());
    return;
  }
  for (let index = 0; index < count; index++) consume(operation());
}

function consume(value) {
  const numeric = value?.entityVersion ?? value?.completed ?? 0;
  checksum = (checksum + Number(numeric)) >>> 0;
}

function client(read) {
  return {
    async getTask() { return read(); },
    async cancelTask() { throw new Error('unused'); },
    async getTaskResult() { throw new Error('unused'); },
  };
}

function snapshot(entityVersion) {
  return {
    schemaVersion: 1, entityVersion, id: 'bench-task', type: 'benchmark',
    state: 'running', progress: { completed: entityVersion }, hasResult: false,
    executions: [], createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:01Z',
  };
}

function percentile(values, percentileValue) {
  return values[Math.min(values.length - 1, Math.ceil(values.length * percentileValue) - 1)];
}

function positiveInteger(raw, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new RangeError('benchmark values must be positive integers');
  return value;
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}
