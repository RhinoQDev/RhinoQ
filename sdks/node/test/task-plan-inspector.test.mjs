import assert from 'node:assert/strict';
import test from 'node:test';

import { adaptRhinoQPlanJson, inspectRhinoQPlan } from '../dist/index.js';

test('Plan Inspector keeps compiled capsules bounded and separates Needs decision', () => {
  const ready = inspectRhinoQPlan({
    schemaVersion: 1,
    profile: 'reports',
    tasks: [{
      key: 'exportReport', name: 'report.export', version: 1, adapter: 'bullmq', runtime: 'bullmq', scope: 'reports',
      retry: { mode: 'runtime', maxAttempts: 3 }, externalEffect: false, capability: 'task',
      dataPath: {
        workload: 'task', input: { transport: 'inline', queueCarries: 'payload' },
        output: { transport: 'private-reference', checksumRequired: true }, needsDecision: [],
      },
    }],
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.tasks[0].factory, 'task');
  assert.equal(ready.tasks[0].compiledCapsule.dataPath?.outputTransport, 'private-reference');

  const undecided = inspectRhinoQPlan({
    schemaVersion: 1,
    profile: 'media',
    tasks: [{
      key: 'video', name: 'video.transcode', version: 1, adapter: 'bullmq', runtime: 'bullmq', scope: 'media',
      retry: { mode: 'never' }, externalEffect: false, capability: 'media',
      dataPath: {
        workload: 'media', input: { transport: 'private-reference', queueCarries: 'private-reference' },
        output: { transport: 'stream-to-storage', checksumRequired: true },
        needsDecision: ['provider must support direct multipart transfer'],
      },
    }],
  });
  assert.equal(undecided.status, 'needs-decision');
  assert.deepEqual(undecided.needsDecision, ['video.transcode: provider must support direct multipart transfer']);
  assert.match(undecided.note, /read-only/);
});

test('Plan Inspector reports an explicit not-configured state', () => {
  const report = inspectRhinoQPlan();
  assert.equal(report.status, 'not-configured');
  assert.equal(report.tasks.length, 0);
  assert.match(report.needsDecision[0], /typed application compiler/);
});

test('Plan Inspector exposes deployment and redacted capability-link evidence', () => {
  const inspection = inspectRhinoQPlan({
    schemaVersion: 1, profile: 'reports', tasks: [],
    deployment: { kind: 'rhinoq-deployment', schemaVersion: 1, app: 'reports', stage: 'dev', namespace: 'reports-dev', tenantBoundary: 'single-tenant-process', fingerprint: 'fixture:deployment' },
    capabilityGraph: { kind: 'rhinoq-capability-graph', schemaVersion: 1, fingerprint: 'fixture:links', unresolvedOptional: [], links: [{ capability: 'storage:artifacts', provider: 'storage/s3', requiredBy: ['task:report.export'], binding: { properties: {}, secretRefs: ['secret://aws/rhinoq'], permissions: ['s3:GetObject'] } }] },
  });
  assert.equal(inspection.deployment.namespace, 'reports-dev');
  assert.deepEqual(inspection.capabilityLinks[0].secretRefs, ['secret://aws/rhinoq']);
  assert.equal(JSON.stringify(inspection).includes('secret-value'), false);
});

test('plan JSON adapter reports confidence and refuses unsupported input without mutation', () => {
  const legacy = adaptRhinoQPlanJson({ schemaVersion: 1, profile: 'reports', tasks: [] });
  assert.equal(legacy.source, 'legacy-manifest');
  assert.equal(legacy.confidence, 'medium');
  assert.equal(legacy.plan.profile, 'reports');
  assert.match(legacy.warnings[0], /projected/);

  const invalid = adaptRhinoQPlanJson({ schemaVersion: 2, profile: 'future', tasks: [] });
  assert.equal(invalid.confidence, 'low');
  assert.equal(invalid.plan, undefined);
  assert.equal(invalid.unsupported[0], 'invalid or unsupported plan input');
});
