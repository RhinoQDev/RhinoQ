import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskWaitpointStore } from '../dist/index.js';

const waiting = { schemaVersion: 1, entityVersion: 1, id: 'wp-1', taskId: 'task-1', key: 'approve', kind: 'approval', state: 'waiting', payloadVersion: 1, createdAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z' };

test('TaskWaitpointStore exposes loading and idempotent command identity', async () => {
  const calls = [];
  const store = new TaskWaitpointStore({
    async getTaskWaitpoint() { return waiting; },
    async resolveTaskWaitpoint(taskId, waitpointId, request) { calls.push({ taskId, waitpointId, request }); return { ...waiting, entityVersion: 2, state: 'resolved', resolution: request.resolution }; },
  }, 'task-1', 'wp-1');
  const pending = store.refresh(); assert.equal(store.getSnapshot().loading, true); await pending;
  const resolved = await store.submit({ approved: true }, 'submit-1');
  assert.equal(resolved.state, 'resolved'); assert.equal(calls[0].request.expectedVersion, 1); assert.equal(calls[0].request.resolutionId, 'submit-1');
  await assert.rejects(() => store.submit({}, 'submit-2'), /resolved/);
});
