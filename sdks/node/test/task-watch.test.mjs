import assert from 'node:assert/strict';
import test from 'node:test';

import { watchTask } from '../dist/index.js';

test('watchTask ignores stale snapshots and stops on a newer terminal version', async () => {
  const snapshots = [
    snapshot(2, 'running'),
    snapshot(1, 'queued'),
    snapshot(3, 'succeeded'),
  ];
  let calls = 0;
  const client = {
    async getTask() {
      return snapshots[calls++];
    },
  };

  const seen = [];
  for await (const current of watchTask(client, 'task_watch_01', { pollIntervalMs: 1 })) {
    seen.push([current.entityVersion, current.state]);
  }

  assert.deepEqual(seen, [
    [2, 'running'],
    [3, 'succeeded'],
  ]);
  assert.equal(calls, 3);
});

test('watchTask aborts during the polling delay without another request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = {
    async getTask() {
      calls++;
      return snapshot(1, 'running');
    },
  };
  const watcher = watchTask(client, 'task_watch_02', {
    pollIntervalMs: 60_000,
    signal: controller.signal,
  });

  const first = await watcher.next();
  assert.equal(first.value?.entityVersion, 1);
  controller.abort();
  const stopped = await watcher.next();

  assert.equal(stopped.done, true);
  assert.equal(calls, 1);
});

test('watchTask validates the polling contract before making a request', async () => {
  const client = { getTask: async () => snapshot(1, 'running') };

  await assert.rejects(
    async () => {
      for await (const _snapshot of watchTask(client, '', { pollIntervalMs: 1 })) {
        // The generator must reject before yielding.
      }
    },
    /task id is required/,
  );
  await assert.rejects(
    async () => {
      for await (const _snapshot of watchTask(client, 'task_watch_03', { pollIntervalMs: 0 })) {
        // The generator must reject before yielding.
      }
    },
    /pollIntervalMs must be a positive number/,
  );
});

function snapshot(entityVersion, state) {
  return {
    schemaVersion: 1,
    entityVersion,
    id: 'task_watch_01',
    type: 'report.export',
    state,
    progress: { completed: 0 },
    hasResult: false,
    executions: [],
    createdAt: '2026-07-29T00:00:00Z',
    updatedAt: '2026-07-29T00:00:01Z',
  };
}
