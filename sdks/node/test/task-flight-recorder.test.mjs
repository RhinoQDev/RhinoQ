import assert from 'node:assert/strict';
import test from 'node:test';
import { taskFlightRecorder } from '../dist/index.js';

const task = (overrides = {}) => ({
  schemaVersion: 1,
  entityVersion: 8,
  id: 'task-flight-1',
  type: 'report.generate',
  ownerId: 'owner-a',
  state: 'running',
  cancellation: { status: 'none' },
  progress: { completed: 1, total: 2 },
  hasResult: false,
  executions: [
    { id: 'execution-a', itemKey: 'report-a', attempt: 1, runtime: 'bullmq', state: 'succeeded', version: 3, hasResult: true },
    { id: 'execution-b', itemKey: 'report-b', attempt: 2, runtime: 'bullmq', state: 'failed', version: 4, hasResult: false, failureReason: 'provider returned 502' },
  ],
  createdAt: '2026-08-10T08:00:00.000Z',
  updatedAt: '2026-08-10T08:02:00.000Z',
  ...overrides,
});

test('Flight Recorder joins task, execution result and partial-failure attention', () => {
  const recorder = taskFlightRecorder({
    task: task(),
    executionResults: [
      { executionId: 'execution-a', itemKey: 'report-a', attempt: 1, state: 'succeeded', reference: 'storage://hidden', updatedAt: '2026-08-10T08:01:00.000Z' },
      { executionId: 'execution-b', itemKey: 'report-b', attempt: 2, state: 'failed', failureReason: 'provider returned 502', updatedAt: '2026-08-10T08:02:00.000Z' },
    ],
    now: () => new Date('2026-08-10T08:03:00.000Z'),
  });

  assert.equal(recorder.schemaVersion, 1);
  assert.equal(recorder.generatedAt, '2026-08-10T08:03:00.000Z');
  assert.equal(recorder.attention[0].kind, 'partial_failure');
  assert.equal(recorder.attention[0].safeToRetry, undefined);
  assert.match(recorder.attention[0].message, /Review failed attempts/);
  assert.ok(recorder.events.some((event) => event.kind === 'execution.result'));
  assert.ok(!JSON.stringify(recorder).includes('storage://hidden'), 'storage references must not enter the operator timeline');
});

test('expired and waiting waitpoints explain why a Task needs attention', () => {
  const recorder = taskFlightRecorder({
    task: task({ state: 'running', executions: [] }),
    waitpoints: [
      {
        schemaVersion: 1, entityVersion: 2, id: 'wp-expired', taskId: 'task-flight-1',
        key: 'approval', kind: 'approval', state: 'expired', payloadVersion: 1,
        deadline: '2026-08-10T08:01:00.000Z', createdAt: '2026-08-10T08:00:00.000Z', updatedAt: '2026-08-10T08:02:00.000Z',
      },
      {
        schemaVersion: 1, entityVersion: 1, id: 'wp-input', taskId: 'task-flight-1',
        key: 'customer-input', kind: 'input', state: 'waiting', payloadVersion: 1,
        deadline: '2026-08-10T08:05:00.000Z', createdAt: '2026-08-10T08:00:30.000Z', updatedAt: '2026-08-10T08:00:30.000Z',
      },
    ],
  });

  assert.deepEqual(recorder.attention.map((item) => item.kind).sort(), ['waitpoint_expired', 'waitpoint_waiting']);
  assert.ok(recorder.attention.some((item) => /Waiting for input/.test(item.message)));
  assert.ok(recorder.events.some((event) => event.state === 'expired'));
});

test('uncertain Tasks are explicitly fail-closed', () => {
  const recorder = taskFlightRecorder({ task: task({ state: 'uncertain', executions: [] }) });
  assert.equal(recorder.attention[0].kind, 'uncertain');
  assert.equal(recorder.attention[0].safeToRetry, false);
  assert.match(recorder.explanation, /confirmation|cannot yet prove/i);
});
