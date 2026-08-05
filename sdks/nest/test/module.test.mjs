import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RHINOQ_BRIDGE,
  RHINOQ_HEALTH,
  RHINOQ_INTEGRATION,
  RHINOQ_TASKS,
  RhinoQModule,
  RhinoQLifecycle,
} from '../index.js';

test('forRootAsync returns one standard lifecycle graph', () => {
  const dynamic = RhinoQModule.forRootAsync({
    imports: ['PoolModule'],
    inject: ['POOL'],
    useFactory: (pool) => ({ pool, events: { on() {} }, runtimeScope: 'reports', terminalProjection: 'execution-only' }),
  });

  assert.equal(dynamic.module, RhinoQModule);
  assert.deepEqual(dynamic.imports, ['PoolModule']);
  assert.ok(dynamic.providers.some((provider) => provider.provide === RHINOQ_INTEGRATION));
  assert.ok(dynamic.providers.some((provider) => provider.provide === RHINOQ_TASKS));
  assert.ok(dynamic.providers.some((provider) => provider.provide === RHINOQ_BRIDGE));
  assert.ok(dynamic.providers.some((provider) => provider.provide === RHINOQ_HEALTH));
  assert.ok(dynamic.providers.some((provider) => provider.provide === RhinoQLifecycle));
  assert.deepEqual(dynamic.exports, [RHINOQ_INTEGRATION, RHINOQ_TASKS, RHINOQ_BRIDGE, RHINOQ_HEALTH]);
});

test('forRootAsync refuses a missing factory before Nest starts', () => {
  assert.throws(() => RhinoQModule.forRootAsync({}), /useFactory/);
});
