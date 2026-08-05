import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BullMQTaskBridge,
  RhinoQClient,
  RhinoQError,
} from '../dist/index.js';

test('Gateway client exposes the versioned Task polling contract', async () => {
  const requests = [];
  const snapshot = {
    schemaVersion: 1,
    entityVersion: 2,
    id: 'task_01',
    type: 'report.export',
    state: 'queued',
    progress: { completed: 0 },
    hasResult: false,
    executions: [],
    createdAt: '2026-07-29T00:00:00Z',
    updatedAt: '2026-07-29T00:00:01Z',
  };
  const client = new RhinoQClient({
    url: 'http://gateway.test',
    fetch: async (url, options) => {
      requests.push({
        url,
        method: options.method,
        body: options.body ? JSON.parse(options.body) : undefined,
      });
      return Response.json(snapshot);
    },
  });

  await client.createTask({
    id: 'task_01',
    type: 'report.export',
    ownerId: 'user_01',
    definitionVersion: 1,
  });
  await client.createTaskExecution('task_01', {
    id: 'exec_01',
    runtime: 'bullmq',
  });
  await client.bindTaskExecution('exec_01', {
    runtime: 'bullmq',
    externalId: 'bull_job_01',
  });
  const polled = await client.getTask('task_01');
  await client.transitionTask('task_01', polled.entityVersion, 'running');
  await client.requestTaskCancellation('task_01', polled.entityVersion);
  await client.resolveTaskCancellation(
    'task_01',
    polled.entityVersion,
    'acknowledged',
    'worker reached a checkpoint',
  );
  await client.reportTaskProgress('task_01', polled.entityVersion, {
    completed: 1,
    total: 4,
  });
  await client.attachTaskResult(
    'task_01',
    polled.entityVersion,
    's3://reports/task_01.pdf',
  );
  await client.getTaskResult('task_01');

  assert.deepEqual(requests.map((request) => [request.method, request.url]), [
    ['POST', 'http://gateway.test/v1/tasks'],
    ['POST', 'http://gateway.test/v1/tasks/task_01/executions'],
    ['POST', 'http://gateway.test/v1/task-executions/exec_01/bind'],
    ['GET', 'http://gateway.test/v1/tasks/task_01'],
    ['POST', 'http://gateway.test/v1/tasks/task_01/state'],
    ['POST', 'http://gateway.test/v1/tasks/task_01/cancel'],
    ['POST', 'http://gateway.test/v1/tasks/task_01/cancellation'],
    ['POST', 'http://gateway.test/v1/tasks/task_01/progress'],
    ['POST', 'http://gateway.test/v1/tasks/task_01/result'],
    ['GET', 'http://gateway.test/v1/tasks/task_01/result'],
  ]);
  assert.deepEqual(requests[4].body, {
    expectedVersion: 2,
    state: 'running',
  });
  assert.deepEqual(requests[5].body, {
    expectedVersion: 2,
  });
  assert.deepEqual(requests[6].body, {
    expectedVersion: 2,
    status: 'acknowledged',
    reason: 'worker reached a checkpoint',
  });
  assert.deepEqual(requests[7].body, {
    expectedVersion: 2,
    progress: { completed: 1, total: 4 },
  });
  assert.deepEqual(requests[8].body, {
    expectedVersion: 2,
    reference: 's3://reports/task_01.pdf',
  });
});

test('BullMQ Task bridge projects an existing job without owning the queue', async () => {
  const events = new FakeQueueEvents();
  const client = new FakeTaskClient();
  const bridge = new BullMQTaskBridge({ client, events, terminalProjection: 'single-execution' });

  const queued = await bridge.track({
    task: { id: 'task_bull_01', type: 'report.export', definitionVersion: 1 },
    executionId: 'exec_bull_01',
    jobId: 'bull_job_01',
  });
  assert.equal(queued.state, 'queued');
  assert.equal(client.executions.get('exec_bull_01').state, 'dispatched');

  events.emit('active', { jobId: 'bull_job_01' });
  await flush();
  assert.equal((await client.getTask('task_bull_01')).state, 'running');
  assert.equal(client.executions.get('exec_bull_01').state, 'running');

  events.emit('progress', { jobId: 'bull_job_01', data: { completed: 2, total: 5, message: 'rendering' } });
  await flush();
  assert.deepEqual((await client.getTask('task_bull_01')).progress, {
    completed: 2, total: 5, message: 'rendering',
  });

  events.emit('completed', { jobId: 'bull_job_01' });
  await flush();
  assert.equal((await client.getTask('task_bull_01')).state, 'succeeded');
  assert.equal(client.executions.get('exec_bull_01').state, 'succeeded');

  bridge.close();
  assert.equal(events.listeners.size, 0);
});

