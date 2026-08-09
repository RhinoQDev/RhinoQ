import assert from 'node:assert/strict';
import test from 'node:test';

import { taskUIModel } from '../dist/index.js';

test('task UI model exposes safe actions and attention states', () => {
  assert.deepEqual(taskUIModel(task('uncertain')).attention.kind, 'uncertain');
  assert.equal(taskUIModel(task('running')).canCancel, true);
  assert.equal(taskUIModel(task('failed')).canRetry, true);
  assert.equal(taskUIModel(task('succeeded', { cancellation: { status: 'too_late' } })).attention.kind, 'cancel_too_late');
  assert.equal(taskUIModel(task('running', { cancellation: { status: 'cannot_cancel_safely', reason: 'effect started' } })).attention.message, 'effect started');
  assert.equal(taskUIModel(task('failed', { executionCounts: { pending: 0, running: 0, succeeded: 2, failed: 1, cancelled: 0, uncertain: 0 } })).attention.kind, 'partial_failure');
});

function task(state, extra = {}) {
  return { schemaVersion: 1, entityVersion: 1, id: 'task-1', type: 'export', state,
    progress: { completed: 1, total: 2 }, hasResult: state === 'succeeded', executions: [],
    createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:01Z', ...extra };
}
