import test from 'node:test';
import assert from 'node:assert/strict';
import { WaitpointExpiryScheduler } from '../dist/index.js';

test('waitpoint expiry scheduler uses a bounded command and reports expirations', async () => {
  const calls = [];
  const notices = [];
  const scheduler = new WaitpointExpiryScheduler({
    tasks: { expireTaskWaitpoints: async (limit) => { calls.push(limit); return 3; } },
    batchLimit: 17,
    onExpired: async (count) => notices.push(count),
  });

  assert.equal(await scheduler.sweep(), 3);
  assert.deepEqual(calls, [17]);
  assert.deepEqual(notices, [3]);
  assert.equal(scheduler.lastExpiredCount, 3);
  assert.equal(scheduler.sweepCount, 1);
});

test('waitpoint expiry scheduler does not overlap sweeps', async () => {
  let release;
  let calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const scheduler = new WaitpointExpiryScheduler({
    tasks: { expireTaskWaitpoints: async () => { calls += 1; await pending; return 1; } },
  });

  const first = scheduler.sweep();
  assert.equal(await scheduler.sweep(), 0);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, 1);
});

test('waitpoint expiry scheduler reports errors and keeps the loop usable', async () => {
  const errors = [];
  const scheduler = new WaitpointExpiryScheduler({
    tasks: { expireTaskWaitpoints: async () => { throw new Error('database unavailable'); } },
    onError: error => errors.push(error.message),
  });

  assert.equal(await scheduler.sweep(), 0);
  assert.deepEqual(errors, ['database unavailable']);
  assert.equal(scheduler.sweepCount, 1);
});

test('waitpoint expiry scheduler validates interval and batch bounds', () => {
  const tasks = { expireTaskWaitpoints: async () => 0 };
  assert.throws(() => new WaitpointExpiryScheduler({ tasks, everyMs: 999 }), /at least 1000/);
  assert.throws(() => new WaitpointExpiryScheduler({ tasks, batchLimit: 501 }), /between 1 and 500/);
});
