#!/usr/bin/env node
import { createServer } from 'node:http';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { Pool } from 'pg';
import { installPostgresTaskProfile } from '../postgres/task-client.js';
import { TASK_SCHEMA_VERSION } from '../postgres/task-schema.js';
import { SDK_VERSION } from '../gateway/types.js';
import { resolveDatabaseConfig, type ResolvedDatabaseConfig } from './database-config.js';
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

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'help';
  const args = process.argv.slice(3);
  switch (command) {
    case 'init': await init(args); break;
    case 'adopt': await adopt(args); break;
    case 'verify': await verify(args); break;
    case 'doctor': await doctor(args); break;
    case 'notify': await notify(args); break;
    case 'fixture': await fixture(args); break;
    case 'eval': await evaluateProduct(args); break;
    case 'lab': await lab(args); break;
    case 'demo': await demo(args); break;
    case 'dev': await dev(args); break;
    case 'version': case '--version': case '-v': console.log(SDK_VERSION); break;
    case 'help': case '--help': case '-h':
      console.log('Start from your goal:\n  npx rhinoq init                         # install the Task profile\n  npx rhinoq init --example report-export # generate a consumer shell\n  npx rhinoq eval                         # verify DB, fixture and both UI surfaces\n  npx rhinoq fixture async                # create a visible generic Task\n  npx rhinoq dev                          # open the local Workbench\n\nObserve an existing runtime:\n  Use createRhinoQApp({ adapters, ownerFromRequest }) for manual, SQS, BullMQ, or custom adapters.\n\nAdopt an existing BullMQ app:\n  npx rhinoq adopt --mode single [--apply]\n\nExplicitly simulated demos:\n  npx rhinoq demo transport-fallback\n  npx rhinoq demo missing-output --confirm-disposable\n\nFailure Lab:\n  npx rhinoq lab run completed-but-missing-output --recover --confirm-disposable\n');
      help(); break;
    default: fail(`unknown command ${JSON.stringify(command)}`, 'Run: npx rhinoq help');
  }
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
      `Set RHINOQ_DATABASE_URL or DATABASE_URL, or set PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE (RHINOQ_DB_* also works), then run: npx rhinoq ${command}`,
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
    const pool = new Pool({ ...resolved.pool, connectionTimeoutMillis: 5_000 });
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

