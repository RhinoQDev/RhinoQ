import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import {
  PostgresTaskClient,
  TASK_CHANGE_CHANNEL,
  TaskChangeHub,
  installPostgresTaskProfile,
  migrateTaskSchema,
} from '../dist/index.js';

// Each SSE stream used to poll on its own timer, so database load scaled with
// the number of people watching rather than with the number of changes. These
// tests check the replacement actually announces, and — more importantly — that
// the announcement stays a hint: identity only, because NOTIFY is delivered
// outside row-level security.
const databaseUrl = process.env.RHINOQ_TEST_DATABASE_URL;

function connectionString(tenantId = 'default') {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c rhinoq.tenant_id=${tenantId}`);
  return url.toString();
}

async function freshProfile() {
  const pool = new pg.Pool({ connectionString: connectionString(), max: 4 });
  await pool.query('DROP SCHEMA IF EXISTS rhinoq_task CASCADE');
  await migrateTaskSchema(pool);
  return { pool, tasks: await installPostgresTaskProfile(pool) };
}

async function hubFor(onError) {
  const hub = new TaskChangeHub({
    async connect() {
      const client = new pg.Client({ connectionString: connectionString() });
      await client.connect();
      return client;
    },
    onError,
  });
  await hub.start();
  return hub;
}

function nextChange(hub, predicate = () => true, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('no notification arrived')); }, timeoutMs);
    const off = hub.subscribe((change) => {
      if (!predicate(change)) return;
      clearTimeout(timer);
      off();
      resolve(change);
    });
  });
}

test('creating a Task announces it', { skip: !databaseUrl }, async () => {
  const { pool, tasks } = await freshProfile();
  const hub = await hubFor();
  try {
    const arrived = nextChange(hub, (change) => change.taskId === 'notify-create');
    await tasks.createTask({
      id: 'notify-create', type: 'export', ownerId: 'owner', definitionVersion: 1,
    });
    const change = await arrived;
    assert.equal(change.taskId, 'notify-create');
    assert.equal(change.tenantId, 'default');
    assert.ok(Number.isFinite(change.version));
  } finally {
    await hub.stop();
    await pool.end();
  }
});

test('an item transition announces its parent Task', { skip: !databaseUrl }, async () => {
  const { pool, tasks } = await freshProfile();
  const hub = await hubFor();
  try {
    await tasks.createTask({ id: 'notify-item', type: 'export', ownerId: 'owner', definitionVersion: 1 });
    await tasks.createTaskExecution('notify-item', {
      id: 'notify-item--a', itemKey: 'a', runtime: 'bullmq',
      runtimeScope: 'x', externalId: 'notify-item__a',
    });
    const execution = await tasks.getTaskExecution('notify-item--a');

    const arrived = nextChange(hub, (change) => change.taskId === 'notify-item');
    await tasks.transitionTaskExecutionAck('notify-item--a', execution.version, 'running');
    const change = await arrived;
    assert.equal(change.taskId, 'notify-item');
  } finally {
    await hub.stop();
    await pool.end();
  }
});

// The security property. Anything in the payload is readable by every session
// listening on the channel, whatever tenant it belongs to.
test('the payload carries identity only', { skip: !databaseUrl }, async () => {
  const { pool, tasks } = await freshProfile();
  const listener = new pg.Client({ connectionString: connectionString() });
  await listener.connect();
  try {
    const payload = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no notification arrived')), 5_000);
      listener.on('notification', (message) => {
        if (message.channel !== TASK_CHANGE_CHANNEL) return;
        clearTimeout(timer);
        resolve(JSON.parse(message.payload));
      });
    });
    await listener.query(`LISTEN ${TASK_CHANGE_CHANNEL}`);
    await tasks.createTask({
      id: 'notify-shape', type: 'export', ownerId: 'secret-owner', definitionVersion: 1,
    });

    const body = await payload;
    assert.deepEqual(
      Object.keys(body).sort(), ['taskId', 'tenantId', 'version'],
      'a NOTIFY payload is not filtered by RLS; it must carry nothing but identity',
    );
    assert.equal(JSON.stringify(body).includes('secret-owner'), false);
  } finally {
    await listener.end();
    await pool.end();
  }
});

// A rolled-back change never happened, and a listener must not be told it did.
test('a rolled-back write announces nothing', { skip: !databaseUrl }, async () => {
  const { pool, tasks } = await freshProfile();
  const hub = await hubFor();
  try {
    const seen = [];
    hub.subscribe((change) => seen.push(change.taskId));

    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(
        `SELECT rhinoq_task.create_task($1,$2,$3,$4,$5)`,
        ['rolled-back', 'export', 'default', 'owner', 1],
      );
      await connection.query('ROLLBACK');
    } finally {
      connection.release();
    }

    // Commit something afterwards: once its notification arrives, any
    // notification for the rolled-back write would already have been delivered.
    const arrived = nextChange(hub, (change) => change.taskId === 'committed');
    await tasks.createTask({ id: 'committed', type: 'export', ownerId: 'owner', definitionVersion: 1 });
    await arrived;

    assert.equal(seen.includes('rolled-back'), false, 'a rolled-back write must not announce');
  } finally {
    await hub.stop();
    await pool.end();
  }
});

test('a fan-out announces per statement, not per item', { skip: !databaseUrl }, async () => {
  const { pool, tasks } = await freshProfile();
  const hub = await hubFor();
  try {
    await tasks.createTask({ id: 'fanout', type: 'export', ownerId: 'owner', definitionVersion: 1 });
    let announcements = 0;
    hub.subscribe((change) => { if (change.taskId === 'fanout') announcements += 1; });

    const items = 20;
    for (let index = 0; index < items; index++) {
      await tasks.createTaskExecutionAck('fanout', {
        id: `fanout--${index}`, itemKey: `item-${index}`, runtime: 'bullmq',
        runtimeScope: 'x', externalId: `fanout__${index}`,
      });
    }
    // Let the last notification land.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // One statement per item here, so one announcement each is correct. What
    // must not happen is several per item — the count triggers and the announce
    // triggers both fire, and a naive wiring announces twice.
    assert.ok(
      announcements <= items,
      `${announcements} announcements for ${items} items; the triggers are announcing more than once per statement`,
    );
    assert.ok(announcements > 0, 'a fan-out must announce at all');
  } finally {
    await hub.stop();
    await pool.end();
  }
});

test('the hub reports connection failures instead of throwing into the process', async () => {
  const errors = [];
  const hub = new TaskChangeHub({
    connect: async () => { throw new Error('database unreachable'); },
    onError: (error) => errors.push(error.message),
  });
  await assert.rejects(hub.start(), /database unreachable/);
  assert.equal(hub.connected, false, 'a hub that cannot listen must report itself disconnected');
  await hub.stop();
});
