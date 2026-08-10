import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApplicationTaskClient,
  RhinoQError,
  createTaskRequestHandler,
} from '../dist/index.js';

test('application Task handler reuses host auth without a RhinoQ token', async () => {
  const snapshot = {
    schemaVersion: 1,
    entityVersion: 3,
    id: 'task-1',
    type: 'export',
    ownerId: 'owner-a',
    state: 'running',
    cancellation: { status: 'none' },
    progress: { completed: 1, total: 2 },
    hasResult: false,
    executions: [],
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:01.000Z',
  };
  const tasks = {
    async listTasks(ownerId) {
      assert.equal(ownerId, 'owner-a');
      return [snapshot];
    },
    async getTaskForOwner(taskId, ownerId) {
      if (taskId !== snapshot.id || ownerId !== snapshot.ownerId) {
        throw new RhinoQError('RHINOQ_TASK_NOT_FOUND', taskId, false, {
          status: 404,
        });
      }
      return snapshot;
    },
	async getTaskSummaryForOwner(taskId, ownerId) {
		const { executions, ...summary } = await this.getTaskForOwner(taskId, ownerId);
		return summary;
	},
	async listTaskExecutionsForOwner(taskId, ownerId, cursor, limit) {
		await this.getTaskForOwner(taskId, ownerId);
		assert.equal(cursor, 'next'); assert.equal(limit, 2);
		return { schemaVersion: 1, entityVersion: 3, taskId, executions: [], nextCursor: 'done' };
	},
    async requestTaskCancellationForOwner(taskId, ownerId, expectedVersion) {
      assert.equal(taskId, snapshot.id);
      assert.equal(ownerId, snapshot.ownerId);
      assert.equal(expectedVersion, snapshot.entityVersion);
      return {
        ...snapshot,
        entityVersion: 4,
        state: 'cancel_requested',
        cancellation: { status: 'requested' },
      };
    },
    async createTaskWaitpoint(taskId, request) {
      return { schemaVersion: 1, entityVersion: 1, taskId, state: 'waiting', createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt, ...request };
    },
    async getTaskWaitpoint(id, ownerId) {
      assert.equal(ownerId, 'owner-a');
      return { schemaVersion: 1, entityVersion: 1, id, taskId: 'task-1', key: 'approve', kind: 'approval', state: 'waiting', payloadVersion: 1, createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt };
    },
    async listTaskWaitpointsForOwner(taskId, ownerId, limit) {
      assert.equal(taskId, 'task-1'); assert.equal(ownerId, 'owner-a'); assert.equal(limit, 100);
      return [await this.getTaskWaitpoint('wp-1', ownerId)];
    },
    async listWaitingTaskWaitpointsForOwner(ownerId, limit) {
      assert.equal(ownerId, 'owner-a'); assert.equal(limit, 50);
      return [await this.getTaskWaitpoint('wp-1', ownerId)];
    },
    async resolveTaskWaitpoint(id, ownerId, request) {
      const current = await this.getTaskWaitpoint(id, ownerId);
      return { ...current, entityVersion: 2, state: 'resolved', resolution: request.resolution, resolvedBy: ownerId };
    },
    async getTaskExecutionResultsForOwner(taskId, ownerId) {
      await this.getTaskForOwner(taskId, ownerId);
      return { schemaVersion: 1, entityVersion: 3, taskId, executions: [] };
    },
  };
  const handler = createTaskRequestHandler({
    tasks,
    ownerFromRequest: (request) => request.headers.get('x-owner') ?? undefined,
    retryTask: async ({ task, ownerId, commandId }) => {
      assert.equal(task.id, 'task-1'); assert.equal(ownerId, 'owner-a'); assert.equal(commandId, 'retry-1');
      return { ...task, entityVersion: 5, state: 'queued' };
    },
    health: async () => ({ status: 'ok' }),
  });
  const client = new ApplicationTaskClient({
    url: 'http://app.test/tasks',
    headers: () => ({ 'x-owner': 'owner-a' }),
    fetch: (input, init) => handler(new Request(input, init)),
  });

  const capabilities = await (await handler(new Request('http://app.test/tasks/_capabilities', {
    headers: { 'x-owner': 'owner-a' },
  }))).json();
  assert.deepEqual(capabilities, {
    schemaVersion: 1, cancel: true, retry: true, result: false, waitpoints: true, stream: true,
  });
  assert.deepEqual(await client.capabilities(), capabilities);
  const unresolvedResult = await handler(new Request('http://app.test/tasks/task-1/result', {
    headers: { 'x-owner': 'owner-a' },
  }));
  assert.equal(unresolvedResult.status, 501);
  assert.equal((await unresolvedResult.json()).code, 'RHINOQ_RESULT_NOT_CONFIGURED');

  assert.equal((await client.getTask('task-1')).entityVersion, 3);
	assert.equal((await client.getTaskSummary('task-1')).executions, undefined);
	assert.equal((await client.listTaskExecutions('task-1', 'next', 2)).nextCursor, 'done');
  assert.equal((await client.listTasks()).length, 1);
  const cancelled = await client.cancelTask('task-1', 3);
  assert.equal(cancelled.state, 'cancel_requested');
  assert.equal(cancelled.cancellation.status, 'requested');
  assert.equal((await client.health()).status, 'ok');
  const waitpoint = await client.createTaskWaitpoint('task-1', { id: 'wp-1', key: 'approve', kind: 'approval', payloadVersion: 1 });
  assert.equal(waitpoint.state, 'waiting');
  assert.equal((await client.getTaskWaitpoint('task-1', 'wp-1')).taskId, 'task-1');
  assert.equal((await client.listTaskWaitpoints('task-1'))[0].kind, 'approval');
  assert.equal((await client.listWaitingTaskWaitpoints())[0].taskId, 'task-1');
  const invalidWaitpointPage = await handler(new Request('http://app.test/tasks/task-1/waitpoints?limit=101', { headers: { 'x-owner': 'owner-a' } }));
  assert.equal(invalidWaitpointPage.status, 400);
  const resolved = await client.resolveTaskWaitpoint('task-1', 'wp-1', { expectedVersion: 1, resolutionId: 'submit-1', resolution: { approved: true } });
  assert.equal(resolved.state, 'resolved');
  assert.equal((await client.getTaskGroupManifest('task-1')).taskId, 'task-1');
  const failedItems = await client.downloadFailedTaskItems('task-1', 'csv');
  assert.match(await failedItems.text(), /^taskId,itemKey/);
  assert.throws(() => client.retryTask('task-1', 4, ''), /commandId/i);
});

