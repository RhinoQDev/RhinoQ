import assert from 'node:assert/strict';
import test from 'node:test';

import { defineRhinoQApplication, defineRhinoQDeployment, createManualRuntimeAdapter, rhinoQDeploymentResource } from '../dist/index.js';

test('deployment identity is deterministic and namespaces resources by stage', () => {
  const first = defineRhinoQDeployment({ app: 'rhinoq-reports', stage: 'pr-123', region: 'ap-southeast-1', target: 'aws-account:production' });
  const second = defineRhinoQDeployment({ app: 'rhinoq-reports', stage: 'pr-123', region: 'ap-southeast-1', target: 'aws-account:production' });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.namespace, 'rhinoq-reports-pr-123');
  assert.equal(rhinoQDeploymentResource(first, 'worker'), 'rhinoq-reports-pr-123-worker');
  assert.equal(first.tenantBoundary, 'single-tenant-process');
  assert.match(first.note, /not an authorization claim/);
});

test('application compiler fingerprints deployment identity into the canonical plan', () => {
  const adapter = createManualRuntimeAdapter('manual', 'reports');
  const deployment = defineRhinoQDeployment({ app: 'reports', stage: 'staging' });
  const app = defineRhinoQApplication({
    profile: { name: 'reports', adapters: [adapter] }, deployment,
    tasks: (task) => ({ report: task.task('report.export', async (input) => input) }),
  });
  assert.equal(app.manifest().deployment.fingerprint, deployment.fingerprint);
  assert.equal(app.plan().deployment.namespace, 'reports-staging');
});

test('deployment identity refuses unsafe names and broader tenant claims', () => {
  assert.throws(() => defineRhinoQDeployment({ app: 'Reports App', stage: 'dev' }), /DNS-safe/);
  assert.throws(() => defineRhinoQDeployment({ app: 'reports', stage: 'dev', tenantBoundary: 'shared-control-plane' }), /single-tenant-process/);
});
