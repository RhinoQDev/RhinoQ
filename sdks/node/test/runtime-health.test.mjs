import assert from 'node:assert/strict';
import test from 'node:test';
import { BullMQRuntimeInspector } from '../dist/index.js';

test('BullMQ runtime health reports queue counts, workers and retry policy', async () => {
  const inspector = new BullMQRuntimeInspector({ queue: {
    name: 'reports', opts: { defaultJobOptions: { attempts: 3, backoff: { type: 'exponential' } } },
    async getJobCounts() { return { waiting: 4, active: 2, delayed: 1, failed: 3, completed: 9 }; },
    async isPaused() { return false; }, async getWorkers() { return [{}, {}]; },
  } });
  const health = await inspector.inspect();
  assert.equal(health.status, 'healthy');
  assert.deepEqual(health.workers, { observable: true, connected: 2 });
  assert.equal(health.queue.waiting, 4);
  assert.deepEqual(health.policy, { attempts: 3, backoff: 'exponential' });
});

test('waiting work with no workers is degraded', async () => {
  const inspector = new BullMQRuntimeInspector({ queue: {
    name: 'reports', async getJobCounts() { return { waiting: 1 }; }, async getWorkers() { return []; },
  } });
  const health = await inspector.inspect();
  assert.equal(health.status, 'degraded');
  assert.equal(health.reason, 'waiting_without_workers');
});

test('provider failures are unavailable without leaking their message', async () => {
  const inspector = new BullMQRuntimeInspector({ queue: {
    name: 'reports', async getJobCounts() { throw new Error('redis://secret@internal'); },
  } });
  const health = await inspector.inspect();
  assert.equal(health.status, 'unavailable');
  assert.equal(health.reason, 'runtime_unreachable');
  assert.ok(!JSON.stringify(health).includes('secret'));
});
