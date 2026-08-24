#!/usr/bin/env node
import { createServer } from 'node:http';
import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { installPostgresTaskProfile } from '../postgres/task-client.js';
import { TASK_SCHEMA_VERSION } from '../postgres/task-schema.js';
import { SDK_VERSION } from '../gateway/types.js';
import { resolveDatabaseConfig, withPostgresOption, type ResolvedDatabaseConfig } from './database-config.js';
import {
  NOTIFY_REGISTRY_VERSION,
  defaultSecretEnv,
  loadNotifyRegistry,
  notifyRegistryPath,
  resolveNotifyDestination,
  saveNotifyRegistry,
  type NotifyDestinationEntry,
  type NotifyKind,
} from '../notify/registry.js';
import { sendTestNotification } from '../notify/sender.js';
import { createNodeWorkbenchMiddleware } from '../workbench/handler.js';
import { createNodeTaskCenterMiddleware, createNodeTaskMiddleware } from '../tasks/adapters.js';
import { WaitpointExpiryScheduler } from '../tasks/waitpoint-scheduler.js';
import { recoverFailureLab, runFailureLab, type FailureLabScenario } from '../lab/failure-lab.js';
import { adoptionChecklist } from '../runtime/adoption.js';
import { scanRhinoQIntegrationEraser, type RhinoQIntegrationEraserReport } from '../adopt/eraser.js';
import { compileRhinoQPlan, type RhinoQPlan, type RhinoQPlanManifest } from '../tasks/plan-inspector.js';
import { runRhinoQCompilerWorkflow } from '../tasks/compiler-workflow.js';
import { compileRhinoQBuildProfile, type RhinoQBuildProfile } from '../runtime/build-profile.js';
import { listRhinoQProcessorPackCatalog } from '../tasks/processor-pack.js';
import { listRhinoQCapabilities } from '../capabilities/registry.js';
import { createDemoTaskSource } from './demo.js';

const execFile = promisify(execFileCallback);

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'help';
  const args = process.argv.slice(3);
  switch (command) {
    case 'up': await up(args); break;
    case 'connect': await connect(args); break;
    case 'add': await add(args); break;
    case 'setup': await setup(args); break;
    case 'init': await init(args); break;
    case 'adopt': await adopt(args); break;
    case 'verify': await verify(args); break;
    case 'doctor': await doctor(args); break;
    case 'plan': await plan(args); break;
    case 'capabilities': await capabilities(args); break;
    case 'modules': await modules(args); break;
    case 'build-profile': await buildProfile(args); break;
    case 'explain': await explain(args); break;
    case 'notify': await notify(args); break;
    case 'fixture': await fixture(args); break;
    case 'eval': await evaluateProduct(args); break;
    case 'measure': await measure(args); break;
    case 'lab': await lab(args); break;
    case 'demo': await demo(args); break;
    case 'dev': await dev(args); break;
    case 'version': case '--version': case '-v': console.log(SDK_VERSION); break;
    case 'help': case '--help': case '-h':
      console.log('First value: npx rhinoq dev --demo | npx rhinoq up | npx rhinoq eval');
      console.log('This Node CLI checks the isolated Task profile only; use the Go CLI for engine fencing, leases and reaper checks.');
      help(); break;
    default: fail(`unknown command ${JSON.stringify(command)}`, 'Run: npx rhinoq help');
  }
}

type SetupRuntime = 'auto' | 'bullmq' | 'postgres' | 'manual';

interface SourceCount { frontend: number; backend: number; sql: number; integration: number; total: number }

async function measure(args: string[]): Promise<void> {
  let before: string | undefined;
  let after: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const [key, inline] = args[index]!.split('=', 2);
    const value = inline ?? args[++index];
    if (key === '--before') before = requiredOption(key, value);
    else if (key === '--after') after = requiredOption(key, value);
    else if (key === '--out') output = requiredOption(key, value);
    else fail(`unknown measure option ${JSON.stringify(key)}`, 'Run: npx rhinoq measure --before <baseline-dir> --after <rhinoq-dir> [--out report.json]');
  }
  if (!before || !after) fail('measure requires --before and --after directories', 'Run: npx rhinoq measure --before <baseline-dir> --after <rhinoq-dir>');
  const baseline = await countConsumerSource(resolve(before));
  const rhinoq = await countConsumerSource(resolve(after));
  if (!baseline.total || !rhinoq.total) fail('both directories need countable consumer source', 'Add .js/.ts/.tsx/.sql/.go source; tests, generated files and lock files are excluded');
  const removed = baseline.total - rhinoq.total;
  const report = {
    schemaVersion: 1,
    methodology: 'nonblank noncomment consumer source; generated/test/lock/vendor files excluded',
    before: baseline,
    after: rhinoq,
    delta: { lines: -removed, percent: Number(((removed / baseline.total) * 100).toFixed(1)) },
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    const path = resolve(output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serialized, 'utf8');
    console.log(`PASS wrote ${path}`);
  }
  console.log(serialized.trimEnd());
}

type PlanCommand = 'show' | 'validate' | 'diff';

/**
 * Read-only plan workflow. It accepts an explicit JSON artifact and never
 * imports arbitrary application source, starts a worker, or changes config.
 */
async function plan(args: string[]): Promise<void> {
  let action: PlanCommand = 'show';
  let from = '.rhinoq/plan.json';
  let against: string | undefined;
  let output: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (index === 0 && !raw.startsWith('--')) {
      if (raw !== 'show' && raw !== 'validate' && raw !== 'diff') fail(`unknown plan action ${JSON.stringify(raw)}`, 'Run: npx rhinoq plan [show|validate|diff] --from <path>');
      action = raw;
      continue;
    }
    const [key, inline] = raw.split('=', 2);
    if (key === '--json') { json = true; continue; }
    const value = inline ?? args[++index];
    if (key === '--from') from = requiredOption(key, value);
    else if (key === '--against') against = requiredOption(key, value);
    else if (key === '--output') output = requiredOption(key, value);
    else fail(`unknown plan option ${JSON.stringify(key)}`, 'Run: npx rhinoq plan validate --from .rhinoq/plan.json');
  }
  const current = await readCanonicalPlan(resolve(from));
  if (action === 'show') {
    if (output) {
      const outputPath = resolve(output);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeNew(outputPath, `${JSON.stringify(current, null, 2)}\n`);
    }
    printPlan(current, json);
    return;
  }
  if (action === 'validate') {
    const workflow = runRhinoQCompilerWorkflow({ action: 'validate', plan: current });
    if (workflow.status !== 'ready') {
      if (json) console.log(JSON.stringify({ plan: current, workflow }, null, 2));
      fail(`plan requires decisions: ${workflow.diagnostics.map((item) => item.whatHappened).join('; ')}`, 'Resolve the listed Task data-path decisions and regenerate the plan');
    }
    if (json) console.log(JSON.stringify({ plan: current, workflow }, null, 2));
    else console.log(`PASS plan ${current.fingerprint} is ready (${current.tasks.length} Task(s), profile ${current.profile}).`);
    return;
  }
  if (!against) fail('plan diff requires --against <path>', 'Run: npx rhinoq plan diff --from .rhinoq/plan.json --against .rhinoq/plan.previous.json');
  const previous = await readCanonicalPlan(resolve(against));
  const workflow = runRhinoQCompilerWorkflow({ action: 'diff', previous, plan: current });
  const diff = workflow.diff!;
  if (json) console.log(JSON.stringify(diff, null, 2));
  else {
    console.log(`Plan diff ${previous.fingerprint} -> ${current.fingerprint}`);
    console.log(`  added   ${diff.added.length}`);
    console.log(`  removed ${diff.removed.length}`);
    console.log(`  changed ${diff.changed.length}`);
    for (const name of diff.added) console.log(`  + ${name}`);
    for (const name of diff.removed) console.log(`  - ${name}`);
    for (const name of diff.changed) console.log(`  ~ ${name}`);
  }
}

async function readCanonicalPlan(path: string): Promise<RhinoQPlan> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    fail(`cannot read plan ${path}: ${safe(error)}`, `Write a compiled plan artifact first, for example compiler.plan() -> ${path}`);
  }
  try {
    const compiled = compileRhinoQPlan(raw as RhinoQPlanManifest);
    if (raw && typeof raw === 'object' && (raw as { kind?: unknown }).kind === 'rhinoq-plan'
      && (raw as { fingerprint?: unknown }).fingerprint !== compiled.fingerprint) {
      throw new TypeError(`fingerprint mismatch: artifact ${(raw as { fingerprint?: unknown }).fingerprint ?? '(missing)'}, computed ${compiled.fingerprint}`);
    }
    return compiled;
  } catch (error) {
    fail(`invalid plan ${path}: ${safe(error)}`, 'Export the plan from the typed application compiler and keep schemaVersion 1');
  }
}

function printPlan(planValue: RhinoQPlan, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(planValue, null, 2));
    return;
  }
  console.log(`RhinoQ plan ${planValue.fingerprint}`);
  console.log(`  profile       ${planValue.profile}`);
  console.log(`  status        ${planValue.status}`);
  console.log(`  Tasks         ${planValue.tasks.length}`);
  console.log(`  capabilities  ${planValue.capabilities.join(', ') || '(none)'}`);
  console.log(`  requirements  ${planValue.requirements.join(', ') || '(none)'}`);
  if (planValue.needsDecision.length) console.log(`  needsDecision ${planValue.needsDecision.join('; ')}`);
  if (planValue.limitations.length) console.log(`  limitations   ${planValue.limitations.join('; ')}`);
}

async function capabilities(args: string[]): Promise<void> {
  const unknown = args.filter((arg) => arg !== '--json');
  if (unknown.length) fail(`unknown capabilities option ${JSON.stringify(unknown[0])}`, 'Run: npx rhinoq capabilities [--json]');
  const registry = listRhinoQCapabilities();
  if (args.includes('--json')) {
    console.log(JSON.stringify({ schemaVersion: 1, capabilities: registry }, null, 2));
    return;
  }
  console.log('RhinoQ capability ledger (implementation and evidence are separate)');
  for (const entry of registry) console.log(`${entry.status.padEnd(17)} ${entry.id.padEnd(24)} evidence=${entry.evidence} owner=${entry.owner}`);
  console.log('NEXT use --json in CI/release review and compare claims with raw evidence.');
}

async function modules(args: string[]): Promise<void> {
  const action = args[0] && !args[0].startsWith('--') ? args[0] : 'list';
  const rest = action === 'list' || action === 'doctor' ? args.slice(args[0] === action ? 1 : 0) : args;
  if (action !== 'list' && action !== 'doctor') fail(`unknown module action ${JSON.stringify(action)}`, 'Run: npx rhinoq modules [list|doctor] [--json]');
  const unknown = rest.filter((arg) => arg !== '--json');
  if (unknown.length) fail(`unknown modules option ${JSON.stringify(unknown[0])}`, 'Run: npx rhinoq modules doctor --json');
  const catalog = listRhinoQProcessorPackCatalog().map((entry) => ({
    id: `processor/${entry.name}`,
    namespace: 'processor',
    status: entry.status,
    evidence: entry.evidence,
    ...(action === 'doctor' ? { readiness: 'not-probed', note: 'instantiate the application-owned pack and call module.provision(), module.validate() and pack.inspect() in the target worker' } : {}),
  }));
  if (rest.includes('--json')) console.log(JSON.stringify({ schemaVersion: 1, action, modules: catalog }, null, 2));
  else {
    console.log(`RhinoQ modules ${action} (catalog is not a provider health probe)`);
    for (const entry of catalog) console.log(`${entry.status.padEnd(24)} ${entry.id} ${'readiness' in entry ? entry.readiness : ''}`);
  }
}

async function explain(args: string[]): Promise<void> {
  const target = args[0];
  if (target === 'plan') {
    await plan(args.slice(1));
    return;
  }
  if (target === 'module') {
    const id = args[1];
    const entry = listRhinoQProcessorPackCatalog().find((item) => `processor/${item.name}` === id);
    if (!entry) fail(`module ${JSON.stringify(id)} is not in the bounded catalog`, 'Run: npx rhinoq modules list');
    const json = args.includes('--json');
    const explained = { schemaVersion: 1, id, namespace: 'processor', status: entry.status, evidence: entry.evidence, lifecycle: ['loaded', 'provisioned', 'validated', 'used', 'cleaned'], note: 'catalog explanation only; target-worker readiness must be probed by the application-owned module' };
    if (json) console.log(JSON.stringify(explained, null, 2));
    else console.log(`${id}: ${entry.status}\n  evidence  ${entry.evidence}\n  lifecycle loaded -> provisioned -> validated -> used -> cleaned\n  note      ${explained.note}`);
    return;
  }
  if (target === 'task') {
    const name = args[1];
    let from = '.rhinoq/plan.json';
    let json = false;
    for (let index = 2; index < args.length; index += 1) {
      const raw = args[index]!;
      if (raw === '--json') { json = true; continue; }
      const [key, inline] = raw.split('=', 2);
      const value = inline ?? args[++index];
      if (key === '--from') from = requiredOption(key, value);
      else fail(`unknown explain task option ${JSON.stringify(key)}`, 'Run: npx rhinoq explain task report.export --from .rhinoq/plan.json');
    }
    if (!name?.trim()) fail('explain task requires a Task name', 'Run: npx rhinoq explain task report.export --from .rhinoq/plan.json');
    const explained = (await readCanonicalPlan(resolve(from))).tasks.find((task) => task.name === name);
    if (!explained) fail(`Task ${JSON.stringify(name)} is not in plan ${resolve(from)}`, 'Use a Task name from npx rhinoq plan --from <path> --json');
    if (json) console.log(JSON.stringify({ schemaVersion: 1, task: explained }, null, 2));
    else console.log(`${explained.name}: ${explained.capability ?? 'task'}\n  runtime   ${explained.runtime}/${explained.scope}\n  adapter   ${explained.adapter}\n  retry     ${explained.retry.mode}\n  effect    ${explained.externalEffect ? 'external; confirmation required' : 'none'}\n  decisions ${(explained.dataPath?.needsDecision ?? []).join('; ') || 'none'}`);
    return;
  }
  fail(`unknown explain target ${JSON.stringify(target)}`, 'Run: npx rhinoq explain [task|plan|module] ...');
}

async function buildProfile(args: string[]): Promise<void> {
  let name = 'rhinoq-profile';
  let lockPath: string | undefined;
  const selected: { id: string; namespace: 'runtime' | 'processor' | 'provider' | 'storage' | 'surface'; version: string }[] = [];
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (raw === '--json') { json = true; continue; }
    const [key, inline] = raw.split('=', 2);
    const value = inline ?? args[++index];
    if (key === '--name') name = requiredOption(key, value);
    else if (key === '--with') selected.push(parseBuildModule(requiredOption(key, value)));
    else if (key === '--lock') lockPath = requiredOption(key, value);
    else fail(`unknown build-profile option ${JSON.stringify(key)}`, 'Run: npx rhinoq build-profile --name media-worker --with processor/ffmpeg@1.0.0');
  }
  if (lockPath && selected.length) fail('build-profile cannot combine --lock and --with', 'Use either a lock artifact or explicit --with module selections');
  let profile: RhinoQBuildProfile;
  if (lockPath) {
    try {
      const raw = JSON.parse(await readFile(resolve(lockPath), 'utf8')) as RhinoQBuildProfile;
      profile = compileRhinoQBuildProfile(raw);
    } catch (error) {
      fail(`invalid build profile lock ${resolve(lockPath)}: ${safe(error)}`, 'Use a schemaVersion 1 profile with namespaced modules and exact versions');
    }
  } else {
    profile = compileRhinoQBuildProfile({ name, modules: selected });
  }
  if (json) console.log(JSON.stringify(profile, null, 2));
  else {
    console.log(`RhinoQ build profile ${profile.fingerprint}`);
    console.log(`  name          ${profile.name}`);
    console.log(`  selected only ${profile.selectedOnly}`);
    for (const module of profile.modules) console.log(`  with          ${module.id}@${module.version}${module.checksum ? ` ${module.checksum}` : ''}`);
    for (const limitation of profile.limitations) console.log(`  limitation    ${limitation}`);
  }
}

