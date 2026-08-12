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
import {
  createRhinoQ,
  type CreateRhinoQOptions,
  type RhinoQRuntimeIntegration,
} from './integration.js';

export interface CreateRhinoQAppOptions {
  pool: SqlPool;
  adapters: RuntimeAdapter[];
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
}

export interface RhinoQAppHTTPOptions {
  operatorToken: string;
  origin?: string;
  actions?: boolean;
  taskCenterTitle?: string;
  overviewPath?: string;
  workbenchPath?: string;
  retryTask?: NodeTaskMiddlewareOptions['retryTask'];
  resolveResult?: NodeTaskMiddlewareOptions['resolveResult'];
  resolveArtifact?: NodeTaskMiddlewareOptions['resolveArtifact'];
  riskPolicy?: NodeTaskMiddlewareOptions['riskPolicy'];
  providerOperationsByTask?: WorkbenchHandlerOptions['providerOperationsByTask'];
  runtimeJobLink?: WorkbenchHandlerOptions['runtimeJobLink'];
}

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
  ) {}

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
      ...(options.resolveResult ? { resolveResult: options.resolveResult } : {}),
      ...(options.resolveArtifact ? { resolveArtifact: options.resolveArtifact } : {}),
      ...(options.riskPolicy ? { riskPolicy: options.riskPolicy } : {}),
    });
    const workbench = createNodeWorkbenchMiddleware({
      tasks: this.tasks, basePath: '/admin', actions: options.actions,
      requireOperator: (request) => request.headers.get('x-operator-token') === options.operatorToken,
      navigation: { overviewPath: options.overviewPath ?? '/', tasksPath: '/task-center' },
      runtimeReports: () => this.runtime.runtimeReports(),
      ...(options.providerOperationsByTask ? { providerOperationsByTask: options.providerOperationsByTask } : {}),
      ...(options.runtimeJobLink ? { runtimeJobLink: options.runtimeJobLink } : {}),
    });
    return (request, response, next) => {
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

export async function createRhinoQApp(options: CreateRhinoQAppOptions): Promise<RhinoQPortableApp> {
  if (!options?.pool || typeof options.pool.query !== 'function') {
    throw new TypeError('createRhinoQApp requires a PostgreSQL pool');
  }
  if (!Array.isArray(options.adapters)) throw new TypeError('createRhinoQApp requires adapters');
  const tasks = options.tasks ?? await installPostgresTaskProfile(options.pool);
  const runtime = createRhinoQ({
    client: tasks,
    adapters: options.adapters,
    terminalProjection: options.terminalProjection ?? 'single-execution',
    ...(options.resolveUnboundEvent ? { resolveUnboundEvent: options.resolveUnboundEvent } : {}),
    ...(options.adoptionStore ? { adoptionStore: options.adoptionStore } : {}),
    ...(options.adoptionReplicaId ? { adoptionReplicaId: options.adoptionReplicaId } : {}),
  });
  await runtime.start();
  return new RhinoQPortableApp(tasks, runtime, options);
}
