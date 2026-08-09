import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';
import pg from 'pg';
import { createBullMQRetryDispatchHandler } from '../dist/bullmq/retry-dispatch.js';

const enabled = process.env.RHINOQ_REAL_RETRY_FAULT === '1';

test('real PostgreSQL outbox survives lost HTTP acknowledgement and converges on one BullMQ job', { skip: !enabled, timeout: 60_000 }, async () => {
  const databaseURL = process.env.RHINOQ_TEST_DATABASE_URL;
  const agentDatabaseURL = process.env.RHINOQ_AGENT_TEST_DATABASE_URL;
  const agentBinary = process.env.RHINOQ_AGENT_BINARY;
  if (!databaseURL || !agentDatabaseURL || !agentBinary) throw new Error('RHINOQ_TEST_DATABASE_URL, RHINOQ_AGENT_TEST_DATABASE_URL and RHINOQ_AGENT_BINARY are required');
  const secret = 'real-fault-secret';
  const { Queue } = await import('bullmq');
  const queueName = `rhinoq-retry-fault-${Date.now()}`;
  const queue = new Queue(queueName, { connection: { host: '127.0.0.1', port: 56379 } });
  const pool = new pg.Pool({ connectionString: databaseURL });
  const handler = createBullMQRetryDispatchHandler({ secret, queues: { [queueName]: queue } });
  let deliveries = 0;
  const server = http.createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const request = new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method, headers: incoming.headers, body });
    const response = await handler(request);
    deliveries++;
    if (deliveries === 1) { incoming.socket.destroy(); return; }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });

  try {
    await new Promise((resolve, reject) => server.listen(58080, '127.0.0.1', (error) => error ? reject(error) : resolve()));
    await queue.drain(true);
    await pool.query('TRUNCATE rhinoq_outbox RESTART IDENTITY');
    const intent = { schemaVersion: 1, commandId: 'retry-real-fault-1', taskId: 'task-real-fault', executionId: 'exec-real-fault-1', runtime: 'bullmq', queue: queueName, jobName: 'generate', data: { reportId: 'r-real' }, attempt: 2 };
    const inserted = await pool.query(`INSERT INTO rhinoq_outbox(aggregate_type,aggregate_id,event_type,payload) VALUES('task',$1,'task.retry.dispatch_requested',$2::jsonb) RETURNING id`, [intent.taskId, JSON.stringify(intent)]);
    const eventID = inserted.rows[0].id;

    const first = startAgent(agentBinary, agentDatabaseURL, secret, 58081);
    const firstExit = await waitForExit(first, 20_000);
    assert.notEqual(firstExit.code, 0, 'lost acknowledgement must leave the outbox unpublished and stop the unsupervised publisher');
    assert.ok(await queue.getJob(intent.executionId), `BullMQ accepted the job before the response was lost; agent=${firstExit.output}`);
    assert.equal((await pool.query('SELECT published_at IS NOT NULL AS done FROM rhinoq_outbox WHERE id=$1', [eventID])).rows[0].done, false);

    const second = startAgent(agentBinary, agentDatabaseURL, secret, 58082);
    await waitUntil(async () => (await pool.query('SELECT published_at IS NOT NULL AS done FROM rhinoq_outbox WHERE id=$1', [eventID])).rows[0].done, 20_000);
    second.kill();
    await waitForExit(second, 10_000);
    assert.equal(deliveries, 2);
    assert.equal((await queue.getJobs(['waiting', 'active', 'completed', 'failed', 'delayed'])).filter((job) => job.id === intent.executionId).length, 1);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await pool.end();
  }
});

function startAgent(binary, databaseURL, secret, port) {
  const child = spawn(binary, [], { windowsHide: true, env: { ...process.env, RHINOQ_DATABASE_URL: databaseURL, RHINOQ_AGENT_TOKEN: 'fault-agent-token-32-bytes-minimum-value', RHINOQ_AGENT_ADDRESS: `127.0.0.1:${port}`, RHINOQ_RETRY_DISPATCH_URL: 'http://127.0.0.1:58080/internal/rhinoq/retry-dispatch', RHINOQ_RETRY_DISPATCH_SECRET: secret, RHINOQ_RETRY_DISPATCH_INTERVAL: '100ms', RHINOQ_RETRY_DISPATCH_RECLAIM_AFTER: '100ms' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  child.stdout.on('data', (chunk) => { child.output += chunk; });
  child.stderr.on('data', (chunk) => { child.output += chunk; });
  return child;
}
function waitForExit(child, timeout) {
  return Promise.race([new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, output: child.output }))), new Promise((_, reject) => setTimeout(() => reject(new Error('process exit timeout')), timeout))]);
}
async function waitUntil(check, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error('condition timeout');
}
