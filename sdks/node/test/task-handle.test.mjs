import assert from 'node:assert/strict';
import test from 'node:test';

import { TaskHandle } from '../dist/index.js';

// A fake client that records the version each call was fenced with, and returns
// a snapshot one version newer. It lets the unit tests prove the handle threads
// the version without a database.
function fakeClient(initial) {
  let snapshot = initial;
  const fencedWith = [];
  const bump = (patch) => {
    snapshot = { ...snapshot, entityVersion: snapshot.entityVersion + 1, ...patch };
    return snapshot;
  };
  return {
    fencedWith,
    snapshot: () => snapshot,
    async getTask() { return snapshot; },
    async transitionTask(id, version, state) { fencedWith.push(version); return bump({ state }); },
    async reportTaskProgress(id, version, progress) { fencedWith.push(version); return bump({ progress }); },
    async requestTaskCancellation(id, version) { fencedWith.push(version); return bump({ state: 'cancel_requested' }); },
    async attachTaskResult(id, version) { fencedWith.push(version); bump({ hasResult: true }); return {}; },
  };
}

function snapshot(overrides = {}) {
  return { schemaVersion: 1, id: 'task-1', type: 't', state: 'pending', entityVersion: 1, progress: { completed: 0 }, hasResult: false, executions: [], createdAt: '', updatedAt: '', ...overrides };
}

test('the handle threads the version so the caller never passes one', async () => {
  const client = fakeClient(snapshot());
  const handle = new TaskHandle(client, client.snapshot());

  await handle.start();          // pending -> queued -> running: two writes
  await handle.reportProgress({ completed: 5 });
  await handle.succeed();

  // Each write must have been fenced with the version the previous one returned,
  // strictly increasing, with no gap and nothing threaded by the caller.
  assert.deepEqual(client.fencedWith, [1, 2, 3, 4], 'versions must be threaded in order');
  assert.equal(handle.version, 5);
  assert.equal(handle.state, 'succeeded');
  assert.equal(handle.isTerminal, true);
});

test('start() from an already-running task does nothing', async () => {
  const client = fakeClient(snapshot({ state: 'running', entityVersion: 9 }));
  const handle = new TaskHandle(client, client.snapshot());
  await handle.start();
  assert.deepEqual(client.fencedWith, [], 'a running task needs no start transitions');
  assert.equal(handle.version, 9);
});

test('start() from queued only does the running step', async () => {
  const client = fakeClient(snapshot({ state: 'queued', entityVersion: 3 }));
  const handle = new TaskHandle(client, client.snapshot());
  await handle.start();
  assert.deepEqual(client.fencedWith, [3], 'only one transition from queued');
  assert.equal(handle.state, 'running');
});

test('a version conflict is surfaced, not retried', async () => {
  const client = fakeClient(snapshot({ state: 'running', entityVersion: 2 }));
  client.transitionTask = async () => {
    const error = new Error('RHINOQ_VERSION_CONFLICT');
    error.code = 'RHINOQ_VERSION_CONFLICT';
    throw error;
  };
  const handle = new TaskHandle(client, client.snapshot());
  await assert.rejects(handle.succeed(), (error) => error.code === 'RHINOQ_VERSION_CONFLICT');
  // The handle must not have silently retried or advanced.
  assert.equal(handle.version, 2);
});

test('refresh() resumes from the current truth', async () => {
  const client = fakeClient(snapshot({ state: 'running', entityVersion: 7 }));
  const handle = new TaskHandle(client, snapshot({ state: 'running', entityVersion: 2 }));
  await handle.refresh();
  assert.equal(handle.version, 7, 'refresh adopts the latest version');
});

test('attachResult refreshes so the next write is not stale', async () => {
  const client = fakeClient(snapshot({ state: 'running', entityVersion: 4 }));
  const handle = new TaskHandle(client, client.snapshot());
  await handle.attachResult('s3://bucket/result.json');
  // attach fenced with 4; the handle then refreshed to the post-attach version.
  assert.equal(client.fencedWith[0], 4);
  assert.equal(handle.version, 5);
});

test('complete() hides the happy-path lifecycle while preserving version fencing', async () => {
  const client = fakeClient(snapshot());
  const handle = new TaskHandle(client, client.snapshot());

  await handle.complete('s3://bucket/result.json');

  assert.deepEqual(client.fencedWith, [1, 2, 3, 4], 'start, attach and succeed must stay fenced');
  assert.equal(handle.state, 'succeeded');
  assert.equal(handle.snapshot.hasResult, true);
});

test('the handle refuses a missing client or snapshot', () => {
  assert.throws(() => new TaskHandle(null, snapshot()), TypeError);
  assert.throws(() => new TaskHandle(fakeClient(snapshot()), {}), TypeError);
});
