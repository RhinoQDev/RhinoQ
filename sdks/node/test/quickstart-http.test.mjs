import assert from 'node:assert/strict';
import test from 'node:test';

import { RhinoQApp, RhinoQPortableApp, createManualRuntimeAdapter, createRhinoQApp } from '../dist/index.js';

function createApp(options = {}) {
  const snapshot = {
    schemaVersion: 1, entityVersion: 2, id: 'task-cancel', type: 'export', ownerId: 'owner-a', state: 'running',
    cancellation: { status: 'none' }, progress: { completed: 0, total: 1 }, hasResult: false, executions: options.executions ?? [],
    createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:01.000Z',
  };
  const tasks = {
    async listTasks() { return []; },
    async listTasksByState() { return []; },
    async getTask(id) { return { ...snapshot, id }; },
    async getTaskForOwner(id, ownerId) {
      assert.equal(ownerId, 'owner-a');
      return { ...snapshot, id };
    },
    async listTaskExecutionRuntimeRefs(taskId) {
      return { schemaVersion: 1, entityVersion: 2, taskId, executions: options.runtimeRefs ?? [] };
    },
    async requestTaskCancellation(id) {
      this.cancelled = id;
      return { ...snapshot, id, entityVersion: 3, state: 'cancel_requested', cancellation: { status: 'requested' } };
    },
    async getTaskExecutionResults() { throw new Error('not used'); },
  };
  return { tasks, app: new RhinoQApp({
    tasks,
    bridge: { close() {} },
    reconciler: { stop() {} },
    metrics: {},
    scope: 'test',
    queue: { async getJob() { return undefined; } },
    observe: async () => undefined,
    ownerFromRequest: () => 'owner-a',
    runtimeHealth: options.runtimeHealth ?? [],
  }) };
}

function request(path, headers = {}, method = 'GET', body = '') {
  const listeners = new Map();
  const value = {
    method,
    url: path,
    headers,
    on(event, listener) { listeners.set(event, listener); },
  };
  if (method !== 'GET' && method !== 'HEAD') queueMicrotask(() => {
    if (body) listeners.get('data')?.(body);
    listeners.get('end')?.();
  });
  return value;
}

function invoke(middleware, path, headers = {}, method = 'GET', body = '') {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const response = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      write(chunk) { chunks.push(Buffer.from(chunk)); },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        resolve({ status: this.statusCode, headers: this.headers, body: Buffer.concat(chunks).toString() });
      },
    };
    middleware(request(path, headers, method, body), response, (error) => {
      if (error) reject(error);
      else resolve({ passed: true });
    });
  });
}

test('app.http exposes the complete default user and operator journey from one mount', async () => {
  const { app, tasks: source } = createApp();
  const middleware = app.http({ operatorToken: 'ops-secret' });

  const center = await invoke(middleware, '/task-center');
  assert.equal(center.status, 200);
  assert.match(center.body, /\/tasks/);
  assert.match(center.body, /href="\/task-center"/);
  assert.match(center.body, />Overview<\/a>/);
  assert.match(center.body, /href="\/admin"/);

  const detailPage = await invoke(middleware, '/task-center/task-cancel');
  assert.equal(detailPage.status, 200);
  assert.match(detailPage.body, /Back to tasks/);

  const tasks = await invoke(middleware, '/tasks');
  assert.equal(tasks.status, 200);
  assert.deepEqual(JSON.parse(tasks.body), { tasks: [] });

  const capabilities = await invoke(middleware, '/tasks/_capabilities');
  assert.deepEqual(JSON.parse(capabilities.body), {
    schemaVersion: 1, cancel: true, retry: false, result: false, waitpoints: true, stream: true, risk: false,
    tenant: false, verifications: true, artifacts: false, authorization: false,
  });

  const forbidden = await invoke(middleware, '/admin');
  assert.equal(forbidden.status, 403);

  const workbench = await invoke(middleware, '/admin', { 'x-operator-token': 'ops-secret' });
  assert.equal(workbench.status, 200);
  assert.match(workbench.body, /RhinoQ Workbench/);
  assert.match(workbench.body, /href="\/task-center"/);
  assert.match(workbench.body, /id="detailDrawer"/);

  const cancelled = await invoke(
    middleware,
    '/tasks/task-cancel/cancel',
    { 'content-type': 'application/json' },
    'POST',
    '{}',
  );
  assert.equal(cancelled.status, 200);
  assert.equal(JSON.parse(cancelled.body).state, 'cancel_requested');
  assert.equal(source.cancelled, 'task-cancel');

  assert.deepEqual(await invoke(middleware, '/application-route'), { passed: true });
});

