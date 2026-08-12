import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  createManualRuntimeAdapter,
  createRhinoQ,
  installPostgresTaskProfile,
} from '@rhinoq/node';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to a disposable PostgreSQL database');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const tasks = await installPostgresTaskProfile(pool);
const adapter = createManualRuntimeAdapter('manual', 'reports');
const rhino = createRhinoQ({ client: tasks, terminalProjection: 'single-execution', adapters: [adapter] });
const id = randomUUID();
const ref = { runtime: 'manual', scope: 'reports', externalId: `job-${id}` };
const occurredAt = new Date().toISOString();

try {
  await rhino.track({
    task: { id: `task-${id}`, type: 'report.export', ownerId: 'example', definitionVersion: 1 },
    executionId: `execution-${id}`,
    ref,
  });
  await rhino.start();
  await adapter.emit({ type: 'started', ref, occurredAt });
  await adapter.emit({ type: 'progressed', ref, occurredAt, progress: { completed: 1, total: 1 } });
  await adapter.emit({ type: 'succeeded', ref, occurredAt, resultRef: `report://${id}` });
  console.log(await tasks.getTask(`task-${id}`));
} finally {
  await rhino.close();
  await pool.end();
}
