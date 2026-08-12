import assert from 'node:assert/strict';
import test from 'node:test';
import { explainTaskIncident } from '../dist/index.js';

const task = {
  schemaVersion: 1, entityVersion: 4, id: 'task-1', type: 'report.export', ownerId: 'owner-1',
  state: 'uncertain', cancellation: { status: 'none' }, progress: { completed: 1, total: 1 },
  hasResult: false, createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:01:00.000Z',
  executions: [{
    id: 'execution-1', itemKey: 'report-1', attempt: 1, runtime: 'custom', runtimeScope: 'reports',
    state: 'succeeded', version: 3, hasResult: false,
  }],
};

test('Incident Explainer keeps technical success separate from business verification', () => {
  const explanation = explainTaskIncident({
    task,
    runtimeReports: [{
      name: 'custom', scope: 'reports',
      capabilities: { events: 'push', dispatch: false, inspect: true, cancel: 'unsupported', progress: true, stableAttempts: true },
      health: { status: 'healthy', checkedAt: '2026-08-12T00:02:00.000Z' }, guaranteeGaps: [],
    }],
  });
  assert.ok(explanation.evidence.some((item) => item.kind === 'task_snapshot' && item.statement.includes('version')));
  assert.equal(explanation.businessOutcome, 'unknown');
  assert.match(explanation.summary, /cannot yet determine/);
  assert.ok(explanation.evidence.some((item) => /without a recorded result/.test(item.statement)));
  assert.ok(explanation.likelyCauses.some((cause) => cause.id === 'missing-result'));
  const cancel = explanation.recommendedActions.find((action) => action.id === 'request-cancellation');
  assert.equal(cancel, undefined, 'a terminal technical attempt does not make an uncertain Task cancellable');
});

test('verification evidence deterministically selects verified or violated outcome', () => {
  const record = {
    id: 'verification-1', taskId: 'task-1', verifier: 'object-exists', status: 'mismatch',
    verifiedAt: '2026-08-12T00:03:00.000Z', createdAt: '2026-08-12T00:03:00.000Z',
  };
  assert.equal(explainTaskIncident({ task, verifications: [record] }).businessOutcome, 'violated');
  assert.equal(explainTaskIncident({ task, verifications: [{ ...record, status: 'verified' }] }).businessOutcome, 'verified');
});

test('cancellation recommendation follows runtime capability reports', () => {
  const running = {
    ...task, state: 'running',
    executions: [{ ...task.executions[0], state: 'running' }],
  };
  const report = {
    name: 'custom', scope: 'reports', health: { status: 'healthy', checkedAt: '2026-08-12T00:02:00.000Z' }, guaranteeGaps: [],
    capabilities: { events: 'push', dispatch: false, inspect: true, cancel: 'unsupported', progress: true, stableAttempts: true },
  };
  const unsupported = explainTaskIncident({ task: running, runtimeReports: [report] });
  assert.equal(unsupported.recommendedActions.find((action) => action.id === 'request-cancellation').availability, 'unsupported');
  const supported = explainTaskIncident({
    task: running,
    runtimeReports: [{ ...report, capabilities: { ...report.capabilities, cancel: 'supported' } }],
  });
  assert.equal(supported.recommendedActions.find((action) => action.id === 'request-cancellation').availability, 'available');
});
