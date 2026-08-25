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
    schemaVersion: 1, cancel: true, retry: true, result: false, waitpoints: true, stream: true, risk: false,
    tenant: false, verifications: true, artifacts: false, authorization: false,
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

test('owner waitpoint routes forward tenant identity to every store call', async () => {
  const seen = [];
  const waitpoint = {
    schemaVersion: 1, entityVersion: 1, id: 'wp-tenant', taskId: 'task-tenant',
    key: 'approve', kind: 'approval', state: 'waiting', payloadVersion: 1,
    createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
  };
  const handler = createTaskRequestHandler({
    tasks: {
      async getTaskWaitpoint(id, ownerId, tenantId) {
        seen.push(['read', id, ownerId, tenantId]);
        return waitpoint;
      },
      async resolveTaskWaitpoint(id, ownerId, request, tenantId) {
        seen.push(['resolve', id, ownerId, tenantId, request.resolutionId]);
        return { ...waitpoint, entityVersion: 2, state: 'resolved', resolution: request.resolution };
      },
    },
    ownerFromRequest: (request) => request.headers.get('x-owner') ?? undefined,
    tenantFromRequest: (request) => request.headers.get('x-tenant') ?? undefined,
  });
  const headers = { 'x-owner': 'owner-a', 'x-tenant': 'tenant-a' };
  const read = await handler(new Request('http://app.test/tasks/task-tenant/waitpoints/wp-tenant', { headers }));
  assert.equal(read.status, 200);
  const resolve = await handler(new Request('http://app.test/tasks/task-tenant/waitpoints/wp-tenant', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 1, resolutionId: 'resolve-tenant', resolution: { approved: true } }),
  }));
  assert.equal(resolve.status, 200);
  assert.deepEqual(seen, [
    ['read', 'wp-tenant', 'owner-a', 'tenant-a'],
    ['read', 'wp-tenant', 'owner-a', 'tenant-a'],
    ['resolve', 'wp-tenant', 'owner-a', 'tenant-a', 'resolve-tenant'],
  ]);
});

test('risk policy exposes owner-scoped at-risk and stuck tasks with explicit thresholds', async () => {
  const updatedAt = new Date(Date.now() - 120_000).toISOString();
  const handler = createTaskRequestHandler({
    tasks: {
      async listTasksByState(query) {
        assert.deepEqual(query.states, ['pending', 'queued', 'running', 'cancel_requested']);
        assert.equal(query.idleForMs, 30_000);
        assert.equal(query.ownerId, 'owner-a');
        assert.equal(query.limit, 25);
        return [{ schemaVersion: 1, entityVersion: 2, id: 'task-risk', type: 'export', ownerId: 'owner-a', state: 'running', cancellation: { status: 'none' }, progress: { completed: 1, total: 2 }, hasResult: false, createdAt: updatedAt, updatedAt }];
      },
    },
    ownerFromRequest: () => 'owner-a',
    riskPolicy: { atRiskAfterMs: 30_000, stuckAfterMs: 90_000 },
  });
  const capabilities = await (await handler(new Request('http://app.test/tasks/_capabilities'))).json();
  assert.deepEqual(capabilities.risk, { atRiskAfterMs: 30_000, stuckAfterMs: 90_000 });
  const response = await handler(new Request('http://app.test/tasks/_risk?limit=25'));
  const body = await response.json();
  assert.equal(body.tasks[0].risk, 'stuck');
  assert.ok(body.tasks[0].idleForMs >= 90_000);
});

test('risk policy rejects ambiguous thresholds', () => {
  assert.throws(() => createTaskRequestHandler({
    tasks: {}, ownerFromRequest: () => 'owner-a',
    riskPolicy: { atRiskAfterMs: 60_000, stuckAfterMs: 60_000 },
  }), /stuckAfterMs/);
});

test('tenant context fences verification and artifact reads through the owner HTTP surface', async () => {
  const verification = {
    schemaVersion: 1, id: 'verify-1', taskId: 'task-tenant', verifier: 'output-exists',
    status: 'verified', verifiedAt: '2026-08-10T00:00:00.000Z', createdAt: '2026-08-10T00:00:00.000Z',
  };
  const artifact = {
    schemaVersion: 1, entityVersion: 1, id: 'artifact-1', taskId: 'task-tenant', name: 'report.csv',
    contentType: 'text/csv', sizeBytes: 12, checksumSha256: 'a'.repeat(64),
    expiresAt: '2026-08-11T00:00:00.000Z', lineage: ['source'],
    createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
  };
  const assertScope = (ownerId, tenantId) => {
    assert.equal(ownerId, 'owner-a');
    assert.equal(tenantId, 'tenant-a');
  };
  const handler = createTaskRequestHandler({
    tasks: {
      async listRecentlyVerifiedForOwner(ownerId, limit, tenantId) {
        assertScope(ownerId, tenantId); assert.equal(limit, 20); return [verification];
      },
      async listTaskVerificationsForOwner(taskId, ownerId, limit, tenantId) {
        assert.equal(taskId, 'task-tenant'); assertScope(ownerId, tenantId); assert.equal(limit, 50); return [verification];
      },
      async listTaskArtifactsForOwner(taskId, ownerId, limit, tenantId) {
        assert.equal(taskId, 'task-tenant'); assertScope(ownerId, tenantId); assert.equal(limit, 100); return [artifact];
      },
      async getTaskArtifactForOwner(id, ownerId, tenantId) {
        assert.equal(id, 'artifact-1'); assertScope(ownerId, tenantId);
        return { ...artifact, reference: 'storage://private/report.csv' };
      },
    },
    ownerFromRequest: () => 'owner-a',
    tenantFromRequest: (request) => request.headers.get('x-tenant') ?? undefined,
    resolveArtifact: async (record, _request, ownerId, tenantId) => {
      assertScope(ownerId, tenantId);
      assert.equal(record.reference, 'storage://private/report.csv');
      return { url: '/downloads/report.csv' };
    },
  });
  const fetch = (path) => handler(new Request(`http://app.test/tasks${path}`, { headers: { 'x-tenant': 'tenant-a' } }));
  assert.deepEqual((await (await fetch('/_verified')).json()).verifications, [verification]);
  assert.deepEqual((await (await fetch('/task-tenant/verifications')).json()).verifications, [verification]);
  assert.equal(JSON.stringify(await (await fetch('/task-tenant/artifacts')).json()).includes('storage://'), false);
  assert.deepEqual(await (await fetch('/task-tenant/artifacts/artifact-1/download')).json(), { url: '/downloads/report.csv' });
  assert.equal((await handler(new Request('http://app.test/tasks/_verified'))).status, 401);
});

