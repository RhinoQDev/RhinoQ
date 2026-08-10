import assert from 'node:assert/strict';
import test from 'node:test';

import { BullMQTaskDefinition } from '../dist/index.js';

test('Task definitions generate stable wiring and enforce declared cardinality', async () => {
  const bindings = [];
  const bridge = {
    async dispatch(binding) { bindings.push(binding); return { id: binding.task.id }; },
    async dispatchMany(batch) { bindings.push(...batch); return { id: batch[0].task.id }; },
  };
  const reports = new BullMQTaskDefinition(bridge, { type: 'report.generate', jobName: 'generate', mode: 'single' });
  await reports.dispatch({ id: 'report-1', ownerId: 'owner-a', data: { format: 'pdf' } });
  const firstId = bindings[0].jobId;
  bindings.length = 0;
  await reports.dispatch({ id: 'report-1', ownerId: 'owner-a', data: { format: 'pdf' } });
  assert.equal(bindings[0].jobId, firstId);
  assert.equal(bindings[0].task.type, 'report.generate');
  assert.throws(() => reports.dispatchMany('report-1', 'owner-a', []), /single definitions/);
});
