import assert from 'node:assert/strict';
import test from 'node:test';

import { DurableEffectNotConfirmedError, createDurableTaskContext } from '../dist/index.js';

test('a known non-applied Effect also blocks Task progress', async () => {
  const context = createDurableTaskContext({
    taskId: 'task-1', executionId: 'execution-1', taskVersion: 1,
    effects: {
      async effect() {
        return {
          id: 'effect-1', provider: 'payments', operation: 'charge', idempotencyKey: 'charge-1',
          confirmation: 'readback', retryPolicy: 'when-not-happened', state: 'not_happened', version: 2,
          createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:02.000Z',
        };
      },
    },
  });

  await assert.rejects(
    context.effect('charge', { key: 'order-1', execute: async () => ({ ok: true }) }),
    DurableEffectNotConfirmedError,
  );
});
