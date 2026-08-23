import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { createDurableTaskContext, installPostgresTaskProfile, migrateTaskSchema } from '../dist/index.js';

const databaseUrl = process.env.RHINOQ_TEST_DATABASE_URL;

async function freshProfile() {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', '-c rhinoq.tenant_id=default');
  const pool = new pg.Pool({ connectionString: url.toString() });
  await pool.query('DROP SCHEMA IF EXISTS rhinoq_task CASCADE');
  await migrateTaskSchema(pool);
  return { pool, tasks: await installPostgresTaskProfile(pool) };
}

async function seed(tasks, taskId) {
  await tasks.createTask({ id: taskId, type: 'generate-report', ownerId: 'owner', definitionVersion: 1 });
  const executionId = `${taskId}:execution:1`;
  await tasks.createTaskExecution(taskId, {
    id: executionId, itemKey: 'default', runtime: 'bullmq', runtimeScope: 'reports', externalId: executionId,
  });
  return executionId;
}

function acquire(tasks, taskId, executionId, stepKey, owner, options = {}) {
  return tasks.acquireDurableStep({
    taskId, executionId, itemKey: 'default', taskVersion: 1, stepKey, stepVersion: options.stepVersion ?? 1,
    owner, leaseMs: options.leaseMs ?? 1_000, maxAttempts: options.maxAttempts ?? 3,
  });
}

test('PostgreSQL durable Steps reuse completed work and fence races, stale workers, retry, and version drift', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    const taskId = 'durable-report';
    const executionId = await seed(tasks, taskId);

    const load = await acquire(tasks, taskId, executionId, 'load-data', 'worker-a');
    const renewedLoad = await tasks.renewDurableStep(load.lease, 1_000);
    await tasks.completeDurableStep(renewedLoad, { rows: 2 });
    const reused = await acquire(tasks, taskId, executionId, 'load-data', 'worker-b');
    assert.deepEqual(reused, { action: 'reused', state: 'completed', result: { rows: 2 } });

    const running = await acquire(tasks, taskId, executionId, 'generate', 'worker-a');
    await assert.rejects(
      acquire(tasks, taskId, executionId, 'generate', 'worker-b'),
      (error) => error?.code === 'RHINOQ_DURABLE_STEP_LEASE_HELD',
    );
    await tasks.completeDurableStep(running.lease, { report: 'artifact:report-1' });

    const stale = await acquire(tasks, taskId, executionId, 'upload', 'worker-a');
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const takeover = await acquire(tasks, taskId, executionId, 'upload', 'worker-b');
    assert.equal(takeover.action, 'acquired');
    assert.equal(takeover.lease.epoch, stale.lease.epoch + 1);
    await assert.rejects(
      tasks.completeDurableStep(stale.lease, { stale: true }),
      (error) => error?.code === 'RHINOQ_DURABLE_STEP_LEASE_FENCED',
    );
    await tasks.completeDurableStep(takeover.lease, { uploaded: true });

    const retryOne = await acquire(tasks, taskId, executionId, 'notify', 'worker-a');
    await tasks.failDurableStep(retryOne.lease, new Error('provider unavailable'));
    const retryTwo = await acquire(tasks, taskId, executionId, 'notify', 'worker-b');
    assert.equal(retryTwo.lease.attempt, 2);
    await tasks.completeDurableStep(retryTwo.lease, { notified: true });

    await assert.rejects(
      acquire(tasks, taskId, executionId, 'load-data', 'worker-c', { stepVersion: 2 }),
      (error) => error?.code === 'RHINOQ_DURABLE_STEP_VERSION_MISMATCH',
    );
  } finally {
    await pool.end();
  }
});

test('PostgreSQL context.step keeps a fenced Step lease alive for a long callback', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    const taskId = 'durable-heartbeat';
    const executionId = await seed(tasks, taskId);
    const context = createDurableTaskContext({
      taskId,
      executionId,
      taskVersion: 1,
      steps: tasks,
      workerId: 'node-heartbeat',
      stepLeaseMs: 1_000,
    });

    const result = await context.step('render', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      return { artifact: 'report-42' };
    });
    assert.deepEqual(result, { artifact: 'report-42' });
    const rows = await tasks.listDurableSteps(taskId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'completed');
    assert.deepEqual(rows[0].result, { artifact: 'report-42' });
  } finally {
    await pool.end();
  }
});
