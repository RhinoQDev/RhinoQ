import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForApproval, waitForInput } from '../dist/index.js';

const base = { schemaVersion: 1, entityVersion: 1, id: 'wp-1', taskId: 'task-1', key: 'review', kind: 'input', payloadVersion: 1, createdAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z' };

test('waitForInput resumes from the same durable waitpoint without holding a worker open', async () => {
  let state = { ...base, state: 'waiting' };
  const client = { async createTaskWaitpoint(taskId, request) { assert.equal(taskId, 'task-1'); assert.equal(request.id, 'wp-1'); return state; } };
  assert.equal((await waitForInput(client, { taskId: 'task-1', id: 'wp-1', key: 'review', kind: 'input', payloadVersion: 1 })).status, 'waiting');
  state = { ...state, state: 'resolved', entityVersion: 2, resolution: { answer: 42 } };
  const resumed = await waitForInput(client, { taskId: 'task-1', id: 'wp-1', key: 'review', kind: 'input', payloadVersion: 1, parse: value => value.answer });
  assert.equal(resumed.status, 'resolved'); assert.equal(resumed.value, 42);
});

test('waitForApproval validates the resolution contract', async () => {
  const client = { async createTaskWaitpoint() { return { ...base, kind: 'approval', state: 'resolved', resolution: { approved: true } }; } };
  const result = await waitForApproval(client, { taskId: 'task-1', id: 'wp-1', key: 'review', payloadVersion: 1 });
  assert.equal(result.value, true);
});