test('tenant authorization is an explicit deny-by-default policy hook', async () => {
  assert.throws(() => createTaskRequestHandler({
    tasks: {}, ownerFromRequest: () => 'owner-a', tenantFromRequest: () => 'tenant-a',
    requireTenantAuthorization: true,
  }), /tenant authorization requires authorize/);
  const seen = [];
  const handler = createTaskRequestHandler({
    tasks: { async getTaskForOwner() { throw new Error('ownership read must not happen'); } },
    ownerFromRequest: () => 'owner-a', tenantFromRequest: () => 'tenant-a',
    authorize: ({ action, taskId, tenantId }) => { seen.push({ action, taskId, tenantId }); return false; },
  });
  const response = await handler(new Request('http://app.test/tasks/task-1/cancel', { method: 'POST' }));
  assert.equal(response.status, 403);
  assert.deepEqual(seen, [{ action: 'task:cancel', taskId: 'task-1', tenantId: 'tenant-a' }]);
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
    tenantFromRequest: () => 'tenant-a',
    resolveResult: async (result, _request, ownerId, tenantId) => {
      assert.equal(ownerId, 'owner-a');
      assert.equal(tenantId, 'tenant-a');
      return { url: `/downloads/${result.taskId}` };
    },
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
  assert.deepEqual(await missing.json(), {
    code: 'RHINOQ_INVALID_REQUEST',
    message: 'expectedVersion must be a positive integer and commandId must be a non-empty string.',
    field: 'commandId', retryable: false,
    expectedShape: { expectedVersion: 7, commandId: 'task-123-retry-7' },
    nextAction: 'Read the latest Task entityVersion and create a stable commandId for this retry intent.',
    docs: 'https://github.com/RhinoQDev/RhinoQ/blob/main/docs/task-api.md#retry-a-task',
  });
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

test('unsupported cancellation is advertised and refused before any Task read or mutation', async () => {
  let touched = false;
  const handler = createTaskRequestHandler({
    tasks: new Proxy({}, { get() { touched = true; throw new Error('Task store must not be touched'); } }),
    ownerFromRequest: () => 'owner-a',
    cancel: false,
  });
  const capabilities = await (await handler(new Request('http://app.test/tasks/_capabilities'))).json();
  assert.equal(capabilities.cancel, false);

  const response = await handler(new Request('http://app.test/tasks/task-1/cancel', {
    method: 'POST', body: JSON.stringify({ expectedVersion: 7 }),
  }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    code: 'RHINOQ_UNSUPPORTED',
    message: 'Cancellation is not configured for this owner API; no Task state was changed.',
    field: 'action', retryable: false,
    nextAction: 'Configure app.http({ cancelTask }) or open the runtime tool if it offers a safe cancellation workflow.',
    docs: 'https://github.com/RhinoQDev/RhinoQ/blob/main/docs/task-api.md#cancel-a-task',
  });
  assert.equal(touched, false);
});

test('invalid cancellation fence explains the field, shape and next action', async () => {
  const handler = createTaskRequestHandler({ tasks: {}, ownerFromRequest: () => 'owner-a' });
  const response = await handler(new Request('http://app.test/tasks/task-1/cancel', {
    method: 'POST', body: JSON.stringify({ expectedVersion: 0 }),
  }));
  assert.equal(response.status, 400);
  const error = await response.json();
  assert.equal(error.code, 'RHINOQ_INVALID_REQUEST');
  assert.equal(error.field, 'expectedVersion');
  assert.deepEqual(error.expectedShape, { expectedVersion: 7 });
  assert.match(error.nextAction, /omit expectedVersion/);
});

test('browser client preserves structured mutation guidance', async () => {
  const handler = createTaskRequestHandler({ tasks: {}, ownerFromRequest: () => 'owner-a', cancel: false });
  const client = new ApplicationTaskClient({
    url: 'http://app.test/tasks', fetch: (input, init) => handler(new Request(input, init)),
  });
  await assert.rejects(client.cancelTask('task-1', 7), (error) => {
    assert.ok(error instanceof RhinoQError);
    assert.equal(error.code, 'RHINOQ_UNSUPPORTED');
    assert.equal(error.status, 409);
    assert.equal(error.retryable, false);
    assert.equal(error.field, 'action');
    assert.match(error.nextAction, /cancelTask/);
    assert.match(error.docs, /task-api\.md#cancel-a-task/);
    return true;
  });
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
