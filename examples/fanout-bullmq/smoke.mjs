// Does a fan-out batch actually finish?
//
// This exists because "it worked when I ran it" was not evidence. The example
// settled on some runs and hung on others, and a defect that shows up two runs
// in three passes every manual review — including the author's, which is how it
// survived. Nothing here is subtle: start the real server, push real batches
// through it, and refuse to exit zero unless every item reached a terminal
// state and the settled signal fired exactly once per batch.
//
// It runs twice, because the two failure modes need opposite conditions:
//
//   instant    zero-length jobs, high concurrency. Every job finishes inside
//              the dispatch window, which is where projections were lost.
//   realistic  the example's normal timings, so a BullMQ retry actually has
//              room to happen and be recorded as a second attempt.
//
//   npm run smoke
//
// Environment:
//   RHINOQ_SMOKE_SIZES       instant-phase batch sizes    (default 50,50,100,200)
//   RHINOQ_SMOKE_SLOW_SIZES  realistic-phase batch sizes  (default 50)
//   RHINOQ_SMOKE_TIMEOUT     per-batch budget in ms       (default 120000)
//   RHINOQ_DATABASE_URL, REDIS_URL
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import process from 'node:process';

import pg from 'pg';

const DATABASE_URL = process.env.RHINOQ_DATABASE_URL
  ?? 'postgres://postgres:rhinoq@127.0.0.1:55433/fanout';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:56379';
const sizes = (name, fallback) => (process.env[name] ?? fallback)
  .split(',').map((value) => Number(value.trim())).filter((value) => value > 0);
const PHASES = [
  {
    name: 'instant',
    sizes: sizes('RHINOQ_SMOKE_SIZES', '50,50,100,200'),
    env: { RHINOQ_EXAMPLE_WORK_MS: '0', RHINOQ_EXAMPLE_CONCURRENCY: '16' },
  },
  {
    name: 'realistic',
    sizes: sizes('RHINOQ_SMOKE_SLOW_SIZES', '50'),
    env: {},
    // Only here do BullMQ's retries have room to run and be projected as a
    // second attempt, so only here can the two counts be required to differ.
    expectRetries: true,
  },
];
const TIMEOUT_MS = Number(process.env.RHINOQ_SMOKE_TIMEOUT ?? 120_000);
const PORT = Number(process.env.PORT ?? 3100);
const BASE = `http://127.0.0.1:${PORT}`;

let settledLines = [];
const failures = [];
const pool = new pg.Pool({ connectionString: DATABASE_URL });
let batches = 0;
let items = 0;

try {
  for (const phase of PHASES) {
    if (phase.sizes.length === 0) continue;
    process.stdout.write(`\n--- ${phase.name} ---\n`);
    const server = startServer(phase.env);
    try {
      await waitForServer(server);
      for (const [index, size] of phase.sizes.entries()) {
        batches += 1;
        items += size;
        await runBatch(phase, index + 1, size);
      }
    } finally {
      server.kill('SIGTERM');
      await Promise.race([once(server, 'exit'), sleep(5_000)]);
    }
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await pool.end().catch(() => undefined);
}

if (failures.length > 0) {
  process.stdout.write(`\nFAIL ${failures.length} check(s) failed:\n`);
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`\nPASS ${batches} batch(es), ${items} items, all settled exactly once.\n`);

function startServer(env) {
  settledLines = [];
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: import.meta.dirname,
    env: { ...process.env, PORT: String(PORT), RHINOQ_DATABASE_URL: DATABASE_URL, REDIS_URL, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [server.stdout, server.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      if (line.startsWith('[settled] ')) settledLines.push(line);
      process.stdout.write(`  server | ${line}\n`);
    });
  }
  return server;
}

