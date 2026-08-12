import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import pg from 'pg';

import {
  BullMQTaskBridge,
  createManualRuntimeAdapter,
  createRhinoQApp,
  PostgresProjectorLease,
  PostgresProducer,
  installPostgresTaskProfile,
  migrateTaskSchema,
} from '../dist/index.js';

const databaseUrl = process.env.RHINOQ_TEST_DATABASE_URL;

test('runtime-neutral app composition projects a real PostgreSQL Task to terminal progress', {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const adapter = createManualRuntimeAdapter('manual', 'postgres-e2e');
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const taskId = `portable-app-${suffix}`;
  const ref = { runtime: 'manual', scope: 'postgres-e2e', externalId: `job-${suffix}` };
  const app = await createRhinoQApp({ pool, adapters: [adapter], ownerFromRequest: () => 'owner-e2e' });
  try {
    await app.runtime.track({
      task: { id: taskId, type: 'report.export', ownerId: 'owner-e2e', definitionVersion: 1 },
      executionId: `execution-${suffix}`, ref,
    });
    await adapter.emit({ type: 'succeeded', ref, occurredAt: new Date().toISOString(), resultRef: `report://${suffix}` });
    const task = await app.tasks.getTask(taskId);
    assert.equal(task.state, 'succeeded');
    assert.deepEqual(task.progress, { completed: 1, total: 1 });
    assert.equal(task.hasResult, true);
    assert.doesNotThrow(() => app.http({ operatorToken: 'e2e-token' }));
  } finally {
    await app.close();
    await pool.end();
  }
});

test('HTTP owner surfaces hide a real PostgreSQL Task across tenant and owner boundaries', {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const taskId = `http-tenant-${suffix}`;
  const app = await createRhinoQApp({
    pool, adapters: [],
    ownerFromRequest: (request) => request.headers.get('x-owner') ?? undefined,
    tenantFromRequest: (request) => request.headers.get('x-tenant') ?? undefined,
  });
  const middleware = app.http({ operatorToken: 'http-tenant-operator' });
  const server = createServer((request, response) => middleware(request, response));
  try {
    await app.tasks.createTask({ id: taskId, type: 'tenant.probe', tenantId: 'tenant-a', ownerId: 'owner-a', definitionVersion: 1 });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const own = await fetch(`${base}/tasks/${taskId}`, { headers: { 'x-owner': 'owner-a', 'x-tenant': 'tenant-a' } });
    assert.equal(own.status, 200);
    assert.equal((await own.json()).id, taskId);
    for (const headers of [
      { 'x-owner': 'owner-a', 'x-tenant': 'tenant-b' },
      { 'x-owner': 'owner-b', 'x-tenant': 'tenant-a' },
    ]) {
      const hidden = await fetch(`${base}/tasks/${taskId}`, { headers });
      assert.equal(hidden.status, 404);
      assert.equal((await hidden.text()).includes(taskId), true, 'structured error may echo only the requested opaque id');
    }
    assert.equal((await fetch(`${base}/admin`)).status, 403);
  } finally {
    if (server.listening) { server.close(); await once(server, 'close'); }
    await app.close();
    await pool.end();
  }
});

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

