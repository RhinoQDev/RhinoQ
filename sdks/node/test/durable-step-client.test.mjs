import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresTaskClient, TASK_RLS_TABLES, TASK_SCHEMA_VERSION } from '../dist/index.js';

const step = (overrides = {}) => ({
  id: 'step-123', task_id: 'task-1', execution_id: 'execution-1', item_key: 'default', step_key: 'render',
  task_version: 2, step_version: 3, state: 'running', result: null, result_ref: null,
  failure_reason: null, attempt: 1, version: 1,
  created_at: '2026-08-23T00:00:00.000Z', updated_at: '2026-08-23T00:00:00.000Z', completed_at: null,
  ...overrides,
});

test('PostgreSQL durable Step client uses fenced SQL commands and preserves inline JSON results', async () => {
  const calls = [];
  const client = new PostgresTaskClient({
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes('acquire_durable_step')) {
        return { rows: [{ ...step(), action: 'acquired', attempt_id: 'step-123:attempt:1', lease_owner: 'worker-a', lease_epoch: 1, lease_until: '2026-08-23T00:01:00.000Z' }] };
      }
      if (text.includes('renew_durable_step')) {
        return { rows: [{ attempt_id: 'step-123:attempt:1', lease_owner: 'worker-a', lease_epoch: 1, lease_until: '2026-08-23T00:02:00.000Z' }] };
      }
      if (text.includes('complete_durable_step')) {
        return { rows: [step({ state: 'completed', result: { value: { html: '<h1>ok</h1>' } }, result_ref: 'artifact:artifact-1', completed_at: '2026-08-23T00:00:03.000Z' })] };
      }
      return { rows: [] };
    },
  });

  const acquired = await client.acquireDurableStep({
    taskId: 'task-1', executionId: 'execution-1', itemKey: 'default', taskVersion: 2,
    stepKey: 'render', stepVersion: 3, owner: 'worker-a', leaseMs: 60_000, maxAttempts: 2,
  });
  assert.equal(acquired.action, 'acquired');
  assert.equal(acquired.lease.owner, 'worker-a');
  const renewed = await client.renewDurableStep(acquired.lease, 60_000);
  assert.equal(renewed.expiresAt, '2026-08-23T00:02:00.000Z');
  assert.ok(calls.some((call) => call.text.includes('renew_durable_step') && call.values[3] === 1));
  const completed = await client.completeDurableStep(acquired.lease, { html: '<h1>ok</h1>' }, 'artifact:artifact-1');
  assert.deepEqual(completed.result, { html: '<h1>ok</h1>' });
  assert.equal(completed.resultRef, 'artifact:artifact-1');
  assert.ok(calls.some((call) => call.text.includes('acquire_durable_step')));
  assert.ok(calls.some((call) => call.text.includes('complete_durable_step') && call.values[4] === '{"value":{"html":"<h1>ok</h1>"}}'));
});

test('durable Step migration is current and tenant-fenced', () => {
  assert.equal(TASK_SCHEMA_VERSION, 21);
  assert.ok(TASK_RLS_TABLES.includes('durable_steps'));
  assert.ok(TASK_RLS_TABLES.includes('durable_step_attempts'));
});
