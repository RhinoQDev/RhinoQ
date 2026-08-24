import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createManualRuntimeAdapter,
  defineRhinoQDeployment,
  defineRhinoQProject,
} from '../dist/index.js';

const pool = { async query() { throw new Error('the installed task profile is not queried in this composition test'); } };
const tasks = { async listTasksByState() { return []; } };
const adapter = createManualRuntimeAdapter('manual', 'reports');

test('project profile binds pool, identity and operator surface once', async () => {
  const project = defineRhinoQProject({
    pool,
    profile: { name: 'reports', adapters: [adapter] },
    identity: { ownerFromNodeRequest: () => 'owner-a' },
    http: { operatorToken: 'operator-secret', taskCenterTitle: 'Reports' },
    application: { tasks },
    deployment: defineRhinoQDeployment({ app: 'reports', stage: 'test' }),
    capabilityLinks: {
      components: [{ id: 'storage/test', version: 1, contractVersion: 1, provides: ['storage:artifacts'] }],
      requirements: [{ capability: 'storage:artifacts', requiredBy: 'task:report.export' }],
    },
    tasks: (rhinoq) => ({
      exportReport: rhinoq.task('report.export', async (input) => input),
    }),
  });

  assert.equal(project.manifest().profile, 'reports');
  assert.equal(project.plan().deployment.namespace, 'reports-test');
  assert.equal(project.plan().capabilityGraph.links[0].provider, 'storage/test');
  const started = await project.start();
  assert.equal(started.manifest.tasks[0].name, 'report.export');
  assert.equal(typeof started.http, 'function');
  assert.deepEqual(Object.keys(started.workerHandlers()), ['report.export']);
  await started.close();
});

test('project profile requires owner identity and an operator token', () => {
  const base = {
    pool,
    profile: { name: 'reports', adapters: [adapter] },
    tasks: () => ({}),
    http: { operatorToken: 'secret' },
  };
  assert.throws(() => defineRhinoQProject({ ...base, identity: {} }), /ownerFromRequest/);
  assert.throws(() => defineRhinoQProject({ ...base, identity: { ownerFromNodeRequest: () => 'owner-a' }, http: { operatorToken: ' ' } }), /operatorToken/);
});
