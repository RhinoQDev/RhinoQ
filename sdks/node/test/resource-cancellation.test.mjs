import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PostgresTaskClient,
  RhinoQResourceLeaseLostError,
  RhinoQResourceUnavailableError,
  RhinoQUserCancellationError,
  RhinoQWorkerShutdownError,
  createDurableTaskContext,
  createRhinoQResourceLeaseHeartbeat,
  defineRhinoQTask,
} from '../dist/index.js';

const envelope = (name, taskId = 'task-1') => ({
  taskName: name, definitionVersion: 1, taskId, executionId: `${taskId}:attempt:1`, payload: {},
});

const pool = {
  key: 'media-workers',
  capacity: { cpu: 4, memoryBytes: 8_000, diskBytes: 16_000, network: 10 },
  leaseMs: 1_000,
  retryAfterMs: 500,
};

const resourceRow = (overrides = {}) => ({
  id: 'resource-1', pool_key: 'media-workers', task_id: 'task-1', execution_id: 'execution-1',
  lease_owner: 'worker-a', lease_epoch: 1, cpu: 1, memory_bytes: 512,
  disk_bytes: 1_024, network: 1, lease_until: '2026-08-23T00:01:00.000Z',
  ...overrides,
});

test('PostgreSQL resource lease client uses fenced shared-capacity commands', async () => {
  const calls = [];
  const client = new PostgresTaskClient({
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes('acquire_resource_lease')) return { rows: [resourceRow()] };
      if (text.includes('renew_resource_lease')) return { rows: [resourceRow({ lease_until: '2026-08-23T00:02:00.000Z' })] };
      if (text.includes('release_resource_lease')) return { rows: [{ released: true }] };
      return { rows: [] };
    },
  });
  const acquired = await client.acquireResourceLease({
    pool, taskId: 'task-1', executionId: 'execution-1', owner: 'worker-a',
    resources: { cpu: 1, memoryBytes: 512, diskBytes: 1_024, network: 1 },
  });
  assert.equal(acquired.poolKey, 'media-workers');
  const renewed = await client.renewResourceLease(acquired, 1_000);
  assert.equal(renewed.expiresAt, '2026-08-23T00:02:00.000Z');
  await client.releaseResourceLease(renewed);
  assert.ok(calls.some((call) => call.text.includes('acquire_resource_lease') && call.values[4] === 'worker-a'));
  assert.ok(calls.some((call) => call.text.includes('renew_resource_lease') && call.values[2] === 1));
  assert.ok(calls.some((call) => call.text.includes('release_resource_lease') && call.values[2] === 1));
});

test('resource heartbeat discards a handler result after a renewal loss', async () => {
  const heartbeat = createRhinoQResourceLeaseHeartbeat({
    async renewResourceLease() { throw new Error('fence lost'); },
    async acquireResourceLease() { throw new Error('not used'); },
    async releaseResourceLease() {},
  }, {
    id: 'resource-1', poolKey: 'media-workers', taskId: 'task-1', executionId: 'execution-1',
    owner: 'worker-a', epoch: 1, resources: { cpu: 1, memoryBytes: 0, diskBytes: 0, network: 0 },
    expiresAt: new Date(Date.now() + 1_000).toISOString(),
  }, 1_000);
  await new Promise((resolve) => setTimeout(resolve, 600));
  await heartbeat.stop();
  assert.throws(() => heartbeat.assertOwned(), RhinoQResourceLeaseLostError);
});

