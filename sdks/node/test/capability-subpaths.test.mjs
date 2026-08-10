import assert from 'node:assert/strict';
import test from 'node:test';

test('capability subpaths expose narrow adopter surfaces', async () => {
  const [browser, react, bullmq, server] = await Promise.all([
    import('@rhinoq/node/browser'), import('@rhinoq/node/react'),
    import('@rhinoq/node/bullmq'), import('@rhinoq/node/server'),
  ]);
  assert.equal(typeof browser.TaskStore, 'function');
  assert.equal(typeof react.createUseRhinoTask, 'function');
  assert.equal(typeof bullmq.bullMQCancellation, 'function');
  assert.equal(typeof server.createNodeTaskMiddleware, 'function');
  assert.equal('PostgresTaskClient' in browser, false, 'browser surface must not expose PostgreSQL');
  assert.equal('createBullMQIntegration' in browser, false, 'browser surface must not expose server lifecycle');
});
