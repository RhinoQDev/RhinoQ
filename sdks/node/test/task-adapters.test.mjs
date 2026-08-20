import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

import {
  RhinoQError,
  createNodeTaskMiddleware,
  registerFastifyTaskRoutes,
  taskRoutePatterns,
} from '../dist/index.js';

// The bug this closes: a wildcard route does not match the bare collection
// path in Express 4, Fastify or NestJS. Mounting only `/tasks/*` loses
// listTasks, and every integration had to discover the second route from a 404.
test('the route patterns name the collection path the wildcard misses', () => {
  assert.deepEqual(taskRoutePatterns(), ['/tasks', '/tasks/*']);
  assert.deepEqual(taskRoutePatterns('/jobs'), ['/jobs', '/jobs/*']);
  assert.deepEqual(taskRoutePatterns('api/tasks/'), ['/api/tasks', '/api/tasks/*']);
});

test('one Node middleware serves both the collection and the item route', async () => {
  const { tasks, snapshot } = newTasks();
  const middleware = createNodeTaskMiddleware({
    tasks,
    ownerFromRequest: (request) => request.headers.get('x-owner') ?? undefined,
  });
  const server = createServer((request, response) => middleware(request, response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const collection = await fetch(`${base}/tasks`, { headers: { 'x-owner': 'owner-a' } });
    assert.equal(collection.status, 200);
    assert.deepEqual(await collection.json(), { tasks: [snapshot] });

    const item = await fetch(`${base}/tasks/task-1`, { headers: { 'x-owner': 'owner-a' } });
    assert.equal(item.status, 200);
    assert.equal((await item.json()).id, 'task-1');

    const cancel = await fetch(`${base}/tasks/task-1/cancel`, {
      method: 'POST',
      headers: { 'x-owner': 'owner-a', 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 3 }),
    });
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).state, 'cancel_requested');

    const anonymous = await fetch(`${base}/tasks`);
    assert.equal(anonymous.status, 401);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

// Express strips the mount path from req.url and puts the whole path in
// originalUrl. Reading req.url alone turned `/tasks` into `/` and 404'd.
test('the middleware honours the Express mount path', async () => {
  const { tasks, snapshot } = newTasks();
  const middleware = createNodeTaskMiddleware({
    tasks,
    ownerFromRequest: () => 'owner-a',
  });

  const collection = await callMiddleware(middleware, {
    method: 'GET',
    url: '/',
    originalUrl: '/tasks',
    headers: {},
  });
  assert.equal(collection.statusCode, 200);
  assert.deepEqual(JSON.parse(collection.body), { tasks: [snapshot] });

  const item = await callMiddleware(middleware, {
    method: 'GET',
    url: '/task-1',
    originalUrl: '/tasks/task-1',
    headers: {},
  });
  assert.equal(item.statusCode, 200);
  assert.equal(JSON.parse(item.body).id, 'task-1');
});

test('the middleware normalizes an origin with trailing slashes without regex backtracking', async () => {
  const { tasks, snapshot } = newTasks();
  const middleware = createNodeTaskMiddleware({
    tasks,
    origin: `http://app.test${'/'.repeat(100_000)}`,
    ownerFromRequest: () => 'owner-a',
  });

  const result = await callMiddleware(middleware, { method: 'GET', url: '/tasks', headers: {} });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { tasks: [snapshot] });
});

test('Node middleware preserves a Nest or Passport principal attached to the original request', async () => {
  const { tasks } = newTasks();
  const middleware = createNodeTaskMiddleware({
    tasks,
    ownerFromNodeRequest: (request) => request.user?.id,
  });
  const result = await callMiddleware(middleware, {
    method: 'GET', url: '/tasks', headers: {}, user: { id: 'owner-a' },
  });
  assert.equal(result.statusCode, 200);
});

test('Node middleware refuses construction without an owner boundary', () => {
  assert.throws(() => createNodeTaskMiddleware({ tasks: newTasks().tasks }), /ownerFrom/);
});

// express.json() has already drained the stream by the time the middleware
// runs. Waiting for bytes that will never arrive would hang the request.
test('the middleware accepts a body a JSON parser has already consumed', async () => {
  const { tasks } = newTasks();
  const middleware = createNodeTaskMiddleware({ tasks, ownerFromRequest: () => 'owner-a' });

  const result = await callMiddleware(middleware, {
    method: 'POST',
    url: '/task-1/cancel',
    originalUrl: '/tasks/task-1/cancel',
    headers: { 'content-type': 'application/json' },
    body: { expectedVersion: 3 },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).state, 'cancel_requested');
});