function parseBuildModule(spec: string): { id: string; namespace: 'runtime' | 'processor' | 'provider' | 'storage' | 'surface'; version: string } {
  const at = spec.lastIndexOf('@');
  const id = (at > 0 ? spec.slice(0, at) : '').trim();
  const version = (at > 0 ? spec.slice(at + 1) : '').trim();
  const namespace = id.split('/', 1)[0] ?? '';
  if (!id || !version || !['runtime', 'processor', 'provider', 'storage', 'surface'].includes(namespace)) {
    fail(`invalid module selection ${JSON.stringify(spec)}`, 'Use --with namespace/name@exact-version, for example processor/ffmpeg@1.0.0');
  }
  return { id, namespace: namespace as 'runtime' | 'processor' | 'provider' | 'storage' | 'surface', version };
}

async function countConsumerSource(directory: string): Promise<SourceCount> {
  const count: SourceCount = { frontend: 0, backend: 0, sql: 0, integration: 0, total: 0 };
  const visit = async (path: string): Promise<void> => {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, item.name);
      if (item.isDirectory()) {
        if (!/^(node_modules|vendor|dist|build|coverage|generated|test|tests|__tests__)$/i.test(item.name)) await visit(child);
        continue;
      }
      if (/\.(test|spec)\.|(?:package-lock|pnpm-lock|yarn\.lock)/i.test(item.name)) continue;
      const extension = extname(item.name);
      if (!['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.sql', '.go'].includes(extension)) continue;
      const lines = (await readFile(child, 'utf8')).split(/\r?\n/)
        .filter((line) => line.trim() && !/^\s*(\/\/|\/\*|\*|--)/.test(line)).length;
      const category: Exclude<keyof SourceCount, 'total'> = extension === '.sql' ? 'sql'
        : ['.tsx', '.jsx'].includes(extension) || /[\\/]web[\\/]/i.test(child) ? 'frontend'
          : /rhinoq|integration/i.test(child) ? 'integration' : 'backend';
      count[category] += lines;
      count.total += lines;
    }
  };
  await visit(directory);
  return count;
}

async function setup(args: string[]): Promise<void> {
  let apply = false;
  let runtime: SetupRuntime = 'auto';
  let mode: 'single' | 'fanout' | undefined;
  let ownerProperty: string | undefined;
  let localPostgres = false;
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (raw === '--apply') { apply = true; continue; }
    if (raw === '--local-postgres') { localPostgres = true; continue; }
    const [key, inline] = raw.split('=', 2);
    const value = inline ?? args[++index];
    if (key === '--runtime') {
      if (value !== 'auto' && value !== 'bullmq' && value !== 'postgres' && value !== 'manual') {
        fail('--runtime must be auto, bullmq, postgres or manual', 'Run: npx rhinoq setup --runtime auto');
      }
      runtime = value;
    } else if (key === '--mode') {
      if (value !== 'single' && value !== 'fanout') fail('--mode must be single or fanout', 'Run: npx rhinoq setup --mode single');
      mode = value;
    } else if (key === '--owner-property') ownerProperty = ownerPropertyPath(requiredOption(key, value));
    else fail(`unknown setup option ${JSON.stringify(key)}`, 'Run: npx rhinoq setup [--runtime auto|bullmq|postgres|manual] [--apply]');
  }

  const detected = await detectPackages();
  const go = await pathExists(resolve('go.mod'));
  const selected: Exclude<SetupRuntime, 'auto'> = runtime === 'auto'
    ? detected.bullmq ? 'bullmq' : go ? 'postgres' : 'manual'
    : runtime;
  const resolved = database();
  const generated = selected === 'bullmq'
    ? detected.nest ? 'src/rhinoq.module.ts' : 'rhinoq.integration.mjs'
    : selected === 'postgres' ? 'internal/rhinoqworker/worker.go' : 'rhinoq.app.mjs';

  console.log('RhinoQ complete setup plan');
  console.log(`  project             ${detected.nest ? 'NestJS' : go ? 'Go' : 'Node/framework-neutral'}`);
  console.log(`  capability detect   ${setupCapabilitySummary(detected, resolved)}`);
  console.log(`  execution runtime   ${selected}${runtime === 'auto' ? ' (auto-selected)' : ''}`);
  console.log(`  PostgreSQL          ${resolved ? `reuse ${resolved.source}` : localPostgres ? 'generate disposable local service' : 'configuration required'}`);
  const semantics = selected === 'bullmq' && !mode ? 'NEEDS DECISION: choose single or fanout' : mode ?? 'not applicable for this runtime';
  console.log(`  Task semantics      ${semantics}`);
  console.log(`  integration         ${generated}`);
  console.log('  product surface     owner API + Task Center + Workbench + operator login (project profile mount)');
  console.log('  operations          health + readiness + metrics + reconciliation');
  console.log('  realtime            SSE fallback + optional app-owned WebSocket invalidation hook');
  console.log('  validation          doctor + bounded eval fixture when PostgreSQL is configured');
  if (selected === 'bullmq' && !detected.bullmq) console.log('  prerequisite        MISSING bullmq package');
  if (selected === 'postgres' && !go) console.log('  prerequisite        MISSING go.mod for native Go worker');
  if (!apply) {
    console.log('INFO preview only; no schema or file was changed.');
    console.log(`NEXT review the plan, then run: npx rhinoq setup --runtime ${selected}${mode ? ` --mode ${mode}` : selected === 'bullmq' ? ' --mode single|fanout' : ''}${localPostgres ? ' --local-postgres' : ''} --apply`);
    return;
  }
  if (selected === 'bullmq' && !mode) {
    fail('BullMQ setup needs Task semantics before apply', 'Choose --mode single or --mode fanout, then rerun setup --apply');
  }
  if (selected === 'bullmq' && !detected.bullmq) fail('BullMQ setup selected but bullmq is not installed', 'Install bullmq, or choose --runtime postgres/manual');
  if (selected === 'postgres' && !go) fail('native PostgreSQL queue setup requires a Go project', 'Run go mod init, or choose --runtime manual/bullmq');

  await init([]);
  await mkdir(resolve('.rhinoq'), { recursive: true });
  await writeNew(resolve('.rhinoq', 'setup.json'), `${JSON.stringify({ schemaVersion: 2, runtime: selected, ...(mode ? { mode } : {}), generated, projectProfile: selected === 'manual', capabilities: setupCapabilities(detected, resolved) }, null, 2)}\n`);
  await writeNew(resolve('.env.rhinoq.example'), setupEnvironmentTemplate(selected));

  if (selected === 'bullmq') {
    const adoptArgs = ['--mode', mode!, '--apply'];
    if (ownerProperty) adoptArgs.push('--owner-property', ownerProperty);
    if (localPostgres) adoptArgs.push('--local-postgres');
    await adopt(adoptArgs);
  } else if (selected === 'postgres') {
    const path = resolve(generated);
    await mkdir(dirname(path), { recursive: true });
    if (await writeNew(path, postgresWorkerTemplate())) console.log(`PASS generated ${path}`);
  } else {
    if (await writeNew(resolve(generated), manualAppTemplate())) console.log(`PASS generated ${resolve(generated)}`);
  }

  if (resolved) {
    await doctor([]);
    await evaluateProduct([]);
  } else {
    console.log('WARN doctor/eval deferred until PostgreSQL is configured.');
  }
  console.log('URL Task Center: /task-center');
  console.log('URL Workbench sign in: /operator-login');
  console.log('NEXT connect authenticated owner/tenant identity and your business Task handler; RhinoQ will not guess either.');
}

/** Start a disposable real local stack, then hand it to the same Workbench. */
async function up(args: string[]): Promise<void> {
  let dbPort = 55432;
  let workbenchPort = 8788;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (raw === '--dry-run') { dryRun = true; continue; }
    const [key, inline] = raw.split('=', 2);
    const value = inline ?? args[++index];
    if (key === '--db-port') dbPort = boundedPort(key, value, 1);
    else if (key === '--port') workbenchPort = boundedPort(key, value, 1);
    else fail(`unknown up option ${JSON.stringify(key)}`, 'Run: npx rhinoq up [--db-port=55432] [--port=8788]');
  }
  const compose = resolve('.rhinoq', 'compose.local.yml');
  await mkdir(dirname(compose), { recursive: true });
  const composeWritten = await writeNew(compose, localPostgresTemplate(dbPort));
  if (!composeWritten) {
    try {
      const existing = await readFile(compose, 'utf8');
      const existingPort = existing.match(/127\.0\.0\.1:(\d+):5432/)?.[1];
      if (existingPort) dbPort = boundedPort('--db-port', existingPort, 1);
    } catch { /* the subsequent Docker command will report the real problem */ }
  }
  const databaseURL = `postgresql://rhinoq:rhinoq@127.0.0.1:${dbPort}/rhinoq`;
  let operatorToken = process.env.RHINOQ_OPERATOR_TOKEN?.trim() || randomBytes(32).toString('hex');
  const envPath = resolve('.env.rhinoq.local');
  const envWritten = await writeNew(envPath, `RHINOQ_DATABASE_URL=${databaseURL}\nRHINOQ_OPERATOR_TOKEN=${operatorToken}\n`);
  if (!envWritten) {
    try {
      const existingEnv = await readFile(envPath, 'utf8');
      const existingToken = existingEnv.match(/^RHINOQ_OPERATOR_TOKEN=(.+)$/m)?.[1]?.trim();
      if (existingToken) operatorToken = existingToken;
    } catch { /* use the process token */ }
  }
  console.log(`PASS local stack plan: PostgreSQL 16 on 127.0.0.1:${dbPort}`);
  console.log(`INFO local environment: ${envPath}`);
  if (dryRun) {
    console.log('INFO dry run; Docker was not started and no schema was changed.');
    console.log(`NEXT docker compose -f ${relative(resolve('.'), compose)} up -d`);
    return;
  }
  try {
    await runExternal('docker', ['info']);
  } catch {
    fail('Docker is not available', 'Start Docker Desktop, then rerun: npx rhinoq up');
  }
  try {
    await runExternal('docker', ['compose', '-f', compose, 'up', '-d']);
  } catch (error) {
    fail(`could not start local PostgreSQL: ${safe(error)}`, `Inspect: docker compose -f ${relative(resolve('.'), compose)} logs`);
  }
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await runExternal('docker', ['compose', '-f', compose, 'exec', '-T', 'rhinoq-postgres', 'pg_isready', '-U', 'rhinoq', '-d', 'rhinoq']);
      ready = true;
      break;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    }
  }
  if (!ready) fail('PostgreSQL did not become ready within 30 seconds', `Inspect: docker compose -f ${relative(resolve('.'), compose)} logs rhinoq-postgres`);
  process.env.RHINOQ_DATABASE_URL = databaseURL;
  process.env.RHINOQ_OPERATOR_TOKEN = operatorToken;
  await init([]);
  await fixture(['async']);
  console.log(`PASS local RhinoQ stack is ready; starting Workbench on port ${workbenchPort}.`);
  console.log(`INFO stop the UI with Ctrl+C; stop the database with: docker compose -f ${relative(resolve('.'), compose)} down`);
  await dev([`--port=${workbenchPort}`]);
}

function boundedPort(key: string, value: string | undefined, minimum: number): number {
  const port = Number(requiredOption(key, value));
  if (!Number.isInteger(port) || port < minimum || port > 65535) fail(`${key} must be ${minimum}..65535`, `Run: npx rhinoq up --${key.slice(2)}=8788`);
  return port;
}

