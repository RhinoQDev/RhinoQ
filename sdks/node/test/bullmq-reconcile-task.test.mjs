import assert from 'node:assert/strict';
import test from 'node:test';

import { BullMQTaskBridge } from '../dist/index.js';

test('reconcileTask reads latest runtime refs and repairs a missed event gap', async () => {
  const observed = [];
  const executions = [
    { id: 'exec-a-1', taskId: 'task-1', itemKey: 'a', attempt: 1, runtime: 'bullmq', runtimeScope: 'reports', externalId: 'job-a', state: 'succeeded', version: 3 },
    { id: 'exec-a-2', taskId: 'task-1', itemKey: 'a', attempt: 2, runtime: 'bullmq', runtimeScope: 'reports', externalId: 'job-a', state: 'dispatched', version: 1 },
    { id: 'exec-b-1', taskId: 'task-1', itemKey: 'b', attempt: 1, runtime: 'bullmq', runtimeScope: 'reports', externalId: 'job-b', state: 'dispatched', version: 1 },
    { id: 'exec-native', taskId: 'task-1', itemKey: 'c', attempt: 1, runtime: 'native', runtimeScope: '', externalId: 'job-c', state: 'running', version: 1 },
  ];
  const task = {
    schemaVersion: 1, entityVersion: 1, id: 'task-1', type: 'batch', state: 'running',
    cancellation: { status: 'none' }, progress: { completed: 0 }, hasResult: false,
    executions, createdAt: '2026-08-04T00:00:00Z', updatedAt: '2026-08-04T00:00:00Z',
  };
  const client = {
    async listTaskExecutionRuntimeRefs() {
      return {
        schemaVersion: 1, entityVersion: task.entityVersion, taskId: task.id,
        executions: executions.map((execution) => ({
          executionId: execution.id, itemKey: execution.itemKey, attempt: execution.attempt,
          runtime: execution.runtime, runtimeScope: execution.runtimeScope,
          externalId: execution.externalId, state: execution.state,
        })),
      };
    },
    async lookupTaskExecution(_runtime, externalId) {
      const execution = executions.find((item) => item.externalId === externalId && item.state !== 'succeeded');
      assert.ok(execution, `missing live execution for ${externalId}`);
      return execution;
    },
    async getTaskExecution(id) { return executions.find((execution) => execution.id === id); },
    async getTask() { return task; },
    async transitionTaskExecution(id, expectedVersion, state) {
      const execution = executions.find((item) => item.id === id);
      assert.equal(execution.version, expectedVersion);
      execution.state = state;
      execution.version += 1;
      return task;
    },
    async transitionTask(_id, expectedVersion, state) {
      assert.equal(task.entityVersion, expectedVersion);
      task.state = state;
      task.entityVersion += 1;
      return task;
    },
  };
  const bridge = new BullMQTaskBridge({
    client,
    events: { on() {}, off() {} },
    runtimeScope: 'reports',
    terminalProjection: 'execution-only',
  });
  try {
    const count = await bridge.reconcileTask('task-1', async (reference) => {
      observed.push(reference.externalId);
      return reference.externalId === 'job-a'
        ? { state: 'completed', jobId: reference.externalId }
        : { state: 'active', jobId: reference.externalId, attempt: reference.attempt };
    });

    assert.equal(count, 2);
    assert.deepEqual(observed, ['job-a', 'job-b']);
    assert.equal(executions[1].state, 'succeeded');
    assert.equal(executions[2].state, 'running');
  } finally {
    bridge.close();
  }
});

test('reconcileTask refuses a client without the bounded runtime-reference read', async () => {
  const bridge = new BullMQTaskBridge({
    client: {},
    events: { on() {}, off() {} },
    runtimeScope: 'reports',
    terminalProjection: 'execution-only',
  });
  try {
    await assert.rejects(
      bridge.reconcileTask('task-1', async () => undefined),
      /listTaskExecutionRuntimeRefs/,
    );
  } finally {
    bridge.close();
  }
});