test('app.http refuses to expose the cross-owner Workbench without a token', () => {
  assert.throws(() => createApp().app.http({ operatorToken: '' }), /operatorToken/);
});

test('portable app exchanges the operator token for a scoped HttpOnly browser cookie', async () => {
  const operatorToken = 'ops-secret';
  const { tasks } = createApp();
  const app = await createRhinoQApp({
    pool: { async query() { return { rows: [] }; } },
    tasks,
    adapters: [createManualRuntimeAdapter('manual', 'reports')],
    ownerFromRequest: () => 'owner-a',
  });
  const middleware = app.http({ operatorToken });

  const form = await invoke(middleware, '/operator-login');
  assert.equal(form.status, 200);
  assert.match(form.body, /Operator sign in/);
  assert.equal(form.body.includes(operatorToken), false);

  const refused = await invoke(
    middleware, '/operator-login', { 'content-type': 'application/x-www-form-urlencoded' },
    'POST', 'token=wrong',
  );
  assert.equal(refused.status, 403);
  assert.equal(refused.headers['set-cookie'], undefined);

  const login = await invoke(
    middleware, '/operator-login', { 'content-type': 'application/x-www-form-urlencoded' },
    'POST', `token=${encodeURIComponent(operatorToken)}`,
  );
  assert.equal(login.status, 303);
  assert.equal(login.headers.location, '/admin');
  assert.match(login.headers['set-cookie'], /^rhinoq_operator_session=[^;]+; HttpOnly; SameSite=Strict; Path=\/admin$/);
  assert.equal(login.headers['set-cookie'].includes(operatorToken), false);

  const cookie = login.headers['set-cookie'].split(';', 1)[0];
  const workbench = await invoke(middleware, '/admin', { cookie });
  assert.equal(workbench.status, 200);
  assert.match(workbench.body, /RhinoQ Workbench/);
  await app.close();
});

test('owner and operator HTML never embed operator tokens or private result references', async () => {
  const privateReference = 'storage://private/report.csv?credential=do-not-leak';
  const operatorToken = 'operator-secret-do-not-render';
  const { app } = createApp();
  const middleware = app.http({ operatorToken });
  for (const response of [
    await invoke(middleware, '/task-center/task-cancel'),
    await invoke(middleware, '/admin', { 'x-operator-token': operatorToken }),
  ]) {
    assert.equal(response.status, 200);
    assert.equal(response.body.includes(operatorToken), false);
    assert.equal(response.body.includes(privateReference), false);
    assert.equal(response.body.includes('x-operator-token'), false);
  }
});

test('createRhinoQApp gives a non-BullMQ adapter the same Task Center and Workbench surface', async () => {
  const { tasks } = createApp();
  const adapter = createManualRuntimeAdapter('manual', 'reports');
  const app = await createRhinoQApp({
    pool: { async query() { return { rows: [] }; } },
    tasks,
    adapters: [adapter],
    ownerFromRequest: () => 'owner-a',
  });
  const middleware = app.http({ operatorToken: 'ops-secret' });

  assert.equal((await invoke(middleware, '/task-center')).status, 200);
  assert.equal((await invoke(middleware, '/tasks')).status, 200);
  const capabilities = JSON.parse((await invoke(middleware, '/tasks/_capabilities')).body);
  assert.equal(capabilities.cancel, false);
  const unsupported = await invoke(
    middleware, '/tasks/task-cancel/cancel', { 'content-type': 'application/json' }, 'POST', '{}',
  );
  assert.equal(unsupported.status, 409);
  assert.equal(JSON.parse(unsupported.body).code, 'RHINOQ_UNSUPPORTED');
  assert.equal(tasks.cancelled, undefined);
  assert.equal((await invoke(middleware, '/admin')).status, 403);
  assert.equal((await invoke(middleware, '/admin', { 'x-operator-token': 'ops-secret' })).status, 200);

  const reports = await app.runtime.runtimeReports();
  assert.equal(reports[0].name, 'manual');
  assert.equal(reports[0].scope, 'reports');
  await app.close();
});