async function runExternal(command: string, args: string[]): Promise<string> {
  const result = await execFile(command, args, { cwd: resolve('.'), maxBuffer: 2 * 1024 * 1024 });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function setupEnvironmentTemplate(runtime: Exclude<SetupRuntime, 'auto'>): string {
  return [
    'RHINOQ_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/app',
    'RHINOQ_OPERATOR_TOKEN=replace-with-at-least-32-random-bytes',
    'RHINOQ_REPLICA_ID=replace-with-stable-process-identity',
    ...(runtime === 'bullmq' ? ['REDIS_URL=redis://127.0.0.1:6379'] : []),
    '',
  ].join('\n');
}

function postgresWorkerTemplate(): string {
  return `package rhinoqworker

import (
  "context"
  "github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

// Register is the only application-owned part: connect each declared name to
// business code. RhinoQ owns enqueue, leases, retry, recovery and inspection.
func Register(queue *rhinoq.Client, runReport func(context.Context, rhinoq.Job) error) error {
  return queue.Handle("reports", "report.export", runReport)
}
`;
}

function manualAppTemplate(): string {
  return `import { createManualRuntimeAdapter, defineRhinoQProject } from '@rhinoq/node';

const runtime = createManualRuntimeAdapter('manual', 'application');
export async function startRhinoQ({ pool, ownerFromNodeRequest, tenantFromNodeRequest }) {
  const project = defineRhinoQProject({
    pool,
    profile: { name: 'application', adapters: [runtime] },
    identity: { ownerFromNodeRequest, tenantFromNodeRequest },
    http: { operatorToken: process.env.RHINOQ_OPERATOR_TOKEN },
    tasks: (task) => ({
      // Add business Tasks here. The profile supplies adapter/runtime/scope.
      example: task({ name: 'example.run', run: async (input) => input }),
    }),
  });
  return project.start();
}
`;
}

main().catch((error: unknown) => {
  if (!(error instanceof Error && error.message === '__reported__')) {
    console.error(`FAIL ${safe(error)}\nNEXT ${nextAction(error)}`);
    process.exitCode = 1;
  }
});

function database(): ResolvedDatabaseConfig | undefined {
  return resolveDatabaseConfig(process.env);
}

// Every command that needs PostgreSQL fails the same way, and the NEXT action
// names both shapes. A project whose platform only hands out discrete variables
// used to read "DATABASE_URL is not set" as "RhinoQ needs a URL I do not have".
function requireDatabase(command: string): ResolvedDatabaseConfig {
  const resolved = database();
  if (!resolved) {
    fail(
      'no PostgreSQL connection in the environment',
      `Set RHINOQ_DATABASE_URL (or DATABASE_URL, or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE), then run: npx rhinoq ${command}`,
    );
  }
  return resolved;
}

async function init(args: string[] = []): Promise<void> {
  if (args.length) {
    const index = args.findIndex((value) => value === '--example');
    const example = index >= 0 ? args[index + 1] : undefined;
    if (example !== 'report-export' || args.length !== 2) fail('init example must be report-export', 'Run: npx rhinoq init --example report-export');
    await initReportExportExample();
    return;
  }
  const root = resolve('.rhinoq');
  await mkdir(resolve(root, 'rules'), { recursive: true });
  const resolved = database();
  await writeNew(resolve(root, 'config.json'), JSON.stringify({
    schemaVersion: 1,
    databaseEnv: resolved?.source ?? 'DATABASE_URL',
    taskProfileVersion: TASK_SCHEMA_VERSION,
  }, null, 2) + '\n');
  if (resolved) {
    const pool = new Pool({ ...withPostgresOption(resolved.pool, '-c rhinoq.tenant_id=default'), connectionTimeoutMillis: 5_000 });
    try { await installPostgresTaskProfile(pool); }
    finally { await pool.end(); }
    console.log(`PASS PostgreSQL detected at ${resolved.target} via ${resolved.source}; RhinoQ Task schema v${TASK_SCHEMA_VERSION} is current.`);
  } else {
    await writeNew(resolve('.env.rhinoq.example'), [
      '# Either a connection URL...',
      'DATABASE_URL=postgres://postgres:postgres@localhost:5432/app',
      '',
      '# ...or discrete variables, which is what most managed providers hand out.',
      '# PGHOST=localhost',
      '# PGPORT=5432',
      '# PGUSER=postgres',
      '# PGPASSWORD=postgres',
      '# PGDATABASE=app',
      '# PGSSLMODE=require',
      '',
      'RHINOQ_OPERATOR_TOKEN=replace-with-at-least-32-random-bytes',
      'RHINOQ_REPLICA_ID=replace-with-stable-process-identity',
      '',
      '# Optional: enable createRhinoQApp({ artifacts: "s3" })',
      'RHINOQ_ARTIFACT_BUCKET=',
      'RHINOQ_ARTIFACT_REGION=',
      'RHINOQ_ARTIFACT_MAX_BYTES=10737418240',
      'RHINOQ_ARTIFACT_CONTENT_TYPES=video/mp4,application/pdf,application/zip',
      '',
      'REDIS_URL=redis://localhost:6379',
      '',
    ].join('\n'));
    console.log('WARN no PostgreSQL connection detected; schema was not applied.');
    console.log('NEXT set DATABASE_URL, or PGHOST/PGDATABASE and friends, then run: npx rhinoq init');
  }
  const detected = await detectPackages();
  console.log(`PASS created ${root}`);
  console.log(`INFO PostgreSQL client: ${detected.pg ? 'detected' : 'missing'}; BullMQ: ${detected.bullmq ? 'detected' : 'not detected (optional)'}.`);
  console.log('NEXT add a verification: npx rhinoq verify add completed-report-has-output');
}

/**
 * Friendly existing-app entry point. `connect` deliberately delegates the
 * safety-sensitive detection and preview to the adoption workflow so there
 * is one source of truth for queue semantics, owner mapping and file writes.
 */
async function connect(args: string[]): Promise<void> {
  console.log('RhinoQ connect — keep your runtime, add the Task product surface');
  console.log('  1. inspect existing queues and status glue');
  console.log('  2. decide Task semantics and owner identity');
  console.log('  3. preview a non-overwriting integration');
  console.log('INFO nothing is written until you rerun with --apply.');
  await adopt(args);
}

async function add(args: string[]): Promise<void> {
  const subject = args[0];
  if (subject !== 'task') {
    fail('add currently supports the task generator only', 'Run: npx rhinoq add task report.export [--apply]');
  }
  let name: string | undefined = args[1] && !args[1]!.startsWith('--') ? args[1] : undefined;
  let output = 'src/rhinoq.tasks.mjs';
  let testOutput = 'test/rhinoq.tasks.test.mjs';
  let apply = false;
  for (let index = name ? 2 : 1; index < args.length; index += 1) {
    const raw = args[index]!;
    if (raw === '--apply') { apply = true; continue; }
    if (!raw.startsWith('--') && !name) { name = raw; continue; }
    const [key, inline] = raw.split('=', 2);
    const value = inline ?? args[++index];
    if (key === '--out') output = requiredOption(key, value);
    else if (key === '--test-out') testOutput = requiredOption(key, value);
    else if (key === '--name') name = requiredOption(key, value);
    else fail(`unknown add task option ${JSON.stringify(key)}`, 'Run: npx rhinoq add task report.export [--out src/rhinoq.tasks.mjs] [--test-out test/rhinoq.tasks.test.mjs] [--apply]');
  }
  if (!name) fail('add task requires a Task name', 'Run: npx rhinoq add task report.export [--apply]');
  const normalized = normalizeTaskName(name);
  const outputPath = resolve(output);
  const testPath = resolve(testOutput);
  const key = toTaskKey(normalized);
  const content = taskSliceTemplate(normalized, key);
  const testContent = taskSliceTestTemplate(normalized, relative(dirname(testPath), outputPath), key);
  console.log('RhinoQ Task slice');
  console.log(`  task name   ${normalized}`);
  console.log(`  task key    ${key}`);
  console.log(`  output      ${outputPath}`);
  console.log('  includes    typed declaration, real progress calls, result metadata, worker handler and a smoke test');
  console.log(`  test        ${testPath}`);
  console.log('  UI handoff  /task-center (after the application mounts its HTTP surface)');
  console.log('  runtime     manual adapter placeholder; replace with the app-owned adapter before dispatch');
  if (!apply) {
    console.log('INFO preview only; nothing was written.');
    console.log(`NEXT npx rhinoq add task ${normalized} --apply`);
    return;
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const written = await writeNew(outputPath, content);
  if (!written) return;
  await mkdir(dirname(testPath), { recursive: true });
  await writeNew(testPath, testContent);
  console.log(`PASS generated ${outputPath}`);
  console.log(`PASS generated ${testPath}`);
  console.log(`NEXT import { application } from './${relative(dirname(outputPath), outputPath).replace(/\\/g, '/').replace(/^\.\//, '')}' and call application.start({ pool, ... })`);
  console.log('NEXT replace the manual adapter with BullMQ/SQS/custom dispatch before calling dispatch().');
  console.log('NEXT run npx rhinoq doctor after the app owns DATABASE_URL and the Task schema.');
}

function normalizeTaskName(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized || !/^[A-Za-z0-9]/.test(normalized)) {
    fail(`invalid Task name ${JSON.stringify(value)}`, 'Use a stable name such as report.export');
  }
  if (!normalized.includes('.')) console.log('INFO Task names are easier to search when they use a domain.action form.');
  return normalized;
}

function toTaskKey(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const key = parts.map((part, index) => index === 0
    ? part.charAt(0).toLowerCase() + part.slice(1)
    : part.charAt(0).toUpperCase() + part.slice(1)).join('');
  return /^[A-Za-z_$]/.test(key) ? key : `task${key}`;
}

function taskSliceTemplate(name: string, key: string): string {
  return `import { createManualRuntimeAdapter, defineRhinoQApplication } from '@rhinoq/node';

// This adapter is intentionally observe/handler-only. Replace it with the
// runtime adapter owned by your application before calling dispatch().
const runtime = createManualRuntimeAdapter('manual', 'application');

export const application = defineRhinoQApplication({
  profile: { name: 'application', adapters: [runtime] },
  tasks: (task) => ({
    ${key}: task({
      name: '${name}',
      run: async (input, context) => {
        await context.progress(0, 1, 'Started');
        // TODO: replace this bounded example with business work.
        const output = { input };
        await context.progress(1, 1, 'Completed');
        return output;
      },
      result: (output) => ({ ref: 'inline:${name}', mediaType: 'application/json' }),
    }),
  }),
});

export const manifest = application.manifest();
export const plan = application.plan();
export const taskCenterPath = '/task-center';
`;
}

function taskSliceTestTemplate(name: string, importPath: string, key: string): string {
  const modulePath = importPath.replace(/\\/g, '/');
  const specifier = modulePath.startsWith('.') ? modulePath : `./${modulePath}`;
  return `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { manifest, plan, taskCenterPath } from '${specifier}';

test(${JSON.stringify(`${name} is registered before runtime wiring`)}, () => {
  const entry = manifest.tasks.find((task) => task.key === ${JSON.stringify(key)});
  assert.equal(entry?.name, ${JSON.stringify(name)});
  assert.equal(plan.status, 'ready');
  assert.equal(plan.tasks.length, 1);
  assert.equal(taskCenterPath, '/task-center');
});
`;
}

async function initReportExportExample(): Promise<void> {
  const root = resolve('rhinoq-report-export');
  await mkdir(root, { recursive: true });
  const files: Record<string, string> = {
    'package.json': `${JSON.stringify({ name: 'rhinoq-report-export', private: true, type: 'module', engines: { node: '>=22' }, scripts: { start: 'node --env-file=.env app.mjs' }, dependencies: { '@rhinoq/node': `^${SDK_VERSION}`, pg: '^8.22.0' } }, null, 2)}\n`,
    '.env.example': 'DATABASE_URL=postgres://postgres:postgres@localhost:5432/app\n# Local-only placeholder. Replace it before sharing the app.\nRHINOQ_OPERATOR_TOKEN=local-demo-token-change-me\n# Optional S3 artifact golden path\nRHINOQ_ARTIFACT_BUCKET=\nRHINOQ_ARTIFACT_REGION=\nRHINOQ_ARTIFACT_MAX_BYTES=10737418240\n',
    '.rhinoq/product-surface.json': `${JSON.stringify({ owner: true, tenant: true, result: false, verifier: false, runtimeIdentity: true, durableStore: false }, null, 2)}\n`,
    'app.mjs': reportExportAppTemplate(),
    'README.md': '# RhinoQ report-export consumer\n\nRun `npm install`, configure `DATABASE_URL`, then `npm start`.\n\nDemo sessions are server-side and stable: `owner-a-session` and `owner-b-session`. Replace them with real authentication before deployment. Result and verifier callbacks intentionally remain fail-closed until configured; run `npx rhinoq doctor --product-surface` in this directory.\n',
  };
  for (const [name, content] of Object.entries(files)) {
    const path = resolve(root, name); await mkdir(dirname(path), { recursive: true }); await writeNew(path, content);
  }
  console.log(`PASS generated ${root}`);
  console.log('URL Task Center: http://127.0.0.1:8787/task-center');
  console.log('URL Workbench sign in: http://127.0.0.1:8787/operator-login');
  console.log('WARN result and verifier are fail-closed until application callbacks are configured.');
  console.log(`NEXT cd ${relative(resolve('.'), root)}; npm install; copy .env.example to .env; npm start`);
}

function reportExportAppTemplate(): string {
  return `import { createServer } from 'node:http';
import { Pool } from 'pg';
import { createManualRuntimeAdapter, createRhinoQApp } from '@rhinoq/node';

const sessions = new Map([
  ['owner-a-session', { ownerId: 'owner-a', tenantId: 'tenant-demo' }],
  ['owner-b-session', { ownerId: 'owner-b', tenantId: 'tenant-demo' }],
]);
function identity(request) {
  const session = sessions.get(String(request.headers['x-demo-session'] || ''));
  if (!session) throw new Error('authenticated demo session required');
  return session;
}
const databaseUrl = new URL(process.env.DATABASE_URL);
const databaseOptions = [databaseUrl.searchParams.get('options'), '-c rhinoq.tenant_id=tenant-demo'].filter(Boolean).join(' ');
databaseUrl.searchParams.set('options', databaseOptions);
const pool = new Pool({ connectionString: databaseUrl.toString() });
const runtime = createManualRuntimeAdapter('manual', 'report-export');
const app = await createRhinoQApp({
  pool, adapters: [runtime],
  ownerFromNodeRequest: (request) => identity(request).ownerId,
  tenantFromNodeRequest: (request) => identity(request).tenantId,
});
const reportExport = app.task({
  name: 'report.export', adapter: 'manual', runtime: 'manual', scope: 'report-export',
  run: async ({ reportId }, context) => {
    await context.progress(0, 1, 'Preparing report');
    // Keep the business handler here; provider credentials and verification
    // remain application-owned and fail closed until configured.
    await context.progress(1, 1, 'Report ready');
    return { reportId };
  },
  result: ({ reportId }) => ({ ref: \`report:\${reportId}\`, mediaType: 'application/json' }),
});
const http = app.http({ operatorToken: process.env.RHINOQ_OPERATOR_TOKEN });
createServer((request, response) => http(request, response)).listen(8787, '127.0.0.1', () => {
  console.log('Task Center http://127.0.0.1:8787/task-center');
  console.log('Workbench sign in http://127.0.0.1:8787/operator-login');
  console.log(\`Task handler registered: \${reportExport.name} (manual adapter; dispatch is intentionally not enabled)\`);
});
`;
}

async function demo(args: string[]): Promise<void> {
  const scenario = args[0];
  if (scenario === 'transport-fallback' && args.length === 1) {
    console.log('NOTICE simulated browser transport demo; no network or provider called.');
    console.log(JSON.stringify({ stages: ['live', 'stream_lost', 'polling_fallback', 'converged'], staleSnapshotRejected: true, applicationCodeChanged: false }));
    console.log('NEXT run the service-backed browser campaign before using this as production evidence.');
    return;
  }
  if (scenario === 'missing-output') {
    console.log('NOTICE missing-output uses the disposable Failure Lab; no external provider called.');
    await lab(['run', 'completed-but-missing-output', ...args.slice(1)]);
    return;
  }
  fail('unknown demo scenario', 'Run: npx rhinoq demo transport-fallback or npx rhinoq demo missing-output --confirm-disposable');
}

async function adopt(args: string[]): Promise<void> {
  let apply = false;
  let scan = false;
  let json = false;
  let all = false;
  let observe = false;
  let adapter: 'manual' | 'sqs' | 'bullmq' | 'custom' | undefined;
  let localPostgres = false;
  let mode: 'single' | 'fanout' | undefined;
  let output: string | undefined;
  const selectedQueues: string[] = [];
  const declaredTasks = new Map<string, { taskType: string; mode: 'single' | 'fanout' }>();
  let ownerProperty: string | undefined;
  let routesPath = '/tasks';
  let taskCenterPath = '/task-center';
  let verifyURL: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (raw === '--apply') { apply = true; continue; }
    if (raw === '--scan') { scan = true; continue; }
    if (raw === '--json') { json = true; continue; }
    if (raw === '--all') { all = true; continue; }
    if (raw === '--observe') { observe = true; continue; }
    if (raw === '--local-postgres') { localPostgres = true; continue; }
    const [key, inline] = raw.split('=', 2);
    const value = inline ?? args[++index];
    if (key === '--adapter') {
      if (value !== 'manual' && value !== 'sqs' && value !== 'bullmq' && value !== 'custom') {
        fail('--adapter must be manual, sqs, bullmq or custom', 'Run: npx rhinoq adopt --adapter custom --observe');
      }
      adapter = value;
    } else if (key === '--mode') {
      if (value !== 'single' && value !== 'fanout') fail('--mode must be single or fanout', 'Run: npx rhinoq adopt --mode single');
      mode = value;
    } else if (key === '--out') output = resolve(requiredOption(key, value));
    else if (key === '--queue') selectedQueues.push(requiredOption(key, value));
    else if (key === '--task') {
      const declaration = taskDeclaration(requiredOption(key, value));
      if (declaredTasks.has(declaration.queue)) fail(`duplicate --task declaration for ${declaration.queue}`, 'Declare each queue exactly once');
      declaredTasks.set(declaration.queue, declaration);
    }
    else if (key === '--verify-url') verifyURL = requiredOption(key, value);
    else if (key === '--owner-property') ownerProperty = ownerPropertyPath(requiredOption(key, value));
    else if (key === '--routes-path') routesPath = routePath(requiredOption(key, value));
    else if (key === '--task-center-path') taskCenterPath = routePath(requiredOption(key, value));
    else fail(`unknown adopt option ${JSON.stringify(key)}`, 'Run: npx rhinoq adopt --mode single [--apply]');
  }
  if (scan) {
    const hasGenerationOption = observe || Boolean(adapter) || localPostgres || Boolean(mode) || Boolean(output) ||
      selectedQueues.length > 0 || declaredTasks.size > 0 || Boolean(ownerProperty) ||
      routesPath !== '/tasks' || taskCenterPath !== '/task-center' || Boolean(verifyURL);
    if (apply || hasGenerationOption) {
      fail('--scan is preview-only and cannot be combined with adoption generation options', 'Run: npx rhinoq adopt --scan [--json]');
    }
    const report = await scanRhinoQIntegrationEraser(resolve('.'));
    if (json) console.log(JSON.stringify(report, null, 2));
    else printIntegrationEraserReport(report, all);
    return;
  }
  if (json) fail('--json is only available with --scan', 'Run: npx rhinoq adopt --scan --json');
  if (observe) {
    await adoptObserve({ apply, adapter, output });
    return;
  }
  if (verifyURL) { await verifyAdoptionRuntime(verifyURL, routesPath, taskCenterPath); return; }
  const detected = await detectPackages();
  const database = resolveDatabaseConfig(process.env);
  const queues = detected.nest ? await detectNestQueues(resolve('src')) : [];
  const producers = detected.nest ? await detectQueueAdds(resolve('src')) : [];
  output ??= resolve(detected.nest ? 'src/rhinoq.module.ts' : 'rhinoq.integration.mjs');
  console.log('RhinoQ adoption plan');
  console.log(`  PostgreSQL client  ${detected.pg ? 'reuse installed pg' : 'MISSING: install pg'}`);
  console.log(`  BullMQ             ${detected.bullmq ? 'reuse existing runtime' : 'MISSING: install/use BullMQ first'}`);
  console.log(`  framework          ${detected.nest ? 'NestJS detected; @rhinoq/node/nest is available' : 'framework-neutral'}`);
  console.log(`  BullMQ queues      ${queues.length ? queues.join(', ') : 'none detected statically'}`);
  console.log(`  queue producers    ${producers.length ? producers.map((item) => `${relative(resolve('.'), item.file)}:${item.line}`).join(', ') : 'none detected statically'}`);
  if (queues.length > 1 && selectedQueues.length === 0 && declaredTasks.size === 0) console.log('  queue selection    MISSING: select queues explicitly with --queue or --task');
  if (detected.nest) console.log(`  owner routes       ${ownerProperty ? `${routesPath} from request.${ownerProperty}` : 'not mounted; pass --owner-property after upstream authentication'}`);
  console.log(`  Task semantics     ${mode ?? 'MISSING: choose single or fanout'}`);
  if (declaredTasks.size) for (const [queue, task] of declaredTasks) console.log(`  Task manifest      ${queue} -> ${task.taskType} (${task.mode})`);
  console.log(`  datastore          ${database ? `reuse ${database.source}; isolated rhinoq_task schema` : localPostgres ? 'NEW local PostgreSQL service; isolated rhinoq_task schema' : 'MISSING: PostgreSQL is a required new service'}`);
  console.log('  extra process      none for the Task profile');
  console.log('  RhinoQ credential  none for the Task profile');
  console.log(`  generate           ${output}`);
  const missing = [!detected.pg ? 'pg' : '', !detected.bullmq ? 'bullmq' : ''].filter(Boolean);
  if (missing.length > 0) console.log(`  install            npm install @rhinoq/node ${missing.join(' ')}`);
  if (!database && !localPostgres) console.log('  local evaluation   add --local-postgres to generate a non-overwriting Compose service');
  if (!apply) {
    console.log('INFO preview only; nothing was written.');
    console.log(`NEXT ${missing.length > 0 ? `install ${missing.join(' and ')}, then ` : ''}${mode ? `generate without overwriting: npx rhinoq adopt --mode ${mode} --apply` : 'choose --mode single or --mode fanout, then rerun the preview'}`);
    return;
  }
  if (!mode && declaredTasks.size === 0) {
    fail('adopt --apply requires an explicit Task mode or a declaration for every detected queue', 'Choose --mode single/fanout, or declare each queue with --task queue=task.name:single');
  }
  if (missing.length > 0) fail('adoption prerequisites are missing', `Run: npm install @rhinoq/node ${missing.join(' ')}`);
  if (!database && localPostgres) {
    const compose = resolve('compose.rhinoq.yml');
    await writeNew(compose, localPostgresTemplate());
    console.log(`PASS generated local PostgreSQL evaluation service ${compose}`);
    console.log('INFO start it with: docker compose -f compose.rhinoq.yml up -d');
    console.log('INFO then set DATABASE_URL=postgresql://rhinoq:rhinoq@127.0.0.1:55432/rhinoq');
  }
  if (queues.length > 1 && selectedQueues.length === 0 && declaredTasks.size === 0) {
    fail(`multiple BullMQ queues detected: ${queues.join(', ')}`, 'Select each intended queue explicitly with --queue <name>');
  }
  const chosen = declaredTasks.size ? [...declaredTasks.keys()] : selectedQueues.length ? [...new Set(selectedQueues)] : queues.slice(0, 1);
  for (const queue of chosen) if (queues.length && !queues.includes(queue)) fail(`BullMQ queue ${JSON.stringify(queue)} was not detected`, `Choose one of: ${queues.join(', ')}`);
  const uncovered = queues.filter((queue) => !chosen.includes(queue));
  if (uncovered.length) console.log(`WARN queues not tracked by RhinoQ: ${uncovered.join(', ')}`);
  const defaultMode = mode ?? 'single';
  const taskManifest = chosen.map((queue) => ({ queue, taskType: declaredTasks.get(queue)?.taskType ?? `${queue}.task`, mode: declaredTasks.get(queue)?.mode ?? defaultMode }));
  const written = await writeNew(output, detected.nest ? nestIntegrationTemplate(taskManifest, ownerProperty, routesPath, taskCenterPath) : integrationTemplate(defaultMode));
  if (!written) {
    console.log('INFO no integration file was changed.');
    return;
  }
  if (detected.nest) {
    const appModule = await findNestAppModule(resolve('src'));
    if (!appModule) fail('generated RhinoQ Nest module but no AppModule was found', `Import ${relative(resolve('src'), output)} into the application composition root`);
    await patchNestAppModule(appModule, output);
    console.log(`PASS generated ${output}`);
    console.log(`PASS verified AppModule import in ${appModule}`);
    if (ownerProperty) console.log(`PASS mounted owner Task routes at ${routesPath} and Task Center at ${taskCenterPath} using authenticated request.${ownerProperty}`);
    else console.log('INFO owner Task routes were not mounted because no authenticated owner property was declared.');
    console.log('NEXT set DATABASE_URL and start the application; RhinoQ health must be checked at runtime.');
    for (const producer of producers) console.log(`NEXT replace raw queue.add at ${relative(resolve('.'), producer.file)}:${producer.line} with a declared Task dispatch using stable business identity and authenticated owner identity.`);
  } else {
    console.log(`PASS generated ${output}`);
    console.log('NEXT call startRhinoQ({ pool, queue, queueEvents }) during startup, then run: npx rhinoq doctor');
  }
}

