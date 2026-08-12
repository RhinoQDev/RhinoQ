import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import {
  createManualRuntimeAdapter,
  createRhinoQApp,
} from '@rhinoq/node';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to a disposable PostgreSQL database');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = createManualRuntimeAdapter('manual', 'reports');
const rhino = await createRhinoQApp({
  pool, adapters: [adapter], ownerFromNodeRequest: () => 'example',
});
const tasks = rhino.tasks;
const id = randomUUID();
const ref = { runtime: 'manual', scope: 'reports', externalId: `job-${id}` };
const occurredAt = new Date().toISOString();

const taskId = `task-${id}`;
try {
  await rhino.runtime.track({
    task: { id: taskId, type: 'report.export', ownerId: 'example', definitionVersion: 1 },
    executionId: `execution-${id}`,
    ref,
  });
  await adapter.emit({ type: 'started', ref, occurredAt });
  await adapter.emit({ type: 'progressed', ref, occurredAt, progress: { completed: 1, total: 1 } });
  await adapter.emit({ type: 'succeeded', ref, occurredAt, resultRef: `report://${id}` });
  console.log(await tasks.getTask(taskId));
  const middleware = rhino.http({ operatorToken: process.env.RHINOQ_OPERATOR_TOKEN || 'disposable-lab-token' });
  const server = createServer((request, response) => middleware(request, response, () => {
    response.statusCode = 404; response.end('Not found');
  }));
  await new Promise((resolve) => server.listen(Number(process.env.PORT || 8787), '127.0.0.1', resolve));
  console.log(`Task Center: http://127.0.0.1:${server.address().port}/task-center/${taskId}`);
  console.log(`Workbench API: curl -H "x-operator-token: ${process.env.RHINOQ_OPERATOR_TOKEN || 'disposable-lab-token'}" http://127.0.0.1:${server.address().port}/admin`);
  console.log('Press Ctrl+C to stop.');
  await new Promise((resolve) => process.once('SIGINT', resolve));
  await new Promise((resolve) => server.close(resolve));
} finally {
  await rhino.close();
  await pool.end();
}
