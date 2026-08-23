import assert from 'node:assert/strict';
import test from 'node:test';

import { DurableStepLeaseLostError, createDurableTaskContext } from '../dist/tasks/durable.js';

function createStore({ failRenew = false } = {}) {
  const completed = new Map();
  let attempt = 0;
  let renewals = 0;
  let completions = 0;
  return {
    get renewals() { return renewals; },
    get completions() { return completions; },
    async acquireDurableStep(request) {
      const id = `${request.taskId}\0${request.itemKey}\0${request.stepKey}`;
      if (completed.has(id)) return { action: 'reused', state: 'completed', result: completed.get(id) };
      attempt += 1;
      return { action: 'acquired', state: 'running', lease: {
        stepId: id, attemptId: `${id}:${attempt}`, owner: request.owner, epoch: attempt,
        expiresAt: new Date(Date.now() + request.leaseMs).toISOString(), attempt,
      } };
    },
    async renewDurableStep(lease) {
      renewals += 1;
      if (failRenew) throw new Error('fence lost');
      return { ...lease, expiresAt: new Date(Date.now() + 1_000).toISOString() };
    },
    async completeDurableStep(lease, value) {
      completions += 1;
      completed.set(lease.stepId, value);
      return { state: 'completed' };
    },
    async failDurableStep() { return { state: 'failed' }; },
    async listDurableSteps() { return []; },
  };
}

test('a long-running Step renews its fenced lease before persisting the result', async () => {
  const steps = createStore();
  const context = createDurableTaskContext({ taskId: 'task-1', executionId: 'run-1', taskVersion: 1, steps, stepLeaseMs: 1_000 });
  assert.equal(await context.step('render', async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return 'rendered';
  }), 'rendered');
  assert.ok(steps.renewals >= 1);
  assert.equal(steps.completions, 1);
});

test('a Step never commits a completed value after its lease renewal fails', async () => {
  const steps = createStore({ failRenew: true });
  const context = createDurableTaskContext({ taskId: 'task-1', executionId: 'run-1', taskVersion: 1, steps, stepLeaseMs: 1_000 });
  await assert.rejects(context.step('render', async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return 'must not persist';
  }), DurableStepLeaseLostError);
  assert.equal(steps.completions, 0);
});

test('parallel Steps retain a successful durable result when a sibling fails', async () => {
  const steps = createStore();
  const first = createDurableTaskContext({ taskId: 'task-1', executionId: 'run-1', taskVersion: 1, steps });
  await assert.rejects(Promise.all([
    first.step('script', async () => ({ text: 'done' })),
    first.step('audio', async () => { throw new Error('encoder unavailable'); }),
  ]), /encoder unavailable/);

  const resumed = createDurableTaskContext({ taskId: 'task-1', executionId: 'run-2', taskVersion: 1, steps });
  let scriptRuns = 0;
  assert.deepEqual(await resumed.step('script', () => ({ text: `unexpected-${++scriptRuns}` })), { text: 'done' });
  assert.equal(scriptRuns, 0);
  assert.equal(await resumed.step('audio', () => 'recovered'), 'recovered');
});

test('parallel Steps keep their own effect command identity', async () => {
  const steps = createStore();
  const commandIds = [];
  const effects = {
    async effect(options) {
      commandIds.push(options.commandId);
      return { state: 'confirmed' };
    },
  };
  const context = createDurableTaskContext({
    taskId: 'task-1', executionId: 'run-1', taskVersion: 1, steps, effects,
  });

  await Promise.all([
    context.step('script', () => context.effect('publish-script', {
      key: 'script-42',
      execute: async () => ({ accepted: true }),
    })),
    context.step('audio', () => context.effect('publish-audio', {
      key: 'audio-42',
      execute: async () => ({ accepted: true }),
    })),
  ]);

  assert.equal(commandIds.length, 2);
  assert.notEqual(commandIds[0], commandIds[1]);
});
