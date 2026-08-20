import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { installPostgresTaskProfile, migrateTaskSchema } from '../dist/index.js';

// The low-level happy path is: createTask -> transitionTask('queued') ->
// transitionTask('running') -> reportTaskProgress -> transitionTask('succeeded'),
// threading a fresh entityVersion through every call. The handle does the same
// against a real database while the caller writes only intent.
const databaseUrl = process.env.RHINOQ_TEST_DATABASE_URL;

async function freshProfile() {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', '-c rhinoq.tenant_id=default');
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  await pool.query('DROP SCHEMA IF EXISTS rhinoq_task CASCADE');
  await migrateTaskSchema(pool);
  return { pool, tasks: await installPostgresTaskProfile(pool) };
}

test('a full worker lifecycle runs through the handle with no manual version', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    await tasks.createTask({ id: 'handle-1', type: 'export', ownerId: 'owner', definitionVersion: 1 });

    const handle = await tasks.openTask('handle-1');
    assert.equal(handle.state, 'pending');

    await handle.start();
    assert.equal(handle.state, 'running');

    await handle.reportProgress({ completed: 1, total: 3 });
    await handle.reportProgress({ completed: 3, total: 3 });
    assert.equal(handle.snapshot.progress.completed, 3);

    await handle.succeed();
    assert.equal(handle.state, 'succeeded');
    assert.equal(handle.isTerminal, true);

    // The database agrees with the handle's view.
    const fromDb = await tasks.getTask('handle-1');
    assert.equal(fromDb.state, 'succeeded');
    assert.equal(fromDb.entityVersion, handle.version);
  } finally {
    await pool.end();
  }
});

test('a stale handle raises a version conflict and refresh() recovers it', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    await tasks.createTask({ id: 'handle-2', type: 'export', ownerId: 'owner', definitionVersion: 1 });
    const handle = await tasks.openTask('handle-2');
    await handle.start();

    // A second writer moves the task out from under the handle.
    const current = await tasks.getTask('handle-2');
    await tasks.reportTaskProgress('handle-2', current.entityVersion, { completed: 1 });

    // The handle is now stale; its next write must conflict, not silently retry.
    await assert.rejects(
      handle.reportProgress({ completed: 2 }),
      (error) => error.code === 'RHINOQ_VERSION_CONFLICT' || error.code === 'RHINOQ_WRONG_VERSION_SCOPE',
    );

    // refresh() resumes from truth and the next write succeeds.
    await handle.refresh();
    await handle.reportProgress({ completed: 5 });
    assert.equal(handle.snapshot.progress.completed, 5);
  } finally {
    await pool.end();
  }
});
