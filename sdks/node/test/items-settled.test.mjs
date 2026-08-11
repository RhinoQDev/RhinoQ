import assert from 'node:assert/strict';
import test from 'node:test';

import { BullMQTaskBridge, TaskMetrics } from '../dist/index.js';

// A fan-out with aggregate.progress writes progress on every completion: fifty
// items, fifty round trips, and an application that wants the single moment
// the batch became complete had to derive it by counting. Everyone wrote that
// counter, and everyone wrote it as "did I just see the last one?" — which is
// wrong the moment two workers finish concurrently or an event is redelivered.

test('the settled signal fires once, on the call that closed the last item', async () => {
  const h = newHarness({ items: 3 });
  try {
    await h.finish('bull-job-1');
    await h.finish('bull-job-2');
    assert.deepEqual(h.settled, [], 'nothing fires while an item is still open');

    await h.finish('bull-job-3');
    assert.deepEqual(h.settled.map((task) => task.id), ['task-1']);

    // A redelivered completion must not fire it again.
    await h.finish('bull-job-3');
    assert.equal(h.settled.length, 1);
  } finally {
    h.bridge.close();
  }
});

// Exactly-once is decided by one SQL statement, not by this process, so a
// second bridge seeing the same last item gets false.
test('a second bridge on the same Task does not fire the signal again', async () => {
  const h = newHarness({ items: 1 });
  const second = h.addBridge();
  try {
    await Promise.all([h.finish('bull-job-1'), second.project('completed', { jobId: 'bull-job-1' })]);

    assert.equal(h.settleCalls >= 2, true, 'both bridges asked');
    assert.equal(h.settled.length, 1, 'only one of them was told it was the last');
  } finally {
    h.bridge.close();
    second.close();
  }
});

test('the signal carries the finished Task, not just its id', async () => {
  const h = newHarness({ items: 1 });
  try {
    await h.finish('bull-job-1');

    const [task] = h.settled;
    assert.equal(task.id, 'task-1');
    assert.equal(Array.isArray(task.executions), true);
    assert.equal(task.executions.length, 1);
  } finally {
    h.bridge.close();
  }
});

test('terminal-item progress is synchronized after settlement and before the callback', async () => {
  const h = newHarness({ items: 2, aggregateProgress: true });
  try {
    await h.finish('bull-job-1');
    // Simulate a stale aggregate write that began before the last Execution
    // committed. Settlement must force one fresh sync before the callback can
    // make the Task terminal and close the progress-writing window.
    h.task.progress = { completed: 1, total: 2 };
    await h.finish('bull-job-2');

    assert.deepEqual(h.task.progress, { completed: 2, total: 2 });
    assert.deepEqual(h.settled[0].progress, { completed: 2, total: 2 });
    assert.equal(h.syncCalls >= 3, true, 'each completion syncs and settlement performs a final sync');
  } finally {
    h.bridge.close();
  }
});

// The Gateway client cannot settle items. Configuring the callback there would
// otherwise mean it silently never fires.
test('a client that cannot settle items warns once instead of never firing', async () => {
  const h = newHarness({ items: 1, supportsSettle: false });
  try {
    await h.finish('bull-job-1');
    await h.finish('bull-job-1');

    assert.equal(h.settled.length, 0);
    // Count this warning, not every warning: the constructor also reports a
    // settled signal configured without isTerminalFailure, which is a
    // different trap and has its own test.
    const unsupported = h.warnings.filter((warning) => /cannot settle items/.test(warning));
    assert.equal(unsupported.length, 1, 'the warning fires once, not once per event');
    assert.match(unsupported[0], /never fire/);
  } finally {
    h.bridge.close();
  }
});

test('settlement is counted so a batch that never completes is visible by absence', async () => {
  const metrics = new TaskMetrics();
  const h = newHarness({ items: 1, metrics });
  try {
    await h.finish('bull-job-1');

    const settled = metrics.snapshot().find((s) => s.name === 'rhinoq_task_items_settled_total');
    assert.deepEqual(settled, { name: 'rhinoq_task_items_settled_total', labels: { scope: 'reports' }, value: 1 });
  } finally {
    h.bridge.close();
  }
});

test('without onItemsSettled the bridge never asks the store', async () => {
  const h = newHarness({ items: 1, withCallback: false });
  try {
    await h.finish('bull-job-1');
    assert.equal(h.settleCalls, 0, 'an unused signal must not cost a round trip per item');
  } finally {
    h.bridge.close();
  }
});

