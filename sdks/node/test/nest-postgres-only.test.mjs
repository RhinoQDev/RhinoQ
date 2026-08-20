import assert from 'node:assert/strict';
import test from 'node:test';

import { createPostgresTaskIntegration } from '../dist/index.js';
import { RhinoQModule, RHINOQ_OPTIONS, RHINOQ_INTEGRATION, RHINOQ_TASKS, RHINOQ_HEALTH, RHINOQ_BRIDGE } from '../dist/nest.js';

// The finding this guards: a NestJS application on PostgreSQL alone used to be
// forced to hand the module a BullMQ QueueEvents, because the only integration
// path built a BullMQ bridge and validateOptions required `events`. A developer
// not using BullMQ had to fake a mockQueueEvents object — a leaked abstraction.
//
// The PostgreSQL-only path must need no such thing.

function pool() {
  return {
    async query() { return { rows: [{ version: 6 }] }; },
    async connect() {
      return { async query() { return { rows: [{ acquired: true }] }; }, release() {} };
    },
  };
}

test('the PostgreSQL-only integration needs no QueueEvents', async () => {
  // The whole point: no `events`, no BullMQ, no fake object.
  const integration = await createPostgresTaskIntegration({ pool: pool(), tasks: {} });
  assert.ok(integration.tasks, 'the Task client must be exposed');
  assert.equal(typeof integration.health, 'function');
  assert.equal(typeof integration.start, 'function');
  assert.equal(typeof integration.close, 'function');
  // start()/close() are lifecycle no-ops: there is no projector to own.
  await integration.start();
  integration.close();
});

test('the PostgreSQL-only integration rejects a missing pool, not a missing QueueEvents', async () => {
  await assert.rejects(
    createPostgresTaskIntegration({}),
    (error) => /requires a PostgreSQL pool/.test(error.message),
    'the error must point at the pool, never at QueueEvents',
  );
});

test('health reports database state without any queue concepts', async () => {
  const integration = await createPostgresTaskIntegration({ pool: pool(), tasks: {} });
  const report = await integration.health();
  assert.ok(report.database, 'health must include the database report');
  assert.ok(['ok', 'degraded', 'down'].includes(report.status));
  // A PostgreSQL-only health report has no projector or queueEvents fields.
  assert.equal('projector' in report, false);
  assert.equal('queueEvents' in report, false);
});

test('forPostgresAsync wires tasks and health but no bridge, and never asks for events', () => {
  let factoryArgs;
  const moduleDef = RhinoQModule.forPostgresAsync({
    inject: ['CONFIG'],
    useFactory: (config) => { factoryArgs = config; return { pool: pool() }; },
  });

  assert.equal(moduleDef.module, RhinoQModule);
  const provided = new Set(moduleDef.providers.map((p) => p.provide));
  assert.ok(provided.has(RHINOQ_TASKS), 'must provide the Task client');
  assert.ok(provided.has(RHINOQ_HEALTH), 'must provide health');
  assert.ok(provided.has(RHINOQ_OPTIONS));

  // The bridge is a BullMQ concept; it must not appear on the PostgreSQL path.
  assert.equal(provided.has(RHINOQ_BRIDGE), false, 'the PostgreSQL path must not expose a queue bridge');
  assert.equal(moduleDef.exports.includes(RHINOQ_BRIDGE), false);
  assert.ok(moduleDef.exports.includes(RHINOQ_TASKS));

  // The options factory carries no `events` requirement in its shape.
  const optionsProvider = moduleDef.providers.find((p) => p.provide === RHINOQ_OPTIONS);
  assert.deepEqual(optionsProvider.inject, ['CONFIG']);
});

test('forPostgresAsync refuses a missing factory the same way the other paths do', () => {
  assert.throws(() => RhinoQModule.forPostgresAsync({}), /requires useFactory/);
});
