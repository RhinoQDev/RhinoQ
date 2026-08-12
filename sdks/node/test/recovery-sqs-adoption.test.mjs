import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GuardedRecovery,
  MemoryAdoptionReportStore,
  MemoryRecoveryLedger,
  SQSRuntimeAdapter,
  createBullMQPortableIntegration,
} from '../dist/index.js';

test('guarded recovery is preview-first, idempotent and post-check gated', async () => {
  const calls = [];
  const records = new Map();
  const port = {
    async proposeRepair(request) {
      calls.push(['propose', request.id]);
      if (records.has(request.id)) throw Object.assign(new Error('duplicate repair'), { code: '23505' });
      const record = { id: request.id, finding: request.finding, handler: request.handler, parameters: request.parameters, state: 'proposed', proposedBy: request.actor, version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      records.set(request.id, record);
      return record;
    },
    async previewRepair(id) {
      calls.push(['preview', id]);
      const record = { ...records.get(id), state: 'previewed', preview: 'rebuild artifact', precondition: 'artifact is missing', version: 2 };
      records.set(id, record);
      return record;
    },
    async approveRepair(id, actor, reason) {
      calls.push(['approve', id, actor, reason]);
      return { ...records.get(id), state: 'approved', approvedBy: actor, approvalReason: reason, version: 3 };
    },
    async executeRepair(id) {
      calls.push(['execute', id]);
      const record = { ...records.get(id), state: 'succeeded', version: 4 };
      records.set(id, record);
      return record;
    },
  };
  let checks = 0;
  const recovery = new GuardedRecovery(port, {
    ledger: new MemoryRecoveryLedger(),
    async postCheck(record) { checks += 1; return { status: 'verified', evidence: `checked ${record.id}` }; },
  });
  const request = {
    finding: { ruleId: 'output', subjectType: 'task', subjectId: 'task-1', invariantVersion: 1 },
    handler: 'rebuild-artifact', parameters: { key: 'report-1' }, idempotencyKey: 'repair-task-1', requestedBy: 'operator-a',
  };
  const preview = await recovery.execute(request);
  assert.equal(preview.stage, 'previewed');
  assert.deepEqual(calls.map((item) => item[0]), ['propose', 'preview']);
  await assert.rejects(recovery.execute({ ...request, confirm: true }), /approvedBy/);
  const result = await recovery.execute({ ...request, confirm: true, approvedBy: 'operator-b', approvalReason: 'approved after preview' });
  assert.equal(result.stage, 'verified');
  assert.equal(checks, 1);
  const replay = await recovery.execute({ ...request, confirm: true, approvedBy: 'operator-b', approvalReason: 'approved after preview' });
  assert.equal(replay.replayed, true);
  assert.equal(checks, 1);
  assert.equal(calls.filter((item) => item[0] === 'execute').length, 1);
  await assert.rejects(
    recovery.execute({ ...request, parameters: { key: 'different' } }),
    /reused with different repair parameters/,
  );
});

test('guarded recovery consumes a lost execute response as uncertain', async () => {
  let executes = 0;
  const port = {
    async proposeRepair(request) { return { id: request.id, finding: request.finding, handler: request.handler, state: 'proposed', proposedBy: request.actor, version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; },
    async previewRepair(id) { return { id, finding: { ruleId: 'rule', subjectType: 'task', subjectId: 'task-2', invariantVersion: 1 }, handler: 'repair', parameters: {}, state: 'previewed', proposedBy: 'a', preview: 'change', precondition: 'fresh', version: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; },
    async approveRepair(id) { return { id }; },
    async executeRepair() { executes += 1; throw new Error('response lost after apply'); },
  };
  const recovery = new GuardedRecovery(port, { async postCheck() { return { status: 'verified', evidence: 'not reached' }; } });
  const request = { finding: { ruleId: 'rule', subjectType: 'task', subjectId: 'task-2', invariantVersion: 1 }, handler: 'repair', idempotencyKey: 'repair-lost-response', requestedBy: 'a', approvedBy: 'b', approvalReason: 'reviewed', confirm: true };
  const first = await recovery.execute(request);
  assert.equal(first.stage, 'uncertain');
  const replay = await recovery.execute(request);
  assert.equal(replay.replayed, true);
  assert.equal(executes, 1);
});

test('SQS proof maps redelivery to attempts and fails closed on cancel', async () => {
  const adapter = new SQSRuntimeAdapter({ scope: 'https://sqs.local/reports' });
  const event = adapter.observeReceipt({
    message: { messageId: 'msg-1', attributes: { ApproximateReceiveCount: '3' } }, state: 'failed', terminal: false, reason: 'visibility timeout',
  });
  assert.equal(event.type, 'failed');
  assert.equal(event.attempt, 3);
  assert.equal(event.terminal, false);
  const cancel = await adapter.cancel(event.ref);
  assert.equal(cancel.status, 'unsupported');
  assert.equal(adapter.capabilities.events, 'poll');
  assert.equal(adapter.capabilities.stableAttempts, false);
});

test('SQS inspection preserves progress while keeping the runtime state explicit', async () => {
  const adapter = new SQSRuntimeAdapter({
    scope: 'reports',
    inspect: async () => ({ message: { messageId: 'msg-progress', attributes: { ApproximateReceiveCount: '2' } }, state: 'running', progress: { completed: 2, total: 4 } }),
  });
  const observation = await adapter.inspect(adapter.ref('msg-progress'));
  assert.equal(observation.state, 'running');
  assert.deepEqual(observation.progress, { completed: 2, total: 4 });
  assert.equal(observation.attempt, 2);
});

test('adoption report store deduplicates facts across replicas', async () => {
  const store = new MemoryAdoptionReportStore();
  const base = { eventId: 'e-1', kind: 'observed', runtime: 'sqs', scope: 'reports', externalId: 'msg-1', occurredAt: '2026-08-12T03:00:00.000Z', attempt: 2, uncertain: true, replicaId: 'replica-a' };
  await store.append(base);
  await store.append(base);
  await store.append({ ...base, eventId: 'e-2', replicaId: 'replica-b', kind: 'binding_created', taskId: 'task-1' });
  const report = await store.snapshot();
  assert.equal(report.observedEvents, 1);
  assert.equal(report.runtimeReferences, 1);
  assert.equal(report.retryAttemptsObserved, 1);
  assert.equal(report.uncertainOutcomes, 1);
  assert.equal(report.bindingsCreated, 1);
  assert.equal(report.replicas, 2);
});

test('portable BullMQ composition exposes the runtime adapter and projector', async () => {
  const integration = await createBullMQPortableIntegration({
    pool: { async query() { return { rows: [] }; } },
    tasks: {}, events: new Events(), scope: 'reports', mode: 'single',
    queue: { async add(name, payload, options) { return { id: options.jobId }; } },
    jobName: 'report.export', jobId: ({ idempotencyKey }) => `rq-${idempotencyKey}`,
  });
  assert.equal(integration.adapter.name, 'bullmq');
  assert.equal(integration.adapter.scope, 'reports');
  assert.equal(integration.runtime.projector !== undefined, true);
  await integration.close();
});

class Events {
  on() {}
  off() {}
}
