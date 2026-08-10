import assert from 'node:assert/strict';
import test from 'node:test';
import { recordTaskVerificationChain } from '../dist/index.js';

test('mismatch chains Task verification to Finding, durable notification hook and deep link', async () => {
  const order = [];
  const stored = [];
  const result = await recordTaskVerificationChain({
    tasks: { async recordTaskVerification(taskId, verification) {
      order.push('verification'); stored.push(verification);
      return { schemaVersion: 1, taskId, verifiedAt: '2026-08-10T08:00:00.000Z', createdAt: '2026-08-10T08:00:00.000Z', ...verification };
    } },
    taskId: 'task-1',
    verification: { id: 'verify-1', verifier: 'invoice-exists', status: 'mismatch', summary: 'missing invoice' },
    findingBaseURL: 'https://ops.example.test/workbench',
    async observeFinding(observation) {
      order.push('finding');
      assert.match(observation.evidence, /verify-1/);
      return { ...observation, status: 'open', firstSeen: observation.observedAt, lastSeen: observation.observedAt, occurrenceCount: 1, updatedAt: observation.observedAt };
    },
    async queueNotification({ notificationId, deepLink }) {
      order.push('notification');
      assert.equal(notificationId, 'task-verification:verify-1');
      assert.match(deepLink, /subjectId=task-1/);
    },
  });
  assert.deepEqual(order, ['verification', 'finding', 'notification']);
  assert.equal(result.finding.subjectType, 'task');
  assert.match(stored[0].finding.deepLink, /ruleId=task.invoice-exists/);
});

test('mismatch fails closed when no Finding writer is configured', async () => {
  await assert.rejects(() => recordTaskVerificationChain({
    tasks: { async recordTaskVerification() { throw new Error('must not write'); } },
    taskId: 'task-1',
    verification: { id: 'verify-1', verifier: 'check', status: 'mismatch' },
  }), /requires observeFinding/);
});