test('Task-only profile enforces tenant reads and stores verification and artifact records', {
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
      ['artifacts', 'executions', 'migrations', 'notification_outbox', 'tasks', 'verifications', 'waitpoints'],
    );

    let task = await tasks.createTask({
      id: taskId,
      type: 'bulk-download',
      ownerId: 'owner-a',
      definitionVersion: 1,
    });
    await tasks.createTask({ id: 'tenant-b-task', type: 'bulk-download', tenantId: 'tenant-b', ownerId: 'owner-a', definitionVersion: 1 });
    assert.deepEqual(await tasks.listTasks('owner-a', 50, 0, 'tenant-b').then((items) => items.map((item) => item.id)), ['tenant-b-task']);
    await assert.rejects(tasks.getTaskForOwner('tenant-b-task', 'owner-a'), (error) => error.code === 'RHINOQ_TASK_NOT_FOUND');
    assert.equal((await tasks.getTaskForOwner('tenant-b-task', 'owner-a', 'tenant-b')).id, 'tenant-b-task');
    const verified = await tasks.recordTaskVerification(task.id, {
      id: 'verification-pass-1', verifier: 'output-exists', status: 'verified', summary: 'output exists',
      evidence: { key: 'item-a' }, verifiedAt: '2026-08-10T08:00:00.000Z',
    });
    assert.equal(verified.status, 'verified');
    assert.equal((await tasks.listRecentlyVerifiedForOwner('owner-a'))[0].id, verified.id);
    assert.deepEqual(await tasks.listRecentlyVerifiedForOwner('owner-b'), []);
    const waiting = await tasks.createTaskWaitpoint(task.id, { id: 'node-wp-review', key: 'review', kind: 'approval', payloadVersion: 1 });
    assert.equal(waiting.state, 'waiting');
    assert.equal((await tasks.listTaskWaitpointsForOwner(task.id, 'owner-a'))[0].id, waiting.id);
    assert.deepEqual(await tasks.listTaskWaitpointsForOwner(task.id, 'owner-b'), []);
    assert.equal((await tasks.listWaitingTaskWaitpointsForOwner('owner-a'))[0].id, waiting.id);
    assert.deepEqual(await tasks.listWaitingTaskWaitpointsForOwner('owner-b'), []);
    const resolved = await tasks.resolveTaskWaitpoint(waiting.id, 'owner-a', { expectedVersion: waiting.entityVersion, resolutionId: 'submit-review-1', resolution: { approved: true } });
    assert.equal(resolved.state, 'resolved');
    const replayedResolution = await tasks.resolveTaskWaitpoint(waiting.id, 'owner-a', { expectedVersion: waiting.entityVersion, resolutionId: 'submit-review-1', resolution: { approved: true } });
    assert.equal(replayedResolution.entityVersion, resolved.entityVersion);
    task = await tasks.getTask(task.id);
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
    const artifact = await tasks.registerTaskArtifact(task.id, {
      id: 'artifact-a', executionId: 'node-task-item-a-attempt-1', name: 'report.csv', contentType: 'text/csv',
      sizeBytes: 12, checksumSha256: 'a'.repeat(64), reference: 'storage://private/report.csv',
      expiresAt: '2026-08-11T08:00:00.000Z', lineage: ['source-upload'],
    });
    assert.equal(artifact.checksumSha256, 'a'.repeat(64));
    assert.equal(JSON.stringify(artifact).includes('storage://private'), false);
    assert.equal((await tasks.listTaskArtifactsForOwner(task.id, 'owner-a'))[0].id, artifact.id);
    await assert.rejects(
      tasks.listTaskArtifactsForOwner(task.id, 'owner-b'),
      (error) => error.code === 'RHINOQ_TASK_NOT_FOUND',
    );
    const refreshed = await tasks.refreshTaskArtifact(artifact.id, {
      expectedVersion: artifact.entityVersion, reference: 'storage://private/report-v2.csv', expiresAt: '2026-08-12T08:00:00.000Z',
    });
    assert.equal(refreshed.entityVersion, artifact.entityVersion + 1);
    assert.equal((await tasks.getTaskArtifactRecord(artifact.id)).reference, 'storage://private/report-v2.csv');
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

    // Cancelling a fan-out needs every runtime job ID, and used to pay one
    // getTaskExecution per Execution to collect them. One query now answers it.
    const refs = await tasks.listTaskExecutionRuntimeRefs(taskId);
    assert.equal(refs.entityVersion, task.entityVersion);
    assert.deepEqual(
      refs.executions.map((ref) => [ref.itemKey, ref.attempt, ref.externalId]),
      [
        ['item-a', 1, 'job-1'],
        ['item-a', 2, 'job-2'],
        ['item-b', 1, 'job-1'],
      ],
    );

    // ...and it stays off the polled snapshot, which the owner-scoped routes
    // serve to a browser. A runtime job ID is infrastructure identity.
    for (const snapshot of [task, await tasks.getTaskForOwner(taskId, 'owner-a')]) {
      assert.ok(
        !JSON.stringify(snapshot).includes('job-1'),
        'the polled snapshot must not carry runtime job identity',
      );
    }
	const summary = await tasks.getTaskSummary(taskId);
	assert.equal(summary.entityVersion, task.entityVersion);
	assert.equal(summary.executions, undefined);
	const page1 = await tasks.listTaskExecutions(taskId, '', 2);
	const page2 = await tasks.listTaskExecutions(taskId, page1.nextCursor, 2);
	assert.equal(page1.executions.length, 2);
	assert.equal(page2.executions.length, 1);
	assert.equal(new Set([...page1.executions, ...page2.executions].map((item) => item.id)).size, 3);

    const first = await tasks.getTaskExecution('node-task-item-a-attempt-1');
    await tasks.bindTaskExecution(first.id, {
      runtime: 'bullmq',
      runtimeScope: 'queue-a',
      externalId: 'job-1',
    });
    const bound = await tasks.lookupTaskExecution('bullmq', 'job-1', 'queue-a');
    assert.equal(bound.itemKey, 'item-a');
    assert.equal(bound.attempt, 1);

    let effectRuns = 0;
    const firstEffect = await tasks.onceForItem(
      'node-task-item-a-attempt-1',
      'deduct-credits',
      async (transaction) => {
        effectRuns += 1;
        await transaction.query('SELECT 1', []);
        return 'applied';
      },
    );
    const retryEffect = await tasks.onceForItem(
      'node-task-item-a-attempt-2',
      'deduct-credits',
      async () => {
        effectRuns += 1;
        return 'must-not-run';
      },
    );
    assert.deepEqual(firstEffect, { executed: true, value: 'applied' });
    assert.deepEqual(retryEffect, { executed: false });
    assert.equal(effectRuns, 1);

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

test('PostgresProjectorLease stops trusting a terminated database session', {
  skip: !databaseUrl,
}, async () => {
  const scope = `postgres-lease-${process.pid}-${Date.now()}`;
  const applicationName = `rhinoq-lease-test-${process.pid}-${Date.now()}`;
  const leaseUrl = new URL(databaseUrl);
  leaseUrl.searchParams.set('application_name', applicationName);
  const heldPool = new pg.Pool({ connectionString: leaseUrl.toString(), max: 1 });
  const replacementPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  // PostgreSQL reports the administrator-terminated session asynchronously;
  // the lease's verify() call is the assertion point, not an uncaught pool
  // error event.
  heldPool.on('error', () => {});
  const lease = new PostgresProjectorLease(heldPool, scope);
  const replacement = new PostgresProjectorLease(replacementPool, scope);
  try {
    assert.equal(await lease.acquire(), true);
    const pidResult = await adminPool.query(
      `SELECT pid
       FROM pg_stat_activity
       WHERE application_name = $1 AND datname = current_database()
       ORDER BY backend_start DESC
       LIMIT 1`,
      [applicationName],
    );
    const pid = pidResult.rows[0]?.pid;
    assert.ok(pid, 'the held lease session must be visible to PostgreSQL');
    const terminated = await adminPool.query('SELECT pg_terminate_backend($1) AS terminated', [pid]);
    assert.equal(terminated.rows[0].terminated, true);

    assert.equal(await lease.verify(), false, 'a terminated session no longer owns the advisory lock');
    assert.equal(await replacement.acquire(), true, 'a replacement projector can take over the released lock');
  } finally {
    await lease.release().catch(() => undefined);
    await replacement.release().catch(() => undefined);
    await Promise.all([heldPool.end(), replacementPool.end(), adminPool.end()]);
  }
});