test('BullMQ Task bridge reconciles one known completed job after an offline gap', async () => {
  const events = new FakeQueueEvents();
  const client = new FakeTaskClient();
  const bridge = new BullMQTaskBridge({ client, events, terminalProjection: 'single-execution' });

  await bridge.track({
    task: { id: 'task_bull_reconcile', type: 'report.export', definitionVersion: 1 },
    executionId: 'exec_bull_reconcile',
    jobId: 'bull_job_reconcile',
  });
  await bridge.reconcile({
    jobId: 'bull_job_reconcile',
    state: 'completed',
  });

  assert.equal((await client.getTask('task_bull_reconcile')).state, 'succeeded');
  assert.equal(client.executions.get('exec_bull_reconcile').state, 'succeeded');
  bridge.close();
});

test('BullMQ Task bridge records fan-out executions without completing the aggregate Task', async () => {
  const events = new FakeQueueEvents();
  const client = new FakeTaskClient();
  const bridge = new BullMQTaskBridge({
    client,
    events,
    terminalProjection: 'execution-only',
  });

  await bridge.track({
    task: { id: 'task_batch', type: 'bulk-download', definitionVersion: 1 },
    executionId: 'exec_item_1',
    itemKey: 'item-1',
    jobId: 'bull_item_1',
  });
  await bridge.track({
    task: { id: 'task_batch', type: 'bulk-download', definitionVersion: 1 },
    executionId: 'exec_item_2',
    itemKey: 'item-2',
    jobId: 'bull_item_2',
  });

  await bridge.reconcile({ jobId: 'bull_item_1', state: 'completed' });

  assert.equal((await client.getTask('task_batch')).state, 'running');
  assert.equal(client.executions.get('exec_item_1').state, 'succeeded');
  assert.equal(client.executions.get('exec_item_2').state, 'dispatched');

  await bridge.reconcile({ jobId: 'bull_item_2', state: 'completed' });

  assert.equal((await client.getTask('task_batch')).state, 'running');
  assert.equal(client.executions.get('exec_item_2').state, 'succeeded');
  bridge.close();
});

test('track refuses to start an unkeyed second item instead of merging it into default', async () => {
  const events = new FakeQueueEvents();
  const client = new FakeTaskClient();
  const bridge = new BullMQTaskBridge({ client, events, terminalProjection: 'execution-only' });

  await bridge.track({
    task: { id: 'task_key_guard', type: 'bulk-download', definitionVersion: 1 },
    executionId: 'exec_key_guard_1',
    jobId: 'bull_key_guard_1',
  });

  await assert.rejects(
    bridge.track({
      task: { id: 'task_key_guard', type: 'bulk-download', definitionVersion: 1 },
      executionId: 'exec_key_guard_2',
      jobId: 'bull_key_guard_2',
    }),
    /requires itemKey for a second job/,
  );
  assert.equal(client.executions.has('exec_key_guard_2'), false);
  bridge.close();
});

test('BullMQ Task bridge converges after a stale Task version conflict', async () => {
  const events = new FakeQueueEvents();
  const client = new FakeTaskClient();
  const bridge = new BullMQTaskBridge({ client, events, terminalProjection: 'single-execution' });

  await bridge.track({
    task: { id: 'task_bull_conflict', type: 'report.export', definitionVersion: 1 },
    executionId: 'exec_bull_conflict',
    jobId: 'bull_job_conflict',
  });
  client.taskVersionConflicts = 1;

  await bridge.reconcile({ jobId: 'bull_job_conflict', state: 'active' });

  assert.equal((await client.getTask('task_bull_conflict')).state, 'running');
  assert.equal(client.executions.get('exec_bull_conflict').state, 'running');
  bridge.close();
});

