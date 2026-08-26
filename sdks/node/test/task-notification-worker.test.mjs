import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskEmailDelivery, createTaskWebhookDelivery, TaskNotificationWorker } from '../dist/index.js';

const record = (overrides = {}) => ({
  schemaVersion: 1, id: 'notification-1', taskId: 'task-1', verificationId: 'verification-1',
  verification: { schemaVersion: 1, id: 'verification-1', taskId: 'task-1', verifier: 'invoice.exists', status: 'mismatch', verifiedAt: '2026-08-20T00:01:00.000Z', createdAt: '2026-08-20T00:01:00.000Z' },
  finding: { ruleId: 'invoice.exists', subjectType: 'invoice', subjectId: 'INV-1', invariantVersion: 3, status: 'open', firstSeen: '2026-08-20T00:00:00.000Z', lastSeen: '2026-08-20T00:01:00.000Z', occurrenceCount: 1, latestEvidence: 'invoice row missing', updatedAt: '2026-08-20T00:01:00.000Z' },
  deepLink: 'https://app.example/tasks/task-1', state: 'leased', attempts: 1, availableAt: '2026-08-20T00:00:00.000Z', leaseOwner: 'worker-1', leaseUntil: '2026-08-20T00:02:00.000Z', createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:01:00.000Z',
  ...overrides,
});

test('Task notification worker completes a leased email delivery with durable idempotency identity', async () => {
  const sent = []; const calls = [];
  const queue = {
    async claimTaskNotification(owner, leaseMs) { calls.push(['claim', owner, leaseMs]); return record(); },
    async completeTaskNotification(id, owner) { calls.push(['complete', id, owner]); return record({ state: 'sent' }); },
    async failTaskNotification() { throw new Error('unexpected failure'); },
  };
  const delivery = createTaskEmailDelivery({
    recipients: () => ['support@example.com'],
    render: (item) => ({ subject: `Task ${item.taskId} needs review`, text: item.finding.latestEvidence }),
    async send(message) { sent.push(message); },
  });
  const result = await new TaskNotificationWorker({ queue, delivery, owner: 'worker-1' }).runOnce();
  assert.equal(result.status, 'sent');
  assert.equal(sent[0].idempotencyKey, 'notification-1');
  assert.deepEqual(calls, [['claim', 'worker-1', 60_000], ['complete', 'notification-1', 'worker-1']]);
});

test('Task notification worker records retry scheduling after a transport failure', async () => {
  const calls = [];
  const queue = {
    async claimTaskNotification() { return record(); },
    async completeTaskNotification() { throw new Error('unexpected completion'); },
    async failTaskNotification(id, owner, error, retryAfterMs) { calls.push([id, owner, error, retryAfterMs]); return record({ state: 'failed' }); },
  };
  const worker = new TaskNotificationWorker({ queue, delivery: { async deliver() { throw new Error('provider 503'); } }, owner: 'worker-1', retryAfterMs: 45_000 });
  const result = await worker.runOnce();
  assert.equal(result.status, 'failed');
  assert.deepEqual(calls, [['notification-1', 'worker-1', 'provider 503', 45_000]]);
});

test('Task webhook delivery requires application severity policy and signs the existing wire contract', async () => {
  const requests = [];
  const delivery = createTaskWebhookDelivery({
    destination: { name: 'support', kind: 'webhook', url: 'http://127.0.0.1:9000/hook', secret: 'secret', timeoutMs: 1_000, includeEvidence: true, gracePeriodMs: 0, findingBaseUrl: '' },
    severity: () => 'high',
    fetch: async (url, init) => { requests.push({ url, init }); return new Response(null, { status: 204 }); },
  });
  await delivery.deliver(record());
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.type, 'rhinoq.task.verification');
  assert.equal(body.severity, 'high');
  assert.match(requests[0].init.headers['x-rhinoq-signature'], /^v1=[a-f0-9]{64}$/);
  assert.throws(() => createTaskWebhookDelivery({ destination: {} }), /severity policy/);
});