test('result download is capability-gated and owner-authorized', async () => {
  let reads = 0;
  const handler = createTaskRequestHandler({
    tasks: {
      async getTaskResultForOwner(taskId, ownerId) {
        reads++;
        assert.equal(taskId, 'task-result');
        assert.equal(ownerId, 'owner-a');
        return { schemaVersion: 1, entityVersion: 2, taskId, reference: 'storage://private', updatedAt: '2026-08-10T00:00:00Z' };
      },
    },
    ownerFromRequest: () => 'owner-a',
    resolveResult: async (result) => ({ url: `/downloads/${result.taskId}` }),
  });
  const capabilities = await (await handler(new Request('http://app.test/tasks/_capabilities'))).json();
  assert.equal(capabilities.result, true);
  const response = await handler(new Request('http://app.test/tasks/task-result/result'));
  assert.deepEqual(await response.json(), { url: '/downloads/task-result' });
  assert.equal(reads, 1);
});

test('application Task retry is owner-scoped and command-identified', async () => {
  const failed = {
    schemaVersion: 1, entityVersion: 9, id: 'task-9', type: 'export', ownerId: 'owner-a', state: 'failed',
    cancellation: { status: 'none' }, progress: { completed: 0 }, hasResult: false, executions: [],
    createdAt: '2026-07-30T00:00:00.000Z', updatedAt: '2026-07-30T00:00:01.000Z',
  };
  const seen = [];
  const handler = createTaskRequestHandler({
    tasks: { async getTaskForOwner(id, owner) { assert.equal(owner, 'owner-a'); return { ...failed, id }; } },
    ownerFromRequest: () => 'owner-a',
    retryTask: async (command) => { seen.push(command); return { ...command.task, entityVersion: 10, state: 'queued' }; },
  });
  const client = new ApplicationTaskClient({ url: 'http://app.test/tasks', fetch: (input, init) => handler(new Request(input, init)) });

  const retried = await client.retryTask('task-9', 9, 'retry-command-9');
  assert.equal(retried.state, 'queued');
  assert.equal(seen[0].commandId, 'retry-command-9');
  assert.equal(seen[0].ownerId, 'owner-a');

  const missing = await handler(new Request('http://app.test/tasks/task-9/retry', { method: 'POST', body: JSON.stringify({ expectedVersion: 9 }) }));
  assert.equal(missing.status, 400);
  const conflict = await handler(new Request('http://app.test/tasks/task-9/retry', { method: 'POST', body: JSON.stringify({ expectedVersion: 8, commandId: 'retry-command-8' }) }));
  assert.equal(conflict.status, 409);
});

test('runtime-aware cancellation verifies ownership before handing work to the runtime', async () => {
  const task = {
    schemaVersion: 1, entityVersion: 7, id: 'task-cancel', type: 'export', ownerId: 'owner-a', state: 'running',
    cancellation: { status: 'none' }, progress: { completed: 1, total: 2 }, hasResult: false, executions: [],
    createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:01.000Z',
  };
  const seen = [];
  const handler = createTaskRequestHandler({
    tasks: {
      async getTaskForOwner(id, ownerId) {
        seen.push(`authorize:${ownerId}:${id}`);
        if (ownerId !== 'owner-a') throw new RhinoQError('RHINOQ_TASK_NOT_FOUND', id, false, { status: 404 });
        return task;
      },
    },
    ownerFromRequest: (request) => request.headers.get('x-owner') ?? undefined,
    cancelTask: async ({ task: owned, ownerId, expectedVersion }) => {
      seen.push(`cancel:${ownerId}:${owned.id}:${expectedVersion}`);
      return { ...owned, entityVersion: 8, state: 'cancel_requested', cancellation: { status: 'requested' } };
    },
  });

  const allowed = await handler(new Request('http://app.test/tasks/task-cancel/cancel', {
    method: 'POST', headers: { 'x-owner': 'owner-a' }, body: JSON.stringify({ expectedVersion: 7 }),
  }));
  assert.equal(allowed.status, 200);
  assert.deepEqual(seen, ['authorize:owner-a:task-cancel', 'cancel:owner-a:task-cancel:7']);

  const denied = await handler(new Request('http://app.test/tasks/task-cancel/cancel', {
    method: 'POST', headers: { 'x-owner': 'owner-b' }, body: '{}',
  }));
  assert.equal(denied.status, 404);
  assert.equal(seen.some((entry) => entry.startsWith('cancel:owner-b')), false);
});

test('application Task handler returns non-enumerating owner misses', async () => {
  const handler = createTaskRequestHandler({
    tasks: {
      async getTaskForOwner(taskId) {
        throw new RhinoQError('RHINOQ_TASK_NOT_FOUND', taskId, false, {
          status: 404,
        });
      },
    },
    ownerFromRequest: () => 'owner-b',
  });

  const response = await handler(new Request('http://app.test/tasks/task-a'));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, 'RHINOQ_TASK_NOT_FOUND');
});
