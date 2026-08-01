#!/usr/bin/env node
import { createServer } from 'node:http';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { installPostgresTaskProfile } from '../postgres/task-client.js';
import { TASK_SCHEMA_VERSION } from '../postgres/task-schema.js';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'help';
  const args = process.argv.slice(3);
  switch (command) {
    case 'init': await init(); break;
    case 'verify': await verify(args); break;
    case 'doctor': await doctor(); break;
    case 'fixture': await fixture(args); break;
    case 'dev': await dev(args); break;
    case 'help': case '--help': case '-h': help(); break;
    default: fail(`unknown command ${JSON.stringify(command)}`, 'Run: npx rhinoq help');
  }
}

main().catch((error: unknown) => {
  if (!(error instanceof Error && error.message === '__reported__')) {
    console.error(`FAIL ${safe(error)}\nNEXT ${nextAction(error)}`);
    process.exitCode = 1;
  }
});

function databaseURL(): string {
  return process.env.RHINOQ_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
}

async function init(): Promise<void> {
  const root = resolve('.rhinoq');
  await mkdir(resolve(root, 'rules'), { recursive: true });
  await writeNew(resolve(root, 'config.json'), JSON.stringify({
    schemaVersion: 1,
    databaseEnv: process.env.RHINOQ_DATABASE_URL ? 'RHINOQ_DATABASE_URL' : 'DATABASE_URL',
    taskProfileVersion: TASK_SCHEMA_VERSION,
  }, null, 2) + '\n');
  const url = databaseURL();
  if (url) {
    const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5_000 });
    try { await installPostgresTaskProfile(pool); }
    finally { await pool.end(); }
    console.log(`PASS PostgreSQL detected; RhinoQ Task schema v${TASK_SCHEMA_VERSION} is current.`);
  } else {
    await writeNew(resolve('.env.rhinoq.example'), 'DATABASE_URL=postgres://postgres:postgres@localhost:5432/app\nREDIS_URL=redis://localhost:6379\n');
    console.log('WARN no DATABASE_URL/RHINOQ_DATABASE_URL detected; schema was not applied.');
    console.log('NEXT set DATABASE_URL, then run: npx rhinoq init');
  }
  const detected = await detectPackages();
  console.log(`PASS created ${root}`);
  console.log(`INFO PostgreSQL client: ${detected.pg ? 'detected' : 'missing'}; BullMQ: ${detected.bullmq ? 'detected' : 'not detected (optional)'}.`);
  console.log('NEXT add a verification: npx rhinoq verify add completed-report-has-output');
}

async function verify(args: string[]): Promise<void> {
  if (args[0] !== 'add' || !args[1]) fail('verify requires `add <rule-name>`', 'Run: npx rhinoq verify add completed-report-has-output');
  const name = args[1]!.trim();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(name)) fail('rule name must be 2-63 lowercase letters, digits or dashes', 'Example: completed-report-has-output');
  const path = resolve('.rhinoq', 'rules', `${name}.sql`);
  await mkdir(resolve('.rhinoq', 'rules'), { recursive: true });
  await writeNew(path, `-- RhinoQ Rule: ${name}\n-- Return subject_id, violated and bounded JSON evidence.\n-- Replace completed_reports/output_url with your indexed business table/column.\nSELECT id::text AS subject_id,\n       output_url IS NULL AS violated,\n       jsonb_build_object('status', status, 'hasOutput', output_url IS NOT NULL) AS evidence\nFROM completed_reports\nWHERE id::text > $1\nORDER BY id\nLIMIT $2;\n`);
  console.log(`PASS generated ${path}`);
  console.log('NEXT edit the table/column names, then run: npx rhinoq doctor');
}

async function doctor(): Promise<void> {
  const url = databaseURL();
  if (!url) fail('DATABASE_URL/RHINOQ_DATABASE_URL is not set', 'Set it to PostgreSQL, then run: npx rhinoq doctor');
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    await pool.query('SELECT 1');
    const result = await pool.query<{ version: number }>('SELECT COALESCE(MAX(version),0)::int AS version FROM rhinoq_task.migrations');
    const installed = result.rows[0]?.version ?? 0;
    if (installed !== TASK_SCHEMA_VERSION) fail(`Task schema is v${installed}; SDK needs v${TASK_SCHEMA_VERSION}`, 'Run: npx rhinoq init');
    console.log('PASS PostgreSQL reachable.');
    console.log(`PASS Task schema v${installed} current.`);
  } finally { await pool.end(); }
  if (process.env.REDIS_URL) console.log('PASS REDIS_URL detected for BullMQ.');
  else console.log('INFO REDIS_URL is absent; this is fine unless the app uses BullMQ.');
  console.log('NEXT create the visible failure fixture: npx rhinoq fixture failure');
}

