import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { GuardedRecovery, createManualRuntimeAdapter, createRhinoQApp, sendNotification } from '@rhinoq/node';
import { demoSession, loginSession } from './auth.mjs';
import { createReportRecovery, reportRecoveryRequest } from './recovery.mjs';
import { ReportStorage } from './storage.mjs';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to a disposable PostgreSQL database');
function withTenantSession(connectionString, tenantId = 'default') {
  const url = new URL(connectionString);
  const existing = url.searchParams.get('options');
  url.searchParams.set('options', [existing, `-c rhinoq.tenant_id=${tenantId}`].filter(Boolean).join(' '));
  return url.toString();
}
const pool = new Pool({ connectionString: withTenantSession(process.env.DATABASE_URL, 'tenant-demo') });
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
const recovery = createReportRecovery({ tasks: app.tasks, storage, GuardedRecovery });
const recoveryState = new Map();
const notificationState = new Map();
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

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || '/', 'http://example.invalid').pathname;
  const login = pathname.match(/^\/demo\/login\/(alice|bob)$/);
  if (login) {
    response.statusCode = 302;
    response.setHeader('set-cookie', `rhinoq_demo_session=${loginSession(login[1])}; HttpOnly; SameSite=Lax; Path=/`);
    response.setHeader('location', '/task-center');
    response.end();
    return;
  }
  const recoveryLogin = pathname.match(/^\/demo\/recovery\/login\/(support|approver)$/);
  if (recoveryLogin) {
    response.statusCode = 302;
    response.setHeader('set-cookie', `rhinoq_recovery_actor=${recoveryLogin[1]}; HttpOnly; SameSite=Strict; Path=/demo/recovery`);
    response.setHeader('location', `/demo/recovery/${missing.id}`);
    response.end();
    return;
  }
  const recoveryRoute = pathname.match(/^\/demo\/recovery\/([^/]+)(?:\/(preview|approve))?$/);
  if (recoveryRoute) {
    try {
      const taskId = decodeURIComponent(recoveryRoute[1]);
      if (taskId !== missing.id) { response.statusCode = 404; response.end('Recovery fixture not found'); return; }
      const actor = cookieValue(request, 'rhinoq_recovery_actor');
      if (!actor) { response.statusCode = 401; response.end('Choose the support or approver session printed by the server.'); return; }
      const action = recoveryRoute[2];
      if (request.method === 'POST' && action === 'preview') {
        if (actor !== 'support') { response.statusCode = 403; response.end('Only support-agent may request the preview.'); return; }
        const result = await recovery.execute(reportRecoveryRequest(taskId));
        recoveryState.set(taskId, { previewed: true, result });
        redirectRecovery(response, taskId);
        return;
      }
      if (request.method === 'POST' && action === 'approve') {
        if (actor !== 'approver') { response.statusCode = 403; response.end('A different approver must approve execution.'); return; }
        if (!recoveryState.get(taskId)?.previewed) { response.statusCode = 409; response.end('Support must preview the recovery first.'); return; }
        const result = await recovery.execute(reportRecoveryRequest(taskId, {
          confirm: true, approvedBy: 'ops-approver', approvalReason: 'approved after browser preview',
        }));
        recoveryState.set(taskId, { previewed: true, result });
        redirectRecovery(response, taskId);
        return;
      }
      if (request.method !== 'GET') { response.statusCode = 405; response.end('Method Not Allowed'); return; }
      const current = recoveryState.get(taskId);
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      response.end(recoveryPage(taskId, actor, current));
    } catch (error) {
      response.statusCode = 409;
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end(error instanceof Error ? error.message : 'Recovery failed');
    }
    return;
  }
  const notificationRoute = pathname.match(/^\/demo\/notifications(?:\/(204|429|503|403|timeout))?$/);
  if (notificationRoute) {
    const scenario = notificationRoute[1];
    if (request.method === 'POST' && scenario) {
      const result = await runNotificationFixture(scenario);
      notificationState.set(scenario, result);
      response.statusCode = 303;
      response.setHeader('location', '/demo/notifications');
      response.end();
      return;
    }
    if (request.method !== 'GET') { response.statusCode = 405; response.end('Method Not Allowed'); return; }
    response.statusCode = 200;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.end(notificationFixturePage(notificationState));
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
console.log(`Workbench sign in: http://127.0.0.1:${port}/operator-login`);
console.log(`Recovery preview (support): http://127.0.0.1:${port}/demo/recovery/login/support`);
console.log(`Recovery approval (separate profile): http://127.0.0.1:${port}/demo/recovery/login/approver`);
console.log(`Notification failure fixture: http://127.0.0.1:${port}/demo/notifications`);
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

function cookieValue(request, name) {
  return String(request.headers.cookie || '').split(';').map((part) => part.trim().split('='))
    .find(([key]) => key === name)?.[1];
}

function redirectRecovery(response, taskId) {
  response.statusCode = 303;
  response.setHeader('location', `/demo/recovery/${encodeURIComponent(taskId)}`);
  response.end();
}

function recoveryPage(taskId, actor, current) {
  const result = current?.result ? escapeHTML(JSON.stringify(current.result, null, 2)) : 'No recovery step recorded yet.';
  const action = actor === 'support'
    ? `<form method="post" action="/demo/recovery/${encodeURIComponent(taskId)}/preview"><button>Preview recovery</button></form>`
    : `<form method="post" action="/demo/recovery/${encodeURIComponent(taskId)}/approve"><button>Approve and execute</button></form><p>Submit again to rehearse lost-response replay; the provider write must not repeat.</p>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>RhinoQ guarded recovery</title><style>body{font:16px/1.5 system-ui;max-width:48rem;margin:3rem auto;padding:1rem}button{font:inherit;padding:.7rem 1rem}pre{white-space:pre-wrap;background:#f3f4f6;padding:1rem}</style><h1>Guarded recovery</h1><p>Task <code>${escapeHTML(taskId)}</code> · signed in as <strong>${escapeHTML(actor)}</strong>.</p>${action}<h2>Latest durable result</h2><pre>${result}</pre></html>`;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

async function runNotificationFixture(scenario) {
  let attempts = 0;
  const eventId = `notification-fixture-${scenario}`;
  const statuses = scenario === '429' ? [429, 204] : scenario === '503' ? [503, 204] : scenario === '403' ? [403] : [204];
  try {
    await sendNotification(
      { name: `fixture-${scenario}`, kind: 'webhook', url: 'https://notification-fixture.invalid/hook', secret: '', timeoutMs: 250, includeEvidence: false, gracePeriodMs: 0, findingBaseUrl: '' },
      { id: eventId, type: 'rhinoq.notification.fixture', ruleId: 'fixture', subjectType: 'task', subjectId: 'fixture', invariantVersion: 1, status: 'open', severity: 'info', escalation: false, occurrenceCount: 1, observedAt: new Date().toISOString() },
      { maxAttempts: scenario === '403' ? 3 : 2, backoffMs: 0, fetch: async () => {
        attempts += 1;
        if (scenario === 'timeout') throw new Error('simulated receiver timeout');
        return new Response(null, { status: statuses[Math.min(attempts - 1, statuses.length - 1)] });
      } },
    );
    return { scenario, eventId, attempts, outcome: 'sent', evidence: 'same event ID reused for every bounded attempt' };
  } catch (error) {
    return { scenario, eventId, attempts, outcome: 'failed', error: error instanceof Error ? error.message : String(error), evidence: 'failure remains visible; no success receipt was invented' };
  }
}

function notificationFixturePage(state) {
  const rows = ['204', '429', '503', '403', 'timeout'].map((scenario) => {
    const result = state.get(scenario);
    return `<tr><td>${scenario}</td><td><form method="post" action="/demo/notifications/${scenario}"><button>Run</button></form></td><td><pre>${result ? escapeHTML(JSON.stringify(result, null, 2)) : 'NOT VERIFIED'}</pre></td></tr>`;
  }).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>RhinoQ notification fixture</title><style>body{font:16px/1.5 system-ui;max-width:64rem;margin:3rem auto;padding:1rem}table{width:100%;border-collapse:collapse}th,td{padding:.6rem;border:1px solid #ccc;vertical-align:top}button{font:inherit;padding:.5rem 1rem}pre{white-space:pre-wrap;margin:0}</style><h1>Notification delivery fixture</h1><p>This deterministic transport fixture exercises retry classification and event-ID reuse. It does not contact an external provider and is not production delivery evidence.</p><table><thead><tr><th>Receiver outcome</th><th>Action</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></html>`;
}
