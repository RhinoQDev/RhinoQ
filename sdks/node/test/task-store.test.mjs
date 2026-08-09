import assert from 'node:assert/strict';
import test from 'node:test';

import { TaskStore } from '../dist/index.js';

test('TaskStore reconnects and never regresses a rendered snapshot', async () => {
  const responses = [snapshot(3, 'running'), new Error('offline'), snapshot(2, 'queued'), snapshot(4, 'succeeded')];
  const client = {
    async getTask() {
      const value = responses.shift();
      if (value instanceof Error) throw value;
      return value;
    },
    async cancelTask() { throw new Error('unused'); },
    async getTaskResult() { throw new Error('unused'); },
  };
  const store = new TaskStore(client, 'task-1', { pollIntervalMs: 1, maxBackoffMs: 2 });
  const states = [];
  store.subscribe((state) => states.push([state.status, state.snapshot?.entityVersion]));
  store.start();
  await eventually(() => store.getSnapshot().status === 'stopped');

  assert.equal(store.getSnapshot().snapshot.entityVersion, 4);
  assert.ok(states.some(([status]) => status === 'reconnecting'));
  assert.ok(!states.some(([, version], index) => version === 2 && index > 0));
});

test('TaskStore polls lightweight summaries and pages executions on demand', async () => {
	let fullReads = 0; let summaryReads = 0;
	const client = {
		async getTask() { fullReads++; return snapshot(1, 'running'); },
		async getTaskSummary() { summaryReads++; const { executions, ...summary } = snapshot(2, 'succeeded'); return summary; },
		async listTaskExecutions(_id, cursor, limit) { return { schemaVersion:1, entityVersion:2, taskId:'task-1', executions:[], nextCursor:`${cursor}:${limit}` }; },
		async cancelTask() { throw new Error('unused'); }, async getTaskResult() { throw new Error('unused'); },
	};
	const store = new TaskStore(client, 'task-1', { pollIntervalMs: 1 }); store.start();
	await eventually(() => store.getSnapshot().status === 'stopped');
	assert.equal(summaryReads, 1); assert.equal(fullReads, 0);
	assert.equal(store.getSnapshot().snapshot.executions, undefined);
	assert.equal((await store.listExecutions('cursor', 25)).nextCursor, 'cursor:25');
});

test('TaskStore cancel uses the latest aggregate revision and accepts the response', async () => {
  const calls = [];
  const client = {
    async getTask() { return snapshot(7, 'running'); },
    async cancelTask(id, version) {
      calls.push([id, version]);
      return snapshot(8, 'cancel_requested');
    },
    async getTaskResult() { return { url: '/download' }; },
  };
  const store = new TaskStore(client, 'task-1');
  await store.refresh();
  const cancelled = await store.cancel();

  assert.deepEqual(calls, [['task-1', 7]]);
  assert.equal(cancelled.entityVersion, 8);
  assert.equal(store.getSnapshot().snapshot.state, 'cancel_requested');
  assert.deepEqual(await store.getResult(), { url: '/download' });
});

test('TaskStore stop aborts an in-flight request without publishing it', async () => {
  let resolveRequest;
  const client = {
    getTask: () => new Promise((resolve) => { resolveRequest = resolve; }),
    async cancelTask() { throw new Error('unused'); },
    async getTaskResult() { throw new Error('unused'); },
  };
  const store = new TaskStore(client, 'task-1', { pollIntervalMs: 1 });
  store.start();
  await eventually(() => typeof resolveRequest === 'function');
  store.stop();
  resolveRequest(snapshot(9, 'succeeded'));
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(store.getSnapshot().status, 'stopped');
  assert.equal(store.getSnapshot().snapshot, undefined);
});