function printIntegrationEraserReport(report: RhinoQIntegrationEraserReport, showAll = false): void {
  console.log('RhinoQ Integration Eraser scan');
  console.log('  mode                 preview-only; repository was not modified');
  console.log(`  source files         ${report.filesScanned} scanned (${report.linesScanned} lines)`);
  console.log(`  ignored/generated    ${report.skippedIgnoredFiles}`);
  console.log('  Detected');
  if (report.detected.length) {
    const counts = new Map(report.detected.map((label) => [label, report.findings.filter((finding) => {
      if (label === 'status routes') return finding.category === 'status-route';
      if (label === 'polling hooks') return finding.category === 'polling-hook';
      if (label === 'BullMQ lifecycle listeners') return finding.category === 'bullmq-listener';
      if (label === 'upload proxies') return finding.category === 'upload-proxy';
      return finding.category === 'retry-timer';
    }).length]));
    for (const [label, count] of counts) console.log(`    ${label}: ${count}`);
  } else console.log('    none');
  console.log(`  replaceable estimate ${report.replaceableEstimate.files} files / ${report.replaceableEstimate.matchingLines} high-confidence matching lines`);
  console.log('  estimate note        static evidence only; not a deletion, savings or reliability claim');
  console.log('  still application    auth, handler, business verification');
  const findings = showAll ? report.findings : report.findings.slice(0, 10);
  if (findings.length) {
    console.log(`  ${showAll ? 'findings' : 'High-confidence/review findings (first 10; use --all for full evidence)'}`);
    for (const finding of findings) {
      console.log(`    ${finding.confidence.toUpperCase()} ${finding.category} ${finding.file}:${finding.line}`);
      console.log(`      evidence: ${finding.evidence || '<blank line>'}`);
      console.log(`      candidate: ${finding.replacement}`);
      if (finding.reviewReason) console.log(`      review: ${finding.reviewReason}`);
    }
  }
  const decisions = report.findings.filter((finding) => finding.confidence === 'review');
  console.log('  Needs a decision');
  if (decisions.length) for (const finding of decisions.slice(0, showAll ? decisions.length : 5)) {
    console.log(`    ${finding.file}:${finding.line} — ${finding.reviewReason ?? 'manual review required'}`);
  }
  for (const warning of report.warnings) console.log(`  WARN ${warning}`);
  console.log(`  preview changes      ${report.preview.changes.length} manual-review patch proposal(s)`);
  console.log(`  rollback             ${report.preview.rollback.kind === 'patch-preview' ? 'reverse patch preview available' : 'none required'}; no files were written, patched or deleted`);
}

async function adoptObserve(options: {
  apply: boolean;
  adapter?: 'manual' | 'sqs' | 'bullmq' | 'custom';
  output?: string;
}): Promise<void> {
  if (!options.adapter) fail('observe adoption requires --adapter', 'Run: npx rhinoq adopt --adapter custom --observe');
  const output = options.output ?? resolve('rhinoq.observe.mjs');
  console.log('RhinoQ observe-only adoption plan');
  console.log(`  adapter            ${options.adapter}`);
  console.log('  runtime ownership  observe only; no dispatch or cancellation');
  console.log('  identity           application callback; unresolved events remain visible');
  console.log('  report             durable PostgreSQL adoption facts across replicas');
  console.log('  product surface    /tasks, /task-center and /admin through createRhinoQApp');
  console.log(`  generate           ${output}`);
  if (!options.apply) {
    console.log('INFO preview only; nothing was written.');
    console.log(`NEXT generate without overwriting: npx rhinoq adopt --adapter ${options.adapter} --observe --apply`);
    return;
  }
  const written = await writeNew(output, observeIntegrationTemplate(options.adapter));
  if (!written) { console.log('INFO no observe integration file was changed.'); return; }
  const reportPath = resolve(dirname(output), 'rhinoq-adoption-report.json');
  await writeNew(reportPath, `${JSON.stringify(adoptionChecklist({ durableStore: true }), null, 2)}\n`);
  console.log(`PASS generated ${output}`);
  console.log(`PASS generated ${reportPath}`);
  console.log('NEXT implement resolveIdentity(ref) from authenticated application data, then mount rhino.http({ operatorToken }).');
  console.log('NEXT inspect await rhino.runtime.adoptionReport(); unresolvedEvents identifies identities still missing.');
}

function observeIntegrationTemplate(adapter: 'manual' | 'sqs' | 'bullmq' | 'custom'): string {
  return `import {
  PostgresAdoptionReportStore,
  createRhinoQApp,
  installAdoptionReportProfile,
} from '@rhinoq/node';

// Observe-only: the host constructs the ${adapter} adapter and retains runtime control.
// Return undefined when identity is not proven; RhinoQ reports the gap instead of guessing.
export async function startRhinoQObserve({ pool, runtimeAdapter, ownerFromRequest, resolveIdentity }) {
  await installAdoptionReportProfile(pool);
  const rhino = await createRhinoQApp({
    pool,
    adapters: [runtimeAdapter],
    ownerFromRequest,
    adoptionStore: new PostgresAdoptionReportStore(pool),
    adoptionReplicaId: process.env.RHINOQ_REPLICA_ID || 'local',
    resolveUnboundEvent: async (event) => {
      const identity = await resolveIdentity(event.ref);
      if (!identity) return undefined;
      return {
        task: {
          id: identity.taskId,
          type: identity.taskType,
          ownerId: identity.ownerId,
          definitionVersion: identity.definitionVersion || 1,
        },
        executionId: identity.executionId,
        ...(identity.itemKey ? { itemKey: identity.itemKey } : {}),
        ref: event.ref,
      };
    },
  });
  return rhino;
}
`;
}

function localPostgresTemplate(hostPort = 55432): string {
  return `services:
  rhinoq-postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: rhinoq
      POSTGRES_PASSWORD: rhinoq
      POSTGRES_DB: rhinoq
    ports:
      - "127.0.0.1:${hostPort}:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U rhinoq -d rhinoq"]
      interval: 2s
      timeout: 2s
      retries: 20
    volumes:
      - rhinoq-postgres-data:/var/lib/postgresql/data

volumes:
  rhinoq-postgres-data:
`;
}

function integrationTemplate(mode: 'single' | 'fanout'): string {
  return `import { createBullMQIntegration } from '@rhinoq/node';

// Call once from the application's existing startup/composition root.
// The returned integration owns no Redis connection and closes only RhinoQ's
// listeners, timers and PostgreSQL advisory-lease sessions.
export async function startRhinoQ({ pool, queue, queueEvents }) {
  const rhinoq = await createBullMQIntegration({
    pool,
    queue,
    events: queueEvents,
    mode: '${mode}',
  });
  await rhinoq.start();
  return rhinoq;
}
`;
}

type DeclaredTask = { queue: string; taskType: string; mode: 'single' | 'fanout' };

function nestIntegrationTemplate(tasks: DeclaredTask[], ownerProperty?: string, routesPath = '/tasks', taskCenterPath = '/task-center'): string {
  if (tasks.length === 0) fail('no BullMQ queue was selected or detected', 'Pass --queue <registered-queue-name>');
  const sections = tasks.map(({ queue, mode }, index) => {
    const suffix = `${pascal(queue)}${index + 1}`;
    return `const RHINOQ_QUEUE_EVENTS_${index} = Symbol('RHINOQ_QUEUE_EVENTS_${queue}');
const RHINOQ_INTEGRATION_${index} = Symbol('RHINOQ_INTEGRATION_${queue}');

@Injectable()
class RhinoQOwnedQueueEvents${suffix} implements OnModuleDestroy {
  constructor(@Inject(RHINOQ_QUEUE_EVENTS_${index}) private readonly events: QueueEvents) {}
  async onModuleDestroy(): Promise<void> { await this.events.close(); }
}

@Module({
  imports: [RhinoQSharedInfrastructureModule, BullModule.registerQueue({ name: '${queue}' })],
  providers: [
    {
      provide: RHINOQ_QUEUE_EVENTS_${index},
      inject: [getQueueToken('${queue}')],
      useFactory: (queue: Queue) => new QueueEvents(queue.name, { connection: queue.opts.connection }),
    },
    RhinoQOwnedQueueEvents${suffix},
  ],
  exports: [RHINOQ_POOL, RHINOQ_QUEUE_EVENTS_${index}, BullModule],
})
class RhinoQInfrastructure${suffix}Module {}

const RhinoQ${suffix}Module = RhinoQModule.forBullMQAsync({
  integrationToken: RHINOQ_INTEGRATION_${index},
  imports: [RhinoQInfrastructure${suffix}Module],
  inject: [RHINOQ_POOL, getQueueToken('${queue}'), RHINOQ_QUEUE_EVENTS_${index}],
  useFactory: (pool: Pool, queue: Queue, events: QueueEvents) => ({
    pool, queue, events, mode: '${mode}',
  }),
});`;
  }).join('\n\n');
  const moduleNames = tasks.map(({ queue }, index) => `RhinoQ${pascal(queue)}${index + 1}Module`).join(',\n    ');
  const manifest = JSON.stringify(tasks, null, 2).replace(/^/gm, '  ');
  const routeImports = ownerProperty ? ', MiddlewareConsumer, NestModule' : '';
  const integrationImports = ownerProperty ? ', RhinoQTaskIntegration, createNodeTaskCenterMiddleware' : '';
  const integrations = tasks.map((_, index) => `@Inject(RHINOQ_INTEGRATION_${index}) private readonly rhinoq${index}: RhinoQTaskIntegration`).join(',\n    ');
  const integrationList = tasks.map((_, index) => `this.rhinoq${index}`).join(', ');
  const routeImplementation = ownerProperty ? ` implements NestModule {
  constructor(
    ${integrations}
  ) {}
  configure(consumer: MiddlewareConsumer): void {
    const middleware = this.rhinoq0.middleware({
      basePath: '${routesPath}',
      ownerFromNodeRequest: (request) => readOwner(request, '${ownerProperty}'),
      health: () => aggregateRhinoQHealth([${integrationList}]),
    });
    consumer.apply(middleware).forRoutes('${routesPath}', '${routesPath}/*');
    consumer.apply(createNodeTaskCenterMiddleware({ path: '${taskCenterPath}', apiPath: '${routesPath}' })).forRoutes('${taskCenterPath}');
  }
}` : ' {}';
  const ownerReader = ownerProperty ? `
function readOwner(request: unknown, path: string): string | undefined {
  let value: unknown = request;
  for (const part of path.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

async function aggregateRhinoQHealth(integrations: RhinoQTaskIntegration[]) {
  const queues = await Promise.all(integrations.map((integration) => integration.health()));
  const status = queues.some((item) => item.status === 'down') ? 'down'
    : queues.some((item) => item.status === 'degraded') ? 'degraded' : 'ok';
  return { status, queues };
}
` : '';
  return `import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Inject, Injectable, Module, OnModuleDestroy${routeImports} } from '@nestjs/common';
import { Queue, QueueEvents } from 'bullmq';
import { Pool } from 'pg';
import { RhinoQModule${integrationImports} } from '@rhinoq/node';

const RHINOQ_POOL = Symbol('RHINOQ_POOL');

export const RHINOQ_TASK_MANIFEST = ${manifest} as const;

@Module({
  providers: [{ provide: RHINOQ_POOL, useFactory: () => new Pool() }],
  exports: [RHINOQ_POOL],
})
class RhinoQSharedInfrastructureModule {}

${sections}

@Module({
  imports: [
    ${moduleNames},
  ],
})
export class RhinoQAdoptionModule${routeImplementation}
${ownerReader}
`;
}

