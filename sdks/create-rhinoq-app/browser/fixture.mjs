import { createServer } from 'node:http';
import { page } from '../template/ui.mjs';

const now = new Date(Date.now() - 120_000).toISOString();
const task = {
  schemaVersion: 1, entityVersion: 4, id: 'batch-demo', type: 'report.generate', ownerId: 'demo-user',
  state: 'running', cancellation: { status: 'none' }, progress: { completed: 7, total: 12 },
  itemCounts: { total: 12, pendingDispatch: 0, dispatched: 0, running: 5, succeeded: 6, failed: 1, stalled: 0, cancelled: 0, retries: 1 },
  executionCounts: { total: 13, pendingDispatch: 0, dispatched: 0, running: 5, succeeded: 6, failed: 1, stalled: 0, cancelled: 0 },
  hasResult: false, createdAt: now, updatedAt: now,
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1:4173');
  response.setHeader('cache-control', 'no-store');
  if (url.pathname === '/') return html(response, page());
  if (url.pathname === '/tasks') return json(response, { tasks: [task] });
  if (url.pathname === '/tasks/_waitpoints') return json(response, { waitpoints: [{ id: 'approval-1', taskId: task.id, key: 'approve-publication', kind: 'approval', state: 'waiting' }] });
  if (url.pathname === '/tasks/_risk') return json(response, { policy: { atRiskAfterMs: 60_000, stuckAfterMs: 300_000 }, tasks: [{ ...task, risk: 'at_risk', idleForMs: 120_000 }] });
  if (url.pathname === '/tasks/_verified') return json(response, { verifications: [{ id: 'verification-1', taskId: task.id, verifier: 'report-exists', status: 'verified', verifiedAt: now }] });
  if (url.pathname === `/tasks/${task.id}/summary`) return json(response, task);
  if (url.pathname === '/batches' && request.method === 'POST') return json(response, { taskId: task.id, items: 50 });
  response.statusCode = 404; json(response, { code: 'NOT_FOUND' });
});

server.listen(4173, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());

function json(response, body) {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}
function html(response, body) {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(body);
}
