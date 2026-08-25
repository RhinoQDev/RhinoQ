import { createHash, timingSafeEqual } from 'node:crypto';
import { installPostgresTaskProfile, type PostgresTaskClient } from '../postgres/task-client.js';
import type { SqlPool } from '../postgres/task-schema.js';
import {
  createNodeTaskCenterMiddleware,
  createNodeTaskMiddleware,
  type NodeTaskMiddlewareOptions,
  type NodeTaskRequest,
  type NodeTaskResponse,
} from '../tasks/adapters.js';
import { createNodeWorkbenchMiddleware, type WorkbenchHandlerOptions } from '../workbench/handler.js';
import type { RuntimeAdapter } from './contracts.js';
import { defineRhinoQTask, type RhinoQArtifactStorage, type RhinoQDeclaredTask, type RhinoQTaskOptions, type RhinoQTraceHooks } from '../tasks/declaration.js';
import type { DurableEffectClient } from '../tasks/durable.js';
import { createAwsS3ArtifactProvider, createAwsS3ArtifactProviderFromEnv, type AwsS3ArtifactOptions, type RhinoQArtifactProvider } from '../tasks/artifact-storage.js';
import { ArtifactRetentionService, ArtifactUploadService, PostgresArtifactRetentionStore, PostgresArtifactUploadSessionStore } from '../tasks/artifact-upload.js';
import type { TaskMetrics } from '../observe/metrics.js';
import type { RhinoQPlanInspection } from '../tasks/plan-inspector.js';
import type { RhinoQAutopilotReport } from '../observe/autopilot.js';
import {
  createRhinoQ,
  type CreateRhinoQOptions,
  type RhinoQRuntimeIntegration,
} from './integration.js';
import { validateRhinoQResourcePool, type RhinoQResourcePoolOptions } from '../tasks/resource-lease.js';

export interface CreateRhinoQAppOptions {
  pool: SqlPool;
  adapters: RuntimeAdapter[];
  /** Starts only the process-local capabilities this deployment needs. */
  role?: 'producer' | 'worker' | 'api' | 'operator' | 'all';
  ownerFromRequest?: NodeTaskMiddlewareOptions['ownerFromRequest'];
  ownerFromNodeRequest?: NodeTaskMiddlewareOptions['ownerFromNodeRequest'];
  tenantFromRequest?: NodeTaskMiddlewareOptions['tenantFromRequest'];
  tenantFromNodeRequest?: NodeTaskMiddlewareOptions['tenantFromNodeRequest'];
  terminalProjection?: CreateRhinoQOptions['terminalProjection'];
  resolveUnboundEvent?: CreateRhinoQOptions['resolveUnboundEvent'];
  adoptionStore?: CreateRhinoQOptions['adoptionStore'];
  adoptionReplicaId?: string;
  /** Primarily for composition tests or hosts that installed the profile already. */
  tasks?: PostgresTaskClient;
  /** Existing Go-owned ProviderOperation ledger facade for ctx.effect(). */
  effectClient?: DurableEffectClient;
  /** Stable process/deployment identity used when acquiring Step leases. */
  workerId?: string;
  /**
   * Tenant-scoped PostgreSQL capacity shared by every application worker using
   * this pool key. A Task reserves it only when resources.{cpu,memoryBytes,diskBytes,network} is non-zero.
   */
  resourcePool?: RhinoQResourcePoolOptions;
  artifactStorage?: RhinoQArtifactStorage;
  /** One provider configures both private upload and owner-safe signed download. */
  artifactProvider?: RhinoQArtifactProvider;
  /**
   * Zero-boilerplate file support: `'s3'` reads RHINOQ_ARTIFACT_* environment
   * variables; `{ s3: { bucket, ... } }` takes the same configuration inline,
   * for hosts that configure in code or from a secrets manager rather than the
   * environment. Either form wires the whole file path — direct multipart
   * upload, owner-scoped signed download, and retention cleanup — so an
   * application never assembles the artifact provider, the upload service and
   * the download resolver by hand.
   */
  artifacts?: 's3' | { s3: AwsS3ArtifactOptions };
  trace?: RhinoQTraceHooks;
  metrics?: TaskMetrics;
  /** Optional event-driven realtime invalidation. It is always best-effort. */
  realtime?: {
    invalidate(taskId: string, identity: { ownerId: string; tenantId?: string }, minimumVersion?: number): Promise<void> | void;
  };
}

