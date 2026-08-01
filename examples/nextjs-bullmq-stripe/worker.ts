import { Worker } from 'bullmq';
import { stripeProviderAdapter } from '@rhinoq/node';
import { appURL } from './lib/config';
import { db, ensureDemoSchema } from './lib/db';
import { connection } from './lib/queue';
import { findingKey, rhinoq } from './lib/rhinoq';

await ensureDemoSchema();
const worker = new Worker<{ orderId: string }>('refunds', async (job) => {
  const order = (await db.query('SELECT * FROM demo_orders WHERE id=$1', [job.data.orderId])).rows[0];
  const task = await rhinoq.getTaskSummary(order.id);
  if (task.state === 'queued') await rhinoq.transitionTask(order.id, task.entityVersion, 'running');
  let execution = await rhinoq.getTaskExecution(`${order.id}:bullmq:1`);
  await rhinoq.transitionTaskExecution(execution.id, execution.version, 'running');
  execution = await rhinoq.getTaskExecution(execution.id);
  let initialReadback = true;
  const stripe = stripeProviderAdapter({
    execute: async (idempotencyKey: string) => {
      const response = await fetch(`${appURL}/api/stripe/refunds`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify({ paymentIntentId: order.payment_intent_id }), signal: AbortSignal.timeout(100),
      });
      return await response.json() as { id: string; status: string };
    },
    retrieve: async (operation) => {
      const response = await fetch(`${appURL}/api/stripe/refunds?key=${encodeURIComponent(operation.idempotencyKey)}`);
      if (response.status === 404) return undefined;
      const refund = await response.json() as { id: string; status: string };
      if (initialReadback) { initialReadback = false; return { ...refund, status: 'pending' }; }
      return refund;
    },
  });
  const operation = await rhinoq.providerOperation({
    taskId: order.id, name: 'stripe.refund', idempotencyKey: `refund:${order.id}`,
    confirmation: 'readback', retryPolicy: 'when-not-happened', ...stripe,
  });
  await db.query('UPDATE demo_orders SET provider_operation_id=$2 WHERE id=$1', [order.id, operation.id]);
  execution = await rhinoq.getTaskExecution(execution.id);
  await rhinoq.transitionTaskExecution(execution.id, execution.version, 'succeeded');
  await rhinoq.observeFinding({ ...findingKey(order.id), evidence: JSON.stringify({ bullmq: 'completed', provider: operation.state, orderRefundedAt: null }), observedAt: new Date().toISOString() });
  return { technicalResult: 'completed', providerResult: operation.state };
}, { connection, concurrency: 4 });

worker.on('completed', (job) => console.log(`BullMQ completed ${job.id}; inspect RhinoQ real-world state.`));
worker.on('failed', (job, error) => console.error(`BullMQ failed ${job?.id}:`, error));
const close = async () => { await worker.close(); await db.end(); process.exit(0); };
process.once('SIGINT', close); process.once('SIGTERM', close);
