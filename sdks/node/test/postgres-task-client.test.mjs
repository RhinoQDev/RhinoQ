import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresTaskClient } from '../dist/index.js';

test('Postgres Task creation defaults definitionVersion to 1', async () => {
  const calls = [];
  const client = new PostgresTaskClient({
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes('rhinoq_task.create_task')) return { rows: [] };
      return {
        rows: [{
          id: 'task-default-version',
          type: 'report.export',
          tenant_id: 'default',
          owner_id: null,
          definition_version: 1,
          state: 'pending',
          progress_completed: 0,
          progress_total: null,
          progress_message: null,
          result_ref: null,
          cancellation_status: 'none',
          cancellation_reason: null,
          version: 1,
          created_at: '2026-08-20T00:00:00.000Z',
          updated_at: '2026-08-20T00:00:00.000Z',
          executions: [],
        }],
      };
    },
  });

  const task = await client.createTask({ id: 'task-default-version', type: 'report.export' });

  assert.equal(task.id, 'task-default-version');
  assert.deepEqual(calls[0].values, ['task-default-version', 'report.export', 'default', null, 1]);
});

test('Postgres Task client explains a missing Task schema', async () => {
  const error = Object.assign(
    new Error('relation "rhinoq_task.tasks" does not exist'),
    { code: '42P01' },
  );
  const client = new PostgresTaskClient({
    async query() {
      throw error;
    },
  });

  await assert.rejects(
    () => client.getTask('task-missing-schema'),
    (caught) => {
      assert.equal(caught.code, 'RHINOQ_TASK_SCHEMA_MISSING');
      assert.equal(caught.retryable, false);
      assert.match(caught.message, /npx rhinoq-task/);
      assert.match(caught.nextAction, /npx rhinoq-task/);
      return true;
    },
  );
});

test('Postgres transitionTask shortcuts pending to running through queued', async () => {
  const calls = [];
  let state = 'pending';
  let version = 1;
  const client = new PostgresTaskClient({
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes('rhinoq_task.transition_task')) {
        state = values[2];
        version += 1;
        return { rows: [] };
      }
      return {
        rows: [{
          id: 'task-shortcut', type: 'report.export', tenant_id: 'default', owner_id: null,
          definition_version: 1, state, progress_completed: 0, progress_total: null,
          progress_message: null, result_ref: null, cancellation_status: 'none',
          cancellation_reason: null, version, created_at: '2026-08-20T00:00:00.000Z',
          updated_at: '2026-08-20T00:00:00.000Z', executions: [],
        }],
      };
    },
  });

  const result = await client.transitionTask('task-shortcut', 1, 'running');

  assert.equal(result.state, 'running');
  assert.deepEqual(calls.filter(({ text }) => text.includes('rhinoq_task.transition_task')).map(({ values }) => values), [
    ['task-shortcut', 1, 'queued'],
    ['task-shortcut', 2, 'running'],
  ]);
});

test('operator checkpoint evidence exposes handler version without widening the owner API', async () => {
  const client = new PostgresTaskClient({
    async query(text, values) {
      assert.match(text, /FROM rhinoq_task\.checkpoints WHERE task_id=\$1/);
      assert.deepEqual(values, ['task-checkpoint', 25]);
      return { rows: [{
        id: 'checkpoint-1', task_id: 'task-checkpoint', execution_id: 'execution-1', checkpoint_key: 'page',
        handler_version: 4, input_checksum: 'a'.repeat(64), state: { offset: 20 }, completed: false, version: 2,
        created_at: '2026-08-20T00:00:00.000Z', updated_at: '2026-08-20T00:01:00.000Z',
      }] };
    },
  });
  const checkpoints = await client.listTaskCheckpoints('task-checkpoint', 25);
  assert.equal(checkpoints[0].handlerVersion, 4);
  assert.equal(checkpoints[0].key, 'page');
  await assert.rejects(() => client.listTaskCheckpoints('task-checkpoint', 501), /limit must be 1\.\.500/);
});
