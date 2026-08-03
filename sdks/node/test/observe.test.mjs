import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BullMQTaskBridge,
  RhinoQError,
  TaskMetrics,
  checkEmbeddedHealth,
} from '../dist/index.js';

// The Gateway exposes /metrics and /healthz. An application on the embedded
// PostgreSQL Task client has no Gateway and had no equivalent at all — the one
// regression the Task-only profile introduced.

test('counters accumulate per label set and stay comparable between snapshots', () => {
  const metrics = new TaskMetrics();
  metrics.increment('rhinoq_bridge_event_projected_total', { event: 'completed', scope: 'reports' });
  metrics.increment('rhinoq_bridge_event_projected_total', { event: 'completed', scope: 'reports' });
  metrics.increment('rhinoq_bridge_event_projected_total', { event: 'failed', scope: 'reports' });
  metrics.increment('rhinoq_bridge_version_conflict_total', {}, 3);

  assert.deepEqual(metrics.snapshot(), [
    { name: 'rhinoq_bridge_event_projected_total', labels: { event: 'completed', scope: 'reports' }, value: 2 },
    { name: 'rhinoq_bridge_event_projected_total', labels: { event: 'failed', scope: 'reports' }, value: 1 },
    { name: 'rhinoq_bridge_version_conflict_total', labels: {}, value: 3 },
  ]);

  metrics.reset();
  assert.deepEqual(metrics.snapshot(), []);
});

test('a label order difference is the same series, not a second one', () => {
  const metrics = new TaskMetrics();
  metrics.increment('rhinoq_task_created_total', { scope: 'reports', type: 'export' });
  metrics.increment('rhinoq_task_created_total', { type: 'export', scope: 'reports' });

  assert.equal(metrics.snapshot().length, 1);
  assert.equal(metrics.snapshot()[0].value, 2);
});

test('render produces Prometheus text an application can serve directly', () => {
  const metrics = new TaskMetrics();
  metrics.increment('rhinoq_bridge_event_projected_total', { event: 'active' });
  metrics.increment('rhinoq_bridge_event_projected_total', { event: 'completed' });

  assert.equal(
    metrics.render(),
    '# TYPE rhinoq_bridge_event_projected_total counter\n' +
      'rhinoq_bridge_event_projected_total{event="active"} 1\n' +
      'rhinoq_bridge_event_projected_total{event="completed"} 1\n',
  );
  assert.equal(new TaskMetrics().render(), '', 'an empty registry must render nothing, not a stray TYPE line');
});

