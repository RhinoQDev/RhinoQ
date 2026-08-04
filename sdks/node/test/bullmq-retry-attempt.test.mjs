import assert from 'node:assert/strict';
import test from 'node:test';

import { BullMQTaskBridge, RhinoQError, TaskMetrics } from '../dist/index.js';

// BullMQ reuses its job ID across retries. The first attempt was already
// terminal by the time the retry went active, the Execution state machine
// refused the move, and the second run left no record at all — the `attempt`
// column never advanced past 1 for any external runtime. Open since beta.3.

test('a job that goes active after failing opens the next attempt', async () => {
  const h = newHarness({ firstState: 'failed', failureReason: 'upstream returned 502' });
  try {
    await h.bridge.project('active', { jobId: 'bull-job-1' });

    assert.deepEqual(h.retries, [{ from: 'exec-1', expectedVersion: 4, to: 'exec-1#2' }]);
    // The previous attempt keeps its outcome and its reason. "Attempt 1 failed
    // with a 502, attempt 2 is running" is the only question anyone asks.
    const previous = h.executions.find((execution) => execution.id === 'exec-1');
    assert.equal(previous.state, 'failed');
    assert.equal(previous.failureReason, 'upstream returned 502');
    assert.equal(previous.supersededAt !== undefined, true);

    const current = h.executions.find((execution) => execution.id === 'exec-1#2');
    assert.equal(current.attempt, 2);
    assert.equal(current.itemKey, 'item-a', 'the retry belongs to the same logical item');
    assert.equal(current.externalId, 'bull-job-1');
    assert.equal(current.state, 'running');
    assert.equal(h.task.state, 'running');
  } finally {
    h.bridge.close();
  }
});

test('a failed event followed by active closes the old attempt before retrying', async () => {
  const h = newHarness({ firstState: 'running' });
  try {
    await h.bridge.project('failed', {
      jobId: 'bull-job-1',
      failedReason: 'upstream returned 502',
    });
    assert.equal(h.executions[0].state, 'failed');
    assert.equal(h.task.state, 'running', 'a retryable failure must not fail the Task');

    await h.bridge.project('active', { jobId: 'bull-job-1' });

    assert.equal(h.executions.length, 2);
    assert.equal(h.executions[0].reason, 'upstream returned 502');
    assert.equal(h.executions[1].attempt, 2);
    assert.equal(h.executions[1].state, 'running');
  } finally {
    h.bridge.close();
  }
});

test('an observed runtime attempt repairs a missed failed and active event', async () => {
  const h = newHarness({ firstState: 'running' });
  try {
    await h.bridge.reconcile({ state: 'active', jobId: 'bull-job-1', attempt: 2 });

    assert.equal(h.executions.length, 2);
    assert.equal(h.executions[0].state, 'failed');
    assert.match(h.executions[0].reason, /runtime advanced to attempt 2/);
    assert.equal(h.executions[1].attempt, 2);
    assert.equal(h.executions[1].state, 'running');
  } finally {
    h.bridge.close();
  }
});

test('a succeeded attempt that goes active again is also a new attempt', async () => {
  const h = newHarness({ firstState: 'succeeded' });
  try {
    await h.bridge.project('active', { jobId: 'bull-job-1' });

    assert.equal(h.retries.length, 1);
    assert.equal(h.executions.find((e) => e.id === 'exec-1').state, 'succeeded');
    assert.equal(h.executions.find((e) => e.id === 'exec-1#2').state, 'running');
  } finally {
    h.bridge.close();
  }
});

// A running attempt going active again is a re-delivered event, not a retry.
// Superseding it would leave two live executions of one item.
test('an active event on a live attempt does not open a second one', async () => {
  const h = newHarness({ firstState: 'running' });
  try {
    await h.bridge.project('active', { jobId: 'bull-job-1' });

    assert.deepEqual(h.retries, []);
    assert.equal(h.executions.length, 1);
  } finally {
    h.bridge.close();
  }
});

test("retryProjection 'ignore' restores the old silent behaviour", async () => {
  const h = newHarness({ firstState: 'failed', retryProjection: 'ignore' });
  try {
    await h.bridge.project('active', { jobId: 'bull-job-1' });

    assert.deepEqual(h.retries, []);
    assert.equal(h.executions.length, 1);
    assert.equal(h.executions[0].state, 'failed');
  } finally {
    h.bridge.close();
  }
});

// The Gateway client owns attempt identity for the runtimes it runs itself, so
// its lack of retryTaskExecution is not a defect there. Say so once, not on
// every retried job.
test('a client that cannot record attempts warns exactly once', async () => {
  const h = newHarness({ firstState: 'failed', supportsRetry: false });
  try {
    await h.bridge.project('active', { jobId: 'bull-job-1' });
    await h.bridge.project('active', { jobId: 'bull-job-1' });

    assert.equal(h.warnings.length, 1);
    assert.match(h.warnings[0], /cannot record a retry as a new attempt/);
    assert.match(h.warnings[0], /retryProjection: 'ignore'/);
    assert.equal(h.executions.length, 1);
  } finally {
    h.bridge.close();
  }
});

