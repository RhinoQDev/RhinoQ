import type { TaskSnapshot, TaskSummary } from './gateway/types.js';
import {
  BullMQTaskBridge,
  type BullMQQueue,
  type BullMQQueueEvents,
  type BullMQTaskDispatch,
  type BullMQTaskObservation,
} from './bullmq/task-bridge.js';
import { TaskMetrics } from './observe/metrics.js';
import type { RuntimeHealthReader, RuntimeJobLink } from './observe/runtime-health.js';
import { BullMQRuntimeInspector, type BullMQInspectableQueue } from './bullmq/runtime-inspector.js';
import { PostgresProjectorLease } from './postgres/projector-lease.js';
import { installPostgresTaskProfile, PostgresTaskClient } from './postgres/task-client.js';
import type { SqlPool } from './postgres/task-schema.js';
import {
  createNodeTaskCenterMiddleware,
  createNodeTaskMiddleware,
  type NodeTaskMiddlewareOptions,
  type NodeTaskRequest,
  type NodeTaskResponse,
} from './tasks/adapters.js';
import type { TaskRequestHandlerOptions } from './tasks/http.js';
import { TaskReconciler } from './tasks/reconciler.js';
import {
  createNodeWorkbenchMiddleware,
  type WorkbenchHandlerOptions,
} from './workbench/handler.js';

/**
 * What a BullMQ job looks like from outside BullMQ.
 *
 * RhinoQ does not import BullMQ and never will; this is the shape it reads to
 * answer questions the application would otherwise have to answer by hand.
 */
export interface BullMQJobView {
  id?: string;
  attemptsMade?: number;
  returnvalue?: unknown;
  failedReason?: string;
  opts?: { attempts?: number } & Record<string, unknown>;
  getState?(): Promise<string>;
  remove?(): Promise<unknown>;
}

/** The parts of a BullMQ Queue the high-level entry point reads. */
export interface BullMQQueueForQuickstart extends BullMQQueue {
  name?: string;
  getJob?(jobId: string): Promise<BullMQJobView | undefined | null>;
  getJobCounts?(...types: string[]): Promise<Record<string, number>>;
  isPaused?(): Promise<boolean>;
  getWorkers?(): Promise<unknown[]>;
  opts?: { defaultJobOptions?: Record<string, unknown> };
}

export interface RhinoQItem {
  /**
   * The idempotency key of one logical item: a row ID, not a storage path.
   *
   * Attempts are numbered per key and the item counts count one entry per key,
   * so this is what decides whether two records are "the same work, retried" or
   * "two different things". It ends up on the snapshot a browser polls.
   */
  key: string;
  /** The BullMQ job payload, unchanged. */
  data: unknown;
  /** BullMQ job name. Defaults to the queue name. */
  name?: string;
  /** Per-job BullMQ options, e.g. `{ attempts: 3 }`. */
  options?: Record<string, unknown>;
}

export interface RhinoQDispatchOptions {
  /** Task type, for grouping in the operator console. Defaults to the scope. */
  type?: string;
  /** The application user this batch belongs to; required for the read API. */
  ownerId?: string;
  /** Stable tenant boundary. Omit only for a single-tenant application. */
  tenantId?: string;
  /** Applied to every item that does not set its own. */
  jobOptions?: Record<string, unknown>;
  /**
   * Hold the call until every job has been enqueued as well as reserved.
   * Defaults to false, so a browser gets the Task id before the work starts.
   */
  awaitEnqueue?: boolean;
}

export interface RhinoQAppOptions {
  /** A `pg.Pool`. RhinoQ installs its isolated Task profile into it. */
  pool: SqlPool;
  /** The application's own BullMQ Queue. RhinoQ never creates one. */
  queue: BullMQQueueForQuickstart;
  /** The application's own BullMQ QueueEvents on the same queue. */
  events: BullMQQueueEvents;
  /**
   * Fencing identity for this queue's projector. Defaults to `queue.name`.
   * Two processes projecting the same scope is the hazard the lease prevents.
   */
  scope?: string;
  /**
   * Returns the authenticated application user for `routes()`. Without it the
   * read API is not mounted, because an owner-scoped API with no owner is not
   * a safe default.
   */
  ownerFromRequest?: NodeTaskMiddlewareOptions['ownerFromRequest'];
  /** Resolve the tenant from the authenticated host request. */
  tenantFromRequest?: NodeTaskMiddlewareOptions['tenantFromRequest'];
  /**
   * Called once, by the one caller that closed the last item of a batch. The
   * Task has already been moved to `succeeded`/`failed` before this runs.
   */
  onSettled?: (task: TaskSnapshot) => Promise<void> | void;
  /** How often the sweeper looks for batches that stopped moving. 60s. */
  reconcileEveryMs?: number;
  /** A batch untouched for this long is swept. 5 minutes. */
  idleForMs?: number;
  onWarning?: (warning: string) => void;
  onError?: (error: unknown, context?: unknown) => void;
}