test('a label value that would break the exposition format is escaped', () => {
  const metrics = new TaskMetrics();
  metrics.increment('rhinoq_task_created_total', { scope: 'a"b\\c\nd' });

  assert.match(metrics.render(), /scope="a\\"b\\\\c\\nd"/);
});

test('a non-finite increment is refused rather than poisoning the series', () => {
  const metrics = new TaskMetrics();
  assert.throws(() => metrics.increment('rhinoq_task_created_total', {}, Number.NaN), /finite/);
  assert.throws(() => metrics.increment('rhinoq_task_created_total', {}, Infinity), /finite/);
  assert.deepEqual(metrics.snapshot(), []);
});

// The counters are counts. There is deliberately no latency, no rate and no
// percentile: RhinoQ's Definition of Done forbids publishing a performance
// number without the benchmark behind it, and shipping a p99 gauge publishes
// one. This test exists so that stays a decision rather than an oversight.
test('the metrics surface exposes no timing or rate measurement', () => {
  const metrics = new TaskMetrics();
  metrics.increment('rhinoq_task_created_total');

  for (const sample of metrics.snapshot()) {
    assert.doesNotMatch(sample.name, /seconds|duration|latency|p99|rate|histogram/);
  }
  assert.equal(typeof metrics.increment, 'function');
  assert.equal(metrics.observeDuration, undefined);
  assert.equal(metrics.startTimer, undefined);
});

test('the bridge counts every projected event, its conflicts and its failures', async () => {
  const listeners = new Map();
  const metrics = new TaskMetrics();
  let lookups = 0;
  const client = {
    async lookupTaskExecution() {
      lookups += 1;
      throw new RhinoQError('RHINOQ_EXECUTION_NOT_FOUND', 'unknown job', false, { status: 404 });
    },
  };
  const bridge = new BullMQTaskBridge({
    client,
    events: {
      on(name, listener) { listeners.set(name, listener); },
      off(name) { listeners.delete(name); },
    },
    runtimeScope: 'reports',
    terminalProjection: 'single-execution',
    metrics,
  });
  try {
    await bridge.project('active', { jobId: 'bull-job-1' });
    await bridge.project('active', { jobId: 'bull-job-2' });
    await bridge.project('waiting', { jobId: 'bull-job-1' });

    assert.equal(lookups, 3);
    assert.deepEqual(metrics.snapshot(), [
      { name: 'rhinoq_bridge_event_projected_total', labels: { event: 'active', scope: 'reports' }, value: 2 },
      { name: 'rhinoq_bridge_event_projected_total', labels: { event: 'waiting', scope: 'reports' }, value: 1 },
    ]);
  } finally {
    bridge.close();
  }
});

// A listener failure is otherwise invisible: nothing awaits that promise. A
// bridge that has silently stopped projecting is the failure this counts.
test('a projection that throws is counted even without onError', async () => {
  const listeners = new Map();
  const metrics = new TaskMetrics();
  const bridge = new BullMQTaskBridge({
    client: {
      async lookupTaskExecution() { throw new Error('postgres is gone'); },
    },
    events: {
      on(name, listener) { listeners.set(name, listener); },
      off(name) { listeners.delete(name); },
    },
    runtimeScope: 'reports',
    terminalProjection: 'single-execution',
    metrics,
  });
  try {
    listeners.get('active')({ jobId: 'bull-job-1' });
    const deadline = Date.now() + 1000;
    while (metrics.snapshot().length < 2) {
      if (Date.now() > deadline) throw new Error('the failure was never counted');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const failures = metrics.snapshot().find((sample) => sample.name === 'rhinoq_bridge_projection_failed_total');
    assert.deepEqual(failures, {
      name: 'rhinoq_bridge_projection_failed_total',
      labels: { scope: 'reports' },
      value: 1,
    });
  } finally {
    bridge.close();
  }
});

// A health probe that throws returns 500 for both "the database is gone" and
// "the probe has a bug", and an operator cannot tell those apart at 3am.
test('health reports an unreachable database as down rather than throwing', async () => {
  const health = await checkEmbeddedHealth({
    async query() { throw new Error('ECONNREFUSED 127.0.0.1:5432'); },
  }, 3);

  assert.equal(health.status, 'down');
  assert.equal(health.schemaVersion, 0);
  assert.match(health.detail, /unreachable/);
});

// A schema mismatch is a migration, which is a different page than a dead
// database. Reporting both as down loses that.
test('health reports a schema mismatch as degraded with the command that fixes it', async () => {
  const health = await checkEmbeddedHealth({
    async query(text) {
      if (text === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
      return { rows: [{ version: 2 }] };
    },
  }, 3);

  assert.equal(health.status, 'degraded');
  assert.equal(health.schemaVersion, 2);
  assert.equal(health.expectedSchemaVersion, 3);
  assert.match(health.detail, /npx rhinoq init/);
});

test('health reports a missing schema separately from a missing database', async () => {
  const health = await checkEmbeddedHealth({
    async query(text) {
      if (text === 'SELECT 1') return { rows: [] };
      throw new Error('relation "rhinoq_task.migrations" does not exist');
    },
  }, 3);

  assert.equal(health.status, 'degraded');
  assert.match(health.detail, /Task schema is not installed/);
  assert.match(health.detail, /npx rhinoq init/);
});

test('health reports ok with no detail when the schema matches', async () => {
  const health = await checkEmbeddedHealth({
    async query(text) {
      if (text === 'SELECT 1') return { rows: [] };
      return { rows: [{ version: 3 }] };
    },
  }, 3);

  assert.deepEqual(health, { status: 'ok', schemaVersion: 3, expectedSchemaVersion: 3, detail: '' });
});
