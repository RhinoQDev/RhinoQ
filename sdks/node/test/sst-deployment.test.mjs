import assert from 'node:assert/strict';
import test from 'node:test';

import { compileRhinoQPlan, compileRhinoQSSTDeployment, defineRhinoQDeployment, linkRhinoQCapabilities, materializeRhinoQSSTDeployment } from '../dist/index.js';

function plan() {
  const deployment = defineRhinoQDeployment({ app: 'reports', stage: 'pr-123', region: 'ap-southeast-1' });
  const capabilityGraph = linkRhinoQCapabilities({
    components: [{ id: 'storage/s3', version: 1, contractVersion: 1, provides: ['storage:artifacts'] }],
    requirements: [{ capability: 'storage:artifacts', requiredBy: 'task:report.export' }],
  });
  return compileRhinoQPlan({ schemaVersion: 1, profile: 'reports', deployment, capabilityGraph, tasks: [
    { key: 'report', name: 'report.export', version: 1, adapter: 'postgres', runtime: 'postgres', scope: 'reports', retry: { mode: 'never' }, externalEffect: false },
  ] });
}

test('SST adapter compiles deterministic resource intent without creating resources', () => {
  const calls = [];
  const spec = compileRhinoQSSTDeployment({ plan: plan(), worker: { image: 'registry/rhinoq:1', command: ['./rhinoq-worker'] }, migration: { command: ['./rhinoq', 'migrate', 'apply'] }, workbench: true });
  assert.deepEqual(calls, []);
  assert.equal(spec.worker.name, 'reports-pr-123-worker');
  assert.deepEqual(spec.worker.handlers, ['report.export']);
  assert.deepEqual(spec.requiredLinks, ['storage:artifacts']);
  assert.equal(spec.worker.environment.RHINOQ_STAGE, 'pr-123');
  assert.equal(JSON.stringify(spec).includes('secret-value'), false);
  assert.match(spec.fingerprint, /^fnv1a32:/);
});

test('SST materialization uses adopter factories and fails closed on missing links', () => {
  const spec = compileRhinoQSSTDeployment({ plan: plan(), worker: { image: 'registry/rhinoq:1', command: ['./worker'] }, migration: { command: ['./rhinoq', 'migrate', 'apply'] } });
  const calls = [];
  const materializer = {
    migration(name, args) { calls.push(['migration', name, args]); return { kind: 'task', name }; },
    service(name, args) { calls.push(['service', name, args]); return { kind: 'service', name }; },
  };
  assert.throws(() => materializeRhinoQSSTDeployment({ spec, materializer, links: {} }), /missing resource links/);
  const result = materializeRhinoQSSTDeployment({ spec, materializer, links: { 'storage:artifacts': { kind: 'bucket' } } });
  assert.deepEqual(calls.map((entry) => entry[0]), ['migration', 'service']);
  assert.equal(result.worker.kind, 'service');
  assert.equal(result.migration.kind, 'task');
});

test('SST adapter requires explicit deployment identity and argv', () => {
  const withoutDeployment = compileRhinoQPlan({ schemaVersion: 1, profile: 'reports', tasks: [] });
  assert.throws(() => compileRhinoQSSTDeployment({ plan: withoutDeployment, worker: { image: 'image', command: ['./worker'] } }), /plan\.deployment/);
  assert.throws(() => compileRhinoQSSTDeployment({ plan: plan(), worker: { image: 'image', command: [] } }), /worker command/);
});
