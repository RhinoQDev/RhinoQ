import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { repairSecret } from '../../../lib/config';
import { db, ensureDemoSchema } from '../../../lib/db';

export async function POST(request: Request) {
  const raw = Buffer.from(await request.arrayBuffer());
  const actual = request.headers.get('x-rhinoq-repair-signature') ?? '';
  const expected = `v1=${createHmac('sha256', repairSecret).update(raw).digest('hex')}`;
  const valid = actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  if (!valid) return NextResponse.json({ error: 'invalid RhinoQ repair signature' }, { status: 401 });
  await ensureDemoSchema();
  const body = JSON.parse(raw.toString('utf8')) as { action: string; finding: { subjectId: string }; idempotencyKey?: string };
  const order = (await db.query('SELECT * FROM demo_orders WHERE id=$1', [body.finding.subjectId])).rows[0];
  if (!order) return NextResponse.json({ error: 'order not found' }, { status: 404 });
  if (body.action === 'preview') return NextResponse.json({ summary: `Mark ${order.id} refunded after confirmed Stripe evidence`, precondition: `order:${order.id}:v${order.version}:refunded=${Boolean(order.refunded_at)}` });
  if (body.action === 'apply') {
    if (!body.idempotencyKey) return NextResponse.json({ error: 'idempotency key required' }, { status: 400 });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const prior = await client.query<{ outcome: string }>('SELECT outcome FROM demo_repair_applications WHERE idempotency_key=$1', [body.idempotencyKey]);
      if (prior.rows[0]) { await client.query('COMMIT'); return NextResponse.json({ outcome: prior.rows[0].outcome }); }
      const updated = await client.query('UPDATE demo_orders SET state=$2,refunded_at=now(),version=version+1 WHERE id=$1 AND refunded_at IS NULL RETURNING id', [order.id, 'refunded']);
      if (!updated.rows[0]) throw new Error('order precondition changed');
      const outcome = `order ${order.id} marked refunded exactly once`;
      await client.query('INSERT INTO demo_repair_applications(idempotency_key,outcome) VALUES($1,$2)', [body.idempotencyKey, outcome]);
      await client.query('COMMIT');
      return NextResponse.json({ outcome });
    } catch (cause) { await client.query('ROLLBACK'); throw cause; }
    finally { client.release(); }
  }
  if (body.action === 'verify') return NextResponse.json({ passed: Boolean(order.refunded_at), evidence: order.refunded_at ? `order ${order.id} has refunded_at` : `order ${order.id} is still missing refunded_at` });
  return NextResponse.json({ error: 'unsupported action' }, { status: 400 });
}
