import assert from 'node:assert/strict';
import test from 'node:test';

import { BullMQTaskBridge } from '../dist/index.js';

// cancel() records the cancellation outcome. It has never moved the Task to a
// terminal state, and under aggregate.terminal: 'manual' — the default —
// nothing else does either, so an acknowledged cancellation left the Task
// sitting at cancel_requested until the application noticed and finished it.

test('by default an acknowledged cancellation leaves the Task for the application', async () => {
  const harness = newHarness();
  try {
    const task = await harness.bridge.cancel('task-1', ['bull-job-1']);

    assert.equal(task.state, 'cancel_requested');
    assert.equal(task.cancellation.status, 'acknowledged');
    assert.equal(harness.executions[0].state, 'running', 'the attempt is untouched');
    assert.deepEqual(harness.warnings, []);
  } finally {
    harness.bridge.close();
  }
});

test('terminalizeOnCancel closes the attempts and then the Task', async () => {
  const harness = newHarness({ terminalizeOnCancel: true });
  try {
    const task = await harness.bridge.cancel('task-1', ['bull-job-1']);

    assert.equal(harness.executions[0].state, 'cancelled');
    assert.equal(task.state, 'cancelled');
    assert.equal(task.cancellation.status, 'acknowledged');
    assert.deepEqual(harness.warnings, []);
  } finally {
    harness.bridge.close();
  }
});

// jobIds is application-supplied. A short list must not close a Task whose
// other items are still running, because a terminal Task is never reopened.
test('terminalizeOnCancel refuses while another Execution is still open', async () => {
  const harness = newHarness({
    terminalizeOnCancel: true,
    extraExecutions: [{ id: 'exec-2', taskId: 'task-1', runtime: 'bullmq', state: 'running', version: 1, attempt: 1 }],
  });
  try {
    const task = await harness.bridge.cancel('task-1', ['bull-job-1']);

    assert.equal(harness.executions[0].state, 'cancelled', 'the named job still stops');
    assert.equal(task.state, 'cancel_requested');
    assert.equal(harness.warnings.length, 1);
    assert.match(harness.warnings[0], /stays at cancel_requested/);
    assert.match(harness.warnings[0], /exec-2/);
    assert.match(harness.warnings[0], /pass the complete job list/);
  } finally {
    harness.bridge.close();
  }
});

test('an already terminal Execution is not transitioned again', async () => {
  const harness = newHarness({ terminalizeOnCancel: true, executionState: 'succeeded' });
  try {
    const task = await harness.bridge.cancel('task-1', ['bull-job-1']);

    assert.equal(harness.executions[0].state, 'succeeded');
    assert.equal(task.state, 'cancelled');
    assert.ok(!harness.calls.includes('transitionTaskExecution'));
  } finally {
    harness.bridge.close();
  }
});

// A Task that already refused the request answers too_late. Nothing after that
// point may touch it, terminalizeOnCancel included.
test('terminalizeOnCancel does not touch a Task that refused the request', async () => {
  const harness = newHarness({ terminalizeOnCancel: true, taskState: 'succeeded' });
  try {
    const task = await harness.bridge.cancel('task-1', ['bull-job-1']);

    assert.equal(task.state, 'succeeded');
    assert.ok(!harness.calls.includes('resolveTaskCancellation'));
    assert.equal(harness.executions[0].state, 'running');
  } finally {
    harness.bridge.close();
  }
});

function newHarness({
  terminalizeOnCancel = false,
  extraExecutions = [],
  executionState = 'running',
  taskState = 'running',
} = {}) {
  const calls = [];
  const warnings = [];
  const executions = [
    { id: 'exec-1', taskId: 'task-1', runtime: 'bullmq', state: executionState, version: 2, attempt: 1 },
    ...extraExecutions,
  ];
  const task = {
    schemaVersion: 1,
    entityVersion: 4,
    id: 'task-1',
    type: 'bulk-download',
    state: taskState,
    cancellation: { status: 'none' },
    progress: { completed: 0 },
    hasResult: false,
    executions,
    createdAt: '2026-08-01T10:00:00Z',
    updatedAt: '2026-08-01T10:00:00Z',
  };
  const byId = (id) => executions.find((execution) => execution.id === id);
  const client = {
    async lookupTaskExecution(runtime, externalId) {
      calls.push('lookupTaskExecution');
      assert.equal(externalId, 'bull-job-1');
      return executions[0];
    },
    async getTaskExecution(id) {
      calls.push('getTaskExecution');
      return byId(id);
    },
    async getTask() {
      calls.push('getTask');
      return task;
    },
    async transitionTaskExecution(id, expectedVersion, next) {
      calls.push('transitionTaskExecution');
      const execution = byId(id);
      assert.equal(expectedVersion, execution.version, 'stale execution version');
      execution.state = next;
      execution.version += 1;
      return task;
    },
    async transitionTask(id, expectedVersion, next) {
      calls.push('transitionTask');
      assert.equal(expectedVersion, task.entityVersion, 'stale task version');
      task.state = next;
      task.entityVersion += 1;
      return task;
    },
    async requestTaskCancellation(id, expectedVersion) {
      calls.push('requestTaskCancellation');
      assert.equal(expectedVersion, task.entityVersion);
      // The Gateway answers a late request on a terminal Task with `too_late`
      // and leaves the state alone, rather than reopening it.
      if (task.state !== 'queued' && task.state !== 'running') {
        task.cancellation = { status: 'too_late' };
        task.entityVersion += 1;
        return task;
      }
      task.state = 'cancel_requested';
      task.cancellation = { status: 'requested' };
      task.entityVersion += 1;
      return task;
    },
    async resolveTaskCancellation(id, expectedVersion, status, reason) {
      calls.push('resolveTaskCancellation');
      assert.equal(expectedVersion, task.entityVersion);
      task.cancellation = { status, ...(reason ? { reason } : {}) };
      task.entityVersion += 1;
      return task;
    },
  };

  const bridge = new BullMQTaskBridge({
    client,
    events: { on() {}, off() {} },
    runtimeScope: `cancel-${Math.random().toString(36).slice(2)}`,
    terminalProjection: 'execution-only',
    terminalizeOnCancel,
    cancelJob: async () => ({ status: 'acknowledged' }),
    onWarning: (warning) => warnings.push(warning),
  });

  return { bridge, task, executions, calls, warnings };
}