test('portable app golden response scopes reads and resolves private results', async () => {
  const ownerReads = [];
  const tasks = {
    async getTaskForOwner(id, ownerId, tenantId) {
      ownerReads.push({ id, ownerId, tenantId });
      return { id, type: 'report.export', ownerId, tenantId, state: 'succeeded', entityVersion: 2,
        progress: { completed: 1, total: 1 }, executions: [], updatedAt: '2026-08-25T00:00:01Z' };
    },
    async getTaskSummaryForOwner(id, ownerId, tenantId) { return this.getTaskForOwner(id, ownerId, tenantId); },
    async listTaskExecutionsForOwner() { return { items: [] }; },
    async getTaskResultForOwner(taskId, ownerId, tenantId) {
      return { schemaVersion: 1, entityVersion: 2, taskId, reference: 'storage://private/report-42', ownerId, tenantId, updatedAt: '2026-08-25T00:00:01Z' };
    },
  };
  const runtime = {
    async dispatch(_adapter, command) {
      return { id: command.task.id, type: command.task.type, ownerId: command.task.ownerId, tenantId: command.task.tenantId,
        state: 'queued', entityVersion: 1, progress: { completed: 0 }, executions: [], updatedAt: '2026-08-25T00:00:00Z' };
    },
    async close() {},
  };
  const app = new RhinoQPortableApp(
    tasks, runtime, {}, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined,
    async (result, identity) => ({ downloadUrl: `https://app.example.test/${identity.tenantId}/${result.taskId}` }),
  );
  const task = app.task({ name: 'report.export', adapter: 'manual', runtime: 'manual', scope: 'reports', run: async () => undefined });
  const response = await task.respond({ id: 'task-42', ownerId: 'owner-a', tenantId: 'tenant-a', idempotencyKey: 'report:42', payload: {} }, { waitUpToMs: 50 });
  const body = await response.json();
  assert.equal(body.result.downloadUrl, 'https://app.example.test/tenant-a/task-42');
  assert.equal(JSON.stringify(body).includes('storage://private'), false);
  assert.deepEqual(ownerReads[0], { id: 'task-42', ownerId: 'owner-a', tenantId: 'tenant-a' });
});

test('portable app forwards tenant authorization and application-owned cancellation', async () => {
  const { tasks } = createApp();
  const adapter = createManualRuntimeAdapter('manual', 'reports');
  const authorization = [];
  const app = await createRhinoQApp({
    pool: { async query() { return { rows: [] }; } }, tasks, adapters: [adapter],
    ownerFromRequest: () => 'owner-a', tenantFromRequest: () => 'tenant-a',
  });
  const middleware = app.http({
    operatorToken: 'ops-secret', requireTenantAuthorization: true,
    authorize(input) { authorization.push(input); return input.tenantId === 'tenant-a'; },
    async cancelTask({ task }) { return { ...task, cancellation: { status: 'cannot_cancel_safely' } }; },
  });

  const response = await invoke(
    middleware, '/tasks/task-cancel/cancel', { 'content-type': 'application/json' }, 'POST', '{}',
  );
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).cancellation.status, 'cannot_cancel_safely');
  assert.equal(tasks.cancelled, undefined, 'the generic Task cancellation command is not called');
  assert.deepEqual(authorization.map(({ action, ownerId, tenantId }) => ({ action, ownerId, tenantId })), [
    { action: 'task:cancel', ownerId: 'owner-a', tenantId: 'tenant-a' },
  ]);
  await app.close();
});

test('app.http connects runtime evidence and job links through the authenticated operator journey', async () => {
  const { app } = createApp({
    runtimeHealth: [{ async inspect() {
      return { schemaVersion: 1, runtime: 'bullmq', scope: 'reports', status: 'degraded', observedAt: '2026-08-11T00:00:00.000Z', queue: { waiting: 2, active: 0, delayed: 0, failed: 0, completed: 4, paused: false }, workers: { observable: true, connected: 0 }, reason: 'waiting_without_workers' };
    } }],
    runtimeRefs: [{ executionId: 'task-cancel:run', runtime: 'bullmq', runtimeScope: 'reports', externalId: 'job-7', state: 'running' }],
    executions: [{ id: 'task-cancel:run', runtime: 'bullmq', runtimeScope: 'reports', state: 'running', attempt: 1, version: 1, hasResult: false }],
  });
  const middleware = app.http({
    operatorToken: 'ops-secret',
    runtimeDashboardURL: '/queues/reports',
    runtimeJobLink: ({ scope, externalId }) => `/queues/${scope}/jobs/${externalId}`,
  });
  const headers = { 'x-operator-token': 'ops-secret' };

  const overview = JSON.parse((await invoke(middleware, '/admin/api/overview', headers)).body);
  assert.equal(overview.runtimeHealth[0].scope, 'reports');
  assert.equal(overview.runtimeHealth[0].status, 'degraded');

  const detail = JSON.parse((await invoke(middleware, '/admin/api/tasks/task-cancel', headers)).body);
  assert.equal(detail.items[0].runtimeURL, '/queues/reports/jobs/job-7');

  const forbidden = await invoke(middleware, '/admin/api/runtime-health');
  assert.equal(forbidden.status, 403);
  assert.ok(!forbidden.body.includes('reports'));
});