export interface RhinoQHTTPOptions {
  /** Required because `/admin` can read Tasks across every owner. */
  operatorToken: string;
  /** Browser origin used by the owner API adapter. */
  origin?: string;
  /** Allow mutating operator actions in Workbench. Defaults to false. */
  actions?: boolean;
  /** Heading shown in the owner-facing Task Center. */
  taskCenterTitle?: string;
  /** Application-owned durable retry command. Retry UI is hidden when absent. */
  retryTask?: TaskRequestHandlerOptions['retryTask'];
  /** Owner-authorized result resolver. Result UI is hidden when absent. */
  resolveResult?: TaskRequestHandlerOptions['resolveResult'];
  /** Owner-authorized conversion from an Artifact reference to a short-lived response. */
  resolveArtifact?: TaskRequestHandlerOptions['resolveArtifact'];
  /** Go Gateway task correlation used by the operator Flight Recorder. */
  providerOperationsByTask?: WorkbenchHandlerOptions['providerOperationsByTask'];
  /** Explicit no-progress thresholds for At risk/Stuck UI. */
  riskPolicy?: TaskRequestHandlerOptions['riskPolicy'];
  /** Product-shell route. Defaults to `/`. */
  overviewPath?: string;
  /** Operator entry route. Defaults to `/admin`. */
  workbenchPath?: string;
  /** Operator-only link builder for a BullMQ job inspector such as bull-board. */
  runtimeJobLink?: RuntimeJobLink;
  /** Optional queue overview URL shown in Runtime Health. */
  runtimeDashboardURL?: string;
}

export type RhinoQHTTPMiddleware = (
  request: NodeTaskRequest & { on(event: 'close', listener: () => void): unknown },
  response: NodeTaskResponse & { write(chunk: Uint8Array | string): unknown },
  next?: (error?: unknown) => void,
) => void;

/**
 * Everything a fan-out needs, with the decisions already made.
 *
 * The full API is still there — `app.bridge` and `app.tasks` are the same
 * objects — but nothing here asks the caller to have an opinion on
 * `terminalProjection`, `retryProjection`, `projectorLease` or
 * `isTerminalFailure` at minute thirty. Those are library decisions with one
 * right answer for a queue-backed fan-out, and getting them wrong is silent:
 * the wrong `terminalProjection` closes a batch on its first finished item.
 *
 * ```ts
 * const app = await rhinoq({ pool, queue, events, ownerFromRequest });
 * expressApp.use(app.http({ operatorToken: process.env.OPS_TOKEN }));
 *
 * const task = await app.dispatch('batch-1', urls.map((url, index) => ({
 *   key: `item-${index}`,
 *   data: { url },
 * })));
 * ```
 */
export class RhinoQApp {
  readonly tasks: PostgresTaskClient;
  readonly bridge: BullMQTaskBridge;
  readonly reconciler: TaskReconciler;
  readonly metrics: TaskMetrics;
  readonly scope: string;
  private readonly queue: BullMQQueueForQuickstart;
  private readonly observe: (reference: { externalId?: string }) =>
    Promise<BullMQTaskObservation | undefined>;
  private readonly ownerFromRequest?: NodeTaskMiddlewareOptions['ownerFromRequest'];
  private readonly tenantFromRequest?: NodeTaskMiddlewareOptions['tenantFromRequest'];
  private readonly runtimeHealth: readonly RuntimeHealthReader[];
  private closed = false;

  /** @internal Use `rhinoq()`; construction is async because migration is. */
  constructor(parts: {
    tasks: PostgresTaskClient;
    bridge: BullMQTaskBridge;
    reconciler: TaskReconciler;
    metrics: TaskMetrics;
    scope: string;
    queue: BullMQQueueForQuickstart;
    observe: (reference: { externalId?: string }) => Promise<BullMQTaskObservation | undefined>;
    ownerFromRequest?: NodeTaskMiddlewareOptions['ownerFromRequest'];
    tenantFromRequest?: NodeTaskMiddlewareOptions['tenantFromRequest'];
    runtimeHealth?: readonly RuntimeHealthReader[];
  }) {
    this.tasks = parts.tasks;
    this.bridge = parts.bridge;
    this.reconciler = parts.reconciler;
    this.metrics = parts.metrics;
    this.scope = parts.scope;
    this.queue = parts.queue;
    this.observe = parts.observe;
    this.ownerFromRequest = parts.ownerFromRequest;
    this.tenantFromRequest = parts.tenantFromRequest;
    this.runtimeHealth = parts.runtimeHealth ?? [];
  }

