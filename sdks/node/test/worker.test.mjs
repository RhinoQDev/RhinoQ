import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RhinoQWorker,
} from '../dist/index.js';

function leased(name = 'generate-report') {
  return {
    job: {
      id: 'job_01',
      name,
      state: 'leased',
      class: 'standard',
      priority: 0,
      attempts: 1,
      crashCount: 0,
      correlationId: 'report_01',
      createdAt: '2026-01-01T00:00:00Z',
      notBefore: '2026-01-01T00:00:00Z',
      cancelRequested: false,
    },
    payload: new TextEncoder().encode('{"reportId":"report_01"}'),
    lease: { jobId: 'job_01', owner: 'reports-1', epoch: 1 },
    expiresAt: '2026-01-01T00:01:00Z',
  };
}

function handshake() {
  return {
    result: 'compatible',
    protocolVersion: '1.0',
    capabilities: ['queue-filter'],
    heartbeatIntervalMs: 5,
    maxPayloadBytes: 1_048_576,
  };
}

test('Worker claims only registered queues and completes the handler', async () => {
  const calls = { claimQueues: undefined, completed: 0 };
  let sent = false;
  let worker;
  const gateway = {
    async connect() {
      return handshake();
    },
    async claim(_name, _limit, _lease, queues) {
      calls.claimQueues = queues;
      if (sent) return [];
      sent = true;
      return [leased()];
    },
    async heartbeat() {
      return { expiresAt: '2026-01-01T00:01:00Z', cancelRequested: false };
    },
    async complete() {
      calls.completed += 1;
    },
    async release() {},
    async fail() {
      assert.fail('successful work must not fail');
    },
    async effect() {
      throw new Error('not used');
    },
  };
  worker = new RhinoQWorker({
    client: gateway,
    name: 'reports-1',
    concurrency: 1,
    pollIntervalMs: 1,
    maxPollIntervalMs: 2,
    leaseForMs: 100,
  });
  worker.handle('generate-report', async (job) => {
    assert.equal(job.data.reportId, 'report_01');
    worker.stop();
  });

  await worker.run();

  assert.deepEqual(calls.claimQueues, ['generate-report']);
  assert.equal(calls.completed, 1);
});

test('Worker turns cooperative Gateway cancellation into a cancelled failure', async () => {
  let worker;
  let sent = false;
  let failed;
  const gateway = {
    async connect() {
      return handshake();
    },
    async claim() {
      if (sent) return [];
      sent = true;
      return [leased()];
    },
    async heartbeat() {
      return { expiresAt: '2026-01-01T00:01:00Z', cancelRequested: true };
    },
    async complete() {
      assert.fail('cancelled work must not complete');
    },
    async release() {},
    async fail(_lease, _queue, _error, options) {
      failed = options;
      worker.stop();
    },
    async effect() {
      throw new Error('not used');
    },
  };
  worker = new RhinoQWorker({
    client: gateway,
    name: 'reports-1',
    concurrency: 1,
    heartbeatIntervalMs: 1,
    leaseForMs: 100,
    pollIntervalMs: 1,
    maxPollIntervalMs: 2,
  });
  worker.handle('generate-report', async (job) => {
    await new Promise((resolve) => {
      job.signal.addEventListener('abort', resolve, { once: true });
    });
  });

  await worker.run();

  assert.equal(failed.retryClass, 'cancelled');
});

test('Worker releases an unexpected queue instead of executing it', async () => {
  let worker;
  let released = 0;
  let handled = 0;
  const gateway = {
    async connect() {
      return handshake();
    },
    async claim() {
      return [leased('unknown-job')];
    },
    async heartbeat() {
      return { expiresAt: '2026-01-01T00:01:00Z', cancelRequested: false };
    },
    async complete() {},
    async release() {
      released += 1;
      worker.stop();
    },
    async fail() {},
    async effect() {
      throw new Error('not used');
    },
  };
  worker = new RhinoQWorker({
    client: gateway,
    name: 'reports-1',
    concurrency: 1,
    pollIntervalMs: 1,
    maxPollIntervalMs: 2,
    leaseForMs: 100,
  });
  worker.handle('generate-report', async () => {
    handled += 1;
  });

  await worker.run();

  assert.equal(released, 1);
  assert.equal(handled, 0);
});

test('Worker does not connect when its run signal is already aborted', async () => {
  let connected = 0;
  const gateway = {
    async connect() {
      connected += 1;
      return handshake();
    },
    async claim() {
      assert.fail('an aborted worker must not claim');
    },
    async heartbeat() {},
    async complete() {},
    async release() {},
    async fail() {},
    async effect() {},
  };
  const worker = new RhinoQWorker({
    client: gateway,
    name: 'reports-1',
  });
  worker.handle('generate-report', async () => {});
  const controller = new AbortController();
  controller.abort();

  await worker.run({ signal: controller.signal });

  assert.equal(connected, 0);
});

test('Worker refuses a claim batch above the protocol hard cap', () => {
  assert.throws(
    () => new RhinoQWorker({
      client: {},
      name: 'reports-1',
      maxClaimBatch: 1001,
    }),
    /must not exceed 1000/,
  );
});