function pascal(value: string): string {
  const result = value.split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join('');
  return result || 'Queue';
}

function ownerPropertyPath(value: string): string {
  if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(value)) fail('--owner-property must be a dotted request property', 'Example: --owner-property user.id');
  return value;
}

function routePath(value: string): string {
  if (!/^\/[A-Za-z0-9/_-]*[A-Za-z0-9_-]$/.test(value)) fail('--routes-path must be an absolute path without a trailing slash', 'Example: --routes-path /tasks');
  return value;
}

function taskDeclaration(value: string): { queue: string; taskType: string; mode: 'single' | 'fanout' } {
  const match = /^([^=\s]+)=([A-Za-z0-9][A-Za-z0-9._-]*):(single|fanout)$/.exec(value);
  if (!match) fail('--task must be queue=task.type:single or queue=task.type:fanout', 'Example: --task mail-queue=mail.send:single');
  return { queue: match[1]!, taskType: match[2]!, mode: match[3]! as 'single' | 'fanout' };
}

async function verifyAdoptionRuntime(baseURL: string, routesPath: string, taskCenterPath: string): Promise<void> {
  let base: URL;
  try { base = new URL(baseURL); } catch { fail('--verify-url must be an absolute application URL', 'Example: --verify-url http://127.0.0.1:3000'); }
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(base.hostname))) {
    fail('--verify-url must use HTTPS outside loopback', 'Use the deployed HTTPS application URL');
  }
  let headers: Record<string, string> = {};
  const rawHeaders = process.env.RHINOQ_ADOPT_VERIFY_HEADERS;
  if (rawHeaders) {
    try { headers = JSON.parse(rawHeaders); } catch { fail('RHINOQ_ADOPT_VERIFY_HEADERS must be a JSON object', 'Example: {"authorization":"Bearer ..."}'); }
    if (!headers || typeof headers !== 'object' || Object.values(headers).some((value) => typeof value !== 'string')) fail('RHINOQ_ADOPT_VERIFY_HEADERS values must be strings', 'Provide a JSON object of request headers');
  }
  const root = base.toString().replace(/\/$/, '');
  const healthURL = `${root}${routesPath}/_health`;
  const centerURL = `${root}${taskCenterPath}`;
  const health = await fetch(healthURL, { headers });
  if (!health.ok) fail(`runtime health returned HTTP ${health.status}`, `Fix application auth/runtime wiring, then retry ${healthURL}`);
  const payload = await health.json() as { status?: unknown; database?: unknown; projector?: unknown };
  if (payload.status !== 'ok') fail(`runtime health is ${JSON.stringify(payload.status ?? 'unknown')}`, 'Inspect database/projector details and restore ownership before recruiting users');
  const center = await fetch(centerURL, { headers });
  const html = await center.text();
  if (!center.ok || !/RhinoQ|Task Center/i.test(html)) fail(`Task Center verification failed with HTTP ${center.status}`, `Mount the generated Task Center at ${taskCenterPath}`);
  console.log(`PASS application runtime health at ${healthURL}`);
  console.log(`PASS Task Center reachable at ${centerURL}`);
  console.log(`PASS runtime evidence database=${String(payload.database ?? 'reported')} projector=${String(payload.projector ?? 'reported')}`);
}

async function detectNestQueues(root: string): Promise<string[]> {
  const files = await sourceFiles(root);
  const names = new Set<string>();
  const calls = /BullModule\.registerQueue(?:Async)?\s*\(([\s\S]*?)\)\s*[,;]?/g;
  const name = /\bname\s*:\s*(['"])([^'"\r\n]+)\1/g;
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const call of source.matchAll(calls)) {
      for (const match of call[1]!.matchAll(name)) names.add(match[2]!);
    }
  }
  return [...names].sort();
}

type QueueAddLocation = { file: string; line: number };
async function detectQueueAdds(root: string): Promise<QueueAddLocation[]> {
  const found: QueueAddLocation[] = [];
  for (const file of await sourceFiles(root)) {
    const source = await readFile(file, 'utf8');
    const pattern = /\b(?:this\.)?[A-Za-z_$][\w$]*queue[\w$]*\.add\s*\(/gi;
    for (const match of source.matchAll(pattern)) found.push({ file, line: source.slice(0, match.index).split('\n').length });
  }
  return found;
}

async function sourceFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const nested = await Promise.all(entries.flatMap((entry) => {
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) return [sourceFiles(path)];
      return entry.isFile() && path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [Promise.resolve([path])] : [];
    }));
    return nested.flat();
  } catch { return []; }
}

async function findNestAppModule(root: string): Promise<string | undefined> {
  const files = await sourceFiles(root);
  for (const file of files) if (/export\s+class\s+AppModule\b/.test(await readFile(file, 'utf8'))) return file;
  return undefined;
}

async function patchNestAppModule(appModule: string, generated: string): Promise<void> {
  let source = await readFile(appModule, 'utf8');
  if (source.includes('RhinoQAdoptionModule')) return;
  let specifier = relative(dirname(appModule), generated).replace(/\\/g, '/').replace(/\.ts$/, '');
  if (!specifier.startsWith('.')) specifier = `./${specifier}`;
  source = `import { RhinoQAdoptionModule } from '${specifier}';\n${source}`;
  const replaced = source.replace(/imports\s*:\s*\[/, 'imports: [\n    RhinoQAdoptionModule,');
  if (replaced === source) fail(`could not safely patch Nest imports in ${appModule}`, `Import RhinoQAdoptionModule from ${specifier} manually`);
  await writeFile(appModule, replaced);
}

async function verify(args: string[]): Promise<void> {
  const action = args[0];
  if (action === 'add') {
    await addRule(args.slice(1));
    return;
  }
  if (action === 'apply') {
    await applyRule(args.slice(1));
    return;
  }
  if (action === 'run') {
    await runRule(args.slice(1));
    return;
  }
  if (action === 'delete') {
    await deleteRule(args.slice(1));
    return;
  }
  fail('verify requires `add`, `apply`, `run` or `delete`', 'Run: npx rhinoq verify add completed-report-has-output');
}

async function addRule(args: string[]): Promise<void> {
  const name = ruleName(args[0]);
  const path = resolve('.rhinoq', 'rules', `${name}.sql`);
  await mkdir(resolve('.rhinoq', 'rules'), { recursive: true });
  await writeNew(path, ruleTemplate());
  console.log(`PASS generated ${path}`);
  console.log(`NEXT edit table/column names, then apply it through the Go Gateway: npx rhinoq verify apply ${name} --subject-type report`);
}

async function applyRule(args: string[]): Promise<void> {
  const name = ruleName(args[0]);
  const options = parseRuleOptions(args.slice(1));
  const query = await readRule(name);
  const localError = validateLocalRuleQuery(query, true);
  if (localError) fail(`Rule file is invalid: ${localError}`, `Edit .rhinoq/rules/${name}.sql, then run: npx rhinoq doctor`);

  // Applying an existing Rule appends a new immutable version, and Findings
  // stay attached to the version that observed them. A silent bump therefore
  // cuts the history an operator was reading without telling anyone, so the
  // change is shown and a changed definition needs --force.
  const current = await readRemoteRule(name);
  if (current) {
    const changes = describeRuleChanges(current, query, options);
    if (changes.length === 0) {
      console.log(`KEEP Rule ${name}@v${current.version ?? '?'} already matches .rhinoq/rules/${name}.sql; nothing was applied.`);
      console.log(`NEXT run a bounded check: npx rhinoq verify run ${name}`);
      return;
    }
    console.log(`WARN Rule ${name} already exists at v${current.version ?? '?'} and this definition differs:`);
    for (const change of changes) console.log(`  ${change}`);
    console.log(`INFO applying registers v${(current.version ?? 0) + 1}. Findings recorded against ${name}@v${current.version ?? '?'} keep that version and will not be reopened.`);
    if (!options.force) {
      fail(`Rule ${name} already exists with a different definition`, `Review the diff above, then run: npx rhinoq verify apply ${name} --force`);
    }
  }

  const response = await gatewayRequest('/v1/rules', {
    method: 'POST',
    body: JSON.stringify({
      id: name,
      name: humanizeRuleName(name),
      scope: 'table',
      subjectType: options.subjectType,
      query,
      baselineAt: options.baselineAt,
      everyMs: options.everyMs,
      withinMs: options.withinMs,
      maxRows: options.maxRows,
      statementTimeoutMs: options.statementTimeoutMs,
      maxPlanCost: options.maxPlanCost,
      maxSeqScanRows: options.maxSeqScanRows,
    }),
  });
  const record = (response as { rule?: RuleResponse }).rule ?? response as RuleResponse;
  if (!record.id) fail('Gateway returned no Rule record', 'Check the Go Gateway logs and retry the apply command');
  if (record.status === 'draft') {
    await gatewayRequest(`/v1/rules/${encodeURIComponent(record.id)}/disable`, { method: 'POST' });
  }
  console.log(`PASS applied Rule ${record.id}@v${record.version ?? '?'}; status=disabled`);
  console.log(`NEXT run a bounded check: npx rhinoq verify run ${name}`);
}

async function runRule(args: string[]): Promise<void> {
  const name = ruleName(args[0]);
  const options = parseRuleOptions(args.slice(1), true);
  await gatewayRequest(`/v1/rules/${encodeURIComponent(name)}/enable`, { method: 'POST' });
  let evaluation: RuleEvaluationResponse;
  try {
    evaluation = await gatewayRequest(`/v1/rules/${encodeURIComponent(name)}/evaluate`, {
      method: 'POST',
      body: JSON.stringify({ subjectId: options.subjectId, cursor: options.cursor }),
    }) as RuleEvaluationResponse;
  } finally {
    await gatewayRequest(`/v1/rules/${encodeURIComponent(name)}/disable`, { method: 'POST' }).catch(() => undefined);
  }
  const observations = Array.isArray(evaluation.observations) ? evaluation.observations : [];
  const violated = observations.filter((item) => item.status === 'violated');
  const unknown = observations.filter((item) => item.status === 'unknown');
  console.log(`PASS evaluated ${name}: ${observations.length} subject(s), ${violated.length} violated, ${unknown.length} unknown`);
  if (observations.length === 0) {
    console.log('INFO 0 subject matched. The Rule baseline may exclude older rows by design; to inspect existing data once, rerun verify apply with --baseline <ISO date>.');
  }
  for (const item of [...violated, ...unknown]) {
    const reason = item.reason ? ` · ${item.reason}` : '';
    console.log(`  ${item.status.toUpperCase()} ${item.subjectId}${reason}`);
    if (item.evidence) console.log(`    evidence: ${item.evidence}`);
  }
  if (evaluation.hasMore && evaluation.nextCursor) console.log(`NEXT resume with: npx rhinoq verify run ${name} --cursor ${evaluation.nextCursor}`);
}

// readRemoteRule returns the current Rule, or undefined when there is none.
// A Gateway that predates GET /v1/rules/{id} answers 404 the same way an
// unknown Rule does, so the caller treats both as "nothing to compare" rather
// than blocking an apply on a missing endpoint.
async function readRemoteRule(name: string): Promise<RuleWireRecord | undefined> {
  const response = await gatewayRequest(`/v1/rules/${encodeURIComponent(name)}`, { method: 'GET' }, true);
  if (!response) return undefined;
  const record = (response as { rule?: RuleWireRecord }).rule ?? response as RuleWireRecord;
  return record?.id ? record : undefined;
}

// describeRuleChanges lists what an apply would alter. The query is reported
// line by line because "the query changed" is not something a reviewer can act
// on, and this is the moment the reviewer is present.
function describeRuleChanges(current: RuleWireRecord, query: string, options: RuleOptions): string[] {
  const changes: string[] = [];
  const compare = (label: string, before: unknown, after: unknown): void => {
    if (before === undefined || before === null) return;
    if (String(before) !== String(after)) changes.push(`${label}: ${String(before)} -> ${String(after)}`);
  };
  compare('subject type', current.subjectType, options.subjectType);
  compare('every', `${current.everyMs}ms`, `${options.everyMs}ms`);
  compare('within', `${current.withinMs}ms`, `${options.withinMs}ms`);
  compare('max rows', current.maxRows, options.maxRows);
  compare('statement timeout', `${current.statementTimeoutMs}ms`, `${options.statementTimeoutMs}ms`);
  compare('max plan cost', current.maxPlanCost, options.maxPlanCost);
  compare('max seq scan rows', current.maxSeqScanRows, options.maxSeqScanRows);
  changes.push(...queryDiff(current.query ?? '', query));
  return changes;
}

function queryDiff(before: string, after: string): string[] {
  const beforeLines = before.replace(/\n+$/, '').split('\n');
  const afterLines = after.replace(/\n+$/, '').split('\n');
  const changes: string[] = [];
  for (let index = 0; index < Math.max(beforeLines.length, afterLines.length); index += 1) {
    const oldLine = beforeLines[index] ?? '';
    const newLine = afterLines[index] ?? '';
    if (oldLine === newLine) continue;
    if (oldLine) changes.push(`query line ${index + 1} - ${oldLine}`);
    if (newLine) changes.push(`query line ${index + 1} + ${newLine}`);
  }
  return changes;
}

// deleteRule previews by default. The Gateway computes the plan inside the
// transaction that would perform it, so what is printed here is what would
// actually be removed rather than a second query's opinion of it.
async function deleteRule(args: string[]): Promise<void> {
  const name = ruleName(args[0]);
  let purgeFindings = false;
  let apply = false;
  for (const raw of args.slice(1)) {
    if (raw === '--purge-findings') { purgeFindings = true; continue; }
    if (raw === '--apply') { apply = true; continue; }
    fail(`unknown delete option ${JSON.stringify(raw)}`, `Run: npx rhinoq verify delete ${name} --apply`);
  }
  const query = new URLSearchParams({
    purgeFindings: String(purgeFindings),
    dryRun: String(!apply),
  });
  const response = await gatewayRequest(`/v1/rules/${encodeURIComponent(name)}?${query}`, { method: 'DELETE' });
  const deletion = (response as { deletion?: RuleDeletionResponse }).deletion ?? {};
  console.log(`RhinoQ deletion plan for Rule ${name}`);
  console.log(`  definitions      ${deletion.versions?.length ?? 0} (v${(deletion.versions ?? []).join(',') || '—'})`);
  console.log(`  explain records  ${deletion.explanations ?? 0}`);
  console.log(`  schedules        ${deletion.schedules ?? 0}`);
  console.log(`  subject outcomes ${deletion.outcomes ?? 0}`);
  if (purgeFindings) {
    console.log(`  findings         ${deletion.findings ?? 0} (discarded)`);
    console.log(`  finding history  ${deletion.findingEvents ?? 0} (discarded)`);
  }
  if (!deletion.applied) {
    console.log('INFO nothing was deleted.');
    console.log(`NEXT perform this plan: npx rhinoq verify delete ${name} --apply`);
    return;
  }
  console.log(`PASS Rule ${name} deleted.`);
}

type RuleResponse = { id: string; version?: number; status?: string };
type RuleWireRecord = {
  id?: string;
  version?: number;
  status?: string;
  subjectType?: string;
  query?: string;
  everyMs?: number;
  withinMs?: number;
  maxRows?: number;
  statementTimeoutMs?: number;
  maxPlanCost?: number;
  maxSeqScanRows?: number;
};
type RuleDeletionResponse = {
  versions?: number[];
  explanations?: number;
  schedules?: number;
  outcomes?: number;
  findings?: number;
  findingEvents?: number;
  applied?: boolean;
};
type RuleEvaluationResponse = {
  observations?: Array<{ subjectId: string; status: string; reason?: string; evidence?: string }>;
  hasMore?: boolean;
  nextCursor?: string;
};

type RuleOptions = {
  subjectType: string;
  baselineAt: string;
  everyMs: number;
  withinMs: number;
  maxRows: number;
  statementTimeoutMs: number;
  maxPlanCost: number;
  maxSeqScanRows: number;
  subjectId: string;
  cursor: string;
  force: boolean;
};

function ruleName(value: string | undefined): string {
  const name = value?.trim() ?? '';
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(name)) fail('rule name must be 2-63 lowercase letters, digits or dashes', 'Example: completed-report-has-output');
  return name;
}

