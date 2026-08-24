import assert from 'node:assert/strict';
import test from 'node:test';

import { compileRhinoQPlan, defineRhinoQDeployment, runRhinoQCompilerWorkflow } from '../dist/index.js';

function plan(stage = 'dev', taskName = 'report.export') {
  return compileRhinoQPlan({ schemaVersion: 1, profile: 'reports', deployment: defineRhinoQDeployment({ app: 'reports', stage }), tasks: [
    { key: 'report', name: taskName, version: 1, adapter: 'manual', runtime: 'manual', scope: 'reports', retry: { mode: 'never' }, externalEffect: false },
  ] });
}

test('one pure workflow drives validate, doctor and dev from the same plan', () => {
  const current = plan();
  assert.equal(runRhinoQCompilerWorkflow({ action: 'validate', plan: current }).status, 'ready');
  assert.equal(runRhinoQCompilerWorkflow({ action: 'doctor', plan: current }).status, 'ready');
  const dev = runRhinoQCompilerWorkflow({ action: 'dev', plan: current });
  assert.equal(dev.status, 'ready');
  assert.equal(dev.dev.namespace, 'reports-dev');
  assert.deepEqual(dev.dev.handlers, ['report.export']);
});

test('workflow diff includes deployment and capability identity changes', () => {
  const result = runRhinoQCompilerWorkflow({ action: 'diff', previous: plan('dev'), plan: plan('staging') });
  assert.equal(result.status, 'changed');
  assert.equal(result.diff.deploymentChanged, true);
  assert.deepEqual(result.diff.changed, []);
});

test('dev fails closed without deployment identity', () => {
  const current = compileRhinoQPlan({ schemaVersion: 1, profile: 'reports', tasks: [] });
  const result = runRhinoQCompilerWorkflow({ action: 'dev', plan: current });
  assert.equal(result.status, 'needs-decision');
  assert.equal(result.diagnostics[0].code, 'RHINOQ_DEPLOYMENT_NOT_CONFIGURED');
  assert.equal(result.dev, undefined);
});
