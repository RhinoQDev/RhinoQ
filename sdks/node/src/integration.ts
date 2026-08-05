import type { TaskExecutionRuntimeRef, TaskSummary } from './gateway/types.js';
import {
  BullMQTaskBridge,
  BullMQProjectorUnownedError,
  type BullMQProjectorLease,
  type BullMQQueueEvents,
  type BullMQTaskBridgeOptions,
  type BullMQTaskObservation,
} from './bullmq/task-bridge.js';
import {
  checkEmbeddedHealth,
  TaskMetrics,
  type EmbeddedHealth,
  type HealthQueryable,
} from './observe/metrics.js';
import { PostgresProjectorLease } from './postgres/projector-lease.js';
import { installPostgresTaskProfile, PostgresTaskClient } from './postgres/task-client.js';
import type { SqlPool } from './postgres/task-schema.js';
import {
  createNodeTaskMiddleware,
  type NodeTaskMiddlewareOptions,
} from './tasks/adapters.js';
import {
  TaskReconciler,
  type ReconcilableTaskSource,
  type TaskReconcilerLease,
} from './tasks/reconciler.js';
import type { TaskStateQuery } from './postgres/task-client.js';
import type { TaskClient } from './tasks/client.js';

/** Application-owned read of one BullMQ runtime identity. */
export type BullMQRuntimeObserver = (
  reference: TaskExecutionRuntimeRef,
) => Promise<BullMQTaskObservation | undefined>;

export interface RhinoQReconciliationOptions {
  /** The only runtime-specific code RhinoQ cannot safely invent. */
  observe: BullMQRuntimeObserver;
  query?: Partial<TaskStateQuery>;
  everyMs?: number;
  batchLimit?: number;
  /** Defaults to a PostgreSQL advisory lease derived from runtimeScope. */
  lease?: TaskReconcilerLease;
  onError?: (error: unknown, task?: TaskSummary) => void;
  onLeaseLost?: () => void;
}

/**
 * One-process integration boundary for a Node/BullMQ application.
 *
 * This class owns lifecycle wiring only. Task transitions remain in the
 * versioned PostgreSQL commands, and BullMQ remains application-owned. The
 * default path installs the isolated Task profile, elects one projector per
 * runtime scope and exposes the same metrics/health surfaces used by the
 * embedded client.
 */
export interface RhinoQTaskIntegrationOptions extends Omit<
  BullMQTaskBridgeOptions,
  'client' | 'events' | 'projectorLease' | 'metrics'
> {
  pool: SqlPool;
  events: BullMQQueueEvents;
  runtimeScope: string;
  /** Existing client may be supplied when schema installation is external. */
  tasks?: TaskClient;
  /** Defaults to a session advisory lease for runtimeScope. */
  projectorLease?: BullMQProjectorLease;
  metrics?: TaskMetrics;
  /** Application auth used by the framework-neutral Task HTTP middleware. */
  ownerFromRequest?: NodeTaskMiddlewareOptions['ownerFromRequest'];
  reconciliation?: RhinoQReconciliationOptions;
  /** Retry projector ownership in standby replicas. Defaults to 5 seconds. */
  projectorRetryMs?: number;
}

export interface RhinoQIntegrationHealth {
  status: 'ok' | 'degraded' | 'down';
  database: EmbeddedHealth;
  projector: 'unowned' | 'projecting' | 'lost' | 'closed';
  reconciler: {
    enabled: boolean;
    ownership: 'unowned' | 'owned' | 'closed' | 'disabled';
    lastSweepAt?: string;
    lastSuccessfulSweepAt?: string;
  };
  detail: string;
}

/**
 * Builds the standard BullMQ/Task integration.
 *
 * The function is async on purpose: schema readiness is part of construction,
 * not a best-effort module-init side effect. A consumer cannot observe a
 * half-built client or a bridge that silently disabled itself.
 */