function parseRuleOptions(args: string[], runOnly = false): RuleOptions {
  const options: RuleOptions = {
    subjectType: process.env.RHINOQ_RULE_SUBJECT_TYPE ?? 'report',
    baselineAt: new Date().toISOString(),
    everyMs: 5 * 60_000,
    withinMs: 0,
    maxRows: 500,
    statementTimeoutMs: 5_000,
    maxPlanCost: 100_000,
    maxSeqScanRows: 10_000,
    subjectId: '',
    cursor: '',
    force: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    // --force takes no value, so it must be recognised before the generic
    // "next argument is the value" step consumes the flag that follows it.
    if (raw === '--force') {
      if (runOnly) fail('--force is only valid for verify apply', `Run: npx rhinoq verify apply <rule-name> --force`);
      options.force = true;
      continue;
    }
    const [key, inline] = raw.split('=', 2);
    const value = inline ?? args[++index];
    switch (key) {
      case '--subject-type': options.subjectType = requiredOption(key, value); break;
      case '--baseline': options.baselineAt = requiredOption(key, value); break;
      case '--every': options.everyMs = durationMs(requiredOption(key, value), key); break;
      case '--within': options.withinMs = durationMs(requiredOption(key, value), key); break;
      case '--max-rows': options.maxRows = positiveInteger(key, value); break;
      case '--statement-timeout': options.statementTimeoutMs = durationMs(requiredOption(key, value), key); break;
      case '--max-plan-cost': options.maxPlanCost = positiveNumber(key, value); break;
      case '--max-seq-scan-rows': options.maxSeqScanRows = positiveInteger(key, value); break;
      case '--subject':
        if (!runOnly) fail(`${key} is only valid for verify run`, 'Run: npx rhinoq verify run <rule-name> --subject <id>');
        options.subjectId = requiredOption(key, value); break;
      case '--cursor':
        if (!runOnly) fail(`${key} is only valid for verify run`, 'Run: npx rhinoq verify run <rule-name> --cursor <cursor>');
        options.cursor = requiredOption(key, value); break;
      default: fail(`unknown verify option ${JSON.stringify(key)}`, 'Run: npx rhinoq verify apply <rule-name> --subject-type report');
    }
  }
  return options;
}

function requiredOption(key: string, value: string | undefined): string {
  if (!value?.trim()) fail(`${key} requires a value`, `Run: npx rhinoq verify apply <rule-name> --subject-type report`);
  return value.trim();
}

function positiveInteger(key: string, value: string | undefined): number {
  const parsed = Number(requiredOption(key, value));
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${key} must be a positive integer`, 'Use a bounded positive value');
  return parsed;
}

function positiveNumber(key: string, value: string | undefined): number {
  const parsed = Number(requiredOption(key, value));
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`${key} must be positive`, 'Use a bounded positive value');
  return parsed;
}

function durationMs(value: string, key: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) fail(`${key} must use a duration such as 5m, 30s or 2h`, 'Use a positive duration');
  const units: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const result = Number(match[1]) * (units[match[2]!] ?? 0);
  if (!Number.isFinite(result) || result <= 0) fail(`${key} must be positive`, 'Use a positive duration');
  return Math.round(result);
}

async function readRule(name: string): Promise<string> {
  const path = resolve('.rhinoq', 'rules', `${name}.sql`);
  try { return await readFile(path, 'utf8'); }
  catch { fail(`Rule file not found: ${path}`, `Run: npx rhinoq verify add ${name}`); }
}

function ruleTemplate(): string {
  return `SELECT id::text AS subject_id,
       output_url IS NULL AS violated,
       jsonb_build_object('status', status, 'hasOutput', output_url IS NOT NULL) AS evidence
FROM completed_reports
WHERE created_at >= $1
  AND id::text > $2
ORDER BY id
LIMIT $3
`;
}

function validateLocalRuleQuery(query: string, tableRule = false): string | undefined {
  const trimmed = query.trim();
  if (!trimmed) return 'query is empty';
  if (trimmed.length > 32 * 1024) return 'query exceeds 32 KiB';
  if (!/^(select|with)\s/i.test(trimmed)) return 'query must start with SELECT or WITH';
  if (/[;]|--|\/\*|\*\//.test(trimmed)) return 'comments and multiple statements are not allowed';
  if (!trimmed.includes('$1')) return 'query must contain $1';
  if (tableRule && (!trimmed.includes('$2') || !trimmed.includes('$3'))) return 'table Rule must contain $2 and $3';
  return undefined;
}

function humanizeRuleName(name: string): string {
  return name.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

async function gatewayRequest(path: string, init: RequestInit, allowMissing = false): Promise<any> {
  const base = (process.env.RHINOQ_AGENT_URL ?? process.env.RHINOQ_GATEWAY_URL ?? '').replace(/\/+$/, '');
  if (!base) fail('RHINOQ_AGENT_URL/RHINOQ_GATEWAY_URL is not set', 'Start the Go Gateway with the full Rule schema, set its URL and retry');
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  const token = process.env.RHINOQ_AGENT_TOKEN ?? process.env.RHINOQ_GATEWAY_TOKEN;
  if (token) headers.set('authorization', `Bearer ${token}`);
  let response: Response;
  try { response = await fetch(`${base}${path}`, { ...init, headers }); }
  catch (error) { fail(`cannot reach Go Gateway: ${safe(error)}`, 'Start the Gateway and verify RHINOQ_AGENT_URL/RHINOQ_AGENT_TOKEN'); }
  if (allowMissing && response.status === 404) {
    await response.text();
    return undefined;
  }
  const text = await response.text();
  let payload: any = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok) {
    const message = payload?.error?.message ?? payload?.error ?? payload?.message ?? text;
    fail(`Go Gateway returned HTTP ${response.status}: ${message}`, 'Inspect the Rule schema, table/column names and Explain safety limits');
  }
  return payload;
}

// doctor checks the isolated Task profile and local Rule files. It is
// deliberately not the Go `rhinoq doctor`, which also validates worker
// identity, lease/heartbeat/reaper timing and migration state. They share a
// name because they answer the same question for different planes, so this one
// says out loud what it did not look at: a PASS here is not a runtime PASS.
async function doctor(args: string[] = []): Promise<void> {
  const planFrom = compilerPlanPath(args);
  if (planFrom) {
    const current = await readCanonicalPlan(resolve(planFrom));
    const workflow = runRhinoQCompilerWorkflow({ action: 'doctor', plan: current });
    console.log(`PASS compiler plan ${current.fingerprint} checked by doctor (${workflow.diagnostics.length} diagnostic(s)).`);
    for (const item of workflow.diagnostics) console.log(`${item.severity.toUpperCase()} ${item.code}: ${item.whatHappened}`);
    if (workflow.status !== 'ready') fail('compiler plan is not ready for this deployment', 'Resolve compiler diagnostics and regenerate the plan');
    if (args.includes('--plan-only')) return;
  }
  if (args.includes('--product-surface')) {
    const path = resolve('.rhinoq/product-surface.json');
    let value: Record<string, unknown> = {};
    try { value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; }
    catch { console.log(`WARN ${relative(resolve('.'), path)} is missing or invalid.`); }
    console.log('INFO product surface callbacks and guarantees:');
    for (const [field, consequence] of [
      ['owner', 'owner isolation cannot be proven'], ['tenant', 'tenant authorization cannot be proven'],
      ['result', 'recorded results are not downloadable'], ['verifier', 'business outcome remains unverified'],
      ['runtimeIdentity', 'runtime correlation may be unstable'], ['durableStore', 'adoption data is process-local'],
    ] as const) console.log(`${value[field] === true ? 'PASS' : 'WARN'} ${field}: ${value[field] === true ? 'configured' : consequence}`);
    if (args.length === 1) return;
  }
  if (args.includes('--fix')) {
    await doctorFix();
    if (!database()) {
      console.log('INFO no PostgreSQL connection was available; local files were fixed, runtime checks were not run.');
      console.log('NEXT set DATABASE_URL (or PGHOST/PGDATABASE and friends), then run: npx rhinoq doctor');
      return;
    }
  }
  const resolved = requireDatabase('doctor');
  console.log('INFO scope: Task schema, local Rule files and client packages.');
  console.log('INFO not checked here: worker identity, lease/heartbeat/reaper timing,');
  console.log('     RhinoQ migration state. Those need the Go CLI: rhinoq doctor --ci');
  console.log(`INFO PostgreSQL target ${resolved.target} from ${resolved.source}.`);
  const pool = new Pool({ ...withPostgresOption(resolved.pool, '-c rhinoq.tenant_id=default'), connectionTimeoutMillis: 5_000 });
  let invalidRules = false;
  try {
    await pool.query('SELECT 1');
    const result = await pool.query<{ version: number }>('SELECT COALESCE(MAX(version),0)::int AS version FROM rhinoq_task.migrations');
    const installed = result.rows[0]?.version ?? 0;
    if (installed !== TASK_SCHEMA_VERSION) fail(`Task schema is v${installed}; SDK needs v${TASK_SCHEMA_VERSION}`, 'Run: npx rhinoq init');
    console.log('PASS PostgreSQL reachable.');
    console.log(`PASS Task schema v${installed} current.`);
    await doctorRuntime(pool);
    invalidRules = await doctorRules(pool);
  } finally { await pool.end(); }
  if (invalidRules) fail('one or more local Rule files failed the safety contract', 'Edit the reported .rhinoq/rules/*.sql files, then rerun: npx rhinoq doctor');
  if (process.env.REDIS_URL) console.log('PASS REDIS_URL detected for BullMQ.');
  else console.log('INFO REDIS_URL is absent; this is fine unless the app uses BullMQ.');
  console.log('NEXT create the visible failure fixture: npx rhinoq fixture failure');
  console.log('NEXT before a pilot, run the runtime checks too: rhinoq doctor --ci');
}

async function doctorFix(): Promise<void> {
  await mkdir(resolve('.rhinoq', 'rules'), { recursive: true });
  const configPath = resolve('.rhinoq', 'config.json');
  const configWritten = await writeNew(configPath, `${JSON.stringify({
    schemaVersion: 1,
    databaseEnv: database()?.source ?? 'DATABASE_URL',
    taskProfileVersion: TASK_SCHEMA_VERSION,
  }, null, 2)}\n`);
  const envPath = resolve('.env.rhinoq.example');
  const envWritten = await writeNew(envPath, [
    '# Local connection only; never commit real credentials.',
    'DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app',
    'RHINOQ_OPERATOR_TOKEN=replace-with-at-least-32-random-bytes',
    'RHINOQ_REPLICA_ID=local-dev',
    '',
  ].join('\n'));
  console.log(`PASS doctor --fix ${configWritten ? 'created' : 'kept'} ${configPath}`);
  console.log(`PASS doctor --fix ${envWritten ? 'created' : 'kept'} ${envPath}`);
  console.log('INFO --fix only repairs local plumbing; it never chooses Task semantics, owner identity or security policy.');
}

/**
 * What the running system looks like, not what it was configured to look like.
 *
 * Reaching PostgreSQL and finding the right schema version says the wiring is
 * plausible. It does not say a projector is running, that the last batch ever
 * finished, or that a settled batch was ever acted on — and those are the
 * questions someone actually has at 2am. Every check here is a read.
 */
async function doctorRuntime(pool: Pool): Promise<void> {
  const totals = await pool.query<{ tasks: string; executions: string }>(
    `SELECT (SELECT count(*) FROM rhinoq_task.tasks) AS tasks,
            (SELECT count(*) FROM rhinoq_task.executions) AS executions`,
  );
  const taskCount = Number(totals.rows[0]?.tasks ?? 0);
  if (taskCount === 0) {
    console.log('INFO no Tasks recorded yet; runtime checks need traffic to say anything.');
    return;
  }
  console.log(
    `INFO ${taskCount} Task(s), ${Number(totals.rows[0]?.executions ?? 0)} attempt(s) recorded.`,
  );

  // A Task that has not moved in an hour is either finished work nobody closed
  // or a batch whose projector stopped. Both look identical from the app.
  const stalled = await pool.query<{ count: string; oldest: string | null }>(
    `SELECT count(*) AS count, min(updated_at)::text AS oldest
     FROM rhinoq_task.tasks
     WHERE state IN ('pending', 'queued', 'running')
       AND updated_at < now() - interval '1 hour'`,
  );
  const stalledCount = Number(stalled.rows[0]?.count ?? 0);
  if (stalledCount > 0) {
    console.log(
      `WARN ${stalledCount} Task(s) unfinished and idle over an hour, oldest ${stalled.rows[0]?.oldest}.`,
    );
    console.log('     Either no bridge is projecting them, or nothing decides what a stuck');
    console.log('     batch means. Schedule TaskReconciler; RhinoQ will not guess.');
  } else {
    console.log('PASS no unfinished Task idle for over an hour.');
  }

  // Items all terminal but the Task still open: onItemsSettled either is not
  // wired, or its handler is throwing. The signal fired and nobody caught it.
  const settled = await pool.query<{ count: string }>(
    `SELECT count(*) AS count FROM rhinoq_task.tasks
     WHERE items_settled_at IS NOT NULL
       AND state NOT IN ('succeeded', 'failed', 'cancelled')`,
  );
  const settledOpen = Number(settled.rows[0]?.count ?? 0);
  if (settledOpen > 0) {
    console.log(`WARN ${settledOpen} Task(s) have every item terminal but are not terminal themselves.`);
    console.log('     Under aggregate.terminal: manual — the default — only the application');
    console.log('     closes them. Wire onItemsSettled, or terminalize on the settled signal.');
  } else {
    console.log('PASS no Task left open after all its items finished.');
  }

  // An attempt reserved but never observed means the dispatch happened and the
  // projection did not: the bridge is missing, or it is not on this scope.
  const undispatched = await pool.query<{ runtime_scope: string; count: string }>(
    `SELECT runtime_scope, count(*) AS count
     FROM rhinoq_task.executions
     WHERE state IN ('pending_dispatch', 'dispatched')
       AND updated_at < now() - interval '15 minutes'
     GROUP BY runtime_scope ORDER BY count DESC LIMIT 5`,
  );
  if (undispatched.rows.length > 0) {
    for (const row of undispatched.rows) {
      const scope = row.runtime_scope || '(no runtimeScope)';
      console.log(`WARN ${row.count} attempt(s) in scope ${scope} dispatched but never observed for 15m.`);
    }
    console.log('     That is what a stopped projector looks like from the database.');
    console.log('     Check the bridge process and rhinoq_bridge_lease_lost_total.');
  } else {
    console.log('PASS no attempt left dispatched-but-unobserved.');
  }

  // Who holds a projector lease right now. An advisory lock is session-scoped,
  // so this is live truth rather than a heartbeat table that can go stale.
  const leases = await pool.query<{ count: string }>(
    `SELECT count(*) AS count FROM pg_locks
     WHERE locktype = 'advisory' AND granted AND objsubid = 1`,
  );
  const scopes = new Set(
    (await pool.query<{ runtime_scope: string }>(
      `SELECT DISTINCT runtime_scope FROM rhinoq_task.executions
       WHERE runtime_scope <> '' AND updated_at > now() - interval '24 hours'`,
    )).rows.map((row) => row.runtime_scope),
  );
  if (scopes.size > 0) {
    console.log(
      `INFO ${scopes.size} runtime scope(s) active in the last 24h; ` +
        `${leases.rows[0]?.count ?? 0} advisory lock(s) held on this database.`,
    );
    console.log('     A count of zero with active scopes means no PostgresProjectorLease is');
    console.log('     held: either the bridges run without one, or none of them is running.');
  }

  await doctorProjectionFailures(pool);
}

/** The failure table is application-owned, so its absence is not a fault. */
async function doctorProjectionFailures(pool: Pool): Promise<void> {
  const present = await pool.query<{ present: boolean }>(
    `SELECT to_regclass('public.rhinoq_projection_failures') IS NOT NULL AS present`,
  );
  if (present.rows[0]?.present !== true) {
    console.log('INFO no rhinoq_projection_failures table; a failed projection leaves no trace.');
    console.log('     Apply PROJECTION_FAILURE_TABLE_SQL and pass PostgresProjectionFailureSink');
    console.log('     if losing one matters. onError alone dies with the process that failed.');
    return;
  }
  const failures = await pool.query<{ count: string; attempts: string; newest: string | null }>(
    `SELECT count(*) AS count, COALESCE(sum(attempts), 0) AS attempts, max(last_seen_at)::text AS newest
     FROM rhinoq_projection_failures`,
  );
  const count = Number(failures.rows[0]?.count ?? 0);
  if (count === 0) {
    console.log('PASS projection-failure table present and empty.');
    return;
  }
  console.log(
    `WARN ${count} recorded projection failure(s), ${failures.rows[0]?.attempts} attempt(s) total, ` +
      `newest ${failures.rows[0]?.newest}.`,
  );
  console.log('     Each row is a queue event RhinoQ could not write down. Replaying one is');
  console.log('     an application decision: RhinoQ will not touch your queue on its own.');
}

async function doctorRules(pool: Pool): Promise<boolean> {
  const directory = resolve('.rhinoq', 'rules');
  let files: string[];
  try { files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort(); }
  catch { console.log('INFO no local .rhinoq/rules directory; Rule checks skipped.'); return false; }
  if (files.length === 0) {
    console.log('INFO no local Rule files found.');
    return false;
  }
  let invalid = false;
  for (const file of files) {
    const query = await readFile(resolve(directory, file), 'utf8');
    const problem = validateLocalRuleQuery(query, true);
    if (problem) {
      invalid = true;
      console.log(`FAIL Rule file ${file}: ${problem}`);
    } else {
      console.log(`PASS Rule file ${file} matches the bounded table Rule contract.`);
    }
  }
  const role = await pool.query<{ name: string; superuser: boolean }>(
    'SELECT current_user AS name, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user',
  );
  const currentRole = role.rows[0];
  if (currentRole?.superuser) {
    console.log(`WARN PostgreSQL role ${currentRole.name} is a superuser; use a restricted read-only Rule role before evaluating business SQL.`);
  } else if (currentRole) {
    console.log(`PASS PostgreSQL role ${currentRole.name} is not a superuser.`);
  }
  const relation = await pool.query<{ relation: string | null }>(
    `SELECT to_regclass('public.rhinoq_rules')::text AS relation`,
  );
  if (!relation.rows[0]?.relation) {
    console.log('INFO full Rule schema is not installed; local Rule files are linted but not applied.');
    return invalid;
  }
  const ids = files.map((file) => file.slice(0, -4));
  const applied = await pool.query<{ id: string; status: string }>(
    'SELECT id, status FROM rhinoq_rules WHERE id = ANY($1::text[])', [ids],
  );
  const appliedIDs = new Set(applied.rows.map((row) => row.id));
  for (const id of ids) {
    if (!appliedIDs.has(id)) console.log(`WARN Rule file ${id}.sql has not been applied to rhinoq_rules.`);
    else console.log(`PASS Rule ${id} is present in rhinoq_rules.`);
  }
  return invalid;
}

// notify reads and writes the same .rhinoq/notifications.json the Go CLI uses.
// A Node team could not configure a destination at all before this: the only
// path was to build a NotificationDestination in Go and embed it, which is
// exactly the team the feature was added for.
//
// `send` is deliberately absent. A real Finding delivery goes through the
// durable delivery ledger, and reimplementing that dedup here would put
// correctness in two languages.
async function notify(args: string[]): Promise<void> {
  const action = args[0];
  switch (action) {
    case 'add': await notifyAdd(args.slice(1)); return;
    case 'list': await notifyList(args.slice(1)); return;
    case 'remove': await notifyRemove(args.slice(1)); return;
    case 'test': await notifyTest(args.slice(1)); return;
    case 'send':
      fail(
        'npx rhinoq notify send is not available in the Node SDK',
        'A real Finding delivery is recorded in the durable delivery ledger, which the Go engine owns. Run: rhinoq notify send',
      );
      return;
    default:
      fail('notify requires `add`, `list`, `remove` or `test`', 'Run: npx rhinoq notify list');
  }
}

async function notifyAdd(args: string[]): Promise<void> {
  const name = destinationName(args[0]);
  const options = parseNotifyOptions(args.slice(1));
  if (!options.url && !options.urlEnv) {
    fail(
      'a destination needs --webhook <url>, --slack <url> or --url-env <VAR>',
      `Run: npx rhinoq notify add ${name} --webhook https://example.com/hooks/rhinoq`,
    );
  }
  const path = notifyRegistryPath();
  const registry = await loadNotifyRegistry(path);
  const existing = registry.destinations.findIndex((entry) => entry.name === name);
  if (existing >= 0 && !options.replace) {
    fail(`destination ${JSON.stringify(name)} already exists in ${path}`, `Run: npx rhinoq notify add ${name} --replace ...`);
  }
  const entry: NotifyDestinationEntry = {
    name,
    kind: options.kind,
    ...(options.url ? { url: options.url } : {}),
    ...(options.urlEnv ? { urlEnv: options.urlEnv } : {}),
    ...(options.secretEnv ? { secretEnv: options.secretEnv } : {}),
    ...(options.timeoutMs === 10_000 ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.includeEvidence ? { includeEvidence: true } : {}),
    ...(options.gracePeriodMs ? { gracePeriodMs: options.gracePeriodMs } : {}),
    ...(options.findingBaseUrl ? { findingBaseUrl: options.findingBaseUrl } : {}),
    createdAt: new Date().toISOString(),
  };
  if (existing >= 0) registry.destinations[existing] = entry;
  else registry.destinations.push(entry);
  registry.schemaVersion = NOTIFY_REGISTRY_VERSION;
  await saveNotifyRegistry(path, registry);
  console.log(`PASS destination ${JSON.stringify(name)} ${existing >= 0 ? 'replaced in' : 'added to'} ${path}`);
  if (!entry.secretEnv) {
    console.log('WARN no --secret-env, so events are sent unsigned and the receiver cannot tell they came from RhinoQ.');
    console.log(`NEXT sign them: npx rhinoq notify add ${name} --replace --secret-env ${defaultSecretEnv(name)} ...`);
  }
  console.log(`NEXT prove it works without writing anything: npx rhinoq notify test ${name}`);
}

