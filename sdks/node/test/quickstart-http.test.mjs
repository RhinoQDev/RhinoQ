import assert from 'node:assert/strict';
import test from 'node:test';

import { RhinoQApp } from '../dist/index.js';

function createApp() {
  const snapshot = {
    schemaVersion: 1, entityVersion: 2, id: 'task-cancel', type: 'export', ownerId: 'owner-a', state: 'running',
    cancellation: { status: 'none' }, progress: { completed: 0, total: 1 }, hasResult: false, executions: [],
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
      return { schemaVersion: 1, entityVersion: 2, taskId, executions: [] };
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