export async function createRhinoQTaskIntegration(
  options: RhinoQTaskIntegrationOptions,
): Promise<RhinoQTaskIntegration> {
  validateOptions(options);
  const tasks = options.tasks ?? await installPostgresTaskProfile(options.pool);
  const metrics = options.metrics ?? new TaskMetrics();
  const projectorLease = options.projectorLease
    ?? new PostgresProjectorLease(options.pool, options.runtimeScope);
  const bridge = new BullMQTaskBridge({
    ...options,
    client: tasks,
    events: options.events,
    projectorLease,
    metrics,
  });

  let reconciler: TaskReconciler | undefined;
  if (options.reconciliation) {
    if (typeof (tasks as Partial<ReconcilableTaskSource>).listTasksByState !== 'function') {
      throw new TypeError(
        'reconciliation requires a Task client with listTasksByState; use PostgresTaskClient',
      );
    }
    const reconciliationLease = options.reconciliation.lease
      ?? new PostgresProjectorLease(options.pool, `${options.runtimeScope}:reconciler`);
    const reconcilableTasks = tasks as TaskClient & ReconcilableTaskSource;
    reconciler = new TaskReconciler({
      tasks: reconcilableTasks,
      reconcile: async (task) => {
        await bridge.reconcileTask(task.id, options.reconciliation!.observe);
      },
      query: options.reconciliation.query,
      everyMs: options.reconciliation.everyMs,
      batchLimit: options.reconciliation.batchLimit,
      metrics,
      lease: reconciliationLease,
      onError: options.reconciliation.onError,
      onLeaseLost: options.reconciliation.onLeaseLost,
    });
  }

  return new RhinoQTaskIntegration({
    pool: options.pool,
    tasks,
    postgresTasks: tasks instanceof PostgresTaskClient ? tasks : undefined,
    bridge,
    reconciler,
    metrics,
    ownerFromRequest: options.ownerFromRequest,
    projectorRetryMs: options.projectorRetryMs ?? 5_000,
  });
}

interface RhinoQTaskIntegrationConstructorOptions {
  pool: SqlPool;
  tasks: TaskClient;
  postgresTasks?: PostgresTaskClient;
  bridge: BullMQTaskBridge;
  reconciler?: TaskReconciler;
  metrics: TaskMetrics;
  ownerFromRequest?: NodeTaskMiddlewareOptions['ownerFromRequest'];
  projectorRetryMs: number;
}

export class RhinoQTaskIntegration {
  readonly pool: SqlPool;
  readonly tasks: TaskClient;
  readonly postgresTasks?: PostgresTaskClient;
  readonly bridge: BullMQTaskBridge;
  readonly reconciler?: TaskReconciler;
  readonly metrics: TaskMetrics;
  private readonly ownerFromRequest?: NodeTaskMiddlewareOptions['ownerFromRequest'];
  private readonly projectorRetryMs: number;
  private projectorRetryTimer?: ReturnType<typeof setTimeout>;
  private started = false;
  private closed = false;

  constructor(options: RhinoQTaskIntegrationConstructorOptions) {
    this.pool = options.pool;
    this.tasks = options.tasks;
    this.postgresTasks = options.postgresTasks;
    this.bridge = options.bridge;
    this.reconciler = options.reconciler;
    this.metrics = options.metrics;
    this.ownerFromRequest = options.ownerFromRequest;
    this.projectorRetryMs = options.projectorRetryMs;
  }

  /** Starts the fenced projector and, when configured, the bounded sweeper. */
  async start(): Promise<void> {
    if (this.closed) {
      throw new Error('RhinoQTaskIntegration.start() after close()');
    }
    if (this.started) {
      return;
    }
    try {
      await this.bridge.start();
    } catch (error) {
      if (!(error instanceof BullMQProjectorUnownedError)) {
        throw error;
      }
      this.scheduleProjectorRetry();
    }
    this.reconciler?.start();
    this.started = true;
  }

