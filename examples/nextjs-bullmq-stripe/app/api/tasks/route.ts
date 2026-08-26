import { NextResponse } from 'next/server';
import { db, ensureDemoSchema } from '../../../lib/db';
import { rhinoq } from '../../../lib/rhinoq';

/**
 * Application-owned endpoint for this disposable single-user demo. Production
 * apps must authenticate the owner and should expose createNodeTaskMiddleware
 * instead of Gateway credentials to the browser.
 */
export async function GET() {
  await ensureDemoSchema();
  const result = await db.query('SELECT id FROM demo_orders ORDER BY created_at DESC LIMIT 1');
  const taskId = result.rows[0]?.id as string | undefined;
  if (!taskId) return NextResponse.json({ tasks: [] });
  const summary = await rhinoq.getTaskSummary(taskId);
  return NextResponse.json({ tasks: [{ ...summary, executions: [] }] });
}