async function notifyList(args: string[]): Promise<void> {
  const asJSON = args.includes('--json');
  for (const raw of args) {
    if (raw !== '--json') fail(`unknown list option ${JSON.stringify(raw)}`, 'Run: npx rhinoq notify list --json');
  }
  const path = notifyRegistryPath();
  const registry = await loadNotifyRegistry(path);
  // A Slack incoming-webhook URL is itself the credential, so even the
  // machine-readable form is redacted.
  const redacted = registry.destinations.map((entry) => ({
    ...entry,
    ...(entry.url ? { url: redactURL(entry.url) } : {}),
  }));
  if (asJSON) {
    console.log(JSON.stringify({ schemaVersion: registry.schemaVersion, destinations: redacted }, null, 2));
    return;
  }
  for (const entry of redacted) {
    console.log(`${entry.name}\t${entry.kind}\t${entry.url ?? `$${entry.urlEnv ?? ''}`}\t${entry.secretEnv ? 'signed' : 'UNSIGNED'}`);
  }
  console.log(`\n${redacted.length} destination(s) in ${path}`);
  if (redacted.length === 0) {
    console.log('NEXT add one: npx rhinoq notify add ops --webhook https://example.com/hooks/rhinoq');
  }
}

async function notifyRemove(args: string[]): Promise<void> {
  const name = destinationName(args[0]);
  const path = notifyRegistryPath();
  const registry = await loadNotifyRegistry(path);
  const remaining = registry.destinations.filter((entry) => entry.name !== name);
  if (remaining.length === registry.destinations.length) {
    fail(`no destination named ${JSON.stringify(name)} in ${path}`, 'List what is configured: npx rhinoq notify list');
  }
  await saveNotifyRegistry(path, { ...registry, destinations: remaining });
  console.log(`PASS destination ${JSON.stringify(name)} removed from ${path}`);
}

async function notifyTest(args: string[]): Promise<void> {
  const name = destinationName(args[0]);
  const path = notifyRegistryPath();
  const registry = await loadNotifyRegistry(path);
  let destination;
  try {
    destination = resolveNotifyDestination(registry, name);
  } catch (error) {
    fail(safe(error), 'List what is configured: npx rhinoq notify list');
  }
  try {
    const receipt = await sendTestNotification(destination);
    console.log(`PASS destination ${JSON.stringify(name)} accepted event ${receipt.id}`);
    console.log(`     type=${receipt.type} severity=${receipt.severity} sent=${receipt.sentAt}`);
    if (destination.secret) {
      console.log('     The receiver should have verified X-RhinoQ-Signature: v1=<hmac-sha256>.');
    } else {
      console.log('     This destination is unsigned; the receiver cannot tell the event came from RhinoQ.');
    }
    console.log('     No business data was sent and nothing was recorded.');
  } catch (error) {
    console.error(`FAIL destination ${JSON.stringify(name)} did not accept the test event: ${safe(error)}`);
    console.error('     Nothing was written; no Finding or delivery record exists.');
    console.error("     Check the URL, the receiver's signature verification and its TLS.");
    process.exitCode = 1;
    throw new Error('__reported__');
  }
}

type NotifyOptions = {
  kind: NotifyKind;
  url: string;
  urlEnv: string;
  secretEnv: string;
  timeoutMs: number;
  includeEvidence: boolean;
  gracePeriodMs: number;
  findingBaseUrl: string;
  replace: boolean;
};

function parseNotifyOptions(args: string[]): NotifyOptions {
  const options: NotifyOptions = {
    kind: 'webhook', url: '', urlEnv: '', secretEnv: '', timeoutMs: 10_000,
    includeEvidence: false, gracePeriodMs: 0, findingBaseUrl: '', replace: false,
  };
  let kindWasSet = false;
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (raw === '--replace') { options.replace = true; continue; }
    if (raw === '--include-evidence') { options.includeEvidence = true; continue; }
    const [key, inline] = raw.split('=', 2);
    const value = inline ?? args[++index];
    switch (key) {
      case '--webhook': options.kind = 'webhook'; kindWasSet = true; options.url = requiredOption(key, value); break;
      case '--slack': options.kind = 'slack'; kindWasSet = true; options.url = requiredOption(key, value); break;
      case '--url': options.url = requiredOption(key, value); break;
      case '--url-env': options.urlEnv = requiredOption(key, value); break;
      case '--kind': {
        const kind = requiredOption(key, value);
        if (kind !== 'webhook' && kind !== 'slack') fail('--kind must be webhook or slack', 'Run: npx rhinoq notify add ops --kind slack --url-env RHINOQ_NOTIFY_URL_OPS');
        options.kind = kind; kindWasSet = true; break;
      }
      case '--secret-env': options.secretEnv = requiredOption(key, value); break;
      case '--timeout': options.timeoutMs = durationMs(requiredOption(key, value), key); break;
      case '--grace': options.gracePeriodMs = durationMs(requiredOption(key, value), key); break;
      case '--link-base': options.findingBaseUrl = requiredOption(key, value); break;
      default: fail(`unknown notify option ${JSON.stringify(key)}`, 'Run: npx rhinoq notify add ops --webhook <url> --secret-env <VAR>');
    }
  }
  // A --url-env destination with no --kind would default to webhook, and a
  // Slack URL posted as a signed webhook fails in a way nobody reads as
  // "wrong kind". Make the caller say which it is.
  if (options.urlEnv && !options.url && !kindWasSet) {
    fail('--url-env needs --kind webhook or --kind slack', 'Run: npx rhinoq notify add ops --kind slack --url-env RHINOQ_NOTIFY_URL_OPS');
  }
  return options;
}

function destinationName(value: string | undefined): string {
  const name = value?.trim() ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name)) {
    fail('destination name must be 1-63 letters, digits, dots, dashes or underscores', 'Example: ops');
  }
  return name;
}