async function initReportExportExample(): Promise<void> {
  const root = resolve('rhinoq-report-export');
  await mkdir(root, { recursive: true });
  const files: Record<string, string> = {
    'package.json': `${JSON.stringify({ name: 'rhinoq-report-export', private: true, type: 'module', scripts: { start: 'node app.mjs' }, dependencies: { '@rhinoq/node': '^0.1.0-beta.12', pg: '^8.22.0' } }, null, 2)}\n`,
    '.env.example': 'DATABASE_URL=postgres://postgres:postgres@localhost:5432/app\nRHINOQ_OPERATOR_TOKEN=replace-me\n',
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
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const runtime = createManualRuntimeAdapter('manual', 'report-export');
const app = await createRhinoQApp({
  pool, adapters: [runtime],
  ownerFromNodeRequest: (request) => identity(request).ownerId,
  tenantFromNodeRequest: (request) => identity(request).tenantId,
});
const http = app.http({ operatorToken: process.env.RHINOQ_OPERATOR_TOKEN });
createServer((request, response) => http(request, response)).listen(8787, '127.0.0.1', () => {
  console.log('Task Center http://127.0.0.1:8787/task-center');
  console.log('Workbench sign in http://127.0.0.1:8787/operator-login');
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
    console.log(`NEXT ${missing.length > 0 ? `install ${missing.join(' and ')}, then ` : ''}generate without overwriting: npx rhinoq adopt --mode ${mode ?? 'single'} --apply`);
    return;
  }
  if (!mode && (!detected.nest || declaredTasks.size === 0)) fail('adopt --apply requires an explicit Task mode or per-queue --task declarations', 'Choose --mode single, or declare --task mail-queue=mail.send:single');
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

function localPostgresTemplate(): string {
  return `services:
  rhinoq-postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: rhinoq
      POSTGRES_PASSWORD: rhinoq
      POSTGRES_DB: rhinoq
    ports:
      - "127.0.0.1:55432:5432"
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
  const resolved = requireDatabase('doctor');
  console.log('INFO scope: Task schema, local Rule files and client packages.');
  console.log('INFO not checked here: worker identity, lease/heartbeat/reaper timing,');
  console.log('     RhinoQ migration state. Those need the Go CLI: rhinoq doctor --ci');
  console.log(`INFO PostgreSQL target ${resolved.target} from ${resolved.source}.`);
  const pool = new Pool({ ...resolved.pool, connectionTimeoutMillis: 5_000 });
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
  const pool = new Pool(requireDatabase(`lab run ${scenario} --confirm-disposable`).pool);
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
  const pool = new Pool(requireDatabase(`fixture ${name}`).pool);
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
  const pool = new Pool({ ...resolved.pool, connectionTimeoutMillis: 5_000 });
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
  const portValue = Number(args.find((item) => item.startsWith('--port='))?.slice(7) ?? 8788);
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) fail('port must be 1..65535', 'Example: npx rhinoq dev --port=8788');
  const pool = new Pool(requireDatabase('dev').pool);
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

async function detectPackages(): Promise<{ pg: boolean; bullmq: boolean; nest: boolean }> {
  try { const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { dependencies?: Record<string,string>; devDependencies?: Record<string,string> }; const all={...pkg.dependencies,...pkg.devDependencies}; return {pg:Boolean(all.pg),bullmq:Boolean(all.bullmq),nest:Boolean(all['@nestjs/common'])}; }
  catch { return {pg:false,bullmq:false,nest:false}; }
}
async function writeNew(path: string, content: string): Promise<boolean> { try { await access(path); console.log(`KEEP ${path} already exists.`); return false; } catch { await writeFile(path, content, { flag:'wx' }); return true; } }
function safe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function nextAction(error: unknown): string { const message=safe(error); if (/connect|ECONN|database/i.test(message)) return 'Start PostgreSQL and verify the connection variables, then run: npx rhinoq doctor'; return 'Run: npx rhinoq help'; }
function fail(message: string, next: string): never { console.error(`FAIL ${message}\nNEXT ${next}`); process.exitCode=1; throw new Error('__reported__'); }
function help(): void { console.log(`RhinoQ developer CLI\n\n  npx rhinoq init\n  npx rhinoq verify add completed-report-has-output\n  npx rhinoq verify apply completed-report-has-output --subject-type report\n  npx rhinoq verify run completed-report-has-output\n  npx rhinoq verify delete completed-report-has-output [--apply]\n  npx rhinoq doctor\n  npx rhinoq notify add ops --webhook https://example.com/hooks/rhinoq --secret-env RHINOQ_NOTIFY_SECRET_OPS\n  npx rhinoq notify list [--json]\n  npx rhinoq notify test ops\n  npx rhinoq notify remove ops\n  npx rhinoq fixture failure\n  npx rhinoq dev\n\nverify apply on an existing Rule prints what changed and needs --force, because\na new version does not reopen Findings recorded against the old one.\nverify delete previews by default; --apply performs it.\n\nPostgreSQL connection, in order: RHINOQ_DATABASE_URL, DATABASE_URL, then the\ndiscrete PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE/PGSSLMODE variables\n(RHINOQ_DB_HOST/_PORT/_USER/_PASSWORD/_NAME/_SSLMODE win over those). Discrete\nconfiguration needs at least a host and a database name.\n\nnotify reads and writes the same .rhinoq/notifications.json as the Go CLI, and\nnever stores a secret: an entry names an environment variable. "notify test"\nsends one synthetic signed event and writes nothing - no Finding, no delivery\nrecord. "notify send" is Go-only: a real delivery goes through the durable\ndelivery ledger the engine owns.\n\nThis CLI checks the isolated Task profile only. For runtime checks - fencing,\nlease/heartbeat timing, the reaper and migration state - build and run the Go\nCLI: rhinoq doctor.\n\nEvery failure includes the next action.`); }
