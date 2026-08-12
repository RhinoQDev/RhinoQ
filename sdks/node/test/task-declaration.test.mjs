import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineRhinoQTask } from '../dist/index.js';

test('one Task declaration drives stable dispatch identity and the worker handler', async () => {
  const calls = [];
  const integration = {
    async dispatch(adapter, command) {
      calls.push({ adapter, command });
      return { id: command.task.id, type: command.task.type, ownerId: command.task.ownerId,
        state: 'queued', entityVersion: 2, schemaVersion: 1, progress: { completed: 0 },
        hasResult: false, executions: [], createdAt: '2026-08-12T00:00:00Z', updatedAt: '2026-08-12T00:00:00Z' };
    },
  };
  const task = defineRhinoQTask(integration, {
    name: 'report.export', adapter: 'bullmq', runtime: 'bullmq', scope: 'reports',
    retry: { mode: 'runtime', maxAttempts: 3, backoff: { type: 'exponential', delayMs: 1000 } },
    run: async ({ reportId }) => ({ ref: `${reportId}.pdf` }),
    result: (output) => ({ ref: output.ref, mediaType: 'application/pdf' }),
  });
  const snapshot = await task.dispatch({ id: 'report-42', ownerId: 'owner-a', payload: { reportId: '42' } });
  assert.equal(snapshot.state, 'queued');
  assert.equal(calls[0].adapter, 'bullmq');
  assert.equal(calls[0].command.idempotencyKey, 'report-42');
  assert.equal(calls[0].command.executionId, 'report-42:attempt:1');
  assert.deepEqual(calls[0].command.retry, { maxAttempts: 3, backoff: { type: 'exponential', delayMs: 1000 } });
  assert.deepEqual(calls[0].command.payload, {
    taskName: 'report.export', taskId: 'report-42', executionId: 'report-42:attempt:1', definitionVersion: 1,
    retry: { mode: 'runtime', maxAttempts: 3, backoff: { type: 'exponential', delayMs: 1000 } },
    payload: { reportId: '42' },
  });
  const output = await task.execute({ reportId: '42' }, { taskId: 'report-42', executionId: 'one', progress() {} });
  assert.deepEqual(task.resultMetadata(output), { ref: '42.pdf', mediaType: 'application/pdf' });
  const progress = [];
  const workerOutput = await task.workerHandler()({ data: calls[0].command.payload, updateProgress(value) { progress.push(value); } });
  assert.deepEqual(workerOutput, { ref: '42.pdf' });
  assert.deepEqual(progress, []);
  await assert.rejects(() => task.workerHandler()({ data: { ...calls[0].command.payload, taskName: 'other' } }), /refuses an undeclared Task envelope/);
});

test('Task declaration defaults to no retry and refuses undeclared external effects', () => {
  const integration = { async dispatch() { throw new Error('not reached'); } };
  const safe = defineRhinoQTask(integration, {
    name: 'local.compute', adapter: 'manual', runtime: 'manual', scope: 'local', run: async () => undefined,
  });
  assert.deepEqual(safe.retry, { mode: 'never' });
  assert.throws(() => defineRhinoQTask(integration, {
    name: 'payment.refund', adapter: 'manual', runtime: 'manual', scope: 'payments',
    externalEffect: true, run: async () => undefined,
  }), /explicit idempotency and confirmation policy/);
});