export interface RhinoQAppHTTPOptions {
  operatorToken: string;
  origin?: string;
  actions?: boolean;
  taskCenterTitle?: string;
  overviewPath?: string;
  workbenchPath?: string;
  retryTask?: NodeTaskMiddlewareOptions['retryTask'];
  cancelTask?: NodeTaskMiddlewareOptions['cancelTask'];
  resolveResult?: NodeTaskMiddlewareOptions['resolveResult'];
  resolveArtifact?: NodeTaskMiddlewareOptions['resolveArtifact'];
  authorize?: NodeTaskMiddlewareOptions['authorize'];
  requireTenantAuthorization?: NodeTaskMiddlewareOptions['requireTenantAuthorization'];
  riskPolicy?: NodeTaskMiddlewareOptions['riskPolicy'];
  providerOperationsByTask?: WorkbenchHandlerOptions['providerOperationsByTask'];
  runtimeJobLink?: WorkbenchHandlerOptions['runtimeJobLink'];
  /** Read-only compiled Task plan shown by the operator Console. */
  applicationPlan?: RhinoQPlanInspection;
  /** Deterministic observe/recommend evidence shown by the operator Console. */
  autopilot?(): Promise<RhinoQAutopilotReport> | RhinoQAutopilotReport;
}

const OPERATOR_COOKIE = 'rhinoq_operator_session';

export type RhinoQAppHTTPMiddleware = (
  request: NodeTaskRequest & { on(event: 'close', listener: () => void): unknown },
  response: NodeTaskResponse & { write(chunk: Uint8Array | string): unknown },
  next?: (error?: unknown) => void,
) => void;

/** Runtime-neutral product composition: durable Tasks, adapters and both UIs. */
export class RhinoQPortableApp {
  private closed = false;

  constructor(
    readonly tasks: PostgresTaskClient,
    readonly runtime: RhinoQRuntimeIntegration,
    private readonly identity: Pick<CreateRhinoQAppOptions,
      'ownerFromRequest' | 'ownerFromNodeRequest' | 'tenantFromRequest' | 'tenantFromNodeRequest'>,
    private readonly artifactStorage?: RhinoQArtifactStorage,
    private readonly artifactProvider?: RhinoQArtifactProvider,
    private readonly trace?: RhinoQTraceHooks,
    private readonly effectClient?: DurableEffectClient,
    private readonly workerId?: string,
    private readonly resourcePool?: RhinoQResourcePoolOptions,
    readonly artifacts?: ArtifactUploadService,
    readonly artifactRetention?: ArtifactRetentionService,
    private readonly realtime?: CreateRhinoQAppOptions['realtime'],
    readonly role: NonNullable<CreateRhinoQAppOptions['role']> = 'all',
  ) {}

  task<Input, Output>(options: RhinoQTaskOptions<Input, Output>): RhinoQDeclaredTask<Input, Output> {
    return defineRhinoQTask(this.runtime, options, {
      waitpoints: this.tasks,
      checkpoints: this.tasks,
      ...(this.trace ? { trace: this.trace } : {}),
      ...(this.realtime ? { onMutation: (mutation: { taskId: string; ownerId: string; tenantId?: string; entityVersion: number }) => this.realtime!.invalidate(mutation.taskId, { ownerId: mutation.ownerId, ...(mutation.tenantId ? { tenantId: mutation.tenantId } : {}) }, mutation.entityVersion) } : {}),
      steps: this.tasks,
      ...(this.effectClient ? { effects: this.effectClient } : {}),
      cancellation: { client: this.tasks },
      ...(this.workerId ? { workerId: this.workerId } : {}),
      ...(this.resourcePool ? { resources: { client: this.tasks, pool: this.resourcePool } } : {}),
      ...((this.artifactProvider?.storage ?? this.artifactStorage) ? { artifacts: {
        storage: (this.artifactProvider?.storage ?? this.artifactStorage)!,
        register: (taskId, request) => this.tasks.registerTaskArtifact(taskId, request),
        ...(this.artifacts && this.artifactProvider?.direct?.uploadPart ? { durableMultipart: {
          uploads: this.artifacts,
          authorizeTask: async (taskId, ownerId, tenantId) => { await this.tasks.getTaskForOwner(taskId, ownerId, tenantId); },
        } } : {}),
      } } : {}),
    });
  }

