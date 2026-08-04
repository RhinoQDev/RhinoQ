import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BullMQTaskBridge,
  InMemoryProjectionFailureSink,
  PostgresProjectionFailureSink,
  PROJECTION_FAILURE_TABLE_SQL,
  RhinoQError,
  UPSERT_PROJECTION_FAILURE_SQL,
  projectionFailureKey,
} from '../dist/index.js';

// onError is a callback. It fires once, in the process that failed, and that
// process is often being killed -- the reason the projection failed is
// frequently the reason the process is going away. The event was then gone and
// nothing knew the job had ever happened.

test('a failed projection is written down before onError runs', async () => {
  const order = [];
  const sink = new InMemoryProjectionFailureSink();
  const h = newHarness({
    sink: { async record(failure) { order.push('sink'); await sink.record(failure); } },
    onError: () => order.push('onError'),
    failWith: new RhinoQError('RHINOQ_VERSION_CONFLICT', 'exec-1', true, { status: 409 }),
  });
  try {
    h.emit('completed', { jobId: 'bull-job-1', attempt: 2, returnvalue: { key: 'item-2' } });
    await h.settle(() => sink.size === 1);

    assert.deepEqual(order, ['sink', 'onError'], 'durable first; the callback may never return');

    const [failure] = sink.list();
    assert.equal(failure.schemaVersion, 1);
    assert.equal(failure.event, 'completed');
    assert.equal(failure.runtime, 'bullmq');
    assert.equal(failure.runtimeScope, 'reports');
    assert.equal(failure.externalId, 'bull-job-1');
    assert.equal(failure.code, 'RHINOQ_VERSION_CONFLICT');
    assert.equal(failure.attempts, 1);
    // Everything needed to replay the projection is in the record.
    assert.deepEqual(failure.observation, {
      jobId: 'bull-job-1', attempt: 2, returnvalue: { key: 'item-2' },
    });
    assert.match(failure.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    h.bridge.close();
  }
});

// A stack is not portable across processes and leaks filesystem paths into a
// table somebody will paste into a ticket.
test('the record carries the message, never the stack', async () => {
  const sink = new InMemoryProjectionFailureSink();
  const h = newHarness({ sink, failWith: new Error('postgres is gone') });
  try {
    h.emit('active', { jobId: 'bull-job-1' });
    await h.settle(() => sink.size === 1);

    const [failure] = sink.list();
    assert.equal(failure.message, 'postgres is gone');
    assert.equal(failure.code, undefined);
    assert.equal(JSON.stringify(failure).includes('.ts:'), false);
    assert.equal(JSON.stringify(failure).includes('at Object'), false);
  } finally {
    h.bridge.close();
  }
});

// The same projection can fail repeatedly. A sink that inserts a row each time
// turns one broken job into an unbounded table.
test('repeated failures of one projection collapse onto one record', async () => {
  const sink = new InMemoryProjectionFailureSink();
  const h = newHarness({ sink, failWith: new Error('postgres is gone') });
  try {
    h.emit('active', { jobId: 'bull-job-1' });
    await h.settle(() => sink.size === 1);
    h.emit('active', { jobId: 'bull-job-1' });
    await h.settle(() => sink.list()[0].attempts === 2);

    assert.equal(sink.size, 1);
    assert.equal(sink.list()[0].attempts, 2);
  } finally {
    h.bridge.close();
  }
});

test('different events on one job are different records', async () => {
  const sink = new InMemoryProjectionFailureSink();
  const h = newHarness({ sink, failWith: new Error('postgres is gone') });
  try {
    h.emit('active', { jobId: 'bull-job-1' });
    h.emit('completed', { jobId: 'bull-job-1' });
    await h.settle(() => sink.size === 2);

    assert.deepEqual(sink.list().map((failure) => failure.event), ['active', 'completed']);
  } finally {
    h.bridge.close();
  }
});

// A sink that is itself broken must not swallow the projection error it was
// there to preserve.
test('a sink that throws is reported without losing the original error', async () => {
  const errors = [];
  const h = newHarness({
    sink: { async record() { throw new Error('the failures table is missing'); } },
    onError: (error) => errors.push(error.message),
    failWith: new Error('postgres is gone'),
  });
  try {
    h.emit('active', { jobId: 'bull-job-1' });
    await h.settle(() => errors.length === 2);

    assert.deepEqual(errors, ['the failures table is missing', 'postgres is gone']);
  } finally {
    h.bridge.close();
  }
});

// Nothing awaits a listener's promise, so a throwing onError becomes an
// unhandled rejection — which in Node terminates the process by default. A
// bridge whose error reporting is broken must not be worse than one with none.
test('an onError that throws does not take the process down', async () => {
  const warnings = [];
  const h = newHarness({
    onError: () => { throw new Error('the logger is misconfigured'); },
    failWith: new Error('postgres is gone'),
    warnings,
  });
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    h.emit('active', { jobId: 'bull-job-1' });
    await h.settle(() => warnings.length === 1);
    // Give a stray rejection a chance to surface before asserting there is none.
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(rejections, []);
    assert.match(warnings[0], /onError threw while reporting/);
    assert.match(warnings[0], /the logger is misconfigured/);
    assert.match(warnings[0], /postgres is gone/, 'the original error must survive the broken handler');
  } finally {
    process.off('unhandledRejection', onRejection);
    h.bridge.close();
  }
});

