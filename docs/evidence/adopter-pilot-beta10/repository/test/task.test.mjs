import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from '../src/app.mjs';
import {
  cancelImportTask,
  createImportTask,
  updateImportProgress,
} from '../src/import-service.mjs';

const databaseUrl = process.env.RHINOQ_PILOT_DATABASE_URL;

test('RhinoQ owns task state and the app keeps its business handler', {
  skip: !databaseUrl,
}, async () => {
  const app = await createApp(databaseUrl);
  const id = `pilot-${process.pid}-${Date.now()}`;
  try {
    let task = await createImportTask(app.tasks, {
      id,
      ownerId: 'owner-a',
      tenantId: 'tenant-a',
      total: 2,
    });
    assert.equal(task.state, 'running');

    task = await updateImportProgress(app.tasks, task, 1, 2);
    assert.equal(task.progress.completed, 1);
    assert.equal(task.progress.total, 2);

    const response = await app.taskHandler(new Request('http://fixture.test/tasks', {
      headers: { 'x-owner': 'owner-a', 'x-tenant': 'tenant-a' },
    }));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).tasks.map((item) => item.id), [id]);

    task = await cancelImportTask(app.tasks, task);
    assert.equal(task.cancellation.status, 'requested');
  } finally {
    await app.pool.query('DROP SCHEMA IF EXISTS rhinoq_task CASCADE');
    await app.pool.end();
  }
});
