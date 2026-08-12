import assert from 'node:assert/strict';
import test from 'node:test';

import { RhinoQApp, createManualRuntimeAdapter, createRhinoQApp } from '../dist/index.js';

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
  assert.match(center.body, /href="\/"/);
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
  assert.equal((await invoke(middleware, '/admin')).status, 403);
  assert.equal((await invoke(middleware, '/admin', { 'x-operator-token': 'ops-secret' })).status, 200);

  const reports = await app.runtime.runtimeReports();
  assert.equal(reports[0].name, 'manual');
  assert.equal(reports[0].scope, 'reports');
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
