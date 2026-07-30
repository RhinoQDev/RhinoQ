import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BullMQTaskBridge,
  bullMQCountProgress,
  bullMQPercentageProgress,
} from '../dist/index.js';

// QueueEvents re-delivers `progress` after a reconnect, so a fan-out sees the
// same payload many times. The bridge must recognise its own last write instead
// of paying a round trip — and a no-op write is not the Gateway's job to absorb
// twice.
test('the bridge does not re-send progress it has already reported', async () => {
  const harness = newHarness({ progress: { completed: 6, total: 10 } });
  harness.emit('progress', { jobId: 'bull-job-1', data: { completed: 6, total: 10 } });
  await harness.settle();

  assert.deepEqual(harness.calls, [
    'lookupTaskExecution',
    'getTaskExecution',
    'getTask',
  ]);
  assert.equal(harness.task.entityVersion, 5);
});

test('the bridge reports progress that differs from the stored snapshot', async () => {
  const harness = newHarness({ progress: { completed: 6, total: 10 } });
  harness.emit('progress', { jobId: 'bull-job-1', data: { completed: 7, total: 10 } });
  await harness.settle(4);

  assert.deepEqual(harness.calls, [
    'lookupTaskExecution',
    'getTaskExecution',
    'getTask',
    'reportTaskProgress',
  ]);
  assert.deepEqual(harness.task.progress, { completed: 7, total: 10 });
  assert.equal(harness.task.entityVersion, 6);
});

// A message-only change is still a change: it is what a batch reports when it
// moves from downloading to zipping without finishing another item.
test('the bridge reports a message change at the same counter', async () => {
  const harness = newHarness({ progress: { completed: 6, total: 10 } });
  harness.emit('progress', {
    jobId: 'bull-job-1',
    data: { completed: 6, total: 10, message: 'zipping' },
  });
  await harness.settle(4);

  assert.equal(harness.calls.at(-1), 'reportTaskProgress');
  assert.equal(harness.task.progress.message, 'zipping');
});

// Before per-Execution results existed, `resultReference` was silently ignored
// in execution-only mode — the option existed but did nothing in exactly the
// mode that needs it, so a fan-out could never say where item 37 landed.
test('the bridge records a fan-out item result on its own Execution', async () => {
  const harness = newHarness({
    progress: { completed: 0 },
    terminalProjection: 'execution-only',
    resultReference: async () => 's3://videos/batch/item-2.mp4',
  });
  harness.emit('completed', { jobId: 'bull-job-1', returnvalue: { key: 'item-2' } });
  await harness.settle(5);

  assert.equal(harness.execution.resultRef, 's3://videos/batch/item-2.mp4');
  assert.equal(harness.execution.state, 'succeeded');
  // execution-only must still refuse to terminate the batch on one item.
  assert.equal(harness.task.state, 'running');
  assert.ok(!harness.calls.includes('attachTaskResult'));
});

test('the bridge records why one fan-out item failed', async () => {
  const harness = newHarness({
    progress: { completed: 0 },
    terminalProjection: 'execution-only',
    isTerminalFailure: async () => true,
  });
  harness.emit('failed', {
    jobId: 'bull-job-1',
    failedReason: '  source mirror returned 404 after 3 attempts  ',
  });
  await harness.settle(4);

  assert.equal(harness.execution.state, 'failed');
  assert.equal(harness.execution.reason, 'source mirror returned 404 after 3 attempts');
  assert.equal(harness.task.state, 'running');
});

// Guessing this for a fan-out completes the batch on its first finished item,
// and a terminal Task is never reopened. A JavaScript caller gets no compile
// error, so the constructor has to be the one that refuses.
test('the bridge refuses to guess whether one job is the whole Task', () => {
  const events = { on() {}, off() {} };
  assert.throws(
    () => new BullMQTaskBridge({ client: {}, events }),
    /terminalProjection/,
  );
  assert.throws(
    () => new BullMQTaskBridge({ client: {}, events, terminalProjection: 'whatever' }),
    /terminalProjection/,
  );
});

test('the bridge refuses to guess the unit of numeric BullMQ progress', async () => {
  const errors = [];
  const harness = newHarness({
    progress: { completed: 0 },
    onError: (error) => errors.push(error),
  });

  harness.emit('progress', { jobId: 'bull-job-1', data: 42 });
  await harness.settleErrors(errors);

  assert.match(errors[0].message, /numeric progress is ambiguous/);
  assert.deepEqual(harness.task.progress, { completed: 0 });
  assert.deepEqual(harness.calls, []);
});

