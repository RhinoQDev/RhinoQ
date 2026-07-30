import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import {
  BullMQTaskBridge,
  PostgresProducer,
  installPostgresTaskProfile,
  migrateTaskSchema,
} from '../dist/index.js';

const databaseUrl = process.env.RHINOQ_TEST_DATABASE_URL;

test('PostgresProducer works with pg and joins the caller transaction', {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const queue = 'node-integration';
  try {
    await pool.query('DELETE FROM public.rhinoq_jobs WHERE job_name = $1', [queue]);
    await pool.query('DELETE FROM rhinoq.job_allowlist WHERE job_name = $1', [queue]);
    await pool.query(
      `INSERT INTO rhinoq.job_allowlist (job_name, queue_name, max_payload_bytes)
       VALUES ($1, $1, 262144)`,
      [queue],
    );

    const producer = new PostgresProducer({
      query: (text, values) => pool.query(text, values),
    });
    const committedId = await producer.enqueue({
      jobName: queue,
      payload: { reportId: 'report_01' },
      idempotencyKey: 'node:committed',
      correlationId: 'report_01',
    });
    const committed = await pool.query(
      `SELECT id, convert_from(payload, 'UTF8')::jsonb AS payload,
              correlation_id
       FROM public.rhinoq_jobs
       WHERE id = $1`,
      [committedId],
    );
    assert.deepEqual(committed.rows[0], {
      id: committedId,
      payload: { reportId: 'report_01' },
      correlation_id: 'report_01',
    });

    const connection = await pool.connect();
    let rolledBackId;
    try {
      await connection.query('BEGIN');
      const transactional = new PostgresProducer({
        query: (text, values) => connection.query(text, values),
      });
      rolledBackId = await transactional.enqueue({
        jobName: queue,
        payload: { reportId: 'report_rollback' },
        idempotencyKey: 'node:rolled-back',
      });
      await connection.query('ROLLBACK');
    } finally {
      connection.release();
    }
    const rolledBack = await pool.query(
      'SELECT count(*)::int AS count FROM public.rhinoq_jobs WHERE id = $1',
      [rolledBackId],
    );
    assert.equal(rolledBack.rows[0].count, 0);
  } finally {
    await pool.query('DELETE FROM public.rhinoq_jobs WHERE job_name = $1', [queue]);
    await pool.query('DELETE FROM rhinoq.job_allowlist WHERE job_name = $1', [queue]);
    await pool.end();
  }
});

