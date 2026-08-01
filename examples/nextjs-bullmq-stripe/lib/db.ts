import { Pool } from 'pg';
import { databaseURL } from './config';

export const db = new Pool({ connectionString: databaseURL, max: 8 });

let installed: Promise<void> | undefined;
export function ensureDemoSchema(): Promise<void> {
  installed ??= db.query(`
    CREATE TABLE IF NOT EXISTS demo_orders (
      id text PRIMARY KEY,
      payment_intent_id text NOT NULL,
      state text NOT NULL DEFAULT 'refund_requested',
      refunded_at timestamptz,
      version bigint NOT NULL DEFAULT 1,
      provider_operation_id text,
      repair_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS demo_stripe_refunds (
      id text PRIMARY KEY,
      idempotency_key text NOT NULL UNIQUE,
      payment_intent_id text NOT NULL,
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS demo_repair_applications (
      idempotency_key text PRIMARY KEY,
      outcome text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `).then(() => undefined);
  return installed;
}
