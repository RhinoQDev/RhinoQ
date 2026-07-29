import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { RhinoQClient } from '../dist/index.js';

const goldenURL = new URL(
  '../../../testdata/contracts/task-contract-v1.json',
  import.meta.url,
);

test('Node Task client consumes the shared Go wire contract v1', async () => {
  const golden = JSON.parse(await readFile(goldenURL, 'utf8'));
  const client = new RhinoQClient({
    url: 'http://gateway.test',
    fetch: async (url) => {
      if (url.endsWith('/execution-results')) {
        return Response.json(golden.executionResults);
      }
      if (url.endsWith('/result')) {
        return Response.json(golden.result);
      }
      return Response.json(golden.snapshot);
    },
  });

  const snapshot = await client.getTask('task-contract-01');
  const result = await client.getTaskResult('task-contract-01');
  const executionResults = await client.getTaskExecutionResults('task-contract-01');

  assert.deepEqual(snapshot, golden.snapshot);
  assert.deepEqual(result, golden.result);
  assert.deepEqual(executionResults, golden.executionResults);
  assert.deepEqual(Object.keys(snapshot), [
    'schemaVersion',
    'entityVersion',
    'id',
    'type',
    'ownerId',
    'state',
    'cancellation',
    'progress',
    'hasResult',
    'executions',
    'createdAt',
    'updatedAt',
  ]);
  assert.deepEqual(Object.keys(snapshot.executions[0]), [
    'id',
    'attempt',
    'runtime',
    'state',
    'version',
    'hasResult',
  ]);
  assert.deepEqual(Object.keys(snapshot.executions[2]), [
    'id',
    'attempt',
    'runtime',
    'state',
    'version',
    'hasResult',
    'failureReason',
  ]);

  // Per-item storage references must reach the client only through the
  // separate owner-scoped read, never through the polled snapshot.
  assert.ok(!JSON.stringify(snapshot).includes('s3://'));
  assert.equal(
    executionResults.executions[1].reference,
    's3://reports/task-contract-01/item-2.mp4',
  );
});
