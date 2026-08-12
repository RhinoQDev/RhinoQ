import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createManualRuntimeAdapter, createRhinoQApp } from '@rhinoq/node';
import { demoSession, loginSession } from './auth.mjs';
import { ReportStorage } from './storage.mjs';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to a disposable PostgreSQL database');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const storage = new ReportStorage(process.env.REPORT_STORAGE_DIR || resolve('.data'));
const adapter = createManualRuntimeAdapter('manual', 'report-export');
const app = await createRhinoQApp({
  pool, adapters: [adapter],
  ownerFromNodeRequest: (request) => demoSession(request)?.ownerId,
  tenantFromNodeRequest: (request) => demoSession(request)?.tenantId,
});

const suffix = randomUUID();
const success = await createSuccessfulReport('owner-alice', suffix);
const missing = await createMissingReport('owner-bob', suffix);
const operatorToken = process.env.RHINOQ_OPERATOR_TOKEN || 'replace-this-demo-operator-token';
const middleware = app.http({
  operatorToken,
  resolveResult: async (result) => {
    const key = reportKey(result.reference);
    const body = await storage.read(key);
    return new Response(body, { headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${key}"`,
      'cache-control': 'private, no-store',
    } });
  },
});

const server = createServer((request, response) => {
  const pathname = new URL(request.url || '/', 'http://example.invalid').pathname;
  const login = pathname.match(/^\/demo\/login\/(alice|bob)$/);
  if (login) {
    response.statusCode = 302;
    response.setHeader('set-cookie', `rhinoq_demo_session=${loginSession(login[1])}; HttpOnly; SameSite=Lax; Path=/`);
    response.setHeader('location', '/task-center');
    response.end();
    return;
  }
  if (request.method === 'POST' && /^\/tasks\/[^/]+\/cancel$/.test(pathname)) {
    const session = demoSession(request);
    response.statusCode = session ? 409 : 401;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(session ? {
      code: 'RHINOQ_UNSUPPORTED', retryable: false,
      message: 'The manual report runtime does not support cancellation; no Task state was changed.',
    } : { code: 'RHINOQ_UNAUTHORIZED' }));
    return;
  }
  middleware(request, response, () => { response.statusCode = 404; response.end('Not found'); });
});

const port = Number(process.env.PORT || 8787);
await new Promise((ready) => server.listen(port, '127.0.0.1', ready));
console.log(`Alice success: http://127.0.0.1:${port}/demo/login/alice  (${success.id})`);
console.log(`Bob missing output: http://127.0.0.1:${port}/demo/login/bob  (${missing.id})`);
console.log(`Workbench: http://127.0.0.1:${port}/admin`);
console.log('The demo sessions are intentionally local-only; replace them with application authentication.');

await new Promise((resolveShutdown) => process.once('SIGINT', resolveShutdown));
await new Promise((closed) => server.close(closed));
await app.close();
await pool.end();

async function createSuccessfulReport(ownerId, id) {
  const taskId = `report-success-${id}`;
  const executionId = `${taskId}:attempt-1`;
  const ref = { runtime: 'manual', scope: 'report-export', externalId: executionId };
  const key = `${taskId}.json`;
  await app.runtime.track({ task: { id: taskId, type: 'report.export', tenantId: 'tenant-demo', ownerId, definitionVersion: 1 }, executionId, ref });
  await adapter.emit({ type: 'started', ref, occurredAt: new Date().toISOString() });
  await adapter.emit({ type: 'progressed', ref, occurredAt: new Date().toISOString(), progress: { completed: 1, total: 1, message: 'Report rendered' } });
  const written = await storage.put(key, { reportId: taskId, rows: 3, generatedAt: new Date().toISOString() });
  const observed = await storage.inspect(key);
  if (observed.status !== 'present' || observed.sha256 !== written.sha256) throw new Error('report readback did not confirm the written output');
  await adapter.emit({ type: 'succeeded', ref, occurredAt: new Date().toISOString(), resultRef: `report://${key}` });
  await app.tasks.recordTaskVerification(taskId, { id: `${taskId}:output`, verifier: 'report-output-exists', status: 'verified', summary: 'Report output exists and checksum matches.', evidence: { size: observed.size, sha256: observed.sha256 } });
  return app.tasks.getTask(taskId);
}

async function createMissingReport(ownerId, id) {
  const taskId = `report-missing-${id}`;
  const executionId = `${taskId}:attempt-1`;
  const ref = { runtime: 'manual', scope: 'report-export', externalId: executionId };
  await app.runtime.track({ task: { id: taskId, type: 'report.export', tenantId: 'tenant-demo', ownerId, definitionVersion: 1 }, executionId, ref });
  await adapter.emit({ type: 'started', ref, occurredAt: new Date().toISOString() });
  await adapter.emit({ type: 'progressed', ref, occurredAt: new Date().toISOString(), progress: { completed: 1, total: 1, message: 'Runtime returned successfully' } });
  let execution = await app.tasks.getTaskExecution(executionId);
  await app.tasks.transitionTaskExecution(executionId, execution.version, 'succeeded');
  let task = await app.tasks.getTask(taskId);
  task = await app.tasks.transitionTask(taskId, task.entityVersion, 'uncertain');
  await app.tasks.recordTaskVerification(taskId, { id: `${taskId}:output`, verifier: 'report-output-exists', status: 'mismatch', summary: 'Runtime succeeded, but the expected report output is missing.', evidence: { readback: 'missing' } });
  return task;
}

function reportKey(reference) {
  if (!reference.startsWith('report://')) throw new TypeError('unsupported result reference');
  return reference.slice('report://'.length);
}
