import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BullMQTaskBridge,
  RhinoQError,
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

test('dispatchMany bounds fan-out pressure and never reserves an item twice', async () => {
  const itemCount = 23;
  const concurrency = 3;
  const task = {
    schemaVersion: 1,
    entityVersion: 1,
    id: 'bounded-fanout',
    type: 'bulk-download',
    state: 'pending',
    progress: { completed: 0 },
    hasResult: false,
    executions: [],
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
  };
  const executions = new Map();
  let createCalls = 0;
  let lookupCalls = 0;
  let activeReserves = 0;
  let maxActiveReserves = 0;
  let activeAdds = 0;
  let maxActiveAdds = 0;
  let addCalls = 0;
  const client = {
    async getTask() { return task; },
    async lookupTaskExecution(_runtime, externalId) {
      lookupCalls++;
      const found = [...executions.values()].find((value) => value.externalId === externalId);
      if (!found) throw new RhinoQError('RHINOQ_EXECUTION_NOT_FOUND', 'missing', false);
      return found;
    },
    async createTaskExecution(taskId, input) {
      createCalls++;
      activeReserves++;
      maxActiveReserves = Math.max(maxActiveReserves, activeReserves);
      await delay(2);
      const execution = {
        id: input.id,
        taskId,
        runtime: input.runtime,
        runtimeScope: input.runtimeScope,
        externalId: input.externalId,
        state: 'pending_dispatch',
        version: 1,
      };
      executions.set(execution.id, execution);
      activeReserves--;
      return task;
    },
    async getTaskExecution(id) { return executions.get(id); },
    async bindTaskExecution(id, input) {
      const execution = executions.get(id);
      execution.externalId = input.externalId;
      execution.state = 'dispatched';
      execution.version++;
      return task;
    },
    async transitionTask(_id, _version, state) {
      task.state = state;
      task.entityVersion++;
      return task;
    },
  };
  const added = new Set();
  let failOnce = true;
  const bridge = new BullMQTaskBridge({
    client,
    events: { on() {}, off() {} },
    queue: {
      async add(_name, _data, options) {
        addCalls++;
        activeAdds++;
        maxActiveAdds = Math.max(maxActiveAdds, activeAdds);
        await delay(2);
        if (options.jobId === 'job-7' && failOnce) {
          failOnce = false;
          activeAdds--;
          throw new Error('simulated partial Redis outage');
        }
        added.add(options.jobId);
        activeAdds--;
        return { id: options.jobId };
      },
    },
    runtimeScope: 'bounded-queue',
    dispatchConcurrency: concurrency,
    terminalProjection: 'execution-only',
  });
  const inputs = Array.from({ length: itemCount }, (_, index) => ({
    task: { id: task.id, type: task.type, definitionVersion: 1 },
    executionId: `exec-${index}`,
    itemKey: `item-${index}`,
    jobId: `job-${index}`,
    job: { name: 'download', data: { index } },
  }));

  await assert.rejects(bridge.dispatchMany(inputs), /partial Redis outage/);
  const result = await bridge.dispatchMany(inputs);

  assert.equal(result.state, 'queued');
  assert.equal(executions.size, itemCount);
  assert.equal(createCalls, itemCount);
  assert.equal(lookupCalls, itemCount * 2);
  assert.equal(added.size, itemCount);
  assert.ok(addCalls < itemCount * 2, `retry re-added ${addCalls} jobs`);
  assert.ok(maxActiveReserves <= concurrency, `reserve concurrency was ${maxActiveReserves}`);
  assert.ok(maxActiveAdds <= concurrency, `Queue.add concurrency was ${maxActiveAdds}`);
  assert.ok(maxActiveReserves > 1);
  assert.ok(maxActiveAdds > 1);
});

test('dispatchMany validates its pressure limit before doing work', () => {
  const base = {
    client: {}, events: { on() {}, off() {} }, queue: {}, runtimeScope: 'queue',
    terminalProjection: 'execution-only',
  };
  assert.throws(() => new BullMQTaskBridge({ ...base, dispatchConcurrency: 0 }), /1 to 64/);
  assert.throws(() => new BullMQTaskBridge({ ...base, dispatchConcurrency: 65 }), /1 to 64/);
  assert.throws(() => new BullMQTaskBridge({ ...base, dispatchConcurrency: 1.5 }), /1 to 64/);
});

