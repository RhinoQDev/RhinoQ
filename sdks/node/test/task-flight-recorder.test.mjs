import assert from 'node:assert/strict';
import test from 'node:test';
import { taskFlightRecorder, taskFlightRecorderDiagnostic } from '../dist/index.js';

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

  assert.equal(recorder.schemaVersion, 2);
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

test('Flight Recorder joins business verification, provider outcome and artifact lineage', () => {
  const recorder = taskFlightRecorder({
    task: task({ executions: [] }),
    verifications: [{ schemaVersion: 1, id: 'verify-1', taskId: 'task-flight-1', verifier: 'invoice-exists', status: 'mismatch', summary: 'Invoice row is missing', finding: { ruleId: 'invoice-exists', subjectType: 'invoice', subjectId: 'inv-1', invariantVersion: 7 }, verifiedAt: '2026-08-10T08:03:00.000Z', createdAt: '2026-08-10T08:03:00.000Z' }],
    providerOperations: [{ id: 'provider-1', taskId: 'task-flight-1', provider: 'billing', operation: 'charge', idempotencyKey: 'charge-1', confirmation: 'readback', retryPolicy: 'when-not-happened', state: 'uncertain', reason: 'timeout after request write', version: 2, createdAt: '2026-08-10T08:01:00.000Z', updatedAt: '2026-08-10T08:02:00.000Z' }],
    artifacts: [{ schemaVersion: 1, entityVersion: 1, id: 'artifact-1', taskId: 'task-flight-1', name: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: 42, checksumSha256: 'a'.repeat(64), expiresAt: '2026-08-11T08:00:00.000Z', lineage: ['artifact-source'], createdAt: '2026-08-10T08:02:30.000Z', updatedAt: '2026-08-10T08:02:30.000Z' }],
    checkpoints: [{ schemaVersion: 1, id: 'checkpoint-1', taskId: 'task-flight-1', executionId: 'execution-a', key: 'pdf-render', handlerVersion: 4, inputChecksum: 'b'.repeat(64), state: { page: 2 }, completed: false, version: 2, createdAt: '2026-08-10T08:01:30.000Z', updatedAt: '2026-08-10T08:01:45.000Z' }],
    now: () => new Date('2026-08-10T08:04:00.000Z'),
  });
  assert.ok(recorder.events.some((event) => event.kind === 'verification.outcome' && event.verifier === 'invoice-exists' && event.invariantVersion === 7));
  assert.ok(recorder.events.some((event) => event.kind === 'checkpoint.state' && event.handlerVersion === 4));
  assert.ok(recorder.events.some((event) => event.kind === 'provider.operation'));
  assert.ok(recorder.events.some((event) => event.kind === 'artifact.recorded'));
  assert.ok(recorder.attention.some((item) => item.kind === 'business_mismatch' && item.safeToRetry === false));
  assert.ok(recorder.attention.some((item) => item.kind === 'provider_uncertain' && item.safeToRetry === false));
});

test('Flight Recorder compares retries and preserves supplied waterfall timings', () => {
  const recorder = taskFlightRecorder({
    task: task({ executions: [
      { id: 'attempt-1', itemKey: 'item-a', attempt: 1, runtime: 'worker', state: 'failed', version: 2, failureReason: 'timeout' },
      { id: 'attempt-2', itemKey: 'item-a', attempt: 2, runtime: 'worker', state: 'succeeded', version: 3, hasResult: true },
    ] }),
    traceId: 'trace-1',
    waterfall: [{ id: 'span-1', label: 'provider call', startAt: '2026-08-10T08:00:00.000Z', endAt: '2026-08-10T08:00:01.000Z', traceId: 'trace-1' }],
  });
  assert.equal(recorder.traceId, 'trace-1');
  assert.deepEqual(recorder.attemptDiffs[0], {
    itemKey: 'item-a', executionId: 'attempt-2', attempt: 2, previousExecutionId: 'attempt-1',
    changed: ['state:failed->succeeded', 'failureReason'],
  });
  assert.equal(recorder.waterfall[0].label, 'provider call');
});

test('Flight Recorder diagnostic export is bounded and redaction-safe', () => {
  const recorder = taskFlightRecorder({ task: task() });
  const diagnostic = taskFlightRecorderDiagnostic(recorder, 4096);
  assert.ok(new TextEncoder().encode(diagnostic).byteLength <= 4096);
  assert.equal(JSON.parse(diagnostic).recorder.taskId, 'task-flight-1');
  assert.equal(diagnostic.includes('storage://'), false);
});
