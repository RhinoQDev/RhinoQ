import assert from 'node:assert/strict';
import test from 'node:test';

import { createRhinoQTaskIntegration } from '../dist/index.js';

function pool() {
  return {
    async query() {
      return { rows: [{ version: 6 }] };
    },
    async connect() {
      return {
        async query() { return { rows: [{ acquired: true }] }; },
        release() {},
      };
    },
  };
}

function events() {
  return { on() {}, off() {} };
}

test('the standard integration owns projector lifecycle and reports health', async () => {
  const integration = await createRhinoQTaskIntegration({
    pool: pool(),
    events: events(),
    tasks: {},
    runtimeScope: 'reports',
    terminalProjection: 'execution-only',
  });

  assert.equal(integration.bridge.ownership, 'unowned');
  const before = await integration.health();
  assert.equal(before.status, 'degraded');
  assert.match(before.detail, /projector lease is not owned/);

  await integration.start();
  assert.equal(integration.bridge.ownership, 'projecting');
  integration.close();
  assert.equal(integration.bridge.ownership, 'closed');
});

test('the standard integration wires a leased reconciliation sweep', async () => {
  let reads = 0;
  const integration = await createRhinoQTaskIntegration({
    pool: pool(),
    events: events(),
    tasks: {
      async listTasksByState() { reads += 1; return []; },
    },
    runtimeScope: 'reports',
    terminalProjection: 'execution-only',
    reconciliation: { observe: async () => undefined },
  });

  assert.ok(integration.reconciler);
  assert.equal(await integration.reconciler.sweep(), 0);
  assert.equal(reads, 1);
  assert.equal(integration.reconciler.lastSuccessfulSweepAtIso !== undefined, true);
  integration.close();
});

test('a standby integration retries projector ownership without subscribing early', async () => {
  let acquireAttempts = 0;
  const standbyPool = {
    async query() { return { rows: [{ version: 6 }] }; },
    async connect() {
      acquireAttempts += 1;
      const acquired = acquireAttempts > 1;
      return {
        async query() { return { rows: [{ acquired }] }; },
        release() {},
      };
    },
  };
  const integration = await createRhinoQTaskIntegration({
    pool: standbyPool,
    events: events(),
    tasks: {},
    runtimeScope: 'reports',
    terminalProjection: 'execution-only',
    projectorRetryMs: 1,
  });

  await integration.start();
  assert.equal(integration.bridge.ownership, 'unowned');
  for (let attempt = 0; attempt < 50 && integration.bridge.ownership !== 'projecting'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(integration.bridge.ownership, 'projecting');
  integration.close();
});

test('the integration refuses an unscoped projector', async () => {
  await assert.rejects(
    createRhinoQTaskIntegration({
      pool: pool(),
      events: events(),
      tasks: {},
      terminalProjection: 'execution-only',
    }),
    /runtimeScope/,
  );
});
