import pg from 'pg';
import { PostgresProducer } from '@rhinoq/node';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});
const producer = new PostgresProducer({
  query: (text, values) => pool.query(text, values),
});

try {
  const jobId = await producer.enqueue({
    name: 'generate-report',
    payload: { reportId: 'report_01' },
    idempotencyKey: 'report:report_01',
    correlationId: 'report_01',
  });
  console.log(`enqueued ${jobId}`);
} finally {
  await pool.end();
}