async function waitForServer(server) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited with code ${server.exitCode}`);
    try {
      const response = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  throw new Error('server did not start within 60s');
}

async function runBatch(phase, run, size) {
  const label = `${phase.name} run ${run} (size ${size})`;
  const before = settledLines.length;
  const started = Date.now();
  const response = await fetch(`${BASE}/batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user': 'smoke' },
    body: JSON.stringify({ size }),
  });
  if (!response.ok) throw new Error(`${label}: POST /batches returned ${response.status}`);
  const { taskId } = await response.json();

  const summary = await waitForTerminal(taskId, label);
  const wall = ((Date.now() - started) / 1000).toFixed(1);

  const settled = settledLines.length - before;
  const open = summary.itemCounts.total - terminalItems(summary);
  process.stdout.write(
    `run ${run}  size ${String(size).padStart(4)}  state ${summary.state.padEnd(9)}` +
    `  items ${terminalItems(summary)}/${summary.itemCounts.total}` +
    `  attempts ${summary.executionCounts.total}` +
    `  retries ${summary.itemCounts.retries}` +
    `  settled ${settled}  ${wall}s\n`,
  );

  if (open > 0) {
    failures.push(`${label}: ${open} item(s) never reached a terminal state`);
    await reportStuck(taskId);
  }
  if (settled !== 1) {
    failures.push(`${label}: settled signal fired ${settled} time(s), expected exactly 1`);
  }
  if (summary.state !== 'succeeded' && summary.state !== 'failed') {
    failures.push(`${label}: Task ended at ${summary.state}, not a terminal state`);
  }
  if (summary.itemCounts.total !== size) {
    failures.push(`${label}: itemCounts.total is ${summary.itemCounts.total}, expected ${size} — ` +
      'items and attempts are being conflated again');
  }
  if (summary.progress.completed !== size || summary.progress.total !== size) {
    failures.push(`${label}: progress ended at ${summary.progress.completed}/${summary.progress.total}, ` +
      `expected ${size}/${size} — a progress write was lost`);
  }
  // The example fails one item in twelve and retries twice, so a batch of this
  // shape must record more attempts than items. Equal counts mean the retry
  // never became a second attempt and the per-attempt history is a fiction.
  if (phase.expectRetries && summary.itemCounts.retries === 0) {
    failures.push(`${label}: no retry was projected as a second attempt`);
  }
}

async function waitForTerminal(taskId, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  let summary;
  while (Date.now() < deadline) {
    summary = await readSummary(taskId);
    if (summary.state === 'succeeded' || summary.state === 'failed' || summary.state === 'cancelled') {
      return summary;
    }
    await sleep(200);
  }
  failures.push(`${label}: Task ${taskId} did not finish within ${TIMEOUT_MS}ms`);
  return summary ?? readSummary(taskId);
}

async function readSummary(taskId) {
  const response = await fetch(`${BASE}/tasks/${encodeURIComponent(taskId)}/summary`, {
    headers: { 'x-user': 'smoke' },
  });
  if (!response.ok) throw new Error(`GET /tasks/${taskId}/summary returned ${response.status}`);
  const summary = await response.json();
  if (!summary.itemCounts) {
    throw new Error('summary has no itemCounts; the Task schema is older than migration 007');
  }
  return summary;
}

function terminalItems(summary) {
  const counts = summary.itemCounts;
  return counts.succeeded + counts.failed + counts.cancelled;
}

/**
 * The whole point of the failure path: say which items are stuck and what the
 * runtime thinks of them, rather than printing a red X. This is the join that
 * used to have to be written by hand to diagnose a hung batch.
 */
async function reportStuck(taskId) {
  const stuck = await pool.query(
    `SELECT id, item_key, state, external_id, attempt
     FROM rhinoq_task.executions
     WHERE task_id = $1 AND superseded_at IS NULL
       AND state NOT IN ('succeeded', 'failed', 'cancelled')
     ORDER BY item_key LIMIT 20`,
    [taskId],
  );
  process.stdout.write(`  stuck items in ${taskId}:\n`);
  for (const row of stuck.rows) {
    process.stdout.write(`    ${row.item_key} attempt ${row.attempt}: rhinoq=${row.state} job=${row.external_id}\n`);
  }
  const indexes = stuck.rows
    .map((row) => Number(row.item_key.replace(/\D+/g, '')))
    .filter((value) => Number.isInteger(value));
  if (indexes.length > 0) {
    process.stdout.write(
      `  stuck item index range: ${Math.min(...indexes)}..${Math.max(...indexes)} ` +
        '(a range clustered at the start is the dispatch-window race)\n',
    );
  }
}