test('the idempotency key is the four fields a durable sink keys on', () => {
  assert.equal(
    projectionFailureKey({ runtime: 'bullmq', runtimeScope: 'reports', externalId: 'job-1', event: 'completed' }),
    ['bullmq', 'reports', 'job-1', 'completed'].join('\u0000'),
  );
  // The separator is NUL because a scope or an external ID may contain
  // anything the queue accepts. With a space, these two tuples would collide
  // and one failure would silently overwrite the other in a deduplicating sink.
  assert.notEqual(
    projectionFailureKey({ runtime: 'bullmq', runtimeScope: 'a b', externalId: 'c', event: 'active' }),
    projectionFailureKey({ runtime: 'bullmq', runtimeScope: 'a', externalId: 'b c', event: 'active' }),
  );
  assert.match(PROJECTION_FAILURE_TABLE_SQL, /PRIMARY KEY \(runtime, runtime_scope, external_id, event\)/);
});

test('PostgresProjectionFailureSink writes one parameterized idempotent upsert', async () => {
  const calls = [];
  const sink = new PostgresProjectionFailureSink({
    async query(sql, values) {
      calls.push([sql, values]);
      return { rows: [] };
    },
  });
  const failure = {
    schemaVersion: 1, event: 'failed', runtime: 'bullmq', runtimeScope: 'reports',
    externalId: 'job-1', observation: { jobId: 'job-1', attempt: 2 },
    message: 'database unavailable', code: 'RHINOQ_VERSION_CONFLICT',
    observedAt: '2026-08-04T00:00:00.000Z', attempts: 1,
  };

  await sink.record(failure);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], UPSERT_PROJECTION_FAILURE_SQL);
  assert.match(calls[0][0], /ON CONFLICT \(runtime, runtime_scope, external_id, event\)/);
  assert.deepEqual(calls[0][1], [
    'bullmq', 'reports', 'job-1', 'failed', '{"jobId":"job-1","attempt":2}',
    'database unavailable', 'RHINOQ_VERSION_CONFLICT',
  ]);
});

test('the in-memory sink can be drained once a failure is handled', async () => {
  const sink = new InMemoryProjectionFailureSink();
  const failure = {
    schemaVersion: 1, event: 'completed', runtime: 'bullmq', runtimeScope: 'reports',
    externalId: 'job-1', observation: { jobId: 'job-1' }, message: 'boom',
    observedAt: '2026-08-03T18:00:00.000Z', attempts: 1,
  };
  await sink.record(failure);

  assert.equal(sink.size, 1);
  assert.equal(sink.resolve(failure), true);
  assert.equal(sink.resolve(failure), false);
  assert.equal(sink.size, 0);
});

function newHarness({ sink, onError, failWith, warnings }) {
  const listeners = new Map();
  const bridge = new BullMQTaskBridge({
    client: { async lookupTaskExecution() { throw failWith; } },
    events: {
      on(name, listener) { listeners.set(name, listener); },
      off(name) { listeners.delete(name); },
    },
    runtimeScope: 'reports',
    terminalProjection: 'single-execution',
    ...(sink ? { projectionFailures: sink } : {}),
    ...(onError ? { onError } : {}),
    ...(warnings ? { onWarning: (warning) => warnings.push(warning) } : {}),
  });
  return {
    bridge,
    emit(name, event) { listeners.get(name)(event); },
    async settle(done, timeoutMs = 1000) {
      const deadline = Date.now() + timeoutMs;
      while (!done()) {
        if (Date.now() > deadline) throw new Error('the failure was never recorded');
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
  };
}