  /** Stops timers and releases ownership through the bridge/reconciler APIs. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.projectorRetryTimer) {
      clearTimeout(this.projectorRetryTimer);
      this.projectorRetryTimer = undefined;
    }
    this.reconciler?.stop();
    this.bridge.close();
  }

  /** Returns a framework-neutral middleware using the host application's auth. */
  middleware(
    options: Omit<NodeTaskMiddlewareOptions, 'tasks' | 'ownerFromRequest'> = {},
  ): ReturnType<typeof createNodeTaskMiddleware> {
    if (!this.postgresTasks || !this.ownerFromRequest) {
      throw new Error(
        'RhinoQTaskIntegration.middleware() requires the default PostgreSQL Task client ' +
          'and ownerFromRequest',
      );
    }
    return createNodeTaskMiddleware({
      ...options,
      tasks: this.postgresTasks,
      ownerFromRequest: this.ownerFromRequest,
    });
  }

  /**
   * Health is a report, not a throwing probe. A database can be reachable while
   * this process owns no projector, which is degraded rather than healthy.
   */
  async health(expectedSchemaVersion = 6): Promise<RhinoQIntegrationHealth> {
    const database = await checkEmbeddedHealth(
      this.pool as unknown as HealthQueryable,
      expectedSchemaVersion,
    );
    const reconciler = this.reconciler;
    const projector = this.bridge.ownership;
    const reconcilerOwnership = reconciler
      ? reconciler.ownership
      : 'disabled';
    const details: string[] = [];
    if (database.detail) details.push(database.detail);
    if (projector === 'unowned') details.push('projector lease is not owned');
    if (projector === 'lost') details.push('projector lease was lost; restart or reacquire ownership');
    if (reconciler?.leaseIsUnavailable) {
      details.push('reconciliation lease is unavailable');
    }
    const status = database.status === 'down'
      ? 'down'
      : database.status === 'degraded' || details.length > 0
        ? 'degraded'
        : 'ok';
    return {
      status,
      database,
      projector,
      reconciler: {
        enabled: Boolean(reconciler),
        ownership: reconcilerOwnership,
        ...(reconciler?.lastSweepAtIso ? { lastSweepAt: reconciler.lastSweepAtIso } : {}),
        ...(reconciler?.lastSuccessfulSweepAtIso
          ? { lastSuccessfulSweepAt: reconciler.lastSuccessfulSweepAtIso }
          : {}),
      },
      detail: details.join('; '),
    };
  }

  private scheduleProjectorRetry(): void {
    if (this.closed || this.projectorRetryTimer) {
      return;
    }
    this.projectorRetryTimer = setTimeout(() => {
      this.projectorRetryTimer = undefined;
      void this.tryAcquireProjector();
    }, this.projectorRetryMs);
    this.projectorRetryTimer.unref?.();
  }

  private async tryAcquireProjector(): Promise<void> {
    if (this.closed || this.bridge.ownership !== 'unowned') {
      return;
    }
    try {
      await this.bridge.start();
    } catch (error) {
      if (error instanceof BullMQProjectorUnownedError) {
        this.scheduleProjectorRetry();
        return;
      }
      // A database/subscribe failure is not ownership contention, but a timer
      // callback must not create an unhandled rejection. Health still reports
      // the database/projector state; the counter gives an operator a durable
      // signal that the retry path itself is failing.
      this.metrics.increment('rhinoq_bridge_projector_retry_failed_total', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      this.scheduleProjectorRetry();
    }
  }
}

function validateOptions(options: RhinoQTaskIntegrationOptions): void {
  if (!options || typeof options !== 'object') {
    throw new TypeError('RhinoQTaskIntegration options are required');
  }
  if (!options.pool || typeof options.pool.query !== 'function' ||
      typeof options.pool.connect !== 'function') {
    throw new TypeError('RhinoQTaskIntegration requires a PostgreSQL pool');
  }
  if (!options.events || typeof options.events.on !== 'function') {
    throw new TypeError('RhinoQTaskIntegration requires BullMQ QueueEvents');
  }
  if (!options.runtimeScope?.trim()) {
    throw new TypeError('RhinoQTaskIntegration requires runtimeScope for fencing');
  }
  if (options.projectorRetryMs !== undefined &&
      (!Number.isFinite(options.projectorRetryMs) || options.projectorRetryMs <= 0)) {
    throw new RangeError('projectorRetryMs must be a positive number');
  }
  if (options.reconciliation && typeof options.reconciliation.observe !== 'function') {
    throw new TypeError('reconciliation.observe must be a function');
  }
}
