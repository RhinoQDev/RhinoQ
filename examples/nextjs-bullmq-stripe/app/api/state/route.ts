import { NextResponse } from 'next/server';
import { db, ensureDemoSchema } from '../../../lib/db';
import { getRefundQueue } from '../../../lib/queue';
import { findingKey, rhinoq } from '../../../lib/rhinoq';

export async function GET() {
  await ensureDemoSchema();
  const orderResult = await db.query('SELECT * FROM demo_orders ORDER BY created_at DESC LIMIT 1');
  const order = orderResult.rows[0];
  if (!order) return NextResponse.json({});
  const [task, findings, repairResult, job] = await Promise.all([
    rhinoq.getTaskSummary(order.id),
    rhinoq.findings({ subjectType: 'order', subjectId: order.id, includeSuppressed: true }),
    db.query('SELECT id,state,preview,precondition,outcome,proposed_by,approved_by,approval_reason FROM rhinoq_repairs WHERE id=$1', [order.repair_id]),
    getRefundQueue().getJob(order.id),
  ]);
  const provider = order.provider_operation_id ? await rhinoq.getProviderOperation(order.provider_operation_id) : undefined;
  const evidence = provider ? await rhinoq.listProviderOperationEvidence(provider.id) : [];
  return NextResponse.json({
    orderId: order.id,
    order: { state: order.state, refundedAt: order.refunded_at, version: Number(order.version) },
    job: job ? await job.getState() : 'missing',
    task,
    provider,
    providerEvidence: evidence,
    finding: findings.find((item) => item.ruleId === findingKey(order.id).ruleId),
    repair: repairResult.rows[0],
  });
}
