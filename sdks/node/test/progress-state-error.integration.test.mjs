import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { installPostgresTaskProfile, migrateTaskSchema } from '../dist/index.js';

// A developer who reported progress in the wrong state used to get
// `RhinoQError [RHINOQ_PROGRESS_STATE]: pending` — the bare state, no cause, no
// valid states, no next step. Every other error in the schema (fail_version)
// carries a full sentence. This brings progress-state to the same bar.
const databaseUrl = process.env.RHINOQ_TEST_DATABASE_URL;

async function freshProfile() {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', '-c rhinoq.tenant_id=default');
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  await pool.query('DROP SCHEMA IF EXISTS rhinoq_task CASCADE');
  await migrateTaskSchema(pool);
  return { pool, tasks: await installPostgresTaskProfile(pool) };
}

test('reporting progress on a pending task explains what is wrong and what to do', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    const task = await tasks.createTask({
      id: 'progress-state', type: 'export', ownerId: 'owner', definitionVersion: 1,
    });
    assert.equal(task.state, 'pending');

    await assert.rejects(
      tasks.reportTaskProgress('progress-state', task.entityVersion, { completed: 1 }),
      (error) => {
        assert.equal(error.code, 'RHINOQ_PROGRESS_STATE');
        // The message is no longer the bare state.
        assert.notEqual(error.message, 'pending');
        // It names the offending state, the valid states, and the fix.
        assert.match(error.message, /pending/);
        assert.match(error.message, /running/);
        assert.match(error.message, /cancel_requested/);
        assert.match(error.message, /reportTaskProgress\(progress-state\)/);
        // The next action is also a structured field, not only prose.
        assert.match(error.nextAction ?? '', /running/i);
        return true;
      },
    );
  } finally {
    await pool.end();
  }
});

test('progress still works once the task reaches running', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    let task = await tasks.createTask({
      id: 'progress-ok', type: 'export', ownerId: 'owner', definitionVersion: 1,
    });
    task = await tasks.transitionTask(task.id, task.entityVersion, 'queued');
    task = await tasks.transitionTask(task.id, task.entityVersion, 'running');
    // The error change did not touch the happy path.
    const updated = await tasks.reportTaskProgress(task.id, task.entityVersion, { completed: 3 });
    assert.equal(updated.progress.completed, 3);
  } finally {
    await pool.end();
  }
});