  http(options: RhinoQAppHTTPOptions): RhinoQAppHTTPMiddleware {
    if (!options?.operatorToken?.trim()) {
      throw new TypeError('http({ operatorToken }) is required because /admin reads Tasks across every owner');
    }
    if (!this.identity.ownerFromRequest && !this.identity.ownerFromNodeRequest) {
      throw new TypeError('createRhinoQApp HTTP requires ownerFromRequest or ownerFromNodeRequest for the owner-scoped Task API');
    }
    const taskCenter = createNodeTaskCenterMiddleware({
      path: '/task-center', apiPath: '/tasks',
      navigation: { overviewPath: options.overviewPath ?? '/', workbenchPath: options.workbenchPath ?? '/admin' },
      ...(options.taskCenterTitle ? { title: options.taskCenterTitle } : {}),
    });
    const routes = createNodeTaskMiddleware({
      tasks: this.tasks, basePath: '/tasks', origin: options.origin,
      ...this.identity,
      ...(options.retryTask ? { retryTask: options.retryTask } : {}),
      ...(options.cancelTask ? { cancelTask: options.cancelTask } : {}),
      // A runtime capability alone is insufficient: the owner endpoint still
      // needs an application composition that selects refs and handles every
      // outcome. Without that hook the honest product capability is false.
      cancel: Boolean(options.cancelTask),
      ...(options.resolveResult ? { resolveResult: options.resolveResult } : {}),
      ...(options.resolveArtifact ? { resolveArtifact: options.resolveArtifact }
        : this.artifactProvider ? { resolveArtifact: this.artifactProvider.resolve } : {}),
      ...(this.artifacts ? { uploads: this.artifacts } : {}),
      ...(options.authorize ? { authorize: options.authorize } : {}),
      ...(options.requireTenantAuthorization !== undefined
        ? { requireTenantAuthorization: options.requireTenantAuthorization }
        : {}),
      ...(options.riskPolicy ? { riskPolicy: options.riskPolicy } : {}),
    });
    const workbench = createNodeWorkbenchMiddleware({
      tasks: this.tasks, basePath: '/admin', actions: options.actions,
      requireOperator: (request) => operatorAuthorized(request.headers, options.operatorToken),
      navigation: { overviewPath: options.overviewPath ?? '/', tasksPath: '/task-center' },
      runtimeReports: () => this.runtime.runtimeReports(),
      ...(options.providerOperationsByTask ? { providerOperationsByTask: options.providerOperationsByTask } : {}),
      ...(options.runtimeJobLink ? { runtimeJobLink: options.runtimeJobLink } : {}),
      ...(options.applicationPlan ? { applicationPlan: options.applicationPlan } : {}),
      ...(options.autopilot ? { autopilot: options.autopilot } : {}),
    });
    return (request, response, next) => {
      if (serveOperatorLogin(request, response, options.operatorToken, options.origin)) return;
      taskCenter(request, response, () => {
        routes(request, response, (error) => {
          if (error) { next?.(error); return; }
          workbench(request, response, () => next?.());
        });
      });
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.runtime.close();
  }
}

function operatorAuthorized(headers: Headers, token: string): boolean {
  const header = headers.get('x-operator-token');
  if (header && safeEqual(header, token)) return true;
  const expected = operatorSession(token);
  const cookie = headers.get('cookie')?.split(';')
    .map((part) => part.trim().split('='))
    .find(([name]) => name === OPERATOR_COOKIE)?.[1];
  return Boolean(cookie && safeEqual(cookie, expected));
}

function serveOperatorLogin(
  request: NodeTaskRequest,
  response: NodeTaskResponse,
  token: string,
  origin?: string,
): boolean {
  const pathname = new URL(request.originalUrl ?? request.url ?? '/', 'http://rhinoq.invalid').pathname;
  if (pathname !== '/operator-login') return false;
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  if (request.method === 'GET') {
    response.statusCode = 200;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>RhinoQ operator sign in</title><style>body{font:16px system-ui;max-width:32rem;margin:10vh auto;padding:1rem}label,input,button{display:block;width:100%;box-sizing:border-box}input,button{font:inherit;padding:.7rem;margin-top:.5rem}p{color:#555}</style><h1>Operator sign in</h1><p>Enter the operator token configured on this server. It is exchanged for an HttpOnly cookie and is not placed in the URL.</p><form method="post" action="/operator-login"><label>Operator token<input name="token" type="password" required autocomplete="current-password"></label><button type="submit">Open Workbench</button></form></html>');
    return true;
  }
  if (request.method !== 'POST') {
    response.statusCode = 405;
    response.setHeader('allow', 'GET, POST');
    response.end('Method Not Allowed');
    return true;
  }
  let body = '';
  let tooLarge = false;
  request.on('data', (chunk) => {
    if (tooLarge) return;
    body += chunk.toString();
    if (Buffer.byteLength(body) > 8_192) tooLarge = true;
  });
  request.on('error', () => {
    if (!response.statusCode) response.statusCode = 400;
    response.end('Invalid request');
  });
  request.on('end', () => {
    const supplied = tooLarge ? '' : new URLSearchParams(body).get('token') ?? '';
    if (!safeEqual(supplied, token)) {
      response.statusCode = 403;
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end('Invalid operator token');
      return;
    }
    const secure = origin?.startsWith('https://') ? '; Secure' : '';
    response.statusCode = 303;
    response.setHeader('set-cookie', `${OPERATOR_COOKIE}=${operatorSession(token)}; HttpOnly; SameSite=Strict; Path=/admin${secure}`);
    response.setHeader('location', '/admin');
    response.end();
  });
  return true;
}

function operatorSession(token: string): string {
  return createHash('sha256').update(`rhinoq-operator-session\0${token}`).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createRhinoQApp(options: CreateRhinoQAppOptions): Promise<RhinoQPortableApp> {
  if (!options?.pool || typeof options.pool.query !== 'function') {
    throw new TypeError('createRhinoQApp requires a PostgreSQL pool');
  }
  if (!Array.isArray(options.adapters)) throw new TypeError('createRhinoQApp requires adapters');
  const role = options.role ?? 'all';
  if (!['producer', 'worker', 'api', 'operator', 'all'].includes(role)) throw new TypeError('RhinoQ role must be producer, worker, api, operator or all');
  const artifactChoices = [options.artifactStorage, options.artifactProvider, options.artifacts].filter(Boolean).length;
  if (artifactChoices > 1) throw new TypeError('configure only one of artifacts, artifactProvider or artifactStorage');
  const artifactProvider = options.artifactProvider ?? (await resolveArtifactsOption(options.artifacts));
  const resourcePool = options.resourcePool ? validateRhinoQResourcePool(options.resourcePool) : undefined;
  const tasks = options.tasks ?? await installPostgresTaskProfile(options.pool);
  const runtime = createRhinoQ({
    client: tasks,
    adapters: options.adapters,
    observeEvents: role === 'worker' || role === 'all',
    terminalProjection: options.terminalProjection ?? 'single-execution',
    ...(options.resolveUnboundEvent ? { resolveUnboundEvent: options.resolveUnboundEvent } : {}),
    ...(options.adoptionStore ? { adoptionStore: options.adoptionStore } : {}),
    ...(options.adoptionReplicaId ? { adoptionReplicaId: options.adoptionReplicaId } : {}),
    ...(options.realtime ? { onTaskMutation: (task) => task.ownerId ? options.realtime!.invalidate(task.id, { ownerId: task.ownerId }, task.entityVersion) : undefined } : {}),
  });
  await runtime.start();
  const uploads = artifactProvider?.direct ? new ArtifactUploadService(artifactProvider, new PostgresArtifactUploadSessionStore(options.pool), (taskId, request) => tasks.registerTaskArtifact(taskId, request), options.metrics, async (taskId, ownerId, tenantId) => { await tasks.getTaskForOwner(taskId, ownerId, tenantId); }) : undefined;
  const retention = artifactProvider?.direct?.delete ? new ArtifactRetentionService(artifactProvider, new PostgresArtifactRetentionStore(options.pool), undefined, options.metrics) : undefined;
  return new RhinoQPortableApp(tasks, runtime, options, options.artifactStorage, artifactProvider, options.trace, options.effectClient, options.workerId, resourcePool, uploads, retention, options.realtime, role);
}

/**
 * Turns the `artifacts` option into a provider, or nothing.
 *
 * `'s3'` reads the environment; `{ s3: {...} }` takes the configuration inline.
 * Both produce the same fully-wired provider, so an application chooses between
 * env and code without knowing that a provider, an upload service and a
 * download resolver sit behind either.
 */
async function resolveArtifactsOption(
  artifacts: CreateRhinoQAppOptions['artifacts'],
): Promise<RhinoQArtifactProvider | undefined> {
  if (artifacts === undefined) return undefined;
  if (artifacts === 's3') return createAwsS3ArtifactProviderFromEnv();
  if (typeof artifacts === 'object' && artifacts.s3) return createAwsS3ArtifactProvider(artifacts.s3);
  throw new TypeError('artifacts must be "s3" or { s3: AwsS3ArtifactOptions }');
}
