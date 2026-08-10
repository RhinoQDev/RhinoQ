import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  ApplicationTaskClient,
  TaskListStore,
  TaskStore,
  createTaskRequestHandler,
  createNodeTaskMiddleware,
  parseTaskEventStream,
} from '../dist/index.js';

function snapshot(version, state = 'running', id = 'task-1') {
  return { schemaVersion: 1, entityVersion: version, id, type: 'report', ownerId: 'owner-a', state,
    cancellation: { status: 'none' }, progress: { completed: version, total: 4 }, hasResult: false,
    executions: [], createdAt: '2026-08-09T00:00:00.000Z', updatedAt: `2026-08-09T00:00:0${Math.min(version, 9)}.000Z` };
}

test('owner-scoped Task SSE emits versioned snapshots and honors Last-Event-ID', async () => {
  let reads = 0;
  const tasks = {
    async getTaskSummaryForOwner(id, owner) {
      assert.equal(id, 'task-1'); assert.equal(owner, 'owner-a');
      reads++;
      const { executions, ...summary } = snapshot(reads < 3 ? 3 : 4, reads < 3 ? 'running' : 'succeeded');
      return summary;
    },
    async listTasks() { return []; },
  };
  const handler = createTaskRequestHandler({ tasks, ownerFromRequest: (request) => request.headers.get('x-owner'), stream: { pollIntervalMs: 250, heartbeatMs: 1_000 } });
  const response = await handler(new Request('http://app.test/tasks/task-1/events', { headers: { 'x-owner': 'owner-a', 'last-event-id': '3' } }));
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const received = [];
  for await (const event of parseTaskEventStream(response)) received.push(event);
  assert.deepEqual(received.filter((event) => event.type === 'task.snapshot').map((event) => event.version), [4]);
});

test('Node/Nest middleware pipes SSE chunks instead of buffering response.text()', async () => {
  const tasks = {
    async getTaskSummaryForOwner() { const { executions, ...summary } = snapshot(2, 'succeeded'); return summary; },
    async listTasks() { return []; },
  };
  const middleware = createNodeTaskMiddleware({ tasks, ownerFromNodeRequest: () => 'owner-a' });
  const request = Object.assign(new EventEmitter(), { method: 'GET', url: '/tasks/task-1/events', originalUrl: '/tasks/task-1/events', headers: {} });
  const response = Object.assign(new EventEmitter(), {
    statusCode: 0, headers: {}, chunks: [],
    setHeader(name, value) { this.headers[name] = value; },
    write(chunk) { this.chunks.push(Buffer.from(chunk).toString('utf8')); },
    end(chunk) { if (chunk) this.chunks.push(String(chunk)); this.emit('ended'); },
  });
  const ended = new Promise((resolve) => response.once('ended', resolve));
  middleware(request, response); await ended;
  assert.match(response.headers['content-type'], /^text\/event-stream/);
  assert.match(response.chunks.join(''), /event: task\.snapshot/);
});

test('Task SSE authenticates before opening and does not enumerate a guessed task', async () => {
  let reads = 0;
  const handler = createTaskRequestHandler({
    tasks: { async getTaskSummaryForOwner() { reads++; return snapshot(1); }, async listTasks() { return []; } },
    ownerFromRequest: () => undefined,
  });
  const response = await handler(new Request('http://app.test/tasks/secret/events'));
  assert.equal(response.status, 401); assert.equal(reads, 0);
});

test('Task SSE enforces a bounded connection budget and releases it on cancel', async () => {
  const tasks = {
    async getTaskSummaryForOwner() { const { executions, ...summary } = snapshot(1, 'running'); return summary; },
    async listTasks() { return []; },
  };
  const handler = createTaskRequestHandler({ tasks, ownerFromRequest: () => 'owner-a', stream: { maxConnections: 1, pollIntervalMs: 250 } });
  const first = await handler(new Request('http://app.test/tasks/task-1/events'));
  const refused = await handler(new Request('http://app.test/tasks/task-1/events'));
  assert.equal(refused.status, 503); assert.equal((await refused.json()).code, 'RHINOQ_STREAM_CAPACITY');
  await first.body.cancel();
  const next = await handler(new Request('http://app.test/tasks/task-1/events'));
  assert.equal(next.status, 200); await next.body.cancel();
});

test('ApplicationTaskClient parses the authenticated SSE stream', async () => {
  const tasks = {
    async getTaskSummaryForOwner() { const { executions, ...summary } = snapshot(2, 'succeeded'); return summary; },
    async listTasks() { return [snapshot(2, 'succeeded')]; },
  };
  const handler = createTaskRequestHandler({ tasks, ownerFromRequest: (request) => request.headers.get('x-owner') });
  const client = new ApplicationTaskClient({ url: 'http://app.test/tasks', headers: () => ({ 'x-owner': 'owner-a' }), fetch: (input, init) => handler(new Request(input, init)) });
  const events = [];
  for await (const event of client.streamTask('task-1')) events.push(event);
  assert.equal(events[0].type, 'task.snapshot'); assert.equal(events[0].version, 2);
});

test('TaskStore prefers SSE and preserves the newest snapshot', async () => {
  let polled = 0;
  const client = {
    async getTask() { polled++; return snapshot(1); },
    async *streamTask() { yield { type: 'task.snapshot', version: 2, task: snapshot(2, 'succeeded') }; },
    async cancelTask() {}, async getTaskResult() {},
  };
  const store = new TaskStore(client, 'task-1'); store.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.getSnapshot().snapshot.entityVersion, 2);
  assert.equal(store.getSnapshot().transport, 'live'); assert.equal(polled, 0);
});

test('TaskStore falls back to an authoritative snapshot after SSE loss', async () => {
  let streams = 0, polls = 0;
  const client = {
    async getTask() { polls++; return snapshot(5, 'succeeded'); },
    async *streamTask() { streams++; throw new Error('proxy closed stream'); },
    async cancelTask() {}, async getTaskResult() {},
  };
  const store = new TaskStore(client, 'task-1', { pollIntervalMs: 5, maxBackoffMs: 5 }); store.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.getSnapshot().snapshot.entityVersion, 5);
  assert.equal(store.getSnapshot().transport, 'polling_fallback');
  assert.ok(streams >= 1); assert.ok(polls >= 1); store.stop();
});

test('TaskListStore consumes owner inbox SSE without interval polling', async () => {
  let polled = 0;
  const client = {
    async listTasks() { polled++; return []; },
    async *streamTasks() { yield { type: 'task.snapshot', version: 2, task: snapshot(2, 'succeeded') }; await new Promise(() => {}); },
  };
  const store = new TaskListStore(client, {}, 250); store.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.getSnapshot().tasks[0].entityVersion, 2);
  assert.equal(store.getSnapshot().transport, 'live'); assert.equal(polled, 0);
  store.stop();
});

test('Task inbox page events remove tasks displaced from the bounded page', async () => {
  const client = {
    async listTasks() { return []; },
    async *streamTasks() {
      yield { type: 'task.page', tasks: [snapshot(1, 'running', 'old')] };
      yield { type: 'task.page', tasks: [snapshot(1, 'running', 'new')] };
      await new Promise(() => {});
    },
  };
  const store = new TaskListStore(client, {}, 250); store.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(store.getSnapshot().tasks.map((task) => task.id), ['new']); store.stop();
});
