// The Gateway and the embedded PostgreSQL profile do not carry the same
// per-item guarantees. Where the difference is silent it is a trap: an adopter
// keys idempotency on a field the server discards and only finds out when a
// retry double-charges. These tests pin the places where it must speak up.
import assert from 'node:assert/strict';
import test from 'node:test';

import { RhinoQClient } from '../dist/index.js';

function snapshot() {
  return {
    schemaVersion: 1,
    entityVersion: 1,
    id: 'task_01',
    type: 'report.export',
    state: 'queued',
    progress: { completed: 0 },
    hasResult: false,
    executions: [],
    createdAt: '2026-07-29T00:00:00Z',
    updatedAt: '2026-07-29T00:00:00Z',
  };
}

function client(warnings) {
  return new RhinoQClient({
    url: 'http://gateway.test',
    fetch: async () => Response.json(snapshot()),
    onWarning: (warning) => warnings.push(warning),
  });
}

test('Gateway client warns that itemKey is not carried on this profile', async () => {
  const warnings = [];
  await client(warnings).createTaskExecution('task_01', {
    id: 'task_01:1',
    runtime: 'bullmq',
    itemKey: 'video-42',
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /itemKey/);
  assert.match(warnings[0], /embedded PostgreSQL client/);
});

test('Gateway client warns once, not once per item in a fan-out', async () => {
  const warnings = [];
  const gateway = client(warnings);
  for (let item = 0; item < 50; item += 1) {
    await gateway.createTaskExecution('task_01', {
      id: `task_01:${item}`,
      runtime: 'bullmq',
      itemKey: `video-${item}`,
    });
  }

  assert.equal(warnings.length, 1);
});

test('Gateway client stays quiet when no itemKey is supplied', async () => {
  const warnings = [];
  await client(warnings).createTaskExecution('task_01', {
    id: 'task_01:1',
    runtime: 'bullmq',
    externalId: 'bull-job-01',
  });

  assert.deepEqual(warnings, []);
});