// A path or query can carry the credential, and for Slack it always does.
function redactURL(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : '/…'}`;
  } catch {
    return '(unparsable URL)';
  }
}

async function lab(args: string[]): Promise<void> {
  const action = args[0];
  const scenario = args[1] as FailureLabScenario | undefined;
  const confirmed = args.includes('--confirm-disposable');
  const recover = args.includes('--recover');
  const unknown = args.slice(2).filter((argument) => argument !== '--confirm-disposable' && argument !== '--recover');
  if (action !== 'run' || scenario !== 'completed-but-missing-output' || unknown.length > 0) {
    fail(
      'lab requires `run completed-but-missing-output`',
      'Run: npx rhinoq lab run completed-but-missing-output --confirm-disposable',
    );
  }
  if (!confirmed) {
    fail(
      'Failure Lab writes an additive incident fixture and requires disposable database confirmation',
      'Re-run against a disposable/evaluation database with --confirm-disposable',
    );
  }
  const pool = new Pool(withPostgresOption(requireDatabase(`lab run ${scenario} --confirm-disposable`).pool, '-c rhinoq.tenant_id=default'));
  try {
    const tasks = await installPostgresTaskProfile(pool);
    const result = await runFailureLab(tasks, scenario);
    console.log('NOTICE simulated repair; no external provider called.');
    console.log('NOTICE this proves the guarded workflow only, not a production provider outcome.');
    console.log(`PASS Failure Lab ${scenario}`);
    console.log(`TASK ${result.task.id} runtime=succeeded outcome=${result.explanation.businessOutcome}`);
    console.log(`WHY ${result.explanation.technicalState}`);
    console.log(`AFFECTED tasks=${result.explanation.affected.tasks} items=${result.explanation.affected.items}`);
    console.log(`SAFE NEXT ${result.explanation.recommendedActions[0]!.label}`);
    if (recover) {
      const recovered = await recoverFailureLab(tasks, result.task.id);
      console.log(`RECOVERY ${recovered.stages.join(' -> ')}`);
      console.log(`VERIFIED task=${recovered.task.state} result=${recovered.task.hasResult} stage=${recovered.recovery.stage}`);
      console.log(`SUMMARY ${recovered.incidentSummary}`);
    } else {
      console.log('NEXT complete the guarded loop with --recover, or inspect it with: npx rhinoq dev');
    }
  } finally { await pool.end(); }
}

async function fixture(args: string[]): Promise<void> {
  const name = args[0] ?? 'failure';
  if (name !== 'failure' && name !== 'async') {
    fail('unknown fixture', 'Run: npx rhinoq fixture async or npx rhinoq fixture failure');
  }
  const pool = new Pool(withPostgresOption(requireDatabase(`fixture ${name}`).pool, '-c rhinoq.tenant_id=default'));
  try {
    const tasks = await installPostgresTaskProfile(pool);
    if (name === 'async') {
      await createAsyncFixture(tasks);
      return;
    }
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

type EvalStatus = 'PASS' | 'FAIL' | 'NOT VERIFIED';
type EvalCheck = { status: EvalStatus; check: string; evidence: string };

async function evaluateProduct(args: string[]): Promise<void> {
  if (args.length > 0) fail(`unknown eval option ${JSON.stringify(args[0])}`, 'Run: npx rhinoq eval');
  const resolved = requireDatabase('eval');
  const checks: EvalCheck[] = [];
  const pool = new Pool({ ...withPostgresOption(resolved.pool, '-c rhinoq.tenant_id=default'), connectionTimeoutMillis: 5_000 });
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await pool.query('SELECT 1');
    checks.push({ status: 'PASS', check: 'PostgreSQL', evidence: `${resolved.target} (${resolved.source})` });

    const tasks = await installPostgresTaskProfile(pool);
    const migration = await pool.query<{ version: number }>('SELECT COALESCE(MAX(version),0)::int AS version FROM rhinoq_task.migrations');
    const installed = migration.rows[0]?.version ?? 0;
    if (installed !== TASK_SCHEMA_VERSION) throw new Error(`Task schema v${installed}; expected v${TASK_SCHEMA_VERSION}`);
    checks.push({ status: 'PASS', check: 'Task profile', evidence: `schema v${installed}` });

    const taskId = `eval_${Date.now()}`;
    let task = await tasks.createTask({ id: taskId, type: 'rhinoq.eval', ownerId: 'eval-user', definitionVersion: 1 });
    task = await tasks.transitionTask(taskId, task.entityVersion, 'queued');
    task = await tasks.transitionTask(taskId, task.entityVersion, 'running');
    await tasks.createTaskExecution(taskId, { id: `${taskId}:1`, runtime: 'eval', runtimeScope: 'loopback', externalId: `${taskId}:job` });
    let execution = await tasks.getTaskExecution(`${taskId}:1`);
    await tasks.bindTaskExecution(execution.id, { runtime: 'eval', runtimeScope: 'loopback', externalId: `${taskId}:job` });
    execution = await tasks.getTaskExecution(execution.id);
    await tasks.transitionTaskExecution(execution.id, execution.version, 'running');
    execution = await tasks.getTaskExecution(execution.id);
    await tasks.transitionTaskExecution(execution.id, execution.version, 'succeeded');
    task = await tasks.getTask(taskId);
    await tasks.transitionTask(taskId, task.entityVersion, 'uncertain');
    checks.push({ status: 'PASS', check: 'Durable fixture', evidence: `${taskId}: execution=succeeded, task=uncertain` });

    const taskCenter = createNodeTaskCenterMiddleware({ path: '/task-center', apiPath: '/tasks' });
    const routes = createNodeTaskMiddleware({ tasks, basePath: '/tasks', ownerFromRequest: () => 'eval-user' });
    const workbench = createNodeWorkbenchMiddleware({ tasks, basePath: '/admin', requireOperator: () => true });
    server = createServer((request, response) => {
      taskCenter(request, response, () => routes(request, response, () => workbench(request, response)));
    });
    await new Promise<void>((ready, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', ready);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('loopback evaluation server has no TCP address');
    const base = `http://127.0.0.1:${address.port}`;

    const owner = await fetch(`${base}/tasks/${encodeURIComponent(taskId)}`);
    if (!owner.ok || (await owner.json() as { id?: string }).id !== taskId) throw new Error(`owner Task API returned HTTP ${owner.status}`);
    checks.push({ status: 'PASS', check: 'Owner Task API', evidence: `GET /tasks/${taskId} returned the fixture` });

    const center = await fetch(`${base}/task-center`);
    const centerHTML = await center.text();
    if (!center.ok || !centerHTML.includes('data-rhinoq-task-center')) throw new Error(`Task Center returned HTTP ${center.status}`);
    checks.push({ status: 'PASS', check: 'Task Center', evidence: 'loopback HTML and owner API wiring reachable' });

    const admin = await fetch(`${base}/admin`);
    const adminHTML = await admin.text();
    if (!admin.ok || !adminHTML.includes('RhinoQ Workbench')) throw new Error(`Workbench returned HTTP ${admin.status}`);
    checks.push({ status: 'PASS', check: 'Workbench', evidence: 'loopback operator HTML reachable' });
  } catch (error) {
    checks.push({ status: 'FAIL', check: 'Evaluation stopped', evidence: safe(error) });
  } finally {
    if (server?.listening) await new Promise<void>((closed) => server!.close(() => closed()));
    await pool.end();
  }

  checks.push(
    { status: 'NOT VERIFIED', check: 'Browser journey', evidence: 'run the printed surfaces in a real browser for layout, keyboard and reconnect evidence' },
    { status: 'NOT VERIFIED', check: 'External provider', evidence: 'no provider credential or readback callback was supplied' },
    { status: 'NOT VERIFIED', check: 'Deployment faults', evidence: 'single-process loopback evaluation does not prove failover or multi-replica behavior' },
  );
  console.log('RhinoQ evaluation checklist');
  for (const item of checks) console.log(`${item.status.padEnd(12)} ${item.check.padEnd(20)} ${item.evidence}`);
  if (checks.some((item) => item.status === 'FAIL')) {
    process.exitCode = 1;
    throw new Error('__reported__');
  }
  console.log('NEXT open a persistent local Workbench with: npx rhinoq dev');
}

/**
 * Generic RhinoQ onboarding fixture: one completed execution, one failed
 * execution and one expired approval. It deliberately uses no application
 * domain, so the Workbench shows the platform's async control loop itself.
 */
async function createAsyncFixture(tasks: Awaited<ReturnType<typeof installPostgresTaskProfile>>): Promise<void> {
  const id = `async_demo_${Date.now()}`;
  let task = await tasks.createTask({ id, type: 'workflow.process', ownerId: 'demo-user', definitionVersion: 1 });
  task = await tasks.transitionTask(id, task.entityVersion, 'queued');
  task = await tasks.transitionTask(id, task.entityVersion, 'running');

  await tasks.createTaskExecution(id, {
    id: `${id}:approved`, itemKey: 'approved-step', runtime: 'demo', runtimeScope: 'onboarding',
    externalId: `${id}:approved-job`,
  });
  let completed = await tasks.getTaskExecution(`${id}:approved`);
  await tasks.bindTaskExecution(completed.id, { runtime: 'demo', runtimeScope: 'onboarding', externalId: `${id}:approved-job` });
  completed = await tasks.getTaskExecution(completed.id);
  await tasks.transitionTaskExecution(completed.id, completed.version, 'running');
  completed = await tasks.getTaskExecution(completed.id);
  await tasks.transitionTaskExecution(completed.id, completed.version, 'succeeded');
  completed = await tasks.getTaskExecution(completed.id);
  await tasks.attachTaskExecutionResult(completed.id, completed.version, `demo://result/${id}/approved-step`);

  await tasks.createTaskExecution(id, {
    id: `${id}:failed`, itemKey: 'provider-step', runtime: 'demo', runtimeScope: 'onboarding',
    externalId: `${id}:failed-job`,
  });
  let failed = await tasks.getTaskExecution(`${id}:failed`);
  await tasks.bindTaskExecution(failed.id, { runtime: 'demo', runtimeScope: 'onboarding', externalId: `${id}:failed-job` });
  failed = await tasks.getTaskExecution(failed.id);
  await tasks.transitionTaskExecution(failed.id, failed.version, 'running');
  failed = await tasks.getTaskExecution(failed.id);
  await tasks.transitionTaskExecution(failed.id, failed.version, 'failed', 'demo provider returned a transient 502');

  await tasks.createTaskWaitpoint(id, {
    id: `${id}:approval`, key: 'operator-approval', kind: 'approval', payloadVersion: 1,
    deadline: new Date(Date.now() - 60_000).toISOString(),
  });
  const expired = await tasks.expireTaskWaitpoints(100);
  console.log(`PASS created ${id}: one result, one failed attempt, and ${expired} expired approval waitpoint.`);
  console.log('NEXT open the generic RhinoQ timeline: npx rhinoq dev');
}

async function dev(args: string[]): Promise<void> {
  const planFrom = compilerPlanPath(args);
  if (planFrom) {
    const current = await readCanonicalPlan(resolve(planFrom));
    const workflow = runRhinoQCompilerWorkflow({ action: 'dev', plan: current });
    if (workflow.status !== 'ready' || !workflow.dev) fail('compiler plan is not ready for dev', 'Add deployment identity, resolve diagnostics and regenerate the plan');
    console.log(`PASS dev plan ${current.fingerprint} namespace=${workflow.dev.namespace} handlers=${workflow.dev.handlers.join(',') || '(none)'}`);
  }
  if (args.includes('--demo')) {
    await demoDev(args);
    return;
  }
  const portValue = Number(args.find((item) => item.startsWith('--port='))?.slice(7) ?? 8788);
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) fail('port must be 1..65535', 'Example: npx rhinoq dev --port=8788');
  const pool = new Pool(withPostgresOption(requireDatabase('dev').pool, '-c rhinoq.tenant_id=default'));
  const tasks = await installPostgresTaskProfile(pool);
  const expiry = new WaitpointExpiryScheduler({
    tasks,
    everyMs: 30_000,
    onExpired: (count) => console.log(`INFO expired ${count} waitpoint(s); inspect Needs attention in the Flight Recorder.`),
    onError: () => console.error('WARN waitpoint expiry sweep failed; the next bounded sweep will retry.'),
  });
  expiry.start();
  const workbench = createNodeWorkbenchMiddleware({
    tasks,
    basePath: '/rhinoq',
    // `dev` binds to loopback and is an inspection surface only. Production
    // applications must mount the same middleware behind real operator auth.
    requireOperator: () => true,
  });
  const server = createServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(302, { location: '/rhinoq', 'cache-control': 'no-store' });
      response.end();
      return;
    }
    workbench(request, response);
  });
  server.listen(portValue, '127.0.0.1', () => console.log(`PASS RhinoQ Workbench: http://127.0.0.1:${portValue}/rhinoq\nNEXT press Ctrl+C to stop.`));
  const close = () => { expiry.stop(); server.close(() => pool.end().finally(() => process.exit(0))); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}

function compilerPlanPath(args: readonly string[]): string | undefined {
  const inline = args.find((item) => item.startsWith('--plan-from='));
  if (inline) return inline.slice('--plan-from='.length) || undefined;
  const index = args.indexOf('--plan-from');
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * Disposable browser-first demo. It deliberately uses the same Workbench
 * middleware as a real store, but no PostgreSQL, Redis, provider or token.
 */
async function demoDev(args: string[]): Promise<void> {
  const rawPort = args.find((item) => item.startsWith('--port='))?.slice(7) ?? '8788';
  const portValue = Number(rawPort);
  if (!Number.isInteger(portValue) || portValue < 0 || portValue > 65535) {
    fail('demo port must be 0..65535', 'Example: npx rhinoq dev --demo --port=8788');
  }
  const source = createDemoTaskSource();
  source.start();
  const workbench = createNodeWorkbenchMiddleware({
    tasks: source,
    basePath: '/rhinoq',
    actions: true,
    // Demo data is intentionally cross-owner but disposable. Production
    // applications must put the same middleware behind operator auth.
    requireOperator: () => true,
    navigation: { overviewPath: '/rhinoq', tasksPath: '/rhinoq' },
  });
  const server = createServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(302, { location: '/rhinoq', 'cache-control': 'no-store' });
      response.end();
      return;
    }
    workbench(request, response);
  });
  const close = () => {
    source.stop();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(portValue, '127.0.0.1', resolveListen);
  }).catch((error) => {
    source.stop();
    fail(`could not start demo server: ${safe(error)}`, 'Use npx rhinoq dev --demo --port=0 to choose a free port');
  });
  const address = server.address();
  const port = address && typeof address !== 'string' ? address.port : portValue;
  console.log('PASS RhinoQ disposable demo is running (no PostgreSQL, Redis or provider).');
  console.log(`URL RhinoQ Workbench: http://127.0.0.1:${port}/rhinoq`);
  console.log('INFO demo Tasks: one running with live progress, one completed result, one failed attempt.');
  console.log('WARN demo data is local and synthetic; it is not production evidence.');
  console.log('NEXT press Ctrl+C to stop.');
}

async function detectPackages(): Promise<{ pg: boolean; bullmq: boolean; nest: boolean; sharp: boolean; s3: boolean; cloudinary: boolean }> {
  try {
    const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { dependencies?: Record<string,string>; devDependencies?: Record<string,string> };
    const all={...pkg.dependencies,...pkg.devDependencies};
    return { pg:Boolean(all.pg), bullmq:Boolean(all.bullmq), nest:Boolean(all['@nestjs/common']), sharp:Boolean(all.sharp), s3:Boolean(all['@aws-sdk/client-s3']), cloudinary:Boolean(all.cloudinary) };
  } catch { return {pg:false,bullmq:false,nest:false,sharp:false,s3:false,cloudinary:false}; }
}
function setupCapabilities(detected: Awaited<ReturnType<typeof detectPackages>>, resolved?: ResolvedDatabaseConfig): string[] {
  return [
    detected.nest ? 'framework:nestjs' : 'framework:neutral',
    detected.bullmq ? 'runtime:bullmq' : 'runtime:manual-or-go',
    resolved ? 'database:postgres-configured' : 'database:postgres-required',
    detected.s3 ? 'storage:s3-sdk' : 'storage:provider-required',
    detected.sharp ? 'processor:sharp-package' : 'processor:sharp-package-missing',
    detected.cloudinary ? 'provider:cloudinary-package' : 'provider:cloudinary-package-missing',
  ];
}
function setupCapabilitySummary(detected: Awaited<ReturnType<typeof detectPackages>>, resolved?: ResolvedDatabaseConfig): string {
  return setupCapabilities(detected, resolved).join(', ');
}
async function pathExists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
async function writeNew(path: string, content: string): Promise<boolean> { try { await access(path); console.log(`KEEP ${path} already exists.`); return false; } catch { await writeFile(path, content, { flag:'wx' }); return true; } }
function safe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function nextAction(error: unknown): string { const message=safe(error); if (/connect|ECONN|database/i.test(message)) return 'Start PostgreSQL and verify the connection variables, then run: npx rhinoq doctor'; return 'Run: npx rhinoq help'; }
function fail(message: string, next: string): never { console.error(`FAIL ${message}\nNEXT ${next}`); process.exitCode=1; throw new Error('__reported__'); }
function help(): void { console.log(`RhinoQ developer CLI\n\nStart here (the shortest paths):\n  npx rhinoq dev --demo                 open a browser-first disposable demo\n  npx rhinoq up                         start the real local PostgreSQL profile\n  npx rhinoq setup                      preview integration without writing\n  npx rhinoq setup --apply              configure without overwriting\n  npx rhinoq init --example report-export generate a consumer example\n  npx rhinoq dev                         open the local Workbench (PostgreSQL)\n\nUse with an existing app:\n  npx rhinoq connect                     guided, preview-first adoption\n  npx rhinoq connect --apply             apply only after reviewing the plan\n  npx rhinoq add task report.export      preview a working Task slice\n  npx rhinoq add task report.export --apply generate without overwriting\n  npx rhinoq adopt --mode single        preview a BullMQ integration\n  npx rhinoq adopt --mode single --apply apply only after reviewing the plan\n  npx rhinoq adopt --scan                read-only integration inventory\n  npx rhinoq measure --before old --after new\n\nProduct composition:\n  createRhinoQApp()                     one pool, Task API, Task Center and Workbench\n  defineRhinoQApplication()             typed registry and worker handlers\n\nAdvanced operations:\n  npx rhinoq doctor [--fix]             database/runtime diagnosis or local plumbing fix\n  npx rhinoq doctor --plan-from <file> --plan-only\n  npx rhinoq dev --plan-from <file>     validate deployment plan before dev\n  npx rhinoq verify add completed-report-has-output\n  npx rhinoq verify apply completed-report-has-output --subject-type report\n  npx rhinoq verify run completed-report-has-output\n  npx rhinoq verify delete completed-report-has-output [--apply]\n  npx rhinoq fixture async              create a visible generic Task (database)\n  npx rhinoq demo transport-fallback    explicitly simulated transport evidence\n  npx rhinoq demo missing-output --confirm-disposable\n  npx rhinoq lab run completed-but-missing-output --recover --confirm-disposable\n  npx rhinoq capabilities [--json]      evidence-aware capability ledger\n  npx rhinoq plan --from .rhinoq/plan.json\n\nPostgreSQL configuration: RHINOQ_DATABASE_URL, DATABASE_URL, or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE.\nThe Task profile is authoritative for state, leases, retries and effects; this Node CLI never replaces that correctness layer.\nEvery failure includes one next action.`); }
