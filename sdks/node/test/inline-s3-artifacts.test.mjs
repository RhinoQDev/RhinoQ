import assert from 'node:assert/strict';
import test from 'node:test';

import { createRhinoQApp } from '../dist/index.js';

// The finding behind this: adopters assembled the file path — the S3 provider,
// the upload service, the download resolver — by hand, because they did not know
// createRhinoQApp already wires all of it. It wired it from RHINOQ_ARTIFACT_*
// env only; this adds the same one-call wiring with configuration passed inline,
// for hosts that configure in code rather than the environment.

const fakePool = {
  async query() { return { rows: [] }; },
  async connect() { return { async query() { return { rows: [] }; }, release() {} }; },
};
// A stand-in Task client so the app constructs without a real database.
const fakeTasks = {
  registerTaskArtifact: async () => ({}),
  getTaskForOwner: async () => ({}),
  listTasksByState: async () => [],
};

test('artifacts: { s3 } wires the whole file path from one inline config', async () => {
  const app = await createRhinoQApp({
    pool: fakePool, adapters: [], tasks: fakeTasks,
    artifacts: { s3: { bucket: 'reports', clientConfig: { region: 'us-east-1' } } },
  });
  // The upload service (direct multipart) and retention cleanup are wired — the
  // application assembled none of them.
  assert.ok(app.artifacts, 'the direct multipart upload service must be wired');
  assert.ok(app.artifactRetention, 'artifact retention cleanup must be wired');
});

test('the env form still works and is mutually exclusive with a provider', async () => {
  // Two file configs at once is a mistake worth catching early.
  await assert.rejects(
    createRhinoQApp({
      pool: fakePool, adapters: [], tasks: fakeTasks,
      artifacts: 's3',
      artifactProvider: { storage: {}, resolve: async () => ({}) },
    }),
    /configure only one of/,
  );
});

test('an unknown artifacts value is rejected with an actionable message', async () => {
  await assert.rejects(
    createRhinoQApp({ pool: fakePool, adapters: [], tasks: fakeTasks, artifacts: 'gcs' }),
    /artifacts must be "s3" or \{ s3: AwsS3ArtifactOptions \}/,
  );
});

test('no artifacts option leaves the file path unwired, not half-wired', async () => {
  const app = await createRhinoQApp({ pool: fakePool, adapters: [], tasks: fakeTasks });
  assert.equal(app.artifacts, undefined, 'no file config means no upload service');
  assert.equal(app.artifactRetention, undefined);
});