test('Task-only profile uses three tables and serves the embedded Node client', {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const taskId = 'node-task-profile';
  try {
    await pool.query('DROP SCHEMA IF EXISTS rhinoq_task CASCADE');
    await migrateTaskSchema(pool);
    const tasks = await installPostgresTaskProfile(pool);

    const tables = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'rhinoq_task'
       ORDER BY table_name`,
    );
    assert.deepEqual(
      tables.rows.map((row) => row.table_name),
      ['executions', 'migrations', 'tasks'],
    );

    let task = await tasks.createTask({
      id: taskId,
      type: 'bulk-download',
      ownerId: 'owner-a',
      definitionVersion: 1,
    });
    task = await tasks.transitionTask(task.id, task.entityVersion, 'queued');
    task = await tasks.transitionTask(task.id, task.entityVersion, 'running');
    task = await tasks.reportTaskProgress(task.id, task.entityVersion, {
      completed: 1,
      total: 2,
    });
    const duplicate = await tasks.reportTaskProgress(task.id, 1, {
      completed: 1,
      total: 2,
    });
    assert.equal(duplicate.entityVersion, task.entityVersion);
    await assert.rejects(
      tasks.reportTaskProgress(task.id, task.entityVersion - 1, {
        completed: 2,
        total: 2,
      }),
      (error) => error.code === 'RHINOQ_VERSION_CONFLICT',
    );
    await assert.rejects(
      tasks.reportTaskProgress(task.id, task.entityVersion, {
        completed: 0,
        total: 2,
      }),
      (error) => error.code === 'RHINOQ_PROGRESS_REGRESSION',
    );

    task = await tasks.createTaskExecution(task.id, {
      id: 'node-task-item-a-attempt-1',
      itemKey: 'item-a',
      runtime: 'bullmq',
      runtimeScope: 'queue-a',
      externalId: 'job-1',
    });
    task = await tasks.createTaskExecution(task.id, {
      id: 'node-task-item-b-attempt-1',
      itemKey: 'item-b',
      runtime: 'bullmq',
      runtimeScope: 'queue-b',
      externalId: 'job-1',
    });
    task = await tasks.createTaskExecution(task.id, {
      id: 'node-task-item-a-attempt-2',
      itemKey: 'item-a',
      runtime: 'bullmq',
      runtimeScope: 'queue-a',
      externalId: 'job-2',
    });

    assert.deepEqual(
      task.executions.map((execution) => [
        execution.itemKey,
        execution.attempt,
        execution.runtimeScope,
      ]),
      [
        ['item-a', 1, 'queue-a'],
        ['item-a', 2, 'queue-a'],
        ['item-b', 1, 'queue-b'],
      ],
    );

    const first = await tasks.getTaskExecution('node-task-item-a-attempt-1');
    await tasks.bindTaskExecution(first.id, {
      runtime: 'bullmq',
      runtimeScope: 'queue-a',
      externalId: 'job-1',
    });
    const bound = await tasks.lookupTaskExecution('bullmq', 'job-1', 'queue-a');
    assert.equal(bound.itemKey, 'item-a');
    assert.equal(bound.attempt, 1);

    await assert.rejects(
      tasks.getTaskForOwner(taskId, 'owner-b'),
      (error) => error.code === 'RHINOQ_TASK_NOT_FOUND',
    );
    assert.equal((await tasks.getTaskForOwner(taskId, 'owner-a')).ownerId, 'owner-a');
    assert.deepEqual(
      (await tasks.listTasks('owner-a')).map((snapshot) => snapshot.id),
      [taskId],
    );
    assert.deepEqual(await tasks.listTasks('owner-b'), []);

    const events = { on() {}, off() {} };
    const added = [];
    const queue = {
      async add(name, data, options) {
        added.push({ name, data, options });
        return { id: options.jobId };
      },
    };
    const bridge = new BullMQTaskBridge({
      client: tasks,
      events,
      queue,
      runtimeScope: 'search-video',
      terminalProjection: 'single-execution',
    });
    await bridge.dispatch({
      task: {
        id: 'embedded-bridge-task',
        type: 'search-video',
        ownerId: 'owner-a',
        definitionVersion: 1,
      },
      executionId: 'embedded-bridge-execution',
      jobId: 'shared-job-id',
      job: {
        name: 'search-video',
        data: { keyword: 'rhino' },
        options: { attempts: 3 },
      },
    });
    assert.deepEqual(added, [{
      name: 'search-video',
      data: { keyword: 'rhino' },
      options: { attempts: 3, jobId: 'shared-job-id' },
    }]);
    await bridge.project('active', { jobId: 'shared-job-id' });
    await bridge.project('completed', { jobId: 'shared-job-id' });
    assert.equal((await tasks.getTask('embedded-bridge-task')).state, 'succeeded');

    const fanout = new BullMQTaskBridge({
      client: tasks,
      events,
      queue,
      runtimeScope: 'bulk-download',
      terminalProjection: 'execution-only',
      aggregate: {
        progress: 'terminal-items',
        terminal: 'at-least-one-succeeded',
      },
      isTerminalFailure: async () => true,
    });
    const fanoutTask = {
      id: 'embedded-fanout-task',
      type: 'bulk-download',
      ownerId: 'owner-a',
      definitionVersion: 1,
    };
    await fanout.dispatchMany([
      {
        task: fanoutTask,
        executionId: 'embedded-fanout-a',
        itemKey: 'video-a',
        jobId: 'fanout-a',
        job: { name: 'download', data: { id: 'video-a' } },
      },
      {
        task: fanoutTask,
        executionId: 'embedded-fanout-b',
        itemKey: 'video-b',
        jobId: 'fanout-b',
        job: { name: 'download', data: { id: 'video-b' } },
      },
    ]);
    await fanout.project('active', { jobId: 'fanout-a' });
    await fanout.project('active', { jobId: 'fanout-b' });
    await fanout.project('completed', { jobId: 'fanout-a' });
    await fanout.project('failed', {
      jobId: 'fanout-b',
      failedReason: 'provider rejected item',
    });
    const aggregated = await tasks.getTask(fanoutTask.id);
    assert.equal(aggregated.state, 'succeeded');
    assert.deepEqual(aggregated.progress, { completed: 2, total: 2 });

    let dispatchAttempts = 0;
    const recoverable = new BullMQTaskBridge({
      client: tasks,
      events,
      queue: {
        async add(name, data, options) {
          dispatchAttempts += 1;
          if (dispatchAttempts === 1) {
            throw new Error('simulated Redis outage');
          }
          return { id: options.jobId, name, data };
        },
      },
      runtimeScope: 'recoverable-queue',
      terminalProjection: 'single-execution',
    });
    const recoverableInput = {
      task: {
        id: 'recoverable-dispatch-task',
        type: 'export',
        ownerId: 'owner-a',
        definitionVersion: 1,
      },
      executionId: 'recoverable-dispatch-execution',
      jobId: 'recoverable-job',
      job: { name: 'export', data: { id: 1 } },
    };
    await assert.rejects(recoverable.dispatch(recoverableInput), /Redis outage/);
    assert.equal(
      (await tasks.getTaskExecution(recoverableInput.executionId)).state,
      'pending_dispatch',
    );
    const recovered = await recoverable.dispatch(recoverableInput);
    assert.equal(recovered.state, 'queued');
    assert.equal(
      (await tasks.getTaskExecution(recoverableInput.executionId)).state,
      'dispatched',
    );

    let cancellable = await tasks.createTask({
      id: 'too-late-task',
      type: 'paid-operation',
      ownerId: 'owner-a',
      definitionVersion: 1,
    });
    cancellable = await tasks.transitionTask(
      cancellable.id,
      cancellable.entityVersion,
      'queued',
    );
    cancellable = await tasks.transitionTask(
      cancellable.id,
      cancellable.entityVersion,
      'running',
    );
    cancellable = await tasks.requestTaskCancellation(
      cancellable.id,
      cancellable.entityVersion,
    );
    cancellable = await tasks.transitionTask(
      cancellable.id,
      cancellable.entityVersion,
      'succeeded',
    );
    assert.equal(cancellable.cancellation.status, 'too_late');
  } finally {
    await pool.query('DROP SCHEMA IF EXISTS rhinoq_task CASCADE');
    await pool.end();
  }
});