test('dispatchMany rejects ambiguous batch identities before any durable or Queue work', async () => {
  let calls = 0;
  const bridge = new BullMQTaskBridge({
    client: new Proxy({}, { get() { return async () => { calls++; }; } }),
    events: { on() {}, off() {} },
    queue: { async add() { calls++; } },
    runtimeScope: 'queue',
    terminalProjection: 'execution-only',
  });
  const task = { id: 'task', type: 'batch', ownerId: 'owner', definitionVersion: 1 };
  const input = (index, overrides = {}) => ({
    task,
    executionId: `exec-${index}`,
    jobId: `job-${index}`,
    job: { name: 'work', data: index },
    ...overrides,
  });

  await assert.rejects(
    bridge.dispatchMany([input(1), input(2, { jobId: 'job-1' })]),
    /duplicate BullMQ job id/,
  );
  await assert.rejects(
    bridge.dispatchMany([input(1), input(2, { executionId: 'exec-1' })]),
    /duplicate Execution id/,
  );
  await assert.rejects(
    bridge.dispatchMany([
      input(1),
      input(2, { task: { ...task, definitionVersion: 2 } }),
    ]),
    /consistent Task definition/,
  );
  assert.equal(calls, 0);
});

test('track refuses to reuse a BullMQ job identity for another Execution', async () => {
  const harness = newHarness({ progress: { completed: 0 } });
  await assert.rejects(harness.bridge.track({
    task: { id: 'task-1', type: 'bulk-download', definitionVersion: 1 },
    executionId: 'different-execution',
    jobId: 'bull-job-1',
  }), /already bound to Execution exec-1/);
});

test('concurrent deterministic dispatch converges when another caller wins the bind', async () => {
  const task = {
    schemaVersion: 1, entityVersion: 1, id: 'race-task', type: 'work',
    state: 'pending', progress: { completed: 0 }, hasResult: false, executions: [],
    createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
  };
  const execution = {
    id: 'race-exec', taskId: task.id, runtime: 'bullmq',
    runtimeScope: 'race-queue', externalId: 'race-job',
    state: 'pending_dispatch', version: 1,
  };
  let bindCalls = 0;
  const client = {
    async getTask() { return task; },
    async lookupTaskExecution() { return { ...execution }; },
    async getTaskExecution() { return { ...execution }; },
    async bindTaskExecution() {
      bindCalls++;
      await delay(2);
      if (execution.state !== 'pending_dispatch') {
        throw new RhinoQError('RHINOQ_VERSION_CONFLICT', 'lost bind race', false);
      }
      execution.state = 'dispatched';
      execution.version++;
      return task;
    },
    async transitionTask(_id, _version, state) {
      task.state = state;
      task.entityVersion++;
      return task;
    },
  };
  const bridge = new BullMQTaskBridge({
    client,
    events: { on() {}, off() {} },
    queue: { async add(_name, _data, options) { return { id: options.jobId }; } },
    runtimeScope: execution.runtimeScope,
    terminalProjection: 'single-execution',
  });
  const input = {
    task: { id: task.id, type: task.type, definitionVersion: 1 },
    executionId: execution.id,
    jobId: execution.externalId,
    job: { name: 'work', data: {} },
  };

  const results = await Promise.all([bridge.dispatch(input), bridge.dispatch(input)]);

  assert.equal(bindCalls, 2);
  assert.equal(execution.state, 'dispatched');
  assert.deepEqual(results.map((result) => result.state), ['queued', 'queued']);
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

test('cancellation is acknowledged only after every known job confirms stop', async () => {
  const harness = newHarness({
    progress: { completed: 0 },
    cancelJob: async () => ({ status: 'acknowledged' }),
  });
  const result = await harness.bridge.cancel('task-1', ['bull-job-1']);

  assert.equal(result.cancellation.status, 'acknowledged');
  assert.deepEqual(harness.calls.slice(-4), [
    'getTask', 'requestTaskCancellation', 'lookupTaskExecution', 'getTask',
  ]);
});

test('cancellation fails closed when an active effect cannot be stopped safely', async () => {
  const harness = newHarness({
    progress: { completed: 0 },
    cancelJob: async () => ({
      status: 'cannot_cancel_safely',
      reason: 'provider request may already have completed',
    }),
  });
  const result = await harness.bridge.cancel('task-1', ['bull-job-1']);

  assert.equal(result.cancellation.status, 'cannot_cancel_safely');
  assert.equal(result.cancellation.reason, 'provider request may already have completed');
});

function newHarness({
  progress,
  terminalProjection = 'single-execution',
  resultReference,
  isTerminalFailure,
  progressMapper,
  onError,
  cancelJob,
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
    async requestTaskCancellation() {
      calls.push('requestTaskCancellation');
      task.state = 'cancel_requested';
      task.cancellation = { status: 'requested' };
      task.entityVersion += 1;
      return task;
    },
    async resolveTaskCancellation(id, expectedVersion, status, reason) {
      task.cancellation = { status, ...(reason ? { reason } : {}) };
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
    ...(cancelJob ? { cancelJob } : {}),
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
