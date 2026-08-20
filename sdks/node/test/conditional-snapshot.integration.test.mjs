import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { installPostgresTaskProfile, migrateTaskSchema } from '../dist/index.js';

// getTask aggregates every Execution into one jsonb array — O(N) per read. A
// watcher that re-reads pays that even when nothing changed. getTaskIfNewerThan
// answers "is there anything new" with a cheap version probe and skips the
// execution scan entirely when the caller is current.
const databaseUrl = process.env.RHINOQ_TEST_DATABASE_URL;

async function freshProfile() {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', '-c rhinoq.tenant_id=default');
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  await pool.query('DROP SCHEMA IF EXISTS rhinoq_task CASCADE');
  await migrateTaskSchema(pool);
  return { pool, tasks: await installPostgresTaskProfile(pool) };
}

async function seedItems(tasks, taskId, count, ownerId = 'owner') {
  await tasks.createTask({ id: taskId, type: 'export', ownerId, definitionVersion: 1 });
  for (let index = 0; index < count; index++) {
    await tasks.createTaskExecution(taskId, {
      id: `${taskId}--${index}`, itemKey: `item-${index}`, runtime: 'bullmq',
      runtimeScope: 'x', externalId: `${taskId}__${index}`,
    });
  }
  return tasks.getTask(taskId);
}

test('a current caller gets null and no execution payload', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    const snapshot = await seedItems(tasks, 'cond-current', 50);
    const result = await tasks.getTaskIfNewerThan('cond-current', snapshot.entityVersion);
    assert.equal(result, null, 'a caller already at the latest version must get null');
  } finally {
    await pool.end();
  }
});

test('a behind caller gets the full snapshot', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    const snapshot = await seedItems(tasks, 'cond-behind', 20);
    const result = await tasks.getTaskIfNewerThan('cond-behind', snapshot.entityVersion - 1);
    assert.ok(result, 'a behind caller must get the snapshot');
    assert.equal(result.id, 'cond-behind');
    assert.equal(result.executions.length, 20, 'the full snapshot carries every execution');
  } finally {
    await pool.end();
  }
});

test('the conditional read moves far less data than a full read when current', {
  skip: !databaseUrl,
}, async () => {
  const { pool } = await freshProfile();
  // Count bytes leaving PostgreSQL for each call.
  function counting(inner) {
    const stats = { bytes: 0 };
    return {
      stats,
      async query(text, values) {
        const r = await inner.query(text, values);
        stats.bytes += Buffer.byteLength(JSON.stringify(r.rows ?? []));
        return r;
      },
      connect: (...a) => inner.connect(...a),
    };
  }
  const { PostgresTaskClient } = await import('../dist/index.js');
  const ex = counting(pool);
  const tasks = new PostgresTaskClient(ex);
  const snapshot = await seedItems(tasks, 'cond-bytes', 200);

  const beforeFull = ex.stats.bytes;
  await tasks.getTask('cond-bytes');
  const fullBytes = ex.stats.bytes - beforeFull;

  const beforeCond = ex.stats.bytes;
  await tasks.getTaskIfNewerThan('cond-bytes', snapshot.entityVersion);
  const condBytes = ex.stats.bytes - beforeCond;

  console.log(`  # full read: ${fullBytes} bytes, conditional (current): ${condBytes} bytes`);
  assert.ok(
    condBytes * 10 < fullBytes,
    `conditional read moved ${condBytes} bytes vs full ${fullBytes}; it must be an order of magnitude smaller`,
  );
  await pool.end();
});

test('the owner-scoped conditional read respects the tenant/owner boundary', {
  skip: !databaseUrl,
}, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    const snapshot = await seedItems(tasks, 'cond-owner', 5, 'alice');
    // Wrong owner sees NOT_FOUND, exactly as the full owner-scoped read would.
    await assert.rejects(
      tasks.getTaskForOwnerIfNewerThan('cond-owner', 0, 'mallory'),
      (error) => error.code === 'RHINOQ_TASK_NOT_FOUND',
    );
    // Right owner, behind → snapshot.
    const ok = await tasks.getTaskForOwnerIfNewerThan('cond-owner', snapshot.entityVersion - 1, 'alice');
    assert.ok(ok);
    assert.equal(ok.id, 'cond-owner');
  } finally {
    await pool.end();
  }
});

test('a negative sinceVersion is refused', { skip: !databaseUrl }, async () => {
  const { pool, tasks } = await freshProfile();
  try {
    await seedItems(tasks, 'cond-bad', 1);
    await assert.rejects(tasks.getTaskIfNewerThan('cond-bad', -1), RangeError);
  } finally {
    await pool.end();
  }
});
