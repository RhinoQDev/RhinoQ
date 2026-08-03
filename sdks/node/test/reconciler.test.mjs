import assert from 'node:assert/strict';
import test from 'node:test';

import { TaskMetrics, TaskReconciler } from '../dist/index.js';

// bridge.reconcile() has existed since beta.3 and nothing ever called it on a
// schedule. A batch stuck at `running` -- a bridge that died mid-projection, a
// worker killed between the last item and the aggregate call -- stayed stuck
// until a human noticed. Three days later it was still running and still
// silent.

test('the default query looks for Tasks that stopped moving an hour ago', async () => {
  const seen = [];
  const reconciler = new TaskReconciler({
    tasks: { async listTasksByState(query) { seen.push(query); return []; } },
    async reconcile() {},
  });

  await reconciler.sweep();

  assert.deepEqual(seen, [{ states: ['running'], idleForMs: 3_600_000, limit: 100 }]);
});

test('a sweep reconciles every selected Task and reports the count', async () => {
  const handled = [];
  const reconciler = new TaskReconciler({
    tasks: { async listTasksByState() { return [summary('task-1'), summary('task-2')]; } },
    async reconcile(task) { handled.push(task.id); },
  });

  assert.equal(await reconciler.sweep(), 2);
  assert.deepEqual(handled, ['task-1', 'task-2']);
});

// One Task that cannot be reconciled must not hide every other stuck Task
// behind it. That is the failure mode of a naive for-loop with no try.
test('one failing Task does not abort the sweep', async () => {
  const handled = [];
  const errors = [];
  const reconciler = new TaskReconciler({
    tasks: { async listTasksByState() { return [summary('a'), summary('b'), summary('c')]; } },
    async reconcile(task) {
      if (task.id === 'b') throw new Error('the provider is down');
      handled.push(task.id);
    },
    onError: (error, task) => errors.push([task?.id, error.message]),
  });

  assert.equal(await reconciler.sweep(), 2);
  assert.deepEqual(handled, ['a', 'c']);
  assert.deepEqual(errors, [['b', 'the provider is down']]);
});

test('a failing read is reported and the reconciler stays usable', async () => {
  const errors = [];
  let attempt = 0;
  const reconciler = new TaskReconciler({
    tasks: {
      async listTasksByState() {
        attempt += 1;
        if (attempt === 1) throw new Error('ECONNREFUSED');
        return [summary('task-1')];
      },
    },
    async reconcile() {},
    onError: (error, task) => errors.push([task, error.message]),
  });

  assert.equal(await reconciler.sweep(), 0);
  assert.deepEqual(errors, [[undefined, 'ECONNREFUSED']]);
  assert.equal(await reconciler.sweep(), 1, 'a failed read must not stop later sweeps');
});

// A sweep still running when the next tick arrives means the interval is
// shorter than the work. Overlapping them multiplies load on the database
// that is already the reason the sweep is slow.
test('a sweep that is still running skips the next tick instead of overlapping', async () => {
  const metrics = new TaskMetrics();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const reconciler = new TaskReconciler({
    tasks: { async listTasksByState() { await blocked; return []; } },
    async reconcile() {},
    metrics,
  });

  const first = reconciler.sweep();
  assert.equal(await reconciler.sweep(), 0, 'the overlapping sweep must return immediately');
  release();
  await first;

  const skipped = metrics.snapshot().find((s) => s.name === 'rhinoq_reconciler_sweep_skipped_total');
  assert.equal(skipped.value, 1);
});

test('the schedule fires sweeps and stop() ends them', async () => {
  const ticks = [];
  let fire;
  const reconciler = new TaskReconciler({
    tasks: { async listTasksByState() { ticks.push('swept'); return []; } },
    async reconcile() {},
    everyMs: 1_000,
    setTimer: (handler) => { fire = handler; return { unref() {} }; },
    clearTimer: () => { fire = undefined; },
  });

  reconciler.start();
  assert.deepEqual(ticks, [], 'start() schedules; it does not sweep immediately');

  fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ticks, ['swept']);

  reconciler.stop();
  assert.equal(fire, undefined);
});

test('an interval shorter than a second is refused', () => {
  const options = { tasks: { async listTasksByState() { return []; } }, async reconcile() {} };
  assert.throws(() => new TaskReconciler({ ...options, everyMs: 500 }), /at least 1000ms/);
  assert.throws(() => new TaskReconciler({ ...options, batchLimit: 0 }), /positive integer/);
  assert.throws(() => new TaskReconciler({ async reconcile() {} }), /listTasksByState/);
  assert.throws(() => new TaskReconciler({ tasks: options.tasks }), /reconcile callback/);
});

test('the sweep counts what it selected, reconciled and failed', async () => {
  const metrics = new TaskMetrics();
  const reconciler = new TaskReconciler({
    tasks: { async listTasksByState() { return [summary('a'), summary('b')]; } },
    async reconcile(task) { if (task.id === 'b') throw new Error('nope'); },
    metrics,
    onError: () => {},
  });

  await reconciler.sweep();

  assert.deepEqual(metrics.snapshot(), [
    { name: 'rhinoq_reconciler_task_failed_total', labels: {}, value: 1 },
    { name: 'rhinoq_reconciler_task_reconciled_total', labels: {}, value: 1 },
    { name: 'rhinoq_reconciler_task_selected_total', labels: {}, value: 2 },
  ]);
});

function summary(id) {
  return {
    schemaVersion: 1, entityVersion: 3, id, type: 'bulk-download', state: 'running',
    cancellation: { status: 'none' }, progress: { completed: 1, total: 5 }, hasResult: false,
    executionCounts: { total: 5, pendingDispatch: 0, dispatched: 0, running: 4, succeeded: 1, failed: 0, stalled: 0, cancelled: 0 },
    createdAt: '2026-08-03T10:00:00Z', updatedAt: '2026-08-03T11:00:00Z',
  };
}
