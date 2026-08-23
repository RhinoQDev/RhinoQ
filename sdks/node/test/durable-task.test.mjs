import assert from 'node:assert/strict';
import test from 'node:test';
import { DurableEffectUncertainError, createDurableTaskContext } from '../dist/tasks/durable.js';

class StepStore {
  #completed = new Map();
  #attempt = 0;

  async acquireDurableStep(request) {
    const id = `${request.taskId}\0${request.itemKey}\0${request.stepKey}`;
    if (this.#completed.has(id)) {
      return { action: 'reused', state: 'completed', result: this.#completed.get(id) };
    }
    this.#attempt += 1;
    return {
      action: 'acquired', state: 'running',
      lease: { stepId: id, attemptId: `${id}:${this.#attempt}`, owner: request.owner, epoch: this.#attempt, expiresAt: new Date(Date.now() + 60_000).toISOString(), attempt: this.#attempt },
    };
  }

  async completeDurableStep(lease, result, resultRef) {
    this.#completed.set(lease.stepId, result);
    return { id: lease.stepId, taskId: 'task-1', itemKey: 'default', key: 'script', taskVersion: 1, stepVersion: 1, state: 'completed', result, resultRef, attempt: lease.attempt, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  }

  async failDurableStep(lease, error) {
    return { id: lease.stepId, taskId: 'task-1', itemKey: 'default', key: 'script', taskVersion: 1, stepVersion: 1, state: 'failed', error: String(error), attempt: lease.attempt, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  }

  async listDurableSteps() { return []; }
}

test('completed compatible steps are reused after a fresh runtime context', async () => {
  const steps = new StepStore();
  let calls = 0;
  const first = createDurableTaskContext({ taskId: 'task-1', executionId: 'run-1', taskVersion: 1, steps, workerId: 'worker-a' });
  assert.deepEqual(await first.step('script', async () => ({ text: `script-${++calls}` })), { text: 'script-1' });

  const resumed = createDurableTaskContext({ taskId: 'task-1', executionId: 'run-2', taskVersion: 1, steps, workerId: 'worker-b' });
  assert.deepEqual(await resumed.step('script', async () => ({ text: `script-${++calls}` })), { text: 'script-1' });
  assert.equal(calls, 1);
});

test('duplicate step key fails closed inside one handler pass', async () => {
  const context = createDurableTaskContext({ taskId: 'task-1', executionId: 'run-1', taskVersion: 1, steps: new StepStore() });
  await context.step('render', () => 'first');
  await assert.rejects(context.step('render', () => 'second'), /declared twice/);
});

test('an uncertain effect blocks the Task instead of treating a lost response as success', async () => {
  const effects = {
    async effect() {
      return { id: 'effect-1', provider: 'payments', operation: 'charge', idempotencyKey: 'idem', confirmation: 'readback', retryPolicy: 'when-not-happened', state: 'uncertain', version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    },
  };
  const context = createDurableTaskContext({ taskId: 'task-1', executionId: 'run-1', taskVersion: 1, effects });
  await assert.rejects(
    context.effect('charge', { provider: 'payments', operation: 'charge', key: 'order-1', execute: async () => ({ ok: true }) }),
    DurableEffectUncertainError,
  );
});
