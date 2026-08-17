import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { installPostgresTaskProfile, migrateTaskSchema } from '../dist/index.js';

// Migration 015 narrowed the effect claim's lock from the Task row to one item.
//
// The old shape took `FOR UPDATE` on the parent Task and then handed the same
// transaction to the caller's business callback, so the parent row of the whole
// batch stayed locked for as long as the application ran. Every other item
// queued behind it: a fan-out took N times the per-item cost regardless of
// configured concurrency, and each waiting item pinned a pooled connection.
//
// A green run of the old code proves nothing here, because the serialisation is
// a timing property. These tests measure it.
const databaseUrl = process.env.RHINOQ_TEST_DATABASE_URL;

const ITEMS = 8;
const WORK_MS = 200;

async function freshProfile() {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', '-c rhinoq.tenant_id=default');
  // One connection per item plus headroom, so the pool is never what limits
  // concurrency — otherwise this measures the pool instead of the lock.
  const pool = new pg.Pool({ connectionString: url.toString(), max: ITEMS + 4 });
  await pool.query('DROP SCHEMA IF EXISTS rhinoq_task CASCADE');
  await migrateTaskSchema(pool);
  return { pool, tasks: await installPostgresTaskProfile(pool) };
}

async function seedItems(tasks, taskId, count) {
  await tasks.createTask({
    id: taskId, type: 'transcode.batch', ownerId: 'owner', definitionVersion: 1,
  });
  const executions = [];
  for (let index = 0; index < count; index++) {
    const itemKey = `item-${index}`;
    const executionId = `${taskId}--${itemKey}`;
    await tasks.createTaskExecution(taskId, {
      id: executionId, itemKey, runtime: 'bullmq', runtimeScope: 'transcode',
      externalId: `${taskId}__${itemKey}`,
    });
    executions.push(executionId);
  }
  return executions;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('items of one Task claim their effects in parallel', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    const executions = await seedItems(tasks, 'parallel-claim', ITEMS);

    const started = Date.now();
    await Promise.all(executions.map((executionId) => tasks.onceForItem(
      executionId,
      'charge-customer',
      // Stands in for the provider call an application makes here. Under the
      // old lock this ran while holding the parent Task row.
      async () => { await sleep(WORK_MS); return executionId; },
    )));
    const elapsed = Date.now() - started;

    // Serialised, this is ITEMS * WORK_MS = 1600ms. Parallel, it is one
    // WORK_MS plus round trips. The threshold sits far enough below the
    // serialised figure that a slow machine cannot produce a false pass, and
    // far enough above one WORK_MS that scheduling jitter cannot fail it.
    const serialised = ITEMS * WORK_MS;
    console.log(`  # ${ITEMS} items × ${WORK_MS}ms work: ${elapsed}ms (serialised would be ~${serialised}ms)`);
    assert.ok(
      elapsed < serialised / 2,
      `${ITEMS} items took ${elapsed}ms; serialised would be ~${serialised}ms. `
      + 'The effect claim is still holding a lock shared across items.',
    );
  } finally {
    await pool.end();
  }
});

test('a repeat claim for the same item is still refused exactly once', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    const [executionId] = await seedItems(tasks, 'repeat-claim', 1);

    const first = await tasks.onceForItem(executionId, 'charge-customer', async () => 'charged');
    assert.equal(first.executed, true);
    assert.equal(first.value, 'charged');

    const second = await tasks.onceForItem(executionId, 'charge-customer', async () => {
      throw new Error('the business callback must not run for a claimed effect');
    });
    assert.equal(second.executed, false);
  } finally {
    await pool.end();
  }
});

// The narrowed lock still has to serialise concurrent claims for the SAME item,
// which is the invariant the wide lock was protecting.
test('concurrent claims for one item elect exactly one winner', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    const [executionId] = await seedItems(tasks, 'one-winner', 1);

    const attempts = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      tasks.onceForItem(executionId, 'charge-customer', async () => index)));

    const executed = attempts.filter((attempt) => attempt.executed);
    assert.equal(
      executed.length, 1,
      `${executed.length} concurrent claims ran the callback; exactly one may.`,
    );
  } finally {
    await pool.end();
  }
});

// A retry creates a new attempt for the item, and the claim scans every attempt
// of that item to decide. Both take the same per-item key, in the same order,
// so one cannot insert an attempt into the middle of the other's scan — and the
// claim must still see the committed effect across the attempt boundary.
test('a claim survives the item being retried underneath it', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    const [executionId] = await seedItems(tasks, 'claim-across-retry', 1);

    const first = await tasks.onceForItem(executionId, 'charge-customer', async () => 'charged');
    assert.equal(first.executed, true);

    let execution = await tasks.getTaskExecution(executionId);
    execution = await tasks.bindTaskExecution(executionId, {
      runtime: 'bullmq', runtimeScope: 'transcode', externalId: 'claim-across-retry__item-0',
    }).then(() => tasks.getTaskExecution(executionId));
    await tasks.transitionTaskExecution(executionId, execution.version, 'failed', 'provider 502');

    const failed = await tasks.getTaskExecution(executionId);
    await tasks.retryTaskExecution(executionId, failed.version, `${executionId}--retry`);

    // The second attempt is a different Execution row. The claim spans attempts
    // for the item, so the money must not move again.
    const afterRetry = await tasks.onceForItem(
      `${executionId}--retry`,
      'charge-customer',
      async () => { throw new Error('a retried attempt must not repeat a claimed effect'); },
    );
    assert.equal(afterRetry.executed, false);
  } finally {
    await pool.end();
  }
});