function newHarness({
  items,
  supportsSettle = true,
  withCallback = true,
  aggregateProgress = false,
  metrics,
} = {}) {
  const settled = [];
  const warnings = [];
  const state = { settleCalls: 0, syncCalls: 0, settledAt: undefined };
  const executions = Array.from({ length: items }, (_value, index) => ({
    id: `exec-${index + 1}`, taskId: 'task-1', itemKey: `item-${index + 1}`, attempt: 1,
    runtime: 'bullmq', runtimeScope: 'reports', externalId: `bull-job-${index + 1}`,
    state: 'running', version: 2,
  }));
  const task = {
    schemaVersion: 1, entityVersion: 5, id: 'task-1', type: 'bulk-download',
    state: 'running', cancellation: { status: 'none' }, progress: { completed: 0 },
    hasResult: false, executions, createdAt: '2026-08-03T18:00:00Z', updatedAt: '2026-08-03T18:00:00Z',
  };

  const client = {
    async lookupTaskExecution(runtime, externalId) {
      const found = executions.find((execution) => execution.externalId === externalId);
      if (!found) throw new Error(`no execution for ${externalId}`);
      return found;
    },
    async getTaskExecution(id) { return executions.find((execution) => execution.id === id); },
    async getTask() { return task; },
    async transitionTaskExecution(id, expectedVersion, next) {
      const execution = executions.find((item) => item.id === id);
      assert.equal(expectedVersion, execution.version, 'stale execution version');
      execution.state = next;
      execution.version += 1;
      return task;
    },
    async transitionTask(id, expectedVersion, next) {
      assert.equal(expectedVersion, task.entityVersion);
      task.state = next;
      task.entityVersion += 1;
      return task;
    },
  };
  if (supportsSettle) {
    // Mirrors the SQL: one UPDATE filtered on items_settled_at IS NULL, so
    // exactly one caller is told it closed the batch.
    client.settleTaskItems = async () => {
      state.settleCalls += 1;
      const open = executions.filter((execution) =>
        !['succeeded', 'failed', 'cancelled'].includes(execution.state));
      if (open.length > 0 || state.settledAt !== undefined) return false;
      state.settledAt = '2026-08-03T18:00:01Z';
      return true;
    };
  }
  if (aggregateProgress) {
    client.syncTaskItemProgress = async () => {
      state.syncCalls += 1;
      const completed = executions.filter((execution) =>
        ['succeeded', 'failed', 'cancelled'].includes(execution.state)).length;
      task.progress = { completed, total: executions.length };
      task.entityVersion += 1;
      return task.entityVersion;
    };
  }

  const listeners = new Map();
  const make = () => new BullMQTaskBridge({
    client,
    events: {
      on(name, listener) { listeners.set(name, (listeners.get(name) ?? []).concat(listener)); },
      off(name) { listeners.delete(name); },
    },
    runtimeScope: 'reports',
    terminalProjection: 'execution-only',
    ...(aggregateProgress ? { aggregate: { progress: 'terminal-items', terminal: 'manual' } } : {}),
    onWarning: (warning) => warnings.push(warning),
    ...(withCallback ? { onItemsSettled: (finished) => { settled.push(finished); } } : {}),
    ...(metrics ? { metrics } : {}),
    allowConcurrentBridges: true,
  });
  const bridge = make();

  return {
    bridge, task, executions, settled, warnings,
    get settleCalls() { return state.settleCalls; },
    get syncCalls() { return state.syncCalls; },
    addBridge: make,
    finish(jobId) { return bridge.project('completed', { jobId }); },
  };
}

// Without isTerminalFailure every failure is "may still retry", so the settled
// check does not run after one. A batch whose last item fails then never
// settles: every item terminal, every counter right, and a callback that stays
// silent. Measured against real PostgreSQL and BullMQ before this warning
// existed — 46 succeeded, 4 failed, items_settled_at still null.
test('a settled signal that cannot fire after a failure is called out', () => {
  const warnings = [];
  const bridge = new BullMQTaskBridge({
    client: {},
    events: { on() {}, off() {} },
    runtimeScope: `settle-${Math.random().toString(36).slice(2)}`,
    terminalProjection: 'execution-only',
    onItemsSettled: () => {},
    onWarning: (warning) => warnings.push(warning),
  });
  try {
    assert.match(warnings.join('\n'), /isTerminalFailure/);
    assert.match(warnings.join('\n'), /never settle/);
  } finally {
    bridge.close();
  }
});

test('supplying isTerminalFailure silences it', () => {
  const warnings = [];
  const bridge = new BullMQTaskBridge({
    client: {},
    events: { on() {}, off() {} },
    runtimeScope: `settle-${Math.random().toString(36).slice(2)}`,
    terminalProjection: 'execution-only',
    onItemsSettled: () => {},
    isTerminalFailure: () => true,
    onWarning: (warning) => warnings.push(warning),
  });
  try {
    assert.deepEqual(warnings, []);
  } finally {
    bridge.close();
  }
});
