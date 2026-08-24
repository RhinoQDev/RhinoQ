import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectRhinoQTask } from '../dist/index.js';

test('shared operator inspection stays read-only and marks unavailable evidence', async () => {
  const task = {
    schemaVersion: 1, entityVersion: 3, id: 'task-1', type: 'report.export', state: 'failed',
    cancellation: { status: 'none' }, progress: { completed: 0 }, hasResult: false,
    executions: [{ id: 'execution-1', itemKey: 'default', attempt: 1, runtime: 'bullmq', state: 'failed', hasResult: false, failureReason: 'provider timeout' }],
    createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:01:00.000Z',
  };
  const source = {
    async getTask() { return task; },
    async getTaskExecutionResults() { return { executions: [{ executionId: 'execution-1', failureReason: 'provider timeout' }] }; },
    async listTaskVerifications() { return []; },
  };
  const inspection = await inspectRhinoQTask(source, 'task-1');
  assert.equal(inspection.task, task);
  assert.match(inspection.incidentExplanation.technicalState, /Task=failed/);
  assert.ok(inspection.flightRecorder.attention.some((item) => item.kind === 'failed'));
  assert.ok(inspection.missingEvidence.some((item) => item.startsWith('provider_operations:')));
});
