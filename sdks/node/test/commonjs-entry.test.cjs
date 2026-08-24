const assert = require('node:assert/strict');
const test = require('node:test');

// NestJS — the most common host for BullMQ — compiles to CommonJS by default,
// and a Nest constructor cannot `await import()`. This is the exact call that
// used to fail with ERR_PACKAGE_PATH_NOT_EXPORTED. It resolves through the
// package's own exports map, not through a dist path, so it breaks if the map
// or the {"type":"commonjs"} marker regresses.
test('a CommonJS application can require the package entry point', () => {
  const {
    RhinoQClient,
    RhinoQError,
    RhinoQWorker,
    BullMQTaskBridge,
    watchTask,
  } = require('@rhinoq/node');

  for (const [name, exported] of Object.entries({
    RhinoQClient,
    RhinoQError,
    RhinoQWorker,
    BullMQTaskBridge,
    watchTask,
  })) {
    assert.equal(typeof exported, 'function', `${name} is missing from the CommonJS entry point`);
  }

  const client = new RhinoQClient({
    url: 'http://127.0.0.1:8099',
    token: 'commonjs-smoke-token-at-least-32-bytes',
  });
  assert.equal(typeof client.getTask, 'function');
  assert.equal(typeof client.reportTaskProgress, 'function');
});

// Bundlers, version reporters and `npm ls`-style tooling read the manifest
// through the package name rather than a relative path. An exports map that
// omits it answers ERR_PACKAGE_PATH_NOT_EXPORTED, which reads as "the package
// is broken" rather than "this subpath is closed".
test('the package manifest is reachable through the exports map', () => {
  const manifest = require('@rhinoq/node/package.json');
  assert.equal(manifest.name, '@rhinoq/node');
  assert.equal(typeof manifest.version, 'string');
});

test('a CommonJS Nest application can require the canonical subpath', () => {
  const { RhinoQModule, RHINOQ_TASKS } = require('@rhinoq/node/nest');
  assert.equal(typeof RhinoQModule.forBullMQAsync, 'function');
  assert.equal(typeof RHINOQ_TASKS, 'symbol');
});

test('CommonJS capability subpaths are independently requireable', () => {
  assert.equal(typeof require('@rhinoq/node/browser').TaskStore, 'function');
  assert.equal(typeof require('@rhinoq/node/react').createUseRhinoTask, 'function');
  assert.equal(typeof require('@rhinoq/node/bullmq').bullMQCancellation, 'function');
  assert.equal(typeof require('@rhinoq/node/sqs').createSQSRuntimeAdapter, 'function');
  assert.equal(typeof require('@rhinoq/node/server').createNodeTaskMiddleware, 'function');
  assert.equal(typeof require('@rhinoq/node/sst').compileRhinoQSSTDeployment, 'function');
});