test('numeric BullMQ progress requires an explicit count or percentage mapper', async () => {
  const count = newHarness({
    progress: { completed: 0 },
    progressMapper: bullMQCountProgress,
  });
  count.emit('progress', { jobId: 'bull-job-1', data: 7 });
  await count.settle(4);
  assert.deepEqual(count.task.progress, { completed: 7 });

  const percentage = newHarness({
    progress: { completed: 0 },
    progressMapper: bullMQPercentageProgress,
  });
  percentage.emit('progress', { jobId: 'bull-job-1', data: 42 });
  await percentage.settle(4);
  assert.deepEqual(percentage.task.progress, { completed: 42, total: 100 });
});

function newHarness({
  progress,
  terminalProjection = 'single-execution',
  resultReference,
  isTerminalFailure,
  progressMapper,
  onError,
}) {
  const calls = [];
  const task = {
    schemaVersion: 1,
    entityVersion: 5,
    id: 'task-1',
    type: 'bulk-download',
    state: 'running',
    progress,
    hasResult: false,
    executions: [],
    createdAt: '2026-07-29T10:00:00Z',
    updatedAt: '2026-07-29T10:00:00Z',
  };
  const execution = {
    id: 'exec-1',
    taskId: 'task-1',
    runtime: 'bullmq',
    state: 'running',
    version: 2,
  };
  const client = {
    async lookupTaskExecution(runtime, externalId) {
      calls.push('lookupTaskExecution');
      assert.equal(runtime, 'bullmq');
      assert.equal(externalId, 'bull-job-1');
      return execution;
    },
    async getTaskExecution() {
      calls.push('getTaskExecution');
      return execution;
    },
    async getTask() {
      calls.push('getTask');
      return task;
    },
    async reportTaskProgress(id, expectedVersion, next) {
      calls.push('reportTaskProgress');
      assert.equal(id, 'task-1');
      assert.equal(expectedVersion, task.entityVersion);
      task.progress = next;
      task.entityVersion += 1;
      return task;
    },
    async transitionTaskExecution(id, expectedVersion, state, reason) {
      calls.push('transitionTaskExecution');
      assert.equal(expectedVersion, execution.version);
      execution.state = state;
      execution.reason = reason;
      execution.version += 1;
      return task;
    },
    async attachTaskExecutionResult(id, expectedVersion, reference) {
      calls.push('attachTaskExecutionResult');
      assert.equal(id, 'exec-1');
      assert.equal(expectedVersion, execution.version);
      execution.resultRef = reference;
      execution.version += 1;
      return task;
    },
    async attachTaskResult(id, expectedVersion, reference) {
      calls.push('attachTaskResult');
      task.hasResult = true;
      task.resultRef = reference;
      task.entityVersion += 1;
      return task;
    },
    async transitionTask(id, expectedVersion, state) {
      calls.push('transitionTask');
      task.state = state;
      task.entityVersion += 1;
      return task;
    },
  };

  const listeners = new Map();
  const events = {
    on(name, listener) {
      listeners.set(name, listener);
    },
    off(name) {
      listeners.delete(name);
    },
  };
  const bridge = new BullMQTaskBridge({
    client,
    events,
    terminalProjection,
    ...(resultReference ? { resultReference } : {}),
    ...(isTerminalFailure ? { isTerminalFailure } : {}),
    ...(progressMapper ? { progress: progressMapper } : {}),
    ...(onError ? { onError } : {}),
  });

  return {
    calls,
    task,
    execution,
    bridge,
    emit(name, event) {
      listeners.get(name)(event);
    },
    async settle(expected = 3, timeoutMs = 1000) {
      const deadline = Date.now() + timeoutMs;
      while (calls.length < expected) {
        if (Date.now() > deadline) {
          throw new Error(`bridge stalled after ${calls.join(', ')}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      // Give a stray extra request a chance to appear before asserting.
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
    async settleErrors(errors, timeoutMs = 1000) {
      const deadline = Date.now() + timeoutMs;
      while (errors.length === 0) {
        if (Date.now() > deadline) {
          throw new Error('bridge did not report its progress mapping error');
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
  };
}
