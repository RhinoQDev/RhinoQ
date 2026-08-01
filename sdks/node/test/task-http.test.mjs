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
  };
  const handler = createTaskRequestHandler({
    tasks,
    ownerFromRequest: (request) => request.headers.get('x-owner') ?? undefined,
  });
  const client = new ApplicationTaskClient({
    url: 'http://app.test/tasks',
    headers: () => ({ 'x-owner': 'owner-a' }),
    fetch: (input, init) => handler(new Request(input, init)),
  });

  assert.equal((await client.getTask('task-1')).entityVersion, 3);
	assert.equal((await client.getTaskSummary('task-1')).executions, undefined);
	assert.equal((await client.listTaskExecutions('task-1', 'next', 2)).nextCursor, 'done');
  assert.equal((await client.listTasks()).length, 1);
  const cancelled = await client.cancelTask('task-1', 3);
  assert.equal(cancelled.state, 'cancel_requested');
  assert.equal(cancelled.cancellation.status, 'requested');
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
