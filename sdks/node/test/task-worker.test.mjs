import assert from 'node:assert/strict';
import test from 'node:test';

import { TaskHandle, createTaskWorker } from '../dist/index.js';

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'task-worker-1',
    type: 'report.export',
    state: 'pending',
    entityVersion: 1,
    progress: { completed: 0 },
    hasResult: false,
    executions: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function fakeTaskClient(initial = snapshot()) {
  let current = initial;
  const calls = [];
  const bump = (patch) => {
    current = { ...current, ...patch, entityVersion: current.entityVersion + 1 };
    return current;
  };
  const commandClient = {
    async getTask() { return current; },
    async transitionTask(_id, version, state) { calls.push(['transition', version, state]); return bump({ state }); },
    async reportTaskProgress(_id, version, progress) { calls.push(['progress', version, progress]); return bump({ progress }); },
    async requestTaskCancellation(_id, version) { calls.push(['cancel', version]); return bump({ state: 'cancel_requested' }); },
    async attachTaskResult(_id, version, reference) { calls.push(['result', version, reference]); bump({ hasResult: true }); return {}; },
  };
  return {
    calls,
    async openTask() { return new TaskHandle(commandClient, current); },
  };
}

test('createTaskWorker validates type, serializes progress and completes one Task', async () => {
  const client = fakeTaskClient();
  const runtimeProgress = [];
  const worker = createTaskWorker({
    client,
    type: 'report.export',
    resultRef: (output) => output.reference,
    handler: async (payload, context) => {
      assert.deepEqual(payload, { reportId: '42' });
      await Promise.all([
        context.progress({ completed: 1, total: 2 }),
        context.progress({ completed: 2, total: 2 }),
      ]);
      return { reference: `s3://reports/${payload.reportId}.csv` };
    },
  });

  const output = await worker({
    taskId: 'task-worker-1',
    type: 'report.export',
    payload: { reportId: '42' },
    updateProgress: (progress) => runtimeProgress.push(progress),
  });

  assert.equal(output.reference, 's3://reports/42.csv');
  assert.deepEqual(client.calls.map(([kind]) => kind), ['transition', 'transition', 'progress', 'progress', 'result', 'transition']);
  assert.deepEqual(runtimeProgress.map(({ completed }) => completed), [1, 2]);
  assert.deepEqual(client.calls.slice(0, 2).map(([, version, state]) => [version, state]), [[1, 'queued'], [2, 'running']]);
  assert.deepEqual(client.calls.at(-1).slice(1), [6, 'succeeded']);
});

test('createTaskWorker refuses an unregistered job type before running the handler', async () => {
  const client = fakeTaskClient();
  let called = false;
  const worker = createTaskWorker({
    client,
    type: 'report.export',
    handler: async () => { called = true; },
  });

  await assert.rejects(
    () => worker({ taskId: 'task-worker-1', type: 'video.export', payload: {} }),
    /refuses type/,
  );
  assert.equal(called, false);
});

test('createTaskWorker records failure and does not invent retry policy', async () => {
  const client = fakeTaskClient();
  const worker = createTaskWorker({
    client,
    type: 'report.export',
    handler: async () => { throw new Error('handler failed'); },
  });

  await assert.rejects(() => worker({ taskId: 'task-worker-1', payload: {} }), /handler failed/);
  assert.equal(client.calls.at(-1)[2], 'failed');
  assert.equal(client.calls.filter(([kind]) => kind === 'transition').length, 3);
});
