import assert from 'node:assert/strict';
import test from 'node:test';

import { compileRhinoQTaskProductHandoff } from '../dist/index.js';

test('generated Task product handoff exposes every surface and terminal path without claiming app decisions', () => {
  const handoff = compileRhinoQTaskProductHandoff({
    tasks: [{ name: 'report.export', runtime: 'bullmq', mode: 'single' }],
    ownerIdentityConfigured: true,
    operatorGateConfigured: false,
  });
  assert.equal(handoff.surfaces.find((item) => item.id === 'task-center').status, 'mounted');
  assert.equal(handoff.surfaces.find((item) => item.id === 'workbench').status, 'configuration-required');
  assert.equal(handoff.terminal.watch, 'npx rhinoq watch');
  assert.equal(handoff.acceptance.find((item) => item.id === 'business-verification').status, 'application-decision');
  assert.match(handoff.note, /application-owned/);
});

test('Task product handoff is deterministic across declaration order', () => {
  const left = compileRhinoQTaskProductHandoff({ tasks: [
    { name: 'b.run', runtime: 'bullmq', mode: 'single' }, { name: 'a.run', runtime: 'bullmq', mode: 'fanout' },
  ], ownerIdentityConfigured: false, operatorGateConfigured: false });
  const right = compileRhinoQTaskProductHandoff({ tasks: [...left.tasks].reverse(), ownerIdentityConfigured: false, operatorGateConfigured: false });
  assert.equal(left.fingerprint, right.fingerprint);
});