  /**
   * Creates the Task, reserves every item durably, and enqueues the jobs.
   *
   * Repeating the call with the same `taskId` and item keys is safe: the
   * identities are deterministic, so a retried request finishes a partial
   * dispatch instead of creating a second batch.
   */
  async dispatch(
    taskId: string,
    items: readonly RhinoQItem[],
    options: RhinoQDispatchOptions = {},
  ): Promise<TaskSnapshot> {
    assertTaskId(taskId);
    if (!Array.isArray(items) || items.length === 0) {
      throw new RangeError('dispatch requires at least one item');
    }
    const type = options.type ?? this.scope;
    const task = {
      id: taskId,
      type,
      definitionVersion: 1,
      ...(options.tenantId ? { tenantId: options.tenantId } : {}),
      ...(options.ownerId ? { ownerId: options.ownerId } : {}),
    };
    const inputs: BullMQTaskDispatch[] = items.map((item, index) => {
      if (!item?.key?.trim()) {
        throw new TypeError(`dispatch item ${index} has no key; the key is the idempotency key`);
      }
      return {
        task,
        itemKey: item.key,
        executionId: `${taskId}:${item.key}`,
        // BullMQ refuses a custom job ID containing ':' unless it splits into
        // exactly three parts, so the natural composite is not usable.
        jobId: jobIdFor(taskId, item.key),
        job: {
          name: item.name ?? this.queue.name ?? 'rhinoq',
          data: item.data,
          options: { ...(options.jobOptions ?? {}), ...(item.options ?? {}) },
        },
      };
    });
    return this.bridge.dispatchMany(inputs, { awaitEnqueue: options.awaitEnqueue === true });
  }

  /** The current state of a batch: state, progress, item counts. */
  getTask(taskId: string): Promise<TaskSummary> {
    return this.tasks.getTaskSummary(taskId);
  }

  /**
   * Asks for cancellation and stops the jobs RhinoQ reserved for this Task.
   *
   * Requires `queue.getJob`, because stopping a job is the application's Redis
   * and RhinoQ will not scan it. A job that is already running is not killed:
   * the result is `cancellation.status`, which is a separate axis from state —
   * a job that succeeded after someone pressed Cancel is not the same as one
   * nobody tried to stop.
   */
  async cancel(taskId: string): Promise<TaskSnapshot> {
    assertTaskId(taskId);
    if (typeof this.queue.getJob !== 'function') {
      throw new TypeError('cancel requires a Queue with getJob()');
    }
    const refs = await this.tasks.listTaskExecutionRuntimeRefs(taskId);
    const jobIds = refs.executions
      .map((reference) => reference.externalId)
      .filter((value): value is string => Boolean(value));
    if (jobIds.length === 0) {
      const task = await this.tasks.getTask(taskId);
      return this.tasks.requestTaskCancellation(task.id, task.entityVersion);
    }
    return this.bridge.cancel(taskId, [...new Set(jobIds)]);
  }

  /**
   * Lists every attempt whose durable state disagrees with the queue.
   *
   * "The queue says this finished and RhinoQ still calls it running" is the one
   * shape a stuck batch takes. This reads only; it changes nothing.
   */
  audit(taskId: string): Promise<Awaited<ReturnType<BullMQTaskBridge['auditTask']>>> {
    return this.bridge.auditTask(taskId, this.observe);
  }

  /**
   * Re-reads the runtime for one batch and writes down what it finds.
   *
   * The sweeper does this on a schedule for batches that stopped moving; this
   * is the same thing on demand, for a support script or an operator button.
   */
  reconcile(taskId: string): Promise<number> {
    return this.bridge.reconcileTask(taskId, this.observe);
  }