test('resource admission runs user code only while a shared lease is held and releases it afterwards', async () => {
  const calls = [];
  const resources = {
    async acquireResourceLease(request) {
      calls.push(['acquire', request]);
      return { id: 'resource-1', poolKey: request.pool.key, taskId: request.taskId, executionId: request.executionId,
        owner: request.owner, epoch: 1, resources: request.resources, expiresAt: new Date(Date.now() + 1_000).toISOString() };
    },
    async renewResourceLease(lease) { calls.push(['renew', lease]); return lease; },
    async releaseResourceLease(lease) { calls.push(['release', lease]); },
  };
  let ran = false;
  const task = defineRhinoQTask({ async dispatch() {} }, {
    name: 'media.render', adapter: 'manual', runtime: 'manual', scope: 'media',
    resources: { cpu: 1, memoryBytes: 512, diskBytes: 1_024, network: 1 },
    run: async () => { ran = true; return 'rendered'; },
  }, { workerId: 'worker-a', resources: { client: resources, pool } });
  assert.equal(await task.workerHandler()({ data: envelope('media.render') }), 'rendered');
  assert.equal(ran, true);
  assert.deepEqual(calls.map(([kind]) => kind), ['acquire', 'release']);
});

test('resource admission rejection is retryable and starts no user code', async () => {
  let ran = false;
  const task = defineRhinoQTask({ async dispatch() {} }, {
    name: 'media.wait', adapter: 'manual', runtime: 'manual', scope: 'media', resources: { cpu: 1 },
    run: async () => { ran = true; },
  }, { workerId: 'worker-a', resources: { pool, client: {
    async acquireResourceLease() { throw new RhinoQResourceUnavailableError(pool.key, { cpu: 1, memoryBytes: 0, diskBytes: 0, network: 0 }, 500); },
    async renewResourceLease() { throw new Error('not used'); }, async releaseResourceLease() {},
  } } });
  await assert.rejects(task.workerHandler()({ data: envelope('media.wait') }), RhinoQResourceUnavailableError);
  assert.equal(ran, false);
});

test('user cancellation terminalizes the Task and cancels an owned Durable Step', async () => {
  const transitions = [];
  let ran = false;
  const task = defineRhinoQTask({ async dispatch() {} }, {
    name: 'media.cancel', adapter: 'manual', runtime: 'manual', scope: 'media', run: async () => { ran = true; },
  }, { cancellation: { client: {
    async getTask() { return { id: 'task-1', state: 'cancel_requested', entityVersion: 7, cancellation: { status: 'requested', reason: 'User requested cancellation.' } }; },
    async transitionTask(...args) { transitions.push(args); return { state: 'cancelled' }; },
  } } });
  await assert.rejects(task.workerHandler()({ data: envelope('media.cancel') }), RhinoQUserCancellationError);
  assert.equal(ran, false);
  assert.deepEqual(transitions, [['task-1', 7, 'cancelled']]);

  let cancelled = 0, failed = 0;
  const controller = new AbortController();
  controller.abort(new RhinoQUserCancellationError('task-2'));
  const context = createDurableTaskContext({ taskId: 'task-2', executionId: 'e-2', taskVersion: 1, signal: controller.signal, steps: {
    async acquireDurableStep(request) { return { action: 'acquired', state: 'running', lease: { stepId: 'step-2', attemptId: 'step-2:1', owner: request.owner, epoch: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(), attempt: 1 } }; },
    async renewDurableStep(lease) { return lease; },
    async completeDurableStep() { throw new Error('must not complete'); },
    async failDurableStep() { failed += 1; return { state: 'failed' }; },
    async cancelDurableStep() { cancelled += 1; return { state: 'cancelled' }; },
    async listDurableSteps() { return []; },
  } });
  await assert.rejects(context.step('render', async () => 'ignored'), RhinoQUserCancellationError);
  assert.equal(cancelled, 1);
  assert.equal(failed, 0);
});

test('worker shutdown abort remains retryable and does not terminalize the Task', async () => {
  const controller = new AbortController();
  controller.abort(new Error('deployment rolling restart'));
  let ran = false;
  const task = defineRhinoQTask({ async dispatch() {} }, {
    name: 'media.shutdown', adapter: 'manual', runtime: 'manual', scope: 'media', run: async () => { ran = true; },
  });
  await assert.rejects(task.workerHandler()({ data: envelope('media.shutdown'), signal: controller.signal }), RhinoQWorkerShutdownError);
  assert.equal(ran, false);
});
