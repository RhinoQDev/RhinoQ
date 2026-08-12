import assert from 'node:assert/strict';
import test from 'node:test';

import { explainTask, taskUIModel } from '../dist/index.js';

test('task UI model exposes safe actions and attention states', () => {
  assert.deepEqual(taskUIModel(task('uncertain')).attention.kind, 'uncertain');
  assert.equal(taskUIModel(task('running')).canCancel, true);
  assert.equal(taskUIModel(task('failed')).canRetry, true);
  assert.equal(taskUIModel(task('succeeded', { cancellation: { status: 'too_late' } })).attention.kind, 'cancel_too_late');
  assert.equal(taskUIModel(task('running', { cancellation: { status: 'cannot_cancel_safely', reason: 'effect started' } })).attention.message, 'effect started');
  assert.equal(taskUIModel(task('failed', { executionCounts: { pending: 0, running: 0, succeeded: 2, failed: 1, cancelled: 0, uncertain: 0 } })).attention.kind, 'partial_failure');
});

test('task UI distinguishes recorded result and unconfigured business verification', () => {
  const model = taskUIModel(task('succeeded', { hasResult: true }));
  assert.deepEqual(model.result, { recorded: true, availability: 'not_configured' });
  assert.deepEqual(model.verification, { status: 'not_configured' });
  const verified = taskUIModel(task('succeeded', { hasResult: true, verifications: [{ status: 'verified' }] }));
  assert.deepEqual(verified.verification, { status: 'verified' });
});

test('task explanations answer status, meaning and next action without runtime jargon', () => {
  for (const state of ['pending', 'queued', 'running', 'cancel_requested', 'cancelled', 'failed', 'uncertain', 'succeeded']) {
    const explanation = explainTask(task(state));
    assert.ok(explanation.headline, `${state} needs a headline`);
    assert.ok(explanation.explanation, `${state} needs an explanation`);
    assert.ok(explanation.progressText, `${state} needs progress`);
    if (state !== 'succeeded') assert.ok(explanation.recommendedAction?.label, `${state} needs a next action`);
    assert.doesNotMatch(JSON.stringify(explanation), /bullmq|redis|lease|projector|fence/i);
  }
  assert.equal(explainTask(task('uncertain')).retrySafety, 'unsafe');
  assert.match(explainTask(task('uncertain')).headline, /confirmation/i);
  assert.match(explainTask(task('failed')).recommendedAction.label, /review/i);
});

test('partial progress counts the latest attempt for each item only', () => {
  const explanation = explainTask(task('running', {
    executions: [
      { id: 'a-1', itemKey: 'a', attempt: 1, state: 'failed' },
      { id: 'a-2', itemKey: 'a', attempt: 2, state: 'succeeded' },
      { id: 'b-1', itemKey: 'b', attempt: 1, state: 'failed' },
    ],
  }));
  assert.equal(explanation.headline, '1 item needs attention');
  assert.equal(explanation.progressText, '2 of 2 items finished');
  assert.equal(explanation.retrySafety, 'review');
  assert.match(explanation.recommendedAction.label, /failed items/i);
});

function task(state, extra = {}) {
  return { schemaVersion: 1, entityVersion: 1, id: 'task-1', type: 'export', state,
    progress: { completed: 1, total: 2 }, hasResult: state === 'succeeded', executions: [],
    createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:01Z', ...extra };
}
