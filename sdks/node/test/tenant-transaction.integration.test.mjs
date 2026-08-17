import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import {
  PostgresTaskClient,
  assertTenantId,
  migrateTaskSchema,
} from '../dist/index.js';

// Binding the tenant to the connection string makes the tenant a property of
// the connection, so a process serving N tenants needs N pools. PostgreSQL's
// default max_connections is 100 and it is shared with every other client of
// the server, so that ceiling arrives sooner than the tenant count suggests.
//
// `set_config(..., true)` is SET LOCAL: it lives for one transaction and is
// gone when the connection returns to the pool. One pool serves everyone, and
// isolation stays PostgreSQL's rather than the caller's.
//
// RHINOQ_TEST_APP_DATABASE_URL must point at a NOSUPERUSER NOBYPASSRLS role;
// a superuser is exempt from every policy and would pass these tests while
// proving nothing.
const databaseUrl = process.env.RHINOQ_TEST_DATABASE_URL;
const appUrl = process.env.RHINOQ_TEST_APP_DATABASE_URL;

async function migrated() {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', '-c rhinoq.tenant_id=default');
  const owner = new pg.Pool({ connectionString: url.toString(), max: 2 });
  await owner.query('DROP SCHEMA IF EXISTS rhinoq_task CASCADE');
  await migrateTaskSchema(owner);
  await owner.query('GRANT USAGE ON SCHEMA rhinoq_task TO rhinoq_app');
  await owner.query('GRANT ALL ON ALL TABLES IN SCHEMA rhinoq_task TO rhinoq_app');
  await owner.query('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA rhinoq_task TO rhinoq_app');
  await owner.end();
}

test('one pool serves several tenants and each sees only its own Tasks', {
  skip: !databaseUrl || !appUrl,
}, async () => {
  await migrated();
  // No tenant in the connection string: the pool is deliberately tenant-less.
  const pool = new pg.Pool({ connectionString: appUrl, max: 4 });
  const tasks = new PostgresTaskClient(pool);
  try {
    for (const tenantId of ['acme', 'globex']) {
      await tasks.withTenant(tenantId, async (scoped) => {
        await scoped.createTask({
          id: `task-${tenantId}`, type: 'export', tenantId,
          ownerId: 'owner', definitionVersion: 1,
        });
      });
    }

    for (const [tenantId, own, foreign] of [
      ['acme', 'task-acme', 'task-globex'],
      ['globex', 'task-globex', 'task-acme'],
    ]) {
      await tasks.withTenant(tenantId, async (scoped) => {
        const mine = await scoped.getTask(own);
        assert.equal(mine.id, own);
        await assert.rejects(
          scoped.getTask(foreign),
          (error) => error.code === 'RHINOQ_TASK_NOT_FOUND',
          `${tenantId} must not read ${foreign} through a shared pool`,
        );
      });
    }
  } finally {
    await pool.end();
  }
});

// The whole point of SET LOCAL: a connection handed back to the pool must not
// carry the previous caller's tenant.
test('a tenant binding does not survive into the next checkout', {
  skip: !databaseUrl || !appUrl,
}, async () => {
  await migrated();
  // max: 1 forces the second transaction onto the very connection the first
  // one used, which is the case that would leak.
  const pool = new pg.Pool({ connectionString: appUrl, max: 1 });
  const tasks = new PostgresTaskClient(pool);
  try {
    await tasks.withTenant('acme', async (scoped) => {
      await scoped.createTask({
        id: 'task-acme', type: 'export', tenantId: 'acme',
        ownerId: 'owner', definitionVersion: 1,
      });
    });

    const leaked = await pool.query(
      "SELECT current_setting('rhinoq.tenant_id', true) AS tenant",
    );
    assert.ok(
      !leaked.rows[0].tenant,
      `the pooled connection still announces tenant ${leaked.rows[0].tenant}`,
    );

    await tasks.withTenant('globex', async (scoped) => {
      await assert.rejects(
        scoped.getTask('task-acme'),
        (error) => error.code === 'RHINOQ_TASK_NOT_FOUND',
        'globex reused the connection acme had bound',
      );
    });
  } finally {
    await pool.end();
  }
});

test('a failing callback rolls the transaction back', {
  skip: !databaseUrl || !appUrl,
}, async () => {
  await migrated();
  const pool = new pg.Pool({ connectionString: appUrl, max: 2 });
  const tasks = new PostgresTaskClient(pool);
  try {
    await assert.rejects(
      tasks.withTenant('acme', async (scoped) => {
        await scoped.createTask({
          id: 'rolled-back', type: 'export', tenantId: 'acme',
          ownerId: 'owner', definitionVersion: 1,
        });
        throw new Error('business failure');
      }),
      /business failure/,
    );

    await tasks.withTenant('acme', async (scoped) => {
      await assert.rejects(
        scoped.getTask('rolled-back'),
        (error) => error.code === 'RHINOQ_TASK_NOT_FOUND',
        'the Task written before the callback threw must not have committed',
      );
    });
  } finally {
    await pool.end();
  }
});

test('a tenant id that could carry a second startup option is refused', () => {
  for (const value of [
    'acme -c search_path=public',
    'acme\tsomething',
    'acme\nglobex',
    '',
    '   ',
    'a'.repeat(65),
    null,
    undefined,
    42,
  ]) {
    assert.throws(
      () => assertTenantId(value),
      /RHINOQ_INVALID_TENANT_ID/,
      `${JSON.stringify(value)} must be refused`,
    );
  }
});

test('ordinary tenant identifiers are accepted', () => {
  for (const value of [
    'default',
    'acme',
    'eu:acme',
    'tenant_42',
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    ' padded ',
  ]) {
    assert.equal(assertTenantId(value), value.trim());
  }
});
