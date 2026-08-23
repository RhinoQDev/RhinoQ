import assert from 'node:assert/strict';
import test from 'node:test';

import { taskFlightRecorder } from '../dist/index.js';

test('Flight Recorder includes fenced durable Step state without exposing result references', () => {
  const recorder = taskFlightRecorder({
    task: {
      schemaVersion: 1, entityVersion: 4, id: 'task-1', type: 'report', state: 'running',
      cancellation: { status: 'none' }, progress: { completed: 0 }, hasResult: false, executions: [],
      createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:04.000Z',
    },
    steps: [{
      id: 'step-1', taskId: 'task-1', executionId: 'execution-1', itemKey: 'default', key: 'render',
      taskVersion: 1, stepVersion: 2, state: 'completed', result: { html: 'ok' },
      resultRef: 'artifact:private-render', attempt: 1,
      createdAt: '2026-08-23T00:00:01.000Z', updatedAt: '2026-08-23T00:00:03.000Z', completedAt: '2026-08-23T00:00:03.000Z',
    }],
  });

  const event = recorder.events.find((value) => value.kind === 'step.state');
  assert.equal(event.stepKey, 'render');
  assert.equal(event.hasResult, true);
  assert.equal(JSON.stringify(recorder).includes('artifact:private-render'), false);
});