test('BullMQ Task bridge leaves an observed failed job running without terminal proof', async () => {
  const events = new FakeQueueEvents();
  const client = new FakeTaskClient();
  const bridge = new BullMQTaskBridge({ client, events, terminalProjection: 'single-execution' });

  await bridge.track({
    task: { id: 'task_bull_retry', type: 'report.export', definitionVersion: 1 },
    executionId: 'exec_bull_retry',
    jobId: 'bull_job_retry',
  });
  await bridge.reconcile({ jobId: 'bull_job_retry', state: 'active' });
  await bridge.reconcile({ jobId: 'bull_job_retry', state: 'failed' });

  assert.equal((await client.getTask('task_bull_retry')).state, 'running');
  assert.equal(client.executions.get('exec_bull_retry').state, 'running');
  bridge.close();
});

test('Gateway client sends UTF-8 JSON safely without argument spreading limits', async () => {
  let request;
  const client = new RhinoQClient({
    url: 'http://gateway.test/',
    token: 'secret',
    fetch: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return Response.json({ jobId: 'job_01' }, { status: 201 });
    },
  });
  const large = `Báo cáo 🦏 ${'x'.repeat(300_000)}`;

  const id = await client.enqueue({
    queueName: 'generate-report',
    jobName: 'generate-report',
    payload: { title: large },
  });

  assert.equal(id, 'job_01');
  assert.equal(request.url, 'http://gateway.test/v1/jobs');
  assert.equal(request.options.headers.authorization, 'Bearer secret');
  const decoded = Buffer.from(request.body.payload, 'base64').toString('utf8');
  assert.deepEqual(JSON.parse(decoded), { title: large });
});

test('Gateway claim sends subscribed queues and decodes payload bytes', async () => {
  let body;
  const client = new RhinoQClient({
    url: 'http://gateway.test',
    fetch: async (_url, options) => {
      body = JSON.parse(options.body);
      return Response.json({
        jobs: [{
          job: {
            id: 'job_01',
            queueName: 'send-email',
            jobName: 'send-email',
            state: 'leased',
            resourceClass: 'standard',
            priority: 0,
            attempts: 1,
            crashCount: 0,
            createdAt: '2026-01-01T00:00:00Z',
            notBefore: '2026-01-01T00:00:00Z',
            cancelRequested: false,
          },
          payload: Buffer.from('{"userId":"u1"}').toString('base64'),
          lease: { jobId: 'job_01', owner: 'email-1', epoch: 1 },
          expiresAt: '2026-01-01T00:01:00Z',
        }],
      });
    },
  });

  const jobs = await client.claim('email-1', 4, 60_000, ['send-email']);

  assert.deepEqual(body.queueNames, ['send-email']);
  assert.equal(new TextDecoder().decode(jobs[0].payload), '{"userId":"u1"}');
});

test('Gateway claim omits queue filter for a compatible older server', async () => {
  let body;
  const client = new RhinoQClient({
    url: 'http://gateway.test',
    fetch: async (_url, options) => {
      body = JSON.parse(options.body);
      return Response.json({ jobs: [] });
    },
  });

  await client.claim('legacy-worker', 1);

  assert.equal(Object.hasOwn(body, 'queueNames'), false);
});

test('Gateway client records external effect confirmation evidence', async () => {
  let request;
  const client = new RhinoQClient({
    url: 'http://gateway.test',
    fetch: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return Response.json({
        id: 'effect_01',
        name: 'create-video',
        state: 'confirmed',
        externalRef: 'event_01',
        irreversible: false,
      });
    },
  });

  const effect = await client.confirmEffect('job_01', {
    name: 'create-video',
    key: 'video:01',
    reference: 'event_01',
  });

  assert.equal(request.url, 'http://gateway.test/v1/effects/confirm');
  assert.deepEqual(request.body, {
    jobId: 'job_01',
    name: 'create-video',
    key: 'video:01',
    reference: 'event_01',
  });
  assert.equal(effect.state, 'confirmed');
});