// Two bridges, or a re-delivered event, can both see the terminal attempt. The
// durable lookup is authoritative; the loser must not throw or fork.
test('a concurrent retry converges instead of forking the item', async () => {
  const h = newHarness({ firstState: 'failed', supersedeError: 'RHINOQ_EXECUTION_SUPERSEDED' });
  try {
    await h.bridge.project('active', { jobId: 'bull-job-1' });

    // The supersede was refused, but the lookup already returns the attempt
    // the winner opened, and the bridge activates that one.
    assert.equal(h.executions.filter((execution) => execution.attempt === 2).length, 1);
    assert.equal(h.executions.find((e) => e.attempt === 2).state, 'running');
  } finally {
    h.bridge.close();
  }
});

test('a retry is counted so a retry storm is visible', async () => {
  const h = newHarness({ firstState: 'failed', withMetrics: true });
  try {
    await h.bridge.project('active', { jobId: 'bull-job-1' });

    const retried = h.metrics.snapshot().find((s) => s.name === 'rhinoq_task_execution_retried_total');
    assert.deepEqual(retried, {
      name: 'rhinoq_task_execution_retried_total',
      labels: { scope: 'reports' },
      value: 1,
    });
  } finally {
    h.bridge.close();
  }
});

test('the retry Execution id is deterministic and overridable', async () => {
  const h = newHarness({
    firstState: 'failed',
    retryExecutionId: (previous, attempt) => `${previous.itemKey}:try-${attempt}`,
  });
  try {
    await h.bridge.project('active', { jobId: 'bull-job-1' });
    assert.equal(h.retries[0].to, 'item-a:try-2');
  } finally {
    h.bridge.close();
  }
});

function newHarness({
  firstState,
  failureReason,
  retryProjection,
  retryExecutionId,
  supportsRetry = true,
  supersedeError,
  withMetrics = false,
} = {}) {
  const warnings = [];
  const retries = [];
  const executions = [{
    id: 'exec-1', taskId: 'task-1', itemKey: 'item-a', attempt: 1,
    runtime: 'bullmq', runtimeScope: 'reports', externalId: 'bull-job-1',
    state: firstState, version: 4,
    ...(failureReason ? { failureReason } : {}),
  }];
  const task = {
    schemaVersion: 1, entityVersion: 6, id: 'task-1', type: 'bulk-download',
    state: 'running', cancellation: { status: 'none' }, progress: { completed: 0 },
    hasResult: false, executions, createdAt: '2026-08-03T17:00:00Z', updatedAt: '2026-08-03T17:00:00Z',
  };
  const live = () => executions.find((execution) => execution.supersededAt === undefined);

  const client = {
    async lookupTaskExecution(runtime, externalId) {
      assert.equal(externalId, 'bull-job-1');
      const found = live();
      if (!found) throw new Error('no live execution');
      return found;
    },
    async getTaskExecution(id) {
      return executions.find((execution) => execution.id === id);
    },
    async getTask() { return task; },
    async transitionTaskExecution(id, expectedVersion, next, reason) {
      const execution = executions.find((item) => item.id === id);
      assert.equal(expectedVersion, execution.version, 'stale execution version');
      execution.state = next;
      execution.reason = reason;
      execution.version += 1;
      return task;
    },
    async transitionTask(id, expectedVersion, next) {
      assert.equal(expectedVersion, task.entityVersion);
      task.state = next;
      task.entityVersion += 1;
      return task;
    },
  };
  if (supportsRetry) {
    client.retryTaskExecution = async (from, expectedVersion, to) => {
      retries.push({ from, expectedVersion, to });
      const previous = executions.find((execution) => execution.id === from);
      // Whatever the outcome, the replacement exists afterwards: either this
      // call created it, or the concurrent winner already had.
      previous.supersededAt = '2026-08-03T17:00:01Z';
      executions.push({
        id: supersedeError ? 'exec-1#2-winner' : to,
        taskId: previous.taskId, itemKey: previous.itemKey,
        attempt: previous.attempt + 1, runtime: previous.runtime,
        runtimeScope: previous.runtimeScope, externalId: previous.externalId,
        state: 'dispatched', version: 1,
      });
      if (supersedeError) {
        throw new RhinoQError(supersedeError, from, false, { status: 409 });
      }
      return task;
    };
  }

  const listeners = new Map();
  const metrics = withMetrics ? new TaskMetrics() : undefined;
  const bridge = new BullMQTaskBridge({
    client,
    events: { on(name, listener) { listeners.set(name, listener); }, off(name) { listeners.delete(name); } },
    runtimeScope: 'reports',
    terminalProjection: 'execution-only',
    onWarning: (warning) => warnings.push(warning),
    ...(retryProjection ? { retryProjection } : {}),
    ...(retryExecutionId ? { retryExecutionId } : {}),
    ...(metrics ? { metrics } : {}),
  });
  return { bridge, task, executions, retries, warnings, metrics };
}
