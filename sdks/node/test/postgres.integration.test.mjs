import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import {
  PostgresProducer,
} from '../dist/index.js';

const databaseUrl = process.env.RHINOQ_TEST_DATABASE_URL;

test('PostgresProducer works with pg and joins the caller transaction', {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const queue = 'node-integration';
  try {
    await pool.query('DELETE FROM public.rhinoq_jobs WHERE name = $1', [queue]);
    await pool.query('DELETE FROM rhinoq.job_allowlist WHERE job_name = $1', [queue]);
    await pool.query(
      `INSERT INTO rhinoq.job_allowlist (job_name, max_payload_bytes)
       VALUES ($1, 262144)`,
      [queue],
    );

    const producer = new PostgresProducer({
      query: (text, values) => pool.query(text, values),
    });
    const committedId = await producer.enqueue({
      name: queue,
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
        name: queue,
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
    await pool.query('DELETE FROM public.rhinoq_jobs WHERE name = $1', [queue]);
    await pool.query('DELETE FROM rhinoq.job_allowlist WHERE job_name = $1', [queue]);
    await pool.end();
  }
});
