import assert from 'node:assert/strict';
import test from 'node:test';

import { createRhinoQProviderComponent, linkRhinoQCapabilities } from '../dist/index.js';

test('provider component keeps pure declaration separate from explicit lifecycle', async () => {
  const calls = [];
  const s3 = createRhinoQProviderComponent({
    id: 'storage/s3', version: 1, provides: ['storage:artifacts'],
    binding: { secrets: { credential: { ref: 'secret://aws/rhinoq' } } },
    provision: () => calls.push('provision'),
    validate: () => calls.push('validate'),
    cleanup: () => calls.push('cleanup'),
  });
  const graph = linkRhinoQCapabilities({
    components: [s3.declaration],
    requirements: [{ capability: 'storage:artifacts', requiredBy: 'task:report.export' }],
  });
  assert.deepEqual(calls, []);
  assert.equal(graph.links[0].provider, 'storage/s3');
  await s3.lifecycle.provision();
  await s3.lifecycle.validate();
  await s3.lifecycle.cleanup();
  assert.deepEqual(calls, ['provision', 'validate', 'cleanup']);
});

test('provider component refuses a runtime namespace', () => {
  assert.throws(() => createRhinoQProviderComponent({ id: 'runtime/manual', version: 1, provides: ['runtime:manual'] }), /provider\/ or storage\//);
});
