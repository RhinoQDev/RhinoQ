import assert from 'node:assert/strict';
import test from 'node:test';
import { adoptionChecklist, deterministicRuntimeId, validateRuntimeIdentity } from '../dist/index.js';

test('deterministic runtime IDs are stable and namespaced', () => {
  assert.equal(deterministicRuntimeId('task', 'order:42'), deterministicRuntimeId('task', 'order:42'));
  assert.notEqual(deterministicRuntimeId('task', 'order:42'), deterministicRuntimeId('execution', 'order:42'));
  assert.throws(() => deterministicRuntimeId('task', ' '), /applicationKey/);
});

test('runtime identity validation fails early with an actionable field', () => {
  assert.throws(() => validateRuntimeIdentity({ runtime: 'bullmq', scope: '', applicationKey: 'job:1' }), (error) => error.field === 'scope' && /startup/.test(error.boundary));
  assert.throws(() => validateRuntimeIdentity({ runtime: 'sqs', scope: 'orders', applicationKey: '1' }, { requireReplica: true }), /replicaId/);
});

test('adoption checklist reports every missing product guarantee', () => {
  const report = adoptionChecklist({ owner: true, tenant: true, durableStore: false });
  assert.equal(report.requirements.length, 6);
  assert.equal(report.durable, false);
  assert.ok(report.warnings.some((warning) => warning.startsWith('verifier:')));
  assert.ok(report.warnings.some((warning) => warning.startsWith('durableStore:')));
});
