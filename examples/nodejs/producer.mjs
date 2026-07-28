import pg from 'pg';
import { PostgresProducer } from '@rhinoq/node';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});
const producer = new PostgresProducer({
  query: (text, values) => pool.query(text, values),
});
const reportId = process.argv[2] ?? `report_${Date.now()}`;

try {
  const jobId = await producer.enqueue({
    name: 'generate-report',
    payload: { reportId },
    idempotencyKey: `report:${reportId}`,
    correlationId: reportId,
  });
  console.log(`enqueued ${jobId} for ${reportId}`);
} finally {
  await pool.end();
}
