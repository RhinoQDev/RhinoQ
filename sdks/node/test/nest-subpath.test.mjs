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

test('Nest Application Compiler module exports one started registry and HTTP surface', async () => {
  const { RhinoQModule, RHINOQ_APPLICATION, RHINOQ_TASKS, RHINOQ_MANIFEST, RHINOQ_HTTP } = await import('../dist/nest.js');
  const compiler = { manifest() { return { schemaVersion: 1, profile: 'test', tasks: [] }; }, async start(options) {
    return { tasks: { one: true }, manifest: this.manifest(), http: options.http ? () => {} : undefined, async close() {} };
  } };
  const module = RhinoQModule.forApplicationAsync({ compiler, useFactory: async () => ({ pool: {}, http: { operatorToken: 'test' } }) });
  assert.deepEqual(module.exports, [RHINOQ_APPLICATION, RHINOQ_TASKS, RHINOQ_MANIFEST, RHINOQ_HTTP]);
  const applicationProvider = module.providers.find((provider) => provider.provide === RHINOQ_APPLICATION);
  const application = await applicationProvider.useFactory({ pool: {}, http: { operatorToken: 'test' } });
  assert.deepEqual(application.tasks, { one: true });
});