// Mounted at the application root, the middleware must let unrelated routes
// through instead of answering 404 for the whole application.
test('a path outside basePath is passed to next()', async () => {
  const { tasks } = newTasks();
  const middleware = createNodeTaskMiddleware({ tasks, ownerFromRequest: () => 'owner-a' });
  let passed = false;

  const result = await callMiddleware(
    middleware,
    { method: 'GET', url: '/healthz', headers: {} },
    () => { passed = true; },
  );

  assert.equal(passed, true);
  assert.equal(result.statusCode, undefined, 'the middleware must not answer a foreign path');
});

// A near-miss prefix is a foreign path, not a task route. `/tasksmith` must
// not be swallowed by a `/tasks` mount.
test('a prefix that only looks like basePath is passed to next()', async () => {
  const { tasks } = newTasks();
  const middleware = createNodeTaskMiddleware({ tasks, ownerFromRequest: () => 'owner-a' });
  let passed = false;

  await callMiddleware(
    middleware,
    { method: 'GET', url: '/tasksmith', headers: {} },
    () => { passed = true; },
  );

  assert.equal(passed, true);
});

test('a custom basePath is respected end to end', async () => {
  const { tasks, snapshot } = newTasks();
  const middleware = createNodeTaskMiddleware({
    tasks,
    basePath: '/api/jobs',
    ownerFromRequest: () => 'owner-a',
  });

  const result = await callMiddleware(middleware, { method: 'GET', url: '/api/jobs', headers: {} });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { tasks: [snapshot] });
});

test('the Fastify plugin registers both patterns and answers each', async () => {
  const { tasks, snapshot } = newTasks();
  const routes = new Map();
  const fastify = { all(path, handler) { routes.set(path, handler); } };

  registerFastifyTaskRoutes(fastify, {
    tasks,
    origin: 'http://app.test////',
    ownerFromRequest: () => 'owner-a',
  });

  assert.deepEqual([...routes.keys()], ['/tasks', '/tasks/*']);

  const collection = await callFastify(routes.get('/tasks'), { method: 'GET', url: '/tasks', headers: {} });
  assert.equal(collection.status, 200);
  assert.deepEqual(JSON.parse(collection.payload), { tasks: [snapshot] });

  // Fastify parses JSON before the handler runs, so the body arrives already
  // decoded and must be re-serialised rather than read from the stream.
  const cancel = await callFastify(routes.get('/tasks/*'), {
    method: 'POST',
    url: '/tasks/task-1/cancel',
    headers: { 'content-type': 'application/json' },
    body: { expectedVersion: 3 },
  });
  assert.equal(cancel.status, 200);
  assert.equal(JSON.parse(cancel.payload).state, 'cancel_requested');
});

function newTasks() {
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
        throw new RhinoQError('RHINOQ_TASK_NOT_FOUND', taskId, false, { status: 404 });
      }
      return snapshot;
    },
    async requestTaskCancellationForOwner(taskId, ownerId, expectedVersion) {
      assert.equal(expectedVersion, snapshot.entityVersion);
      return { ...snapshot, entityVersion: 4, state: 'cancel_requested', cancellation: { status: 'requested' } };
    },
  };
  return { tasks, snapshot };
}

// Drives the middleware with a request object shaped like Express's, without
// depending on Express. A `body` field stands in for express.json().
function callMiddleware(middleware, request, next) {
  return new Promise((resolve, reject) => {
    const listeners = new Map();
    const nodeRequest = {
      ...request,
      on(event, listener) {
        listeners.set(event, listener);
        // No stream is written when `body` already holds the parsed value.
        if (event === 'end' && request.body === undefined) queueMicrotask(() => listener());
        return nodeRequest;
      },
    };
    const result = { statusCode: undefined, headers: {}, body: '' };
    const response = {
      set statusCode(value) { result.statusCode = value; },
      get statusCode() { return result.statusCode; },
      setHeader(name, value) { result.headers[name] = value; },
      end(chunk) { result.body = chunk ?? ''; resolve(result); },
    };
    middleware(nodeRequest, response, (error) => {
      if (error) { reject(error); return; }
      next?.();
      resolve(result);
    });
  });
}

async function callFastify(handler, request) {
  const result = { status: 200, headers: {}, payload: '' };
  const reply = {
    status(code) { result.status = code; return reply; },
    header(name, value) { result.headers[name] = value; return reply; },
    send(payload) { result.payload = payload; return reply; },
  };
  await handler(request, reply);
  return result;
}
