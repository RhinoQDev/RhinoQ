import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { appURL } from '../../../lib/config';
import { db, ensureDemoSchema } from '../../../lib/db';
import { getRefundQueue } from '../../../lib/queue';
import { findingKey, rhinoq } from '../../../lib/rhinoq';

export async function POST(request: Request) {
  try {
    await ensureDemoSchema();
    const body = await request.json() as { action?: string; orderId?: string };
    if (body.action === 'create') return NextResponse.json(await createFailure());
    if (!body.orderId) return NextResponse.json({ error: 'create a failure first' }, { status: 400 });
    const order = (await db.query('SELECT * FROM demo_orders WHERE id=$1', [body.orderId])).rows[0];
    if (!order) return NextResponse.json({ error: 'order not found' }, { status: 404 });
    if (body.action === 'recheck') {
      const operation = await rhinoq.getProviderOperation(order.provider_operation_id);
      const result = await rhinoq.recheckProviderOperation(operation, async (record) => {
        const response = await fetch(`${appURL}/api/stripe/refunds?key=${encodeURIComponent(record.idempotencyKey)}`);
        if (response.status === 404) return { decision: 'not_happened', reason: 'Stripe readback proved no refund exists' } as const;
        const refund = await response.json() as { id: string; status: string };
        return { decision: refund.status === 'succeeded' ? 'confirmed' : 'pending', evidence: `${refund.id}:${refund.status}` } as const;
      });
      return NextResponse.json(result);
    }
    if (body.action === 'propose') {
      const repair = await rhinoq.proposeRepair({ finding: findingKey(order.id), handler: 'order.mark-refunded', parameters: { orderId: order.id }, actor: 'operator@demo' });
      await db.query('UPDATE demo_orders SET repair_id=$2 WHERE id=$1', [order.id, repair.id]);
      return NextResponse.json(repair);
    }
    if (!order.repair_id) return NextResponse.json({ error: 'propose a repair first' }, { status: 400 });
    if (body.action === 'preview') return NextResponse.json(await rhinoq.previewRepair(order.repair_id));
    if (body.action === 'approve') return NextResponse.json(await rhinoq.approveRepair(order.repair_id, 'reviewer@demo', 'Stripe evidence confirms the refund; synchronize the order projection'));
    if (body.action === 'execute') {
      const repair = await rhinoq.executeRepair(order.repair_id);
      if (repair.state === 'succeeded') {
        const task = await rhinoq.getTaskSummary(order.id);
        if (task.state === 'uncertain') await rhinoq.transitionTask(order.id, task.entityVersion, 'succeeded');
      }
      return NextResponse.json(repair);
    }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : String(cause) }, { status: 500 });
  }
}

async function createFailure() {
  const id = `order_${randomUUID().slice(0, 8)}`;
  await db.query('INSERT INTO demo_orders(id,payment_intent_id) VALUES($1,$2)', [id, `pi_demo_${id}`]);
  let task = await rhinoq.createTask({ id, type: 'stripe.refund', ownerId: 'demo-user', definitionVersion: 1 });
  task = await rhinoq.transitionTask(id, task.entityVersion, 'queued');
  await rhinoq.createTaskExecution(id, { id: `${id}:bullmq:1`, runtime: 'bullmq' });
  let execution = await rhinoq.getTaskExecution(`${id}:bullmq:1`);
  await rhinoq.bindTaskExecution(execution.id, { runtime: 'bullmq', externalId: id });
  await getRefundQueue().add('refund-order', { orderId: id }, { jobId: id, attempts: 1, removeOnComplete: false });
  return { orderId: id, taskState: task.state };
}
