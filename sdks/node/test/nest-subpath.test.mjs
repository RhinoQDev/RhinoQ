import assert from 'node:assert/strict';
import test from 'node:test';
import { RhinoQModule, RHINOQ_TASKS } from '@rhinoq/node/nest';

test('the package exposes Nest lifecycle wiring from one versioned package', () => {
  const dynamic = RhinoQModule.forRootAsync({ useFactory: () => ({}) });
  assert.equal(dynamic.module, RhinoQModule);
  assert.ok(dynamic.exports.includes(RHINOQ_TASKS));
});

test('Nest exposes the same short BullMQ preset', () => {
  const dynamic = RhinoQModule.forBullMQAsync({ useFactory: () => ({}) });
  assert.equal(dynamic.module, RhinoQModule);
  assert.ok(dynamic.exports.includes(RHINOQ_TASKS));
});

test('Nest supports isolated integration tokens for multi-queue modules', () => {
  const token = Symbol('reports-integration');
  const dynamic = RhinoQModule.forBullMQAsync({ integrationToken: token, useFactory: () => ({}) });
  assert.ok(dynamic.exports.includes(token));
  const integration = dynamic.providers.find((provider) => provider.provide === token);
  assert.ok(integration, 'custom integration provider was not registered');
});
