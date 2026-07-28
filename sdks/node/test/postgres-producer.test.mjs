import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENQUEUE_SQL,
  PostgresProducer,
} from '../dist/index.js';

test('PostgresProducer sends one parameterized enqueue statement', async () => {
  const calls = [];
  const producer = new PostgresProducer({
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [{ job_id: 'job_01' }] };
    },
  });

  const id = await producer.enqueue({
    jobName: 'generate-report',
    payload: { reportId: 'report_01' },
    idempotencyKey: 'report:report_01',
    correlationId: 'report_01',
    priority: 5,
    resourceClass: 'interactive',
    runAfterMs: 250,
    payloadSchema: 'report:v1',
  });

  assert.equal(id, 'job_01');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, ENQUEUE_SQL);
  assert.deepEqual(calls[0].values, [
    'generate-report',
    '{"reportId":"report_01"}',
    'report:report_01',
    'report_01',
    5,
    'interactive',
    250,
    'report:v1',
    null,
  ]);
});

test('PostgresProducer fails before SQL for invalid scheduling or payload', async () => {
  let calls = 0;
  const producer = new PostgresProducer({
    async query() {
      calls += 1;
      return { rows: [{ job_id: 'unexpected' }] };
    },
  });

  await assert.rejects(
    producer.enqueue({
      jobName: 'generate-report',
      payload: {},
      runAfterMs: -1,
    }),
    /runAfterMs/,
  );

  const circular = {};
  circular.self = circular;
  await assert.rejects(
    producer.enqueue({
      jobName: 'generate-report',
      payload: circular,
    }),
    /JSON serializable/,
  );
  assert.equal(calls, 0);
});
