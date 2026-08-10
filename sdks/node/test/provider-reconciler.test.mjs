import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProviderOperationReconciler,
  effectCapabilityReport,
} from '../dist/index.js';

const operation = {
  id: 'op-1', taskId: 'task-1', provider: 'stripe', operation: 'refund',
  idempotencyKey: 'refund:1', confirmation: 'readback', retryPolicy: 'when-not-happened',
  state: 'uncertain', version: 2, createdAt: '2026-08-09T00:00:00Z', updatedAt: '2026-08-09T00:00:01Z',
};

test('provider reconciler only invokes registered read-back verification', async () => {
  const calls = [];
  const reconciler = new ProviderOperationReconciler({
    minimumAgeMs: 0,
    client: {
      async listProviderOperationsNeedingAttention(query) { calls.push(['list', query]); return [operation]; },
      async recheckProviderOperation(item, verify) {
        calls.push(['recheck', item.id]);
        const decision = await verify(item);
        return { ...item, state: decision.decision, version: item.version + 1 };
      },
    },
    verifiers: { 'stripe.refund': async () => ({ decision: 'confirmed', evidence: 'refund_1:succeeded' }) },
  });
  assert.deepEqual(await reconciler.sweep(new Date('2026-08-09T12:00:00Z')),
    { selected: 1, resolved: 1, skipped: 0, failed: 0 });
  assert.equal(calls.some(([kind]) => kind === 'execute'), false);
});

test('provider reconciler skips effects without a verifier instead of guessing', async () => {
  const reconciler = new ProviderOperationReconciler({
    client: {
      async listProviderOperationsNeedingAttention() { return [operation]; },
      async recheckProviderOperation() { throw new Error('must not run'); },
    },
    verifiers: {},
  });
  assert.deepEqual(await reconciler.sweep(), { selected: 1, resolved: 0, skipped: 1, failed: 0 });
});

test('capability report refuses an effectively exactly-once claim with missing evidence', () => {
  assert.equal(effectCapabilityReport({ stableIdentity: true, confirmation: 'readback', retryPolicy: 'when-not-happened', verifierRegistered: true, providerSupportsIdempotency: true }).level, 'effectively-exactly-once');
  const weak = effectCapabilityReport({ stableIdentity: true, confirmation: 'readback', retryPolicy: 'when-not-happened', verifierRegistered: false, providerSupportsIdempotency: true });
  assert.equal(weak.level, 'idempotent-delivery');
  assert.match(weak.blockers[0], /verifier/);
});
