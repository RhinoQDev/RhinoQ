import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkRuntimeAdapterContract,
  createBullMQRuntimeAdapter,
} from '../dist/index.js';

test('BullMQ adapter translates queue events into portable runtime facts', async () => {
  const events = new Events();
  const observed = [];
  const adapter = createBullMQRuntimeAdapter({
    scope: 'reports', events,
    progress: (event) => event.data,
    terminalFailure: async (event) => event.failedReason === 'exhausted',
    resultReference: (event) => event.returnvalue?.reference,
  });
  const subscription = await adapter.subscribe({ async observe(event) { observed.push(event); } });

  events.emit('waiting', { jobId: 'job-1' });
  events.emit('active', { jobId: 'job-1', attempt: 1 });
  events.emit('progress', { jobId: 'job-1', data: { completed: 2, total: 4 } });
  events.emit('failed', { jobId: 'job-1', failedReason: 'retrying' });
  events.emit('failed', { jobId: 'job-2', failedReason: 'exhausted' });
  events.emit('completed', { jobId: 'job-1', returnvalue: { reference: 'report://1' } });
  await flush();

  assert.deepEqual(observed.map((event) => event.type), [
    'accepted', 'started', 'progressed', 'failed', 'failed', 'succeeded',
  ]);
  assert.deepEqual(observed[0].ref, { runtime: 'bullmq', scope: 'reports', externalId: 'job-1' });
  assert.equal(observed[3].terminal, false);
  assert.equal(observed[4].terminal, true);
  assert.equal(observed[5].resultRef, 'report://1');

  await subscription.dispose();
  events.emit('active', { jobId: 'job-after-close' });
  await flush();
  assert.equal(observed.length, 6);
});

test('BullMQ adapter dispatch reserves an explicit safe job identity', async () => {
  const added = [];
  const adapter = createBullMQRuntimeAdapter({
    scope: 'reports', events: new Events(),
    queue: { async add(name, payload, options) { added.push({ name, payload, options }); return { id: options.jobId }; } },
    jobName: 'report.export', jobId: (command) => `rhinoq-${command.idempotencyKey}`,
    jobOptions: () => ({ attempts: 3 }),
  });
  const receipt = await adapter.dispatch({
    taskId: 'task-1', payload: { reportId: 1 }, idempotencyKey: 'report-1',
    retry: { maxAttempts: 4, backoff: { type: 'exponential', delayMs: 1000 } },
    delayMs: 5000, priority: 2,
  });
  assert.deepEqual(receipt.ref, { runtime: 'bullmq', scope: 'reports', externalId: 'rhinoq-report-1' });
  assert.deepEqual(added, [{
    name: 'report.export', payload: { reportId: 1 },
    options: { attempts: 4, backoff: { type: 'exponential', delayMs: 1000 }, delay: 5000, priority: 2, jobId: 'rhinoq-report-1' },
  }]);
});

test('BullMQ adapter refuses colon job IDs before Queue.add', async () => {
  let adds = 0;
  const adapter = createBullMQRuntimeAdapter({
    scope: 'reports', events: new Events(),
    queue: { async add() { adds += 1; } },
    jobName: 'report.export', jobId: () => 'task:job',
  });
  await assert.rejects(
    adapter.dispatch({ taskId: 'task-1', payload: {}, idempotencyKey: 'report-1' }),
    /must not contain/,
  );
  assert.equal(adds, 0);
});

test('BullMQ inspection reports missing jobs as unknown and preserves terminal evidence', async () => {
  let current;
  let resultReads = 0;
  const adapter = createBullMQRuntimeAdapter({
    scope: 'reports', events: new Events(), inspect: async () => current,
    resultReference: (event) => { resultReads += 1; return event.returnvalue?.reference; },
    health: async () => ({ status: 'healthy', checkedAt: '2026-08-12T03:00:00.000Z' }),
  });
  const ref = { runtime: 'bullmq', scope: 'reports', externalId: 'job-1' };

  assert.equal((await adapter.inspect(ref)).state, 'unknown');
  current = { jobId: 'job-1', state: 'completed', terminal: true, returnvalue: { reference: 'report://1' } };
  const observation = await adapter.inspect(ref);
  assert.equal(observation.state, 'succeeded');
  assert.equal(observation.resultRef, 'report://1');
  assert.equal(resultReads, 1);

  const contract = await checkRuntimeAdapterContract(adapter, ref);
  assert.equal(contract.health.status, 'healthy');
  assert.equal(contract.observation.state, 'succeeded');
});

test('BullMQ translation failures degrade health and reach the error callback', async () => {
  const events = new Events();
  const errors = [];
  const adapter = createBullMQRuntimeAdapter({
    scope: 'reports', events, onError(error) { errors.push(error); },
  });
  await adapter.subscribe({ async observe() {} });
  events.emit('active', { jobId: '' });
  await flush();
  assert.equal(errors.length, 1);
  const health = await adapter.health();
  assert.equal(health.status, 'degraded');
  assert.match(health.reason, /requires jobId/);
});

class Events {
  listeners = new Map();
  on(name, listener) { this.listeners.set(name, listener); }
  off(name, listener) { if (this.listeners.get(name) === listener) this.listeners.delete(name); }
  emit(name, event) { this.listeners.get(name)?.(event); }
}

function flush() { return new Promise((resolve) => setTimeout(resolve, 5)); }
