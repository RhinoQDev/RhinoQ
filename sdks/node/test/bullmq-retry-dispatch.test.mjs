import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createBullMQRetryDispatchHandler } from '../dist/bullmq/retry-dispatch.js';

const secret = 'dispatch-secret';
const intent = { schemaVersion: 1, commandId: 'retry-1', taskId: 'task-1', executionId: 'exec-2', runtime: 'bullmq', queue: 'reports', jobName: 'generate', data: { reportId: 'r1' }, attempt: 2 };
function request(payload = intent, signatureSecret = secret) {
  const body = JSON.stringify({ id: 9, eventType: 'task.retry.dispatch_requested', payload });
  const signature = createHmac('sha256', signatureSecret).update(body).digest('hex');
  return new Request('http://localhost/internal/rhinoq/retry-dispatch', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-rhinoq-signature': `v1=${signature}` } });
}

test('retry dispatch enqueues with immutable execution identity', async () => {
  const added = [];
  const handler = createBullMQRetryDispatchHandler({ secret, queues: { reports: { getJob: async () => undefined, add: async (...args) => added.push(args) } } });
  assert.equal((await handler(request())).status, 204);
  assert.deepEqual(added, [['generate', { reportId: 'r1' }, { jobId: 'exec-2', removeOnComplete: false, removeOnFail: false }]]);
});

test('lost response replay observes the existing job and does not add twice', async () => {
  let existing;
  let adds = 0;
  const handler = createBullMQRetryDispatchHandler({ secret, queues: { reports: { getJob: async () => existing, add: async () => { adds++; existing = { id: 'exec-2' }; } } } });
  assert.equal((await handler(request())).status, 204);
  assert.equal((await handler(request())).status, 204);
  assert.equal(adds, 1);
});

test('retry dispatch rejects forged events and unknown queues', async () => {
  const handler = createBullMQRetryDispatchHandler({ secret, queues: { reports: { getJob: async () => undefined, add: async () => assert.fail('must not enqueue') } } });
  assert.equal((await handler(request(intent, 'wrong'))).status, 401);
  assert.equal((await handler(request({ ...intent, queue: 'other' }))).status, 422);
});