async function fixture(args: string[]): Promise<void> {
  if ((args[0] ?? 'failure') !== 'failure') fail('only the `failure` fixture exists', 'Run: npx rhinoq fixture failure');
  const url = databaseURL();
  if (!url) fail('DATABASE_URL/RHINOQ_DATABASE_URL is not set', 'Set it, then run: npx rhinoq fixture failure');
  const pool = new Pool({ connectionString: url });
  try {
    const tasks = await installPostgresTaskProfile(pool);
    const id = `demo_${Date.now()}`;
    let task = await tasks.createTask({ id, type: 'report.generate', ownerId: 'demo-user', definitionVersion: 1 });
    task = await tasks.transitionTask(id, task.entityVersion, 'queued');
    task = await tasks.transitionTask(id, task.entityVersion, 'running');
    await tasks.createTaskExecution(id, { id: `${id}:1`, runtime: 'bullmq', runtimeScope: 'reports', externalId: `${id}:job` });
    let execution = await tasks.getTaskExecution(`${id}:1`);
    await tasks.bindTaskExecution(execution.id, { runtime: 'bullmq', runtimeScope: 'reports', externalId: `${id}:job` });
    execution = await tasks.getTaskExecution(execution.id);
    await tasks.transitionTaskExecution(execution.id, execution.version, 'running');
    execution = await tasks.getTaskExecution(execution.id);
    await tasks.transitionTaskExecution(execution.id, execution.version, 'succeeded');
    task = await tasks.getTask(id);
    task = await tasks.transitionTask(id, task.entityVersion, 'uncertain');
    console.log(`PASS created ${task.id}: BullMQ execution=succeeded, real-world Task=uncertain.`);
    console.log('NEXT inspect it: npx rhinoq dev');
  } finally { await pool.end(); }
}

async function dev(args: string[]): Promise<void> {
  const portValue = Number(args.find((item) => item.startsWith('--port='))?.slice(7) ?? 8788);
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) fail('port must be 1..65535', 'Example: npx rhinoq dev --port=8788');
  const url = databaseURL();
  if (!url) fail('DATABASE_URL/RHINOQ_DATABASE_URL is not set', 'Set it, then run: npx rhinoq dev');
  const pool = new Pool({ connectionString: url });
  const server = createServer(async (_request, response) => {
    try {
      const result = await pool.query(`SELECT id,type,state,version,updated_at FROM rhinoq_task.tasks ORDER BY updated_at DESC LIMIT 25`);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(page(result.rows));
    } catch (error) {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`RhinoQ cannot read PostgreSQL. NEXT run: npx rhinoq doctor\n${safe(error)}`);
    }
  });
  server.listen(portValue, '127.0.0.1', () => console.log(`PASS RhinoQ dev view: http://127.0.0.1:${portValue}\nNEXT press Ctrl+C to stop.`));
  const close = () => server.close(() => pool.end().finally(() => process.exit(0)));
  process.once('SIGINT', close); process.once('SIGTERM', close);
}

function page(rows: unknown[]): string {
  const body = rows.map((value) => { const row = value as Record<string, unknown>; return `<tr><td>${escapeHTML(row.id)}</td><td>${escapeHTML(row.type)}</td><td><strong>${escapeHTML(row.state)}</strong></td><td>${escapeHTML(row.version)}</td></tr>`; }).join('');
  return `<!doctype html><meta charset="utf-8"><title>RhinoQ dev</title><style>body{font:16px system-ui;max-width:960px;margin:4rem auto;padding:0 1rem;background:#0b1020;color:#eef}table{width:100%;border-collapse:collapse}td,th{padding:.8rem;border-bottom:1px solid #334}strong{color:#ffcc66}</style><h1>RhinoQ dev</h1><p>Technical completion is not the same as a real-world outcome.</p><table><thead><tr><th>Task</th><th>Type</th><th>Real-world state</th><th>Version</th></tr></thead><tbody>${body}</tbody></table>`;
}

async function detectPackages(): Promise<{ pg: boolean; bullmq: boolean }> {
  try { const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { dependencies?: Record<string,string>; devDependencies?: Record<string,string> }; const all={...pkg.dependencies,...pkg.devDependencies}; return {pg:Boolean(all.pg),bullmq:Boolean(all.bullmq)}; }
  catch { return {pg:false,bullmq:false}; }
}
async function writeNew(path: string, content: string): Promise<void> { try { await access(path); console.log(`KEEP ${path} already exists.`); } catch { await writeFile(path, content, { flag:'wx' }); } }
function escapeHTML(value: unknown): string { return String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)); }
function safe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function nextAction(error: unknown): string { const message=safe(error); if (/connect|ECONN|database/i.test(message)) return 'Start PostgreSQL and verify DATABASE_URL, then run: npx rhinoq doctor'; return 'Run: npx rhinoq help'; }
function fail(message: string, next: string): never { console.error(`FAIL ${message}\nNEXT ${next}`); process.exitCode=1; throw new Error('__reported__'); }
function help(): void { console.log(`RhinoQ developer CLI\n\n  npx rhinoq init\n  npx rhinoq verify add completed-report-has-output\n  npx rhinoq doctor\n  npx rhinoq fixture failure\n  npx rhinoq dev\n\nEvery failure includes the next action.`); }