  /** The owner-scoped read + cancel API. Mount it: `app.use('/tasks', …)`. */
  routes(
    options: Omit<NodeTaskMiddlewareOptions, 'tasks' | 'ownerFromRequest'> = {},
  ): ReturnType<typeof createNodeTaskMiddleware> {
    if (!this.ownerFromRequest) {
      throw new TypeError(
        'routes() requires ownerFromRequest. The Task API is owner-scoped, and an ' +
          'owner-scoped API with no owner would serve every batch to every caller.',
      );
    }
    return createNodeTaskMiddleware({
      ...options,
      tasks: this.tasks,
      ownerFromRequest: this.ownerFromRequest,
      ...(this.tenantFromRequest ? { tenantFromRequest: this.tenantFromRequest } : {}),
    });
  }

  /**
   * The complete HTTP surface for the default path through RhinoQ.
   *
   * Mount once at the application root. It serves the owner API at `/tasks`,
   * the owner-facing Task Center at `/task-center`, and the operator Workbench
   * at `/admin`. Use the individual middleware builders when custom paths or
   * framework-specific composition are required.
   */
  http(options: RhinoQHTTPOptions): RhinoQHTTPMiddleware {
    if (!options?.operatorToken?.trim()) {
      throw new TypeError(
        'http({ operatorToken }) is required because /admin reads Tasks across every owner.',
      );
    }
    const taskCenter = createNodeTaskCenterMiddleware({
      path: '/task-center',
      apiPath: '/tasks',
      navigation: {
        overviewPath: options.overviewPath ?? '/',
        workbenchPath: options.workbenchPath ?? '/admin',
      },
      ...(options.taskCenterTitle ? { title: options.taskCenterTitle } : {}),
    });
    const routes = this.routes({
      basePath: '/tasks',
      origin: options.origin,
      // The generic owner API records cancellation intent. The high-level path
      // can also reach the queue, so make its Cancel button stop queued work.
      cancelTask: async ({ task }) => this.cancel(task.id),
      ...(options.retryTask ? { retryTask: options.retryTask } : {}),
      ...(options.resolveResult ? { resolveResult: options.resolveResult } : {}),
      ...(options.resolveArtifact ? { resolveArtifact: options.resolveArtifact } : {}),
      ...(options.riskPolicy ? { riskPolicy: options.riskPolicy } : {}),
    });
    const workbench = this.workbench({
      token: options.operatorToken,
      basePath: '/admin',
      actions: options.actions,
      navigation: {
        overviewPath: options.overviewPath ?? '/',
        tasksPath: '/task-center',
      },
      origin: options.origin,
      ...(options.providerOperationsByTask ? { providerOperationsByTask: options.providerOperationsByTask } : {}),
      runtimeHealth: options.runtimeDashboardURL && typeof this.queue.getJobCounts === 'function'
        ? [new BullMQRuntimeInspector({ queue: this.queue as BullMQInspectableQueue, scope: this.scope, dashboardURL: options.runtimeDashboardURL })]
        : this.runtimeHealth,
      ...(options.runtimeJobLink ? { runtimeJobLink: options.runtimeJobLink } : {}),
    });

    return (request, response, next) => {
      taskCenter(request, response, () => {
        routes(request, response, (error) => {
          if (error) {
            if (next) next(error);
            else {
              response.statusCode = 500;
              response.end('Internal Server Error');
            }
            return;
          }
          workbench(request, response, () => next?.());
        });
      });
    };
  }

  /**
   * The operator console. It reads across owners and shows runtime job IDs, so
   * it takes a token rather than defaulting to open.
   *
   * Mount it without a path — `app.use(rhinoqApp.workbench({ token }))` — and
   * set `basePath` to choose the URL. The middleware matches on the full path,
   * so mounting it under `app.use('/admin', …)` and leaving `basePath` at its
   * default answers 404 for every request, which looks exactly like a broken
   * token.
   */
  workbench(
    options: { token?: string; origin?: string } &
      Omit<WorkbenchHandlerOptions, 'tasks' | 'requireOperator'> = {},
  ): ReturnType<typeof createNodeWorkbenchMiddleware> {
    const { token, ...rest } = options;
    rest.basePath ??= '/admin';
    if (!token?.trim()) {
      throw new TypeError(
        'workbench({ token }) is required: the console reads every owner\'s batches and ' +
          'shows runtime identities. Pass a token from the environment, or build the ' +
          'middleware directly with createNodeWorkbenchMiddleware and your own auth.',
      );
    }
    return createNodeWorkbenchMiddleware({
      ...rest,
      tasks: this.tasks,
      requireOperator: (request) => request.headers.get('x-operator-token') === token,
    });
  }

