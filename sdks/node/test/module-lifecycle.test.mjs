import assert from 'node:assert/strict';
import test from 'node:test';

import { createRhinoQModule } from '../dist/index.js';

test('module lifecycle is explicit, ordered and idempotently cleaned', async () => {
  const calls = [];
  const module = createRhinoQModule({
    descriptor: { id: 'runtime/manual', namespace: 'runtime', version: 1, contractVersion: 1 },
    provision: () => calls.push('provision'),
    validate: () => calls.push('validate'),
    cleanup: () => calls.push('cleanup'),
  });
  assert.equal(module.state(), 'loaded');
  await assert.rejects(() => module.validate(), /must be provisioned/);
  await module.provision();
  await module.provision();
  await module.validate();
  await module.validate();
  await module.cleanup();
  await module.cleanup();
  assert.equal(module.state(), 'cleaned');
  assert.deepEqual(calls, ['provision', 'validate', 'cleanup']);
  await assert.rejects(() => module.provision(), /already cleaned/);
});

test('module cleanup does not swallow a failed release and can be retried', async () => {
  let attempts = 0;
  const module = createRhinoQModule({
    descriptor: { id: 'processor/test', namespace: 'processor', version: 1, contractVersion: 1 },
    cleanup: () => { attempts += 1; if (attempts === 1) throw new Error('release failed'); },
  });
  await assert.rejects(() => module.cleanup(), /release failed/);
  assert.equal(module.state(), 'loaded');
  await module.cleanup();
  assert.equal(module.state(), 'cleaned');
});