test('Gateway client preserves typed retry information', async () => {
  const client = new RhinoQClient({
    url: 'http://gateway.test',
    fetch: async () => Response.json({
      error: {
        code: 'RHINOQ_QUEUE_OVER_CAPACITY',
        message: 'queue is full',
        retryable: true,
        retryAfterMs: 5000,
      },
    }, { status: 429 }),
  });

  await assert.rejects(
    client.enqueue({ queueName: 'reports', jobName: 'reports', payload: {} }),
    (error) => {
      assert.ok(error instanceof RhinoQError);
      assert.equal(error.code, 'RHINOQ_QUEUE_OVER_CAPACITY');
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfterMs, 5000);
      assert.equal(error.status, 429);
      return true;
    },
  );
});

class FakeQueueEvents {
  listeners = new Map();

  on(name, listener) {
    this.listeners.set(name, listener);
  }

  off(name) {
    this.listeners.delete(name);
  }

  emit(name, event) {
    this.listeners.get(name)?.(event);
  }
}

class FakeTaskClient {
  tasks = new Map();
  executions = new Map();
  byExternalID = new Map();
  taskVersionConflicts = 0;

  async createTask(request) {
    const task = snapshot({ id: request.id, type: request.type, state: 'pending' });
    this.tasks.set(task.id, task);
    return task;
  }

  async getTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new RhinoQError('RHINOQ_TASK_NOT_FOUND', 'not found', false, { status: 404 });
    }
    return task;
  }

  async createTaskExecution(taskId, request) {
    const task = await this.getTask(taskId);
    const execution = {
      id: request.id, taskId, runtime: request.runtime, state: 'pending_dispatch', version: 1,
    };
    this.executions.set(execution.id, execution);
    return this.bump(task, { executions: [execution] });
  }

  async bindTaskExecution(executionId, binding) {
    const execution = this.executions.get(executionId);
    execution.state = 'dispatched';
    execution.version++;
    this.byExternalID.set(binding.externalId, executionId);
    return this.bump(await this.getTask(execution.taskId));
  }

  async lookupTaskExecution(_runtime, externalId) {
    const executionId = this.byExternalID.get(externalId);
    if (!executionId) {
      throw new RhinoQError('RHINOQ_EXECUTION_NOT_FOUND', 'not found', false, { status: 404 });
    }
    return this.executions.get(executionId);
  }

  async getTaskExecution(executionId) {
    return this.executions.get(executionId);
  }

  async transitionTaskExecution(executionId, expectedVersion, state) {
    const execution = this.executions.get(executionId);
    assert.equal(execution.version, expectedVersion);
    execution.state = state;
    execution.version++;
    return this.bump(await this.getTask(execution.taskId));
  }

  async transitionTask(taskId, expectedVersion, state) {
    const task = await this.getTask(taskId);
    if (this.taskVersionConflicts > 0) {
      this.taskVersionConflicts--;
      this.bump(task);
      throw new RhinoQError('RHINOQ_VERSION_CONFLICT', 'stale version', true, { status: 409 });
    }
    assert.equal(task.entityVersion, expectedVersion);
    return this.bump(task, { state });
  }

  async reportTaskProgress(taskId, expectedVersion, progress) {
    const task = await this.getTask(taskId);
    assert.equal(task.entityVersion, expectedVersion);
    return this.bump(task, { progress });
  }

  async attachTaskResult() {
    throw new Error('not expected');
  }

  bump(task, fields = {}) {
    const next = {
      ...task,
      ...fields,
      entityVersion: task.entityVersion + 1,
      updatedAt: '2026-07-29T00:00:01Z',
    };
    this.tasks.set(next.id, next);
    return next;
  }
}

function snapshot({ id, type, state }) {
  return {
    schemaVersion: 1,
    entityVersion: 1,
    id,
    type,
    state,
    progress: { completed: 0 },
    hasResult: false,
    executions: [],
    createdAt: '2026-07-29T00:00:00Z',
    updatedAt: '2026-07-29T00:00:00Z',
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}
