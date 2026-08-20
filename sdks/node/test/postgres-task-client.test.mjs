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