test('TaskStore does not poll a hidden browser tab and resumes when visible', async () => {
  const previousDocument = globalThis.document;
  const fakeDocument = new EventTarget();
  fakeDocument.visibilityState = 'hidden';
  globalThis.document = fakeDocument;
  let calls = 0;
  const client = {
    async getTask() { calls++; return snapshot(1, 'running'); },
    async cancelTask() { throw new Error('unused'); },
    async getTaskResult() { throw new Error('unused'); },
  };
  const store = new TaskStore(client, 'task-1', { pollIntervalMs: 60_000 });
  try {
    store.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, 0);
    fakeDocument.visibilityState = 'visible';
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    await eventually(() => calls === 1);
  } finally {
    store.stop();
    globalThis.document = previousDocument;
  }
});

test('TaskStore re-reads and retries when polling wins the cancel version race', async () => {
  let version = 4;
  const cancelVersions = [];
  const client = {
    async getTask() { return snapshot(version, 'running'); },
    async cancelTask(_id, expectedVersion) {
      cancelVersions.push(expectedVersion);
      if (cancelVersions.length === 1) {
        version = 5;
        throw Object.assign(new Error('stale'), { code: 'RHINOQ_VERSION_CONFLICT' });
      }
      version = 6;
      return snapshot(version, 'cancel_requested');
    },
    async getTaskResult() { throw new Error('unused'); },
  };
  const store = new TaskStore(client, 'task-1');
  await store.refresh();

  const result = await store.cancel();

  assert.deepEqual(cancelVersions, [4, 5]);
  assert.equal(result.state, 'cancel_requested');
  assert.equal(store.getSnapshot().snapshot.entityVersion, 6);
});

test('a broken subscriber cannot stop delivery to other subscribers', async () => {
  const listenerErrors = [];
  let delivered = 0;
  const store = new TaskStore({
    async getTask() { return snapshot(2, 'running'); },
    async cancelTask() { throw new Error('unused'); },
    async getTaskResult() { throw new Error('unused'); },
  }, 'task-1', { onListenerError: (error) => listenerErrors.push(error.message) });
  store.subscribe(() => { throw new Error('broken component'); });
  store.subscribe(() => { delivered++; });

  await store.refresh();

  assert.equal(delivered, 1);
  assert.deepEqual(listenerErrors, ['broken component']);
  assert.equal(store.getSnapshot().snapshot.entityVersion, 2);
});

test('TaskStore fails a permanently conflicting cancel after a bounded retry budget', async () => {
  let version = 10;
  const attempts = [];
  const client = {
    async getTask() { return snapshot(version, 'running'); },
    async cancelTask(_id, expectedVersion) {
      attempts.push(expectedVersion);
      version++;
      throw Object.assign(new Error(`conflict-${version}`), {
        code: 'RHINOQ_VERSION_CONFLICT',
      });
    },
    async getTaskResult() { throw new Error('unused'); },
  };
  const store = new TaskStore(client, 'task-1');

  await assert.rejects(store.cancel(), /conflict-13/);

  assert.deepEqual(attempts, [10, 11, 12]);
  assert.equal(store.getSnapshot().snapshot.entityVersion, 13);
});

test('TaskStore retries with command identity and downloads an authorized result', async () => {
  const calls = [];
  const client = {
    async getTask() { return { ...snapshot(4, 'failed'), hasResult: true }; },
    async cancelTask() { throw new Error('unused'); },
    async retryTask(id, version, commandId) { calls.push([id, version, commandId]); return snapshot(5, 'queued'); },
    async getTaskResult() { return { url: 'https://download.test/result', expiresAt: '2026-08-02T00:00:00Z' }; },
  };
  const opened = [];
  const store = new TaskStore(client, 'task-1');
  await store.refresh();

  assert.equal((await store.retry('retry-command-1')).state, 'queued');
  assert.deepEqual(calls, [['task-1', 4, 'retry-command-1']]);
  await store.downloadResult((url) => { opened.push(url); });
  assert.deepEqual(opened, ['https://download.test/result']);
});

function snapshot(entityVersion, state) {
  return {
    schemaVersion: 1, entityVersion, id: 'task-1', type: 'report.export', state,
    progress: { completed: 0 }, hasResult: false, executions: [],
    createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:01Z',
  };
}

async function eventually(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
