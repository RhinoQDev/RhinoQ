import assert from 'node:assert/strict';
import test from 'node:test';

import { bullMQCancellation } from '../dist/index.js';

test('BullMQ cancellation removes queued jobs and fails closed for active work', async () => {
  let removed = false;
  const queued = bullMQCancellation({ queue: { async getJob() { return { async getState() { return 'waiting'; }, async remove() { removed = true; } }; } } });
  assert.equal((await queued('job-1', execution())).status, 'acknowledged');
  assert.equal(removed, true);

  const active = bullMQCancellation({ queue: { async getJob() { return { async getState() { return 'active'; }, async remove() {} }; } } });
  assert.equal((await active('job-2', execution())).status, 'cannot_cancel_safely');

  const signalled = bullMQCancellation({
    queue: { async getJob() { return { async getState() { return 'active'; }, async remove() {} }; } },
    cooperativeSignal: async () => true,
  });
  assert.equal((await signalled('job-3', execution())).status, 'acknowledged');
});

function execution() { return { id: 'execution-1', taskId: 'task-1', itemKey: 'default', state: 'running', attempt: 1, runtime: { kind: 'bullmq', jobId: 'job-1' }, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' }; }
