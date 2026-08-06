import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { installPostgresTaskProfile, migrateTaskSchema } from '../dist/index.js';

// Everything here is about what a person reads at 2am, and what happens to a
// batch when they read the wrong thing. Migration 007 exists because the store
// answered three different situations with the same opaque string.
const databaseUrl = process.env.RHINOQ_TEST_DATABASE_URL;

async function freshProfile() {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  await pool.query('DROP SCHEMA IF EXISTS rhinoq_task CASCADE');
  await migrateTaskSchema(pool);
  return { pool, tasks: await installPostgresTaskProfile(pool) };
}

// Reserve and bind, which is what dispatchMany does: the attempt is then
// `dispatched` and waiting for the runtime to say something about it.
async function addItem(tasks, taskId, itemKey) {
  await tasks.createTaskExecution(taskId, {
    id: `${taskId}--${itemKey}`, itemKey, runtime: 'bullmq',
    runtimeScope: 'transcode', externalId: `${taskId}__${itemKey}`,
  });
  return tasks.bindTaskExecution(`${taskId}--${itemKey}`, {
    runtime: 'bullmq', runtimeScope: 'transcode', externalId: `${taskId}__${itemKey}`,
  });
}

async function seed(tasks, id) {
  await tasks.createTask({
    id, type: 'transcode.batch', ownerId: 'owner', definitionVersion: 1,
  });
  return addItem(tasks, id, 'item-1');
}

test('a version conflict names the command and both versions', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    let task = await seed(tasks, 'conflict-message');
    task = await tasks.transitionTask(task.id, task.entityVersion, 'queued');

    // The whole message used to be the Task id, which said nothing about what
    // had been attempted or how far apart the two versions were.
    await assert.rejects(
      tasks.transitionTask(task.id, task.entityVersion - 1, 'running'),
      (error) => {
        assert.equal(error.code, 'RHINOQ_VERSION_CONFLICT');
        assert.match(error.message, /transitionTask\(conflict-message\)/);
        assert.match(error.message, new RegExp(`expected Task version ${task.entityVersion - 1}`));
        assert.match(error.message, new RegExp(`current version ${task.entityVersion}`));
        return true;
      },
    );
  } finally {
    await pool.end();
  }
});

test('an Execution command given the Task version says which axis is wrong', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    const task = await seed(tasks, 'wrong-axis');
    const execution = await tasks.getTaskExecution('wrong-axis--item-1');
    assert.notEqual(execution.version, task.entityVersion, 'the two axes must differ for this test to mean anything');

    // This is the mistake that used to cost an afternoon: the symptom was
    // RHINOQ_VERSION_CONFLICT, which reads exactly like contention, so the
    // reasonable response is to re-read and retry — forever.
    await assert.rejects(
      tasks.transitionTaskExecution(execution.id, task.entityVersion, 'running'),
      (error) => {
        assert.equal(error.code, 'RHINOQ_WRONG_VERSION_SCOPE');
        assert.match(error.message, /TaskExecution\.version/);
        assert.match(error.message, /TaskSnapshot\.entityVersion/);
        return true;
      },
    );

    // The correct axis still works.
    await tasks.transitionTaskExecution(execution.id, execution.version, 'running');
  } finally {
    await pool.end();
  }
});

test('an attempt that reports a result without ever reporting a start still settles', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    await seed(tasks, 'late-start');
    const execution = await tasks.getTaskExecution('late-start--item-1');
    assert.equal(execution.state, 'dispatched');

    // A webhook, a batch callback, or two events delivered out of order. This
    // used to be RHINOQ_INVALID_EXECUTION_TRANSITION and the item was stranded
    // at `dispatched`, which also means its batch never settles.
    await tasks.transitionTaskExecution(execution.id, execution.version, 'succeeded');
    assert.equal((await tasks.getTaskExecution(execution.id)).state, 'succeeded');
    assert.equal(await tasks.settleTaskItems('late-start'), true);
  } finally {
    await pool.end();
  }
});

test('itemCounts counts items and executionCounts counts attempts', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    await tasks.createTask({
      id: 'counts', type: 'transcode.batch', ownerId: 'owner', definitionVersion: 1,
    });
    for (let index = 0; index < 3; index += 1) {
      await addItem(tasks, 'counts', `item-${index}`);
    }
    // One item retries: three URLs in, four attempts recorded.
    let failing = await tasks.getTaskExecution('counts--item-0');
    await tasks.transitionTaskExecution(failing.id, failing.version, 'failed', 'mirror 404');
    failing = await tasks.getTaskExecution(failing.id);
    await tasks.retryTaskExecution(failing.id, failing.version, 'counts--item-0-attempt-2');

    const summary = await tasks.getTaskSummary('counts');
    assert.equal(summary.executionCounts.total, 4, 'attempts');
    assert.equal(summary.itemCounts.total, 3, 'items the user submitted');
    assert.equal(summary.itemCounts.retries, 1);
    assert.equal(summary.itemCounts.failed, 0, 'the failed attempt was superseded');
    assert.equal(summary.itemCounts.dispatched, 3);
  } finally {
    await pool.end();
  }
});
