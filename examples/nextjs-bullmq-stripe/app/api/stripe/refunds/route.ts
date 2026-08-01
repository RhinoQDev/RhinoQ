import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { db, ensureDemoSchema } from '../../../../lib/db';

export async function POST(request: Request) {
  await ensureDemoSchema();
  const key = request.headers.get('idempotency-key') ?? '';
  const { paymentIntentId } = await request.json() as { paymentIntentId?: string };
  if (!key || !paymentIntentId) return NextResponse.json({ error: 'idempotency key and paymentIntentId are required' }, { status: 400 });
  const id = `re_demo_${randomUUID().slice(0, 8)}`;
  const result = await db.query<{ id: string; status: string }>(`
    INSERT INTO demo_stripe_refunds(id,idempotency_key,payment_intent_id,status)
    VALUES($1,$2,$3,'succeeded')
    ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
    RETURNING id,status`, [id, key, paymentIntentId]);
  // Commit first, then delay the response. The worker aborts during this gap.
  await new Promise((resolve) => setTimeout(resolve, 600));
  return NextResponse.json(result.rows[0]);
}

export async function GET(request: Request) {
  await ensureDemoSchema();
  const key = new URL(request.url).searchParams.get('key');
  const result = await db.query<{ id: string; status: string }>('SELECT id,status FROM demo_stripe_refunds WHERE idempotency_key=$1', [key]);
  return result.rows[0] ? NextResponse.json(result.rows[0]) : NextResponse.json({ error: 'not found' }, { status: 404 });
}
