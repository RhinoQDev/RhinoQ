import assert from 'node:assert/strict';
import test from 'node:test';

import { BullMQTaskBridge } from '../dist/index.js';

// Six processes each subscribing QueueEvents for the same queue was the
// documented-nowhere failure mode: every event is projected once per bridge,
// and the projections contend for the same Task version. RhinoQ deliberately
// does not elect a leader, so the contract is "one bridge per scope" and the
// SDK's job is to say when it can see that rule broken.

test('one bridge on a scope is silent and behaves exactly as before', async () => {
  const warnings = [];
  const harness = newHarness({ warnings });
  try {
    harness.emit('active', { jobId: 'bull-job-1' });
    await harness.settle(3);

    assert.deepEqual(warnings, []);
    assert.equal(harness.task.state, 'running');
    assert.deepEqual(harness.transitions, ['execution:running', 'task:running']);
  } finally {
    harness.closeAll();
  }
});

test('a second bridge on the same runtimeScope fails before subscribing', () => {
  const warnings = [];
  const harness = newHarness({ warnings });
  try {
    assert.throws(
      () => harness.addBridge(),
      /Only one projector.*runtimeScope.*projectorLease/,
    );
    assert.deepEqual(warnings, []);
  } finally {
    harness.closeAll();
  }
});

test('bridges on distinct runtimeScopes are not duplicates', () => {
  const warnings = [];
  const harness = newHarness({ warnings });
  try {
    harness.addBridge({ runtimeScope: 'thumbnails' });
    assert.deepEqual(warnings, []);
  } finally {
    harness.closeAll();
  }
});

test('closing a bridge releases its scope for the replacement', () => {
  const warnings = [];
  const harness = newHarness({ warnings });
  try {
    harness.bridges[0].close();
    harness.addBridge();
    assert.deepEqual(warnings, [], 'a rolling replacement is not a duplicate');

    // close() is idempotent; a double close must not free a slot it no longer
    // holds, so the next real duplicate still fails.
    harness.bridges[0].close();
    assert.throws(() => harness.addBridge(), /Only one projector/);
  } finally {
    harness.closeAll();
  }
});

test('allowConcurrentBridges acknowledges the duplicate without changing behaviour', async () => {
  const warnings = [];
  const harness = newHarness({ warnings });
  try {
    harness.addBridge({ allowConcurrentBridges: true });
    assert.deepEqual(warnings, []);

    // Two lookups — one per bridge — but a single pair of transitions.
    harness.emit('active', { jobId: 'bull-job-1' });
    await harness.settle(4);
    assert.equal(harness.task.state, 'running');
    assert.deepEqual(harness.transitions, ['execution:running', 'task:running']);
  } finally {
    harness.closeAll();
  }
});

// The evidence behind the warning: two bridges on one QueueEvents each project
// the event, but the durable outcome is still one transition — the second
// bridge finds the target state already reached. Duplicate work, not duplicate
// state. That is why this is a warning and not a refusal.
test('two bridges project the same event twice but transition the Task once', async () => {
  const warnings = [];
  const harness = newHarness({ warnings, allowConcurrentBridges: true });
  try {
    harness.addBridge({ allowConcurrentBridges: true });

    await Promise.all([
      harness.bridges[0].project('active', { jobId: 'bull-job-1' }),
      harness.bridges[1].project('active', { jobId: 'bull-job-1' }),
    ]);

    assert.deepEqual(harness.transitions, ['execution:running', 'task:running']);
    assert.equal(harness.lookups, 2, 'both bridges did the work');
  } finally {
    harness.closeAll();
  }
});

function newHarness({ warnings = [], allowConcurrentBridges = false } = {}) {
  const transitions = [];
  const task = {
    entityVersion: 4,
    id: 'task-1',
    type: 'bulk-download',
    state: 'queued',
    progress: { completed: 0 },
    hasResult: false,
    executions: [],
    createdAt: '2026-07-29T10:00:00Z',
    updatedAt: '2026-07-29T10:00:00Z',
  };
  const execution = {
    id: 'exec-1',
    taskId: 'task-1',
    runtime: 'bullmq',
    runtimeScope: 'reports',
    state: 'dispatched',
    version: 2,
  };
  const state = { lookups: 0 };
  const client = {
    async lookupTaskExecution() {
      state.lookups += 1;
      return execution;
    },
    async getTaskExecution() {
      return execution;
    },
    async getTask() {
      return task;
    },
    async transitionTaskExecution(id, expectedVersion, next) {
      assert.equal(expectedVersion, execution.version, 'stale execution version');
      transitions.push(`execution:${next}`);
      execution.state = next;
      execution.version += 1;
      return task;
    },
    async transitionTask(id, expectedVersion, next) {
      assert.equal(expectedVersion, task.entityVersion, 'stale task version');
      transitions.push(`task:${next}`);
      task.state = next;
      task.entityVersion += 1;
      return task;
    },
  };

  const listeners = new Map();
  const events = {
    on(name, listener) {
      const existing = listeners.get(name) ?? [];
      existing.push(listener);
      listeners.set(name, existing);
    },
    off(name, listener) {
      listeners.set(name, (listeners.get(name) ?? []).filter((item) => item !== listener));
    },
  };

  const bridges = [];
  const harness = {
    get transitions() { return transitions; },
    get lookups() { return state.lookups; },
    task,
    execution,
    bridges,
    addBridge(overrides = {}) {
      const bridge = new BullMQTaskBridge({
        client,
        events,
        runtimeScope: 'reports',
        terminalProjection: 'single-execution',
        onWarning: (warning) => warnings.push(warning),
        ...overrides,
      });
      bridges.push(bridge);
      return bridge;
    },
    emit(name, event) {
      for (const listener of listeners.get(name) ?? []) listener(event);
    },
    async settle(expected, timeoutMs = 1000) {
      const deadline = Date.now() + timeoutMs;
      while (state.lookups + transitions.length < expected) {
        if (Date.now() > deadline) {
          throw new Error(`bridge stalled after ${transitions.join(', ')}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
    closeAll() {
      for (const bridge of bridges) bridge.close();
    },
  };
  harness.addBridge(allowConcurrentBridges ? { allowConcurrentBridges: true } : {});
  return harness;
}