  /** Releases the projector lease and stops the sweeper. Does not close `pool`. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reconciler.stop();
    this.bridge.close();
  }
}

/**
 * The short way in: three objects the application already has.
 *
 * Async on purpose. Schema readiness is part of construction, not a background
 * side effect, so nothing can observe a half-built client that quietly decided
 * RhinoQ was not configured.
 */
export async function rhinoq(options: RhinoQAppOptions): Promise<RhinoQApp> {
  if (!options?.pool || typeof options.pool.connect !== 'function') {
    throw new TypeError('rhinoq() requires a PostgreSQL pool');
  }
  if (!options.queue || typeof options.queue.add !== 'function') {
    throw new TypeError('rhinoq() requires the application BullMQ Queue');
  }
  if (!options.events || typeof options.events.on !== 'function') {
    throw new TypeError('rhinoq() requires the application BullMQ QueueEvents');
  }
  const scope = (options.scope ?? options.queue.name ?? '').trim();
  if (!scope) {
    throw new TypeError(
      'rhinoq() needs a scope and the Queue has no name. It is the fencing identity: ' +
        'only one process may project a scope, and two that share one corrupt each other.',
    );
  }

  const tasks = await installPostgresTaskProfile(options.pool);
  const metrics = new TaskMetrics();
  const queue = options.queue;
  const observe = bullMQObserver(queue);
  const runtimeHealth: readonly RuntimeHealthReader[] = typeof queue.getJobCounts === 'function'
    ? [new BullMQRuntimeInspector({ queue: queue as BullMQInspectableQueue, scope })]
    : [];

  const bridge = new BullMQTaskBridge({
      client: tasks,
      queue,
      events: options.events,
      runtimeScope: scope,
      metrics,
      // A queue was supplied and dispatch fans out, so one job is never the
      // whole Task. `single-execution` here would drive a batch terminal on its
      // first finished item, silently and irreversibly.
      terminalProjection: 'execution-only',
      aggregate: { progress: 'terminal-items', terminal: 'manual' },
      // BullMQ knows when it is out of attempts. Without this every failure is
      // treated as "the attempt may still retry", so the settled check never
      // runs after a failure and a batch whose last item fails never settles.
      isTerminalFailure: async (event) => {
        if (typeof queue.getJob !== 'function') return true;
        const job = await queue.getJob(event.jobId);
        return !job || (job.attemptsMade ?? 0) >= (job.opts?.attempts ?? 1);
      },
      // Exactly-once, decided by one SQL statement rather than a counter in
      // this process, so it survives a crash, a redelivered event and several
      // bridges. Closing the Task here is the whole reason `aggregate.terminal`
      // stays `manual`: the library decides *when*, the batch decides *what*.
      onItemsSettled: async (task) => {
        const failed = latestPerItem(task).filter((item) => item.state === 'failed').length;
        const current = await tasks.getTask(task.id);
        if (current.state === 'running' || current.state === 'cancel_requested') {
          await tasks.transitionTask(
            current.id,
            current.entityVersion,
            failed > 0 ? 'failed' : 'succeeded',
          );
        }
        await options.onSettled?.(await tasks.getTask(task.id));
      },
      // What cancelling actually does to the runtime. A job that has not
      // started can be removed; one that is running cannot be stopped safely
      // from outside, and saying `cannot_cancel_safely` is the honest answer —
      // pretending otherwise is how a half-finished side effect gets reported
      // as cancelled. The application's own handler is the only thing that can
      // cooperate, and RhinoQ will not kill a worker to fake it.
      cancelJob: async (jobId) => {
        if (typeof queue.getJob !== 'function') {
          return { status: 'cannot_cancel_safely', reason: 'the Queue cannot look a job up' };
        }
        const job = await queue.getJob(jobId);
        if (!job) return { status: 'acknowledged' };
        const state = typeof job.getState === 'function' ? await job.getState() : 'unknown';
        if (state === 'completed' || state === 'failed') {
          return { status: 'acknowledged' };
        }
        if (state === 'active') {
          return { status: 'cannot_cancel_safely', reason: `job ${jobId} is already running` };
        }
        try {
          await job.remove?.();
          return { status: 'acknowledged' };
        } catch (error) {
          return {
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      },
      // Close the Task once every one of its jobs has actually stopped. Leaving
      // an acknowledged cancellation at `running` is a lie the batch view keeps
      // telling; the bridge refuses to close one that still has work in flight.
      terminalizeOnCancel: true,
      // One projector per scope. The lock lives in a database session, so a
      // failover releases it and the replacement does not run beside it.
      projectorLease: new PostgresProjectorLease(options.pool, scope),
      ...(options.onWarning ? { onWarning: options.onWarning } : {}),
      ...(options.onError ? { onError: options.onError } : {}),
  });

  // On by default. Events stop arriving if nobody is listening, and a batch
  // that stopped being written down looks exactly like one that has not
  // finished yet. The sweep is the fallback, not the mechanism — but "you were
  // supposed to configure a reconciler" is not something anyone finds out until
  // the batch that needed it is already stuck, so it is not a choice here.
  const reconciler = new TaskReconciler({
    tasks,
    metrics,
    query: {
      states: ['running', 'cancel_requested'],
      idleForMs: options.idleForMs ?? 300_000,
      itemsSettled: false,
    },
    everyMs: options.reconcileEveryMs ?? 60_000,
    lease: new PostgresProjectorLease(options.pool, `${scope}:reconciler`),
    reconcile: async (task) => {
      await bridge.reconcileTask(task.id, observe);
    },
    ...(options.onError ? { onError: options.onError } : {}),
  });

  const app = new RhinoQApp({
    tasks,
    metrics,
    scope,
    queue,
    bridge,
    reconciler,
    observe,
    runtimeHealth,
    ...(options.ownerFromRequest ? { ownerFromRequest: options.ownerFromRequest } : {}),
    ...(options.tenantFromRequest ? { tenantFromRequest: options.tenantFromRequest } : {}),
  });

  await bridge.start();
  reconciler.start();
  return app;
}

/**
 * Reads one BullMQ job into the observation shape reconciliation needs.
 *
 * This is the one piece of runtime-specific code the bridge cannot invent for
 * itself, because reading it means touching the application's Redis. Every
 * adopter used to write this function; there is only one sensible version.
 */
function bullMQObserver(queue: BullMQQueueForQuickstart) {
  return async (
    reference: { externalId?: string },
  ): Promise<BullMQTaskObservation | undefined> => {
    const jobId = reference.externalId;
    if (!jobId || typeof queue.getJob !== 'function') return undefined;
    const job = await queue.getJob(jobId);
    if (!job || typeof job.getState !== 'function') return undefined;
    switch (await job.getState()) {
      case 'completed':
        return { jobId, state: 'completed', returnvalue: job.returnvalue };
      case 'failed':
        // Fail-closed: a failed observation becomes a failed Task only when the
        // runtime is out of attempts. A transient failure looks terminal here
        // otherwise, and a batch would be failed by a retry that then succeeds.
        return {
          jobId,
          state: 'failed',
          terminal: (job.attemptsMade ?? 0) >= (job.opts?.attempts ?? 1),
          ...(job.failedReason ? { failedReason: job.failedReason } : {}),
        };
      case 'active':
        return { jobId, state: 'active' };
      case 'waiting':
      case 'waiting-children':
      case 'delayed':
      case 'prioritized':
        return { jobId, state: 'waiting' };
      default:
        return undefined;
    }
  };
}

/**
 * One entry per item: the latest attempt, with the history dropped.
 *
 * Every list of attempts RhinoQ hands back — `TaskSnapshot.executions`,
 * `getTaskExecutionResults` — contains retries as separate entries, because
 * "attempt 1 failed with a 502, attempt 2 succeeded" is the answer to the only
 * question anyone asks about a retried job. It is also why counting that list
 * directly reports 54 items for a 50-item batch. Use this wherever the answer
 * is about items rather than attempts.
 */
export function latestAttemptPerItem<
  T extends { id?: string; executionId?: string; itemKey?: string; attempt?: number },
>(executions: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const execution of executions) {
    const key = execution.itemKey ?? execution.executionId ?? execution.id ?? '';
    const current = latest.get(key);
    if (!current || (execution.attempt ?? 1) > (current.attempt ?? 1)) {
      latest.set(key, execution);
    }
  }
  return [...latest.values()];
}

function latestPerItem(task: TaskSnapshot) {
  return latestAttemptPerItem(task.executions);
}

function assertTaskId(taskId: string): void {
  if (!taskId?.trim()) {
    throw new TypeError('a task id is required');
  }
}

/**
 * BullMQ rejects a custom job ID containing `:` unless it splits into exactly
 * three parts — a compatibility rule for old repeatable jobs — so the natural
 * `${taskId}:${itemKey}` is refused. The Execution keeps the readable form;
 * only the runtime identity is rewritten.
 */
function jobIdFor(taskId: string, itemKey: string): string {
  return `${taskId}__${itemKey}`.replaceAll(':', '__');
}
