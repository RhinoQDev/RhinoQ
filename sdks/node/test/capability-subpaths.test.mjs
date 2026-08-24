import assert from 'node:assert/strict';
import test from 'node:test';

test('capability subpaths expose narrow adopter surfaces', async () => {
  const [browser, react, bullmq, sqs, server, sst] = await Promise.all([
    import('@rhinoq/node/browser'), import('@rhinoq/node/react'),
    import('@rhinoq/node/bullmq'), import('@rhinoq/node/sqs'), import('@rhinoq/node/server'), import('@rhinoq/node/sst'),
  ]);
  assert.equal(typeof browser.TaskStore, 'function');
  assert.equal(typeof react.createUseRhinoTask, 'function');
  assert.equal(typeof bullmq.bullMQCancellation, 'function');
  assert.equal(typeof sqs.createSQSRuntimeAdapter, 'function');
  assert.equal(typeof server.createNodeTaskMiddleware, 'function');
  assert.equal(typeof sst.compileRhinoQSSTDeployment, 'function');
  assert.equal('createRhinoQApp' in sst, false, 'SST surface must not expose runtime application composition');
  assert.equal('PostgresTaskClient' in browser, false, 'browser surface must not expose PostgreSQL');
  assert.equal('createBullMQIntegration' in browser, false, 'browser surface must not expose server lifecycle');
});
