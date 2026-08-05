import {
  RhinoQError,
} from '../gateway/client.js';
import type {
  TaskCreateRequest,
  TaskExecution,
  TaskExecutionRuntimeRef,
  TaskProgress,
  TaskSnapshot,
  TaskState,
} from '../gateway/types.js';
import type { TaskClient } from '../tasks/client.js';
import type { TaskMetrics } from '../observe/metrics.js';
import type { ProjectionFailure, ProjectionFailureSink } from '../tasks/projection-failures.js';

type QueueEvent = 'waiting' | 'active' | 'progress' | 'completed' | 'failed';

// Queue events and browser/API writes can legitimately race. The Gateway
// rejects stale aggregate/execution versions, so the bridge must re-read and
// converge instead of treating one optimistic conflict as a dropped event.
const MAX_VERSION_CONVERGENCE_ATTEMPTS = 3;
const DEFAULT_DISPATCH_CONCURRENCY = 8;
const MAX_DISPATCH_CONCURRENCY = 64;

// Every live bridge in this process, counted by runtime scope. Two bridges on
// the same scope both subscribe to QueueEvents, so each job event is projected
// twice and the two projections contend for the same Task version. RhinoQ has
// no leader election and is not going to grow one here, so the only thing it
// can honestly do is say so at construction, while the stack that built the
// second bridge is still on screen.
const activeScopes = new Map<string, number>();

// This intentionally uses the small QueueEvents shape instead of importing
// BullMQ. Applications already using BullMQ pass their QueueEvents instance;
// RhinoQ neither owns their Redis connection nor bundles a second queue.
export interface BullMQQueueEvents {
  on(event: QueueEvent, listener: (event: BullMQEvent) => void): unknown;
  off?(event: QueueEvent, listener: (event: BullMQEvent) => void): unknown;
}

/** Structural subset of BullMQ Queue; RhinoQ does not own its Redis client. */
export interface BullMQQueue {
  add(
    name: string,
    data: unknown,
    options: Record<string, unknown> & { jobId: string },
  ): Promise<{ id?: string } | undefined>;
  /**
   * BullMQ exposes queue defaults through `opts.defaultJobOptions`. The
   * direct property is accepted too so adapters can pass a small structural
   * fake without importing BullMQ's concrete type.
   */
  defaultJobOptions?: Record<string, unknown>;
  opts?: { defaultJobOptions?: Record<string, unknown> };
}

export interface BullMQEvent {
  jobId: string;
  /** Optional one-based runtime attempt supplied by an application read. */
  attempt?: number;
  data?: unknown;
  returnvalue?: unknown;
  failedReason?: string;
}

export interface BullMQTaskBinding {
  task: TaskCreateRequest;
  executionId: string;
  /**
   * The idempotency key of one logical item.
   *
   * Attempts are numbered per `itemKey`, and the aggregate counts one item per
   * key, so this is what decides whether two Executions are "the same work,
   * retried" or "two different things". It is not a label.
   *
   * Omitting it stores the key `default`. That is correct for a Task that is
   * one item and wrong for every fan-out: fifty items with no key become
   * attempts 1..50 of a single item, the aggregate reads `total: 1`, and an
   * `all-succeeded` batch terminates on the first finish. `dispatchMany`
   * therefore requires it.
   */
  itemKey?: string;
  jobId: string;
}

export interface BullMQTaskDispatch extends BullMQTaskBinding {
  job: {
    name: string;
    data: unknown;
    options?: Record<string, unknown>;
  };
}

export type BullMQObservedState = 'waiting' | 'active' | 'completed' | 'failed';

export type BullMQProjectorState =
  | 'unowned'
  | 'projecting'
  | 'lost'
  | 'closed';

/** Non-fatal startup result: another process currently owns the scope. */
export class BullMQProjectorUnownedError extends Error {
  readonly code = 'RHINOQ_PROJECTOR_UNOWNED';

  constructor(runtimeScope: string) {
    super(
      `BullMQTaskBridge could not acquire projector ownership for runtimeScope ${JSON.stringify(runtimeScope)}; ` +
        'run one projector per scope or wait for the current owner to release it',
    );
    this.name = 'BullMQProjectorUnownedError';
  }
}

/**
 * A point-in-time observation read by the application from its BullMQ Job.
 * It is intentionally not a Queue scan contract: the application decides
 * which already-known jobs are worth reconciling after its bridge restarts.
 */
export interface BullMQTaskObservation extends BullMQEvent {
  state: BullMQObservedState;
  /**
   * One-based attempt observed in BullMQ. Supplying this lets reconciliation
   * repair a gap where both the failed and active events were missed.
   */
  attempt?: number;
  /** Required to make an observed failed job terminal in RhinoQ. */
  terminal?: boolean;
}

export interface BullMQProjectorLease {
  /** Returns true only for the process that owns this runtime scope. */
  acquire(): Promise<boolean>;
  /** Releases the ownership held by this bridge. */
  release(): Promise<void>;
  /**
   * Returns false once ownership has been lost without being released — a
   * database failover or a killed session drops the lock while this process
   * carries on. Optional so an existing implementation still type-checks, but
   * a lease without it cannot report the failure it exists to prevent, and the
   * bridge says so at `start()`.
   */
  verify?(): Promise<boolean>;
}

export interface BullMQTaskBridgeOptions {
  client: TaskClient;
  events: BullMQQueueEvents;
  /** Supply the application's Queue only when using dispatch()/dispatchMany(). */
  queue?: BullMQQueue;
  /**
   * Queue/tenant scope for runtime identity. BullMQ job IDs are unique only
   * within a queue, so new Task-only integrations should always set this.
   * Omitted only for compatibility with the legacy Gateway schema.
   */
  runtimeScope?: string;
  /**
   * Maximum concurrent Gateway/Queue operations used by dispatchMany().
   * Defaults to 8 and is capped at 64 to avoid an accidental connection storm.
   */
  dispatchConcurrency?: number;
  /**
   * Controls whether one BullMQ job may terminate its parent Task.
   *
   * Use `single-execution` only when one job represents the whole user-facing
   * Task. Use `execution-only` for fan-out: the bridge records each Execution,
   * while the application completes/fails the Task after its aggregate
   * outcome is known.
   *
   * There is deliberately no default. Only the application knows whether one
   * job is the whole Task, and guessing `single-execution` for a fan-out drives
   * the batch to a terminal `succeeded` on its first finished item — silently,
   * and irreversibly, because terminal Task states are never reopened.
   */
  terminalProjection: 'single-execution' | 'execution-only';
  /**
   * Optional fan-out aggregation after all item Executions are reserved.
   * There is no terminal default: partial-success semantics are business
   * semantics and must be selected explicitly.
   */
  aggregate?: {
    progress?: 'terminal-items';
    terminal?: 'manual' | 'all-succeeded' | 'at-least-one-succeeded';
  };
  /**
   * Maps BullMQ progress into the portable Task progress contract.
   *
   * BullMQ accepts both a number and an object. A number has no portable unit:
   * applications commonly use it as a percentage, while older RhinoQ code
   * treated it as an item count. The default therefore accepts only the
   * structured `{ completed, total?, message? }` shape. Choose
   * `bullMQCountProgress` or `bullMQPercentageProgress` explicitly when the
   * application emits numbers.
   */
  progress?: (event: BullMQEvent) => TaskProgress | undefined;
  /**
   * BullMQ can emit a failed event before retrying. Return true only after the
   * application's Queue/Job inspection has established that this job is truly
   * terminal. Omitting it leaves the Task running instead of falsely failing it.
   */
  isTerminalFailure?: (event: BullMQEvent) => Promise<boolean>;
  /**
   * Maps a completed BullMQ return value to an application-owned result ref.
   * The reference is recorded on the Execution that produced it, and — in
   * `single-execution` mode, where one job is the whole Task — on the Task too.
   */
  resultReference?: (event: BullMQEvent) => Promise<string | undefined>;
  /**
   * Explains one failed item to the user. Defaults to BullMQ's `failedReason`.
   * Return undefined to record the failure without a reason; the Gateway bounds
   * whatever is returned, because it is polled with the snapshot.
   */
  failureReason?: (event: BullMQEvent) => string | undefined;
  /**
   * Application-owned cancellation. Return `acknowledged` only when BullMQ or
   * the worker has durably stopped this job. Unknown active side effects must
   * return `cannot_cancel_safely`; the bridge never calls Queue.remove blindly.
   */
  cancelJob?: (
    jobId: string,
    execution: TaskExecution,
  ) => Promise<
    | { status: 'acknowledged' }
    | { status: 'cannot_cancel_safely' | 'failed'; reason: string }
  >;
  /**
   * Finishes an acknowledged cancellation instead of leaving the Task at
   * `cancel_requested`.
   *
   * `cancel()` records the cancellation *outcome*; it never moves the Task to a
   * terminal state, because a terminal Task is never reopened and only the
   * application knows whether the jobs it named are the whole Task. Under
   * `aggregate.terminal: 'manual'` — the default — nothing else moves it
   * either, so the Task sits at `cancel_requested` until the application
   * transitions it.
   *
   * With this enabled and every named job acknowledged, the bridge cancels
   * those Executions and then the Task. It still refuses when any other
   * Execution is non-terminal: an incomplete `jobIds` list would otherwise
   * close a Task while its remaining items are running.
   */
  terminalizeOnCancel?: boolean;
  /**
   * What to do when a job becomes active again after its attempt finished.
   *
   * BullMQ reuses the job ID across retries. The first attempt is already
   * terminal by then, its state machine refuses to move, and the retry left no
   * record at all — the `attempt` column never advanced past 1 for any
   * external runtime.
   *
   * `new-attempt` (the default) supersedes the finished attempt and opens the
   * next one for the same item, keeping the previous outcome and reason. That
   * is the answer to the only question anyone asks about a retried job.
   *
   * `ignore` restores the old behaviour. Use it while rolling the Task schema
   * back past v4, where the retry row cannot exist.
   */
  retryProjection?: 'new-attempt' | 'ignore';
  /**
   * Names the Execution opened for a retry. Defaults to
   * `<previous execution id>#<attempt>`, which is deterministic, so a repeated
   * projection of the same retry converges instead of forking.
   */
  retryExecutionId?: (previous: TaskExecution, attempt: number) => string;
  /**
   * Called once, when every item of a fan-out has reached a terminal state.
   *
   * `aggregate.progress: 'terminal-items'` writes progress on every
   * completion; this is the single moment the batch became complete. Every
   * adopter wrote that themselves as "did I just see the last one?", counting
   * in application code — an answer that is wrong the moment two workers
   * finish concurrently or an event is re-delivered.
   *
   * Exactly-once is enforced in one SQL statement, not by this process, so it
   * survives a crash and several bridges. It needs a client that implements
   * `settleTaskItems`; the Gateway client does not, and the bridge says so
   * once rather than silently never firing.
   *
   * A throw here is reported through `onError`. The signal is not re-delivered:
   * it already fired.
   */
  onItemsSettled?: (task: TaskSnapshot) => Promise<void> | void;
  /**
   * Writes a failed projection somewhere it survives the process.
   *
   * `onError` is a callback: it fires once, in the process that failed, and
   * that process is often being killed — the reason the projection failed is
   * frequently the reason the process is going away. The event is then gone
   * and nothing knows the job ever happened.
   *
   * The sink is application-owned on purpose. The Task-only profile promises
   * exactly three tables, replaying a projection is a business decision, and
   * the row belongs beside whatever the job was doing.
   *
   * Recording is awaited before `onError` runs, so a sink that throws is
   * reported rather than swallowed.
   */
  projectionFailures?: ProjectionFailureSink;
  /**
   * Counts projections and their failures. The embedded path has no Gateway
   * and therefore no /metrics; this is the replacement. It records counts
   * only — no latency, no rate — because a performance number without its
   * benchmark is a claim RhinoQ is not allowed to make.
   */
  metrics?: TaskMetrics;
  onError?: (error: unknown, event: BullMQEvent) => void;
  /**
   * Receives configuration warnings that are not tied to one job event.
   * Defaults to `console.warn`. Pass a no-op to route them into a logger
   * instead of silencing them by deleting the check.
   */
  onWarning?: (warning: string) => void;
  /**
   * Acknowledges that several bridges share one `runtimeScope` on purpose.
   * Silences the duplicate-scope warning; it changes no behaviour.
   * `RHINOQ_ALLOW_CONCURRENT_BRIDGES=1` does the same for a whole process.
   */
  allowConcurrentBridges?: boolean;
  /**
   * Optional durable owner lease. When supplied, call `await bridge.start()`
   * before the application starts producing QueueEvents. A PostgreSQL
   * advisory-lock implementation is exported as `PostgresProjectorLease`.
   */
  projectorLease?: BullMQProjectorLease;
  /**
   * How often to re-check that the lease is still held. Defaults to 15s;
   * `0` disables the check. Only used when the lease implements `verify()`.
   */
  leaseVerifyIntervalMs?: number;
  /**
   * Called once when the lease is lost without being released. The bridge has
   * already stopped projecting by then; this is where an application decides
   * whether to exit, alert, or attempt to take ownership again. A lost lease
   * means another process may now be projecting this scope.
   */
  onLeaseLost?: (runtimeScope: string) => void;
}

/**
 * BullMQTaskBridge projects application-owned jobs into RhinoQ Tasks. New
 * integrations should use dispatch()/dispatchMany() so the durable identity is
 * reserved before Queue.add(); track() remains the compatibility path for a
 * job the application already added. The bridge does not change worker
 * handlers or guess whether an active side effect can be cancelled safely.
 */
export class BullMQTaskBridge {
  private readonly client: TaskClient;
  private readonly events: BullMQQueueEvents;
  private readonly bullQueue?: BullMQQueue;
  private readonly runtimeScope: string;
  private readonly dispatchConcurrency: number;
  private readonly terminalProjection: 'single-execution' | 'execution-only';
  private readonly aggregateProgress: boolean;
  private readonly aggregateTerminal:
    'manual' | 'all-succeeded' | 'at-least-one-succeeded';
  private readonly progress: (event: BullMQEvent) => TaskProgress | undefined;
  private readonly isTerminalFailure?: (event: BullMQEvent) => Promise<boolean>;
  private readonly resultReference?: (event: BullMQEvent) => Promise<string | undefined>;
  private readonly failureReason: (event: BullMQEvent) => string | undefined;
  private readonly cancelJob?: BullMQTaskBridgeOptions['cancelJob'];
  private readonly terminalizeOnCancel: boolean;
  private readonly retryProjection: 'new-attempt' | 'ignore';
  private readonly retryExecutionId: (previous: TaskExecution, attempt: number) => string;
  private readonly onItemsSettled?: (task: TaskSnapshot) => Promise<void> | void;
  private readonly projectionFailures?: ProjectionFailureSink;
  private readonly projectorLease?: BullMQProjectorLease;
  private readonly leaseVerifyIntervalMs: number;
  private readonly onLeaseLost?: (runtimeScope: string) => void;
  private leaseAcquired = false;
  private projectorState: BullMQProjectorState = 'unowned';
  private leaseVerifyTimer?: ReturnType<typeof setInterval>;
  private verifyingLease = false;
  private warnedAboutRetrySupport = false;
  private warnedAboutSettleSupport = false;
  private readonly metrics?: TaskMetrics;
  private readonly warn: (warning: string) => void;
  private readonly onError?: (error: unknown, event: BullMQEvent) => void;
  private readonly listeners: Array<[QueueEvent, (event: BullMQEvent) => void]>;
  private scopeRegistered = false;
  private subscribed = false;
  private closed = false;

  constructor(options: BullMQTaskBridgeOptions) {
    this.client = options.client;
    this.events = options.events;
    this.bullQueue = options.queue;
    this.runtimeScope = options.runtimeScope?.trim() ?? '';
    this.dispatchConcurrency = boundedInteger(
      options.dispatchConcurrency ?? DEFAULT_DISPATCH_CONCURRENCY,
      'dispatchConcurrency',
      1,
      MAX_DISPATCH_CONCURRENCY,
    );
    // JavaScript callers get no compile-time check, so refuse at construction
    // rather than at the first completed job.
    if (
      options.terminalProjection !== 'single-execution' &&
      options.terminalProjection !== 'execution-only'
    ) {
      throw new TypeError(
        "BullMQTaskBridge requires terminalProjection: 'single-execution' when one " +
          "BullMQ job is the whole Task, or 'execution-only' when the Task fans out " +
          'into several jobs and the application completes it.',
      );
    }
    this.terminalProjection = options.terminalProjection;
    this.aggregateProgress = options.aggregate?.progress === 'terminal-items';
    this.aggregateTerminal = options.aggregate?.terminal ?? 'manual';
    this.progress = options.progress ?? defaultProgress;
    this.isTerminalFailure = options.isTerminalFailure;
    this.resultReference = options.resultReference;
    this.failureReason = options.failureReason ?? defaultFailureReason;
    this.cancelJob = options.cancelJob;
    this.terminalizeOnCancel = options.terminalizeOnCancel === true;
    this.retryProjection = options.retryProjection ?? 'new-attempt';
    this.retryExecutionId = options.retryExecutionId
      ?? ((previous, attempt) => `${previous.id}#${attempt}`);
    this.onItemsSettled = options.onItemsSettled;
    this.metrics = options.metrics;
    this.warn = options.onWarning ?? ((warning: string) => console.warn(warning));
    this.onError = options.onError;
    this.warnOnQueueRetryPolicy();
    this.projectorLease = options.projectorLease;
    this.leaseVerifyIntervalMs = options.leaseVerifyIntervalMs ?? 15_000;
    this.onLeaseLost = options.onLeaseLost;
    this.warnIfSettlementCannotFireAfterAFailure(options);
    if (this.projectorLease && !this.runtimeScope) {
      throw new TypeError('BullMQTaskBridge projectorLease requires runtimeScope');
    }
    this.warnOnDuplicateScope(options);
    this.projectionFailures = options.projectionFailures;
    this.listeners = (['waiting', 'active', 'progress', 'completed', 'failed'] as const)
      .map((name): [QueueEvent, (event: BullMQEvent) => void] => [
        name,
        (event) => this.run(name, event, () => this.project(name, event)),
      ]);
    if (!this.projectorLease) {
      this.subscribe();
      this.projectorState = 'projecting';
    }
  }

  /** Current ownership state for readiness checks and operator diagnostics. */
  get ownership(): BullMQProjectorState {
    return this.projectorState;
  }

  /**
   * Acquires the optional durable owner lease and subscribes to QueueEvents.
   * Without a lease the constructor subscribes immediately for compatibility.
   */
  async start(): Promise<void> {
    if (this.closed) {
      throw new Error('BullMQTaskBridge.start() after close()');
    }
    const lease = this.projectorLease;
    if (!lease) {
      return;
    }
    if (this.leaseAcquired) {
      return;
    }
    let acquired = false;
    try {
      acquired = await lease.acquire();
    } catch (error) {
      releaseScope(this.runtimeScope);
      this.scopeRegistered = false;
      throw error;
    }
    if (!acquired) {
      this.projectorState = 'unowned';
      releaseScope(this.runtimeScope);
      this.scopeRegistered = false;
      throw new BullMQProjectorUnownedError(this.runtimeScope);
    }
    this.leaseAcquired = true;
    this.projectorState = 'projecting';
    try {
      this.subscribe();
    } catch (error) {
      this.leaseAcquired = false;
      if (this.scopeRegistered) {
        releaseScope(this.runtimeScope);
        this.scopeRegistered = false;
      }
      try {
        await lease.release();
      } catch (releaseError) {
        this.warn(
          `RhinoQ: projector lease release failed after subscribe error for runtimeScope ` +
            `${JSON.stringify(this.runtimeScope)}: ` +
            `${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
        );
      }
      throw error;
    }
    this.startLeaseVerification(lease);
  }

  /**
   * Polls the lease so a lost one stops this projector instead of leaving two
   * of them running. The lock lives in a database session; a failover or a
   * killed backend releases it server-side, and nothing arrives here to say so.
   */
  private startLeaseVerification(lease: BullMQProjectorLease): void {
    if (typeof lease.verify !== 'function') {
      this.warn(
        `RhinoQ: the projector lease for runtimeScope ${JSON.stringify(this.runtimeScope)} ` +
          'does not implement verify(), so a lease lost to a failover or a killed ' +
          'session cannot be detected and this process would keep projecting ' +
          'alongside its replacement. Use PostgresProjectorLease.',
      );
      return;
    }
    if (this.leaseVerifyIntervalMs <= 0 || this.leaseVerifyTimer) {
      return;
    }
    this.leaseVerifyTimer = setInterval(() => {
      void this.verifyLeaseOnce(lease);
    }, this.leaseVerifyIntervalMs);
    // Ownership polling must not be the reason a process refuses to exit.
    this.leaseVerifyTimer.unref?.();
  }

  private async verifyLeaseOnce(lease: BullMQProjectorLease): Promise<void> {
    if (this.verifyingLease || this.closed || !this.leaseAcquired) {
      return;
    }
    this.verifyingLease = true;
    try {
      if (await lease.verify?.()) {
        return;
      }
    } catch (error) {
      // An unreadable lease is an unowned lease: it cannot be shown to be held.
      this.warn(
        `RhinoQ: projector lease check failed for runtimeScope ${JSON.stringify(this.runtimeScope)}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.verifyingLease = false;
    }
    this.loseLease();
  }

  /** Stops projecting. Another process may already own this scope. */
  private loseLease(): void {
    if (!this.leaseAcquired) {
      return;
    }
    this.leaseAcquired = false;
    this.projectorState = 'lost';
    this.stopLeaseVerification();
    if (this.subscribed) {
      for (const [name, listener] of this.listeners) {
        this.events.off?.(name, listener);
      }
      this.subscribed = false;
    }
    if (this.scopeRegistered) {
      releaseScope(this.runtimeScope);
      this.scopeRegistered = false;
    }
    this.metrics?.increment('rhinoq_bridge_lease_lost_total', {
      ...(this.runtimeScope ? { scope: this.runtimeScope } : {}),
    });
    this.warn(
      `RhinoQ: lost projector ownership of runtimeScope ${JSON.stringify(this.runtimeScope)} ` +
        'without releasing it, so this bridge stopped projecting. Another process may ' +
        'have taken the scope. Events produced while nobody owned it are not replayed: ' +
        'reconcile with TaskReconciler before trusting the aggregate.',
    );
    this.onLeaseLost?.(this.runtimeScope);
  }

  private stopLeaseVerification(): void {
    if (this.leaseVerifyTimer) {
      clearInterval(this.leaseVerifyTimer);
      this.leaseVerifyTimer = undefined;
    }
  }

  private subscribe(): void {
    if (this.subscribed) {
      return;
    }
    try {
      for (const [name, listener] of this.listeners) {
        this.events.on(name, listener);
      }
    } catch (error) {
      // A partially subscribed bridge must not leave handlers behind when a
      // QueueEvents adapter rejects one of the listener registrations.
      for (const [name, listener] of this.listeners) {
        this.events.off?.(name, listener);
      }
      throw error;
    }
    this.subscribed = true;
  }

  /**
   * Creates/binds the durable Task attempt for a job that was added through the
   * application's existing BullMQ Queue. Repeating the call is safe after a
   * bridge restart because the runtime/external ID lookup is durable.
   */
  async track(binding: BullMQTaskBinding): Promise<TaskSnapshot> {
    if (binding.itemKey !== undefined && !binding.itemKey.trim()) {
      throw new TypeError('BullMQTaskBridge.track itemKey must be a non-empty string when supplied');
    }
    let snapshot: TaskSnapshot;
    try {
      snapshot = await this.client.getTask(binding.task.id);
    } catch (error) {
      if (!isCode(error, 'RHINOQ_TASK_NOT_FOUND')) {
        throw error;
      }
      snapshot = await this.client.createTask(binding.task);
    }

    const existing = await this.find(binding.jobId);
    if (existing) {
      this.assertExistingBinding(existing, binding, snapshot.id);
      return this.ensureTask(snapshot.id, 'queued');
    }

    // An omitted key means the embedded profile stores `default`. That is a
    // useful shorthand for a one-item Task, but after the first unkeyed item
    // it becomes an irreversible fan-out accounting bug: every later job is
    // another attempt of the same item. Fail before the second Execution is
    // written and point the caller at the explicit fan-out path.
    if (
      binding.itemKey === undefined &&
      snapshot.executions?.some((execution) => (execution.itemKey ?? 'default') === 'default')
    ) {
      throw new TypeError(
        `BullMQTaskBridge.track requires itemKey for a second job on Task ${snapshot.id}; ` +
          'use a stable itemKey for every fan-out item or use dispatchMany()',
      );
    }

    try {
      snapshot = await this.client.createTaskExecution(snapshot.id, {
        id: binding.executionId,
        runtime: 'bullmq',
        ...(binding.itemKey ? { itemKey: binding.itemKey } : {}),
        ...(this.runtimeScope ? { runtimeScope: this.runtimeScope } : {}),
      });
      snapshot = await this.client.bindTaskExecution(binding.executionId, {
        runtime: 'bullmq',
        ...(this.runtimeScope ? { runtimeScope: this.runtimeScope } : {}),
        externalId: binding.jobId,
      });
    } catch (error) {
      // A concurrent bridge may have bound the same external ID. The durable
      // lookup is authoritative; do not rely on a local process map.
      const raced = await this.find(binding.jobId);
      if (!raced) {
        throw error;
      }
      this.assertExistingBinding(raced, binding, snapshot.id);
    }
    return this.ensureTask(snapshot.id, 'queued');
  }

  /**
   * Reserves the durable Task/Execution before adding the BullMQ job, then
   * binds and queues it. Repeating with the same IDs is safe after a crash.
   */
  async dispatch(input: BullMQTaskDispatch): Promise<TaskSnapshot> {
    this.assertDispatchReady();
    this.assertDispatchableJobIds([input]);
    const snapshot = await this.reserve(input);
    await this.dispatchReserved(input);
    return this.ensureTask(snapshot.id, 'queued');
  }

  private async dispatchReserved(input: BullMQTaskDispatch): Promise<void> {
    // assertDispatchReady() has already established both fields. Keeping the
    // structural Queue optional lets tracking-only integrations avoid it.
    const queue = this.bullQueue as BullMQQueue;
    const execution = await this.client.getTaskExecution(input.executionId);
    // A deterministic retry must not re-add work that already crossed the
    // durable dispatch boundary. BullMQ only deduplicates a jobId while that
    // job still exists; auto-removal could otherwise turn recovery into a
    // second execution of an already-dispatched item.
    if (execution.state !== 'pending_dispatch') return;
    await queue.add(input.job.name, input.job.data, {
      ...(input.job.options ?? {}),
      jobId: input.jobId,
    });
    try {
      await this.client.bindTaskExecution(input.executionId, {
        runtime: 'bullmq',
        runtimeScope: this.runtimeScope,
        externalId: input.jobId,
      });
    } catch (error) {
      // Queue.add may have succeeded while a concurrent deterministic retry
      // won the bind. Re-read the durable identity before classifying the
      // result as failure; accepting anything else would hide a real mismatch.
      const latest = await this.client.getTaskExecution(input.executionId);
      if (
        latest.state !== 'pending_dispatch' &&
        latest.runtime === 'bullmq' &&
        (latest.runtimeScope ?? '') === this.runtimeScope &&
        latest.externalId === input.jobId
      ) {
        return;
      }
      throw error;
    }
  }

  /**
   * Reserves every fan-out item before dispatching any job. This makes the
   * expected item set durable and lets a repeated call recover a partial
   * dispatch without inventing another Task or attempt.
   */
  async dispatchMany(inputs: BullMQTaskDispatch[]): Promise<TaskSnapshot> {
    this.assertDispatchReady();
    if (inputs.length === 0) {
      throw new RangeError('dispatchMany requires at least one item');
    }
    const taskId = inputs[0]?.task.id;
    if (!taskId || inputs.some((input) => input.task.id !== taskId)) {
      throw new TypeError('dispatchMany items must belong to one Task');
    }
    this.assertDispatchableJobIds(inputs);
    assertConsistentBatch(inputs);
    // Establish the parent before parallel fan-out. Concurrent createTask
    // races are recoverable, but avoiding them removes noise from the hot path.
    await this.reserve(inputs[0]!);
    await mapBounded(
      inputs.slice(1),
      this.dispatchConcurrency,
      (input) => this.reserve(input),
    );
    // No Queue job is visible until the complete expected item set is durable.
    // A partial Queue outage remains recoverable by repeating the same IDs.
    await mapBounded(
      inputs,
      this.dispatchConcurrency,
      (input) => this.dispatchReserved(input),
    );
    return this.ensureTask(taskId, 'queued');
  }

  private assertDispatchReady(): void {
    if (!this.bullQueue) {
      throw new TypeError('BullMQTaskBridge dispatch requires a queue');
    }
    if (!this.runtimeScope) {
      throw new TypeError('BullMQTaskBridge dispatch requires runtimeScope');
    }
  }

  /**
   * BullMQ refuses a custom job ID containing `:` unless it splits into exactly
   * three parts, a compatibility rule for old repeatable jobs. The natural
   * composite — `${taskId}:${itemKey}` — has two, so it is rejected.
   *
   * Checking here matters because dispatch reserves the durable Execution
   * before `Queue.add`. Without this the identity is written, the enqueue
   * throws from inside BullMQ, and the caller is left holding a reserved item
   * that never reached the queue — for a reason that names neither RhinoQ nor
   * the field responsible.
   */
  /**
   * A fan-out whose last item fails would never settle.
   *
   * `failIfTerminal` treats a failure as non-terminal when no classifier is
   * supplied — correct in itself, because the attempt may still retry — but
   * the Execution is written `failed` either way. The settled check therefore
   * does not run after a failure, and if the last item to close is a failed
   * one the signal never fires: the batch sits `running` with every item
   * terminal and every counter correct.
   *
   * Nothing else reports this. The only symptom is a callback that stays
   * silent, which is indistinguishable from a batch that has not finished.
   */
  private warnIfSettlementCannotFireAfterAFailure(options: BullMQTaskBridgeOptions): void {
    if (!options.onItemsSettled || options.isTerminalFailure) {
      return;
    }
    this.warn(
      'RhinoQ: onItemsSettled is configured without isTerminalFailure. Every failed ' +
        'job is then treated as "the attempt may still retry", so the settled check ' +
        'never runs after a failure and a batch whose last item fails will never ' +
        'settle. Supply isTerminalFailure — BullMQ knows when a job is out of attempts.',
    );
  }

  /**
   * Dispatch passes per-job options through, but a Queue created without an
   * explicit default retry policy is easy to mistake for one configured with
   * the application's usual attempts. Warn once at construction while the
   * Queue object and deployment context are still visible.
   */
  private warnOnQueueRetryPolicy(): void {
    const queue = this.bullQueue;
    if (!queue) {
      return;
    }
    const defaults = queue.defaultJobOptions ?? queue.opts?.defaultJobOptions;
    if (!defaults || Object.prototype.hasOwnProperty.call(defaults, 'attempts')) {
      return;
    }
    this.warn(
      'RhinoQ: BullMQ Queue has no default attempts retry policy. Failed jobs retry only ' +
        'when Queue.add supplies attempts; verify this is intentional or configure ' +
        'defaultJobOptions.attempts.',
    );
  }

  private assertDispatchableJobIds(bindings: readonly BullMQTaskBinding[]): void {
    for (const binding of bindings) {
      const jobId = binding.jobId;
      if (jobId.includes(':') && jobId.split(':').length !== 3) {
        throw new TypeError(
          `BullMQ rejects the job ID ${JSON.stringify(jobId)}: a custom ID may not contain ':' ` +
            'unless it splits into exactly three parts. Use another separator — ' +
            `for example ${JSON.stringify(jobId.replaceAll(':', '__'))}. ` +
            'itemKey and executionId are RhinoQ identities and are unaffected.',
        );
      }
    }
  }

  private async reserve(binding: BullMQTaskBinding): Promise<TaskSnapshot> {
    let snapshot: TaskSnapshot;
    try {
      snapshot = await this.client.getTask(binding.task.id);
    } catch (error) {
      if (!isCode(error, 'RHINOQ_TASK_NOT_FOUND')) {
        throw error;
      }
      snapshot = await this.client.createTask(binding.task);
    }
    const existing = await this.find(binding.jobId);
    if (existing) {
      this.assertExistingBinding(existing, binding, snapshot.id);
      return snapshot;
    }
    try {
      return await this.client.createTaskExecution(snapshot.id, {
        id: binding.executionId,
        runtime: 'bullmq',
        ...(binding.itemKey ? { itemKey: binding.itemKey } : {}),
        ...(this.runtimeScope ? { runtimeScope: this.runtimeScope } : {}),
        externalId: binding.jobId,
      });
    } catch (error) {
      const raced = await this.find(binding.jobId);
      if (!raced) {
        throw error;
      }
      this.assertExistingBinding(raced, binding, snapshot.id);
      return this.client.getTask(snapshot.id);
    }
  }

  private assertExistingBinding(
    existing: TaskExecution,
    binding: BullMQTaskBinding,
    taskId: string,
  ): void {
    if (existing.taskId !== taskId) {
      throw new Error(
        `BullMQ job ${binding.jobId} is already bound to Task ${existing.taskId}`,
      );
    }
    if (existing.id !== binding.executionId) {
      throw new Error(
        `BullMQ job ${binding.jobId} is already bound to Execution ${existing.id}`,
      );
    }
  }

  /**
   * Projects one job state that the application has just read from BullMQ. Use
   * this after `track()` on bridge startup to cover a lifecycle event missed
   * while this process was offline. It neither discovers jobs nor scans Redis.
   *
   * A failed observation is fail-closed: it becomes a failed Task only when
   * `terminal: true` is supplied. BullMQ retries can otherwise make a transient
   * failed event look terminal when it is not.
   */
  async reconcile(observation: BullMQTaskObservation): Promise<void> {
    switch (observation.state) {
      case 'waiting':
        await this.queue(observation.jobId);
        return;
      case 'active':
        await this.startJob(observation.jobId, observation.attempt);
        return;
      case 'completed':
        await this.complete(observation);
        return;
      case 'failed':
        if (observation.terminal) {
          await this.fail(observation);
        }
    }
  }

  /** Reconciles a bounded application-supplied set after an offline gap. */
  async reconcileMany(observations: BullMQTaskObservation[]): Promise<void> {
    for (const observation of observations) {
      await this.reconcile(observation);
    }
  }

  /**
   * Reconciles the latest known attempt for every BullMQ item in a Task.
   * `observe` is application-owned because the bridge must not scan or own
   * Redis. The embedded PostgreSQL client supplies the runtime references in
   * one query, so a restart does not require an application-maintained second
   * Task-to-job table.
   */
  async reconcileTask(
    taskId: string,
    observe: (reference: TaskExecutionRuntimeRef) =>
      Promise<BullMQTaskObservation | undefined>,
  ): Promise<number> {
    if (!this.client.listTaskExecutionRuntimeRefs) {
      throw new TypeError(
        'BullMQTaskBridge.reconcileTask requires a Task client with listTaskExecutionRuntimeRefs; ' +
          'the legacy Gateway client cannot provide the bounded runtime reference read',
      );
    }
    if (typeof observe !== 'function') {
      throw new TypeError('BullMQTaskBridge.reconcileTask requires an observation callback');
    }
    const refs = await this.client.listTaskExecutionRuntimeRefs(taskId);
    const latest = latestRuntimeReferences(refs.executions)
      .filter((reference) => reference.runtime === 'bullmq')
      .filter((reference) =>
        !this.runtimeScope || (reference.runtimeScope ?? '') === this.runtimeScope);
    let reconciled = 0;
    for (const reference of latest) {
      if (!reference.externalId) {
        continue;
      }
      const observation = await observe(reference);
      if (!observation) {
        continue;
      }
      if (observation.jobId !== reference.externalId) {
        throw new Error(
          `BullMQ reconciliation returned job ${observation.jobId} for ${reference.externalId}`,
        );
      }
      await this.reconcile(observation);
      reconciled += 1;
    }
    return reconciled;
  }

  /**
   * Requests Task cancellation and coordinates the explicitly known BullMQ
   * jobs. The job list is required because the bridge intentionally does not
   * scan Redis or infer queue ownership.
   */
  async cancel(taskId: string, jobIds: string[]): Promise<TaskSnapshot> {
    if (!this.cancelJob) {
      throw new TypeError('BullMQTaskBridge cancel requires cancelJob');
    }
    if (jobIds.length === 0) {
      throw new RangeError('BullMQTaskBridge cancel requires at least one known job id');
    }
    const task = await this.converge(async () => {
      const current = await this.client.getTask(taskId);
      return current.state === 'cancel_requested'
        ? current
        : this.client.requestTaskCancellation(current.id, current.entityVersion);
    });
    // A terminal Task answers a late request with `too_late`. Do not touch the
    // runtime after the authoritative Task command has already refused it.
    if (task.state !== 'cancel_requested') {
      return task;
    }
    for (const jobId of new Set(jobIds)) {
      const execution = await this.find(jobId);
      if (!execution || execution.taskId !== taskId) {
        return this.resolveCancellation(
          taskId,
          'failed',
          `BullMQ job ${jobId} is not bound to Task ${taskId}`,
        );
      }
      let result: Awaited<ReturnType<NonNullable<BullMQTaskBridgeOptions['cancelJob']>>>;
      try {
        result = await this.cancelJob(jobId, execution);
      } catch {
        return this.resolveCancellation(taskId, 'failed', `BullMQ cancellation failed for job ${jobId}`);
      }
      if (
        result.status !== 'acknowledged' &&
        result.status !== 'cannot_cancel_safely' &&
        result.status !== 'failed'
      ) {
        return this.resolveCancellation(
          taskId,
          'failed',
          `BullMQ cancellation returned an invalid status for job ${jobId}`,
        );
      }
      if (result.status !== 'acknowledged') {
        return this.resolveCancellation(taskId, result.status, result.reason);
      }
    }
    const resolved = await this.resolveCancellation(taskId, 'acknowledged');
    if (!this.terminalizeOnCancel) {
      return resolved;
    }
    return this.terminalizeCancellation(taskId, new Set(jobIds));
  }

  /**
   * Closes a Task whose named jobs have all durably stopped.
   *
   * The Executions go first: an acknowledged job that left its attempt at
   * `running` is a lie the batch view keeps telling. The Task follows only when
   * nothing else is still open, because `jobIds` is application-supplied and a
   * short list would otherwise terminate a Task with items still in flight —
   * and terminal Tasks are never reopened.
   */
  private async terminalizeCancellation(taskId: string, jobIds: Set<string>): Promise<TaskSnapshot> {
    for (const jobId of jobIds) {
      const execution = await this.find(jobId);
      if (!execution || isTerminalExecution(execution.state)) {
        continue;
      }
      await this.converge(async () => {
        const current = await this.client.getTaskExecution(execution.id);
        if (isTerminalExecution(current.state)) {
          return;
        }
        await this.client.transitionTaskExecution(current.id, current.version, 'cancelled');
      });
    }
    return this.converge(async () => {
      const task = await this.client.getTask(taskId);
      if (task.state !== 'cancel_requested') {
        return task;
      }
      const open = latestExecutions(task.executions)
        .filter((execution) => !isTerminalExecution(execution.state));
      if (open.length > 0) {
        this.warn(
          `RhinoQ: Task ${taskId} stays at cancel_requested because ` +
            `${open.length} Execution(s) are still open (${open.map((item) => item.id).join(', ')}). ` +
            'terminalizeOnCancel only closes a Task whose every attempt has stopped; ' +
            'pass the complete job list, or terminate the Task from the application.',
        );
        return task;
      }
      return this.client.transitionTask(task.id, task.entityVersion, 'cancelled');
    });
  }

  /**
   * Awaitable event projection. QueueEvents listeners use the same path, but
   * applications and tests can await this method when they need proof that an
   * observation is durable before continuing.
   */
  async project(event: QueueEvent, observation: BullMQEvent): Promise<void> {
    this.metrics?.increment('rhinoq_bridge_event_projected_total', {
      event,
      ...(this.runtimeScope ? { scope: this.runtimeScope } : {}),
    });
    switch (event) {
      case 'waiting':
        return this.queue(observation.jobId);
      case 'active':
        return this.startJob(observation.jobId, observation.attempt);
      case 'progress':
        return this.reportProgress(observation);
      case 'completed':
        return this.complete(observation);
      case 'failed':
        return this.failIfTerminal(observation);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.projectorState = 'closed';
    this.stopLeaseVerification();
    if (this.subscribed) {
      for (const [name, listener] of this.listeners) {
        this.events.off?.(name, listener);
      }
      this.subscribed = false;
    }
    if (this.scopeRegistered) {
      releaseScope(this.runtimeScope);
      this.scopeRegistered = false;
    }
    if (this.leaseAcquired && this.projectorLease) {
      this.leaseAcquired = false;
      void this.projectorLease.release().catch((error: unknown) => {
        this.warn(
          `RhinoQ: projector lease release failed for runtimeScope ${JSON.stringify(this.runtimeScope)}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  // Detection stops at the process boundary. Six processes each holding one
  // bridge on the same scope is the same hazard and cannot be seen from here
  // without a coordination service, which is a deliberate non-goal — so the
  // warning describes the deployment rule rather than only this process.
  private warnOnDuplicateScope(options: BullMQTaskBridgeOptions): void {
    if (!this.runtimeScope) {
      // The legacy Gateway schema allows an absent scope, which makes two
      // bridges indistinguishable. Nothing truthful can be said about them.
      return;
    }
    const existing = activeScopes.get(this.runtimeScope) ?? 0;
    activeScopes.set(this.runtimeScope, existing + 1);
    this.scopeRegistered = true;
    if (existing === 0 || !this.duplicateScopeWarningEnabled(options)) {
      return;
    }
    releaseScope(this.runtimeScope);
    this.scopeRegistered = false;
    throw new Error(
      `RhinoQ: ${existing + 1} BullMQTaskBridge instances share runtimeScope ` +
        `${JSON.stringify(this.runtimeScope)} in this process. Only one projector ` +
        'may own a scope; close the existing bridge or use a different runtimeScope. ' +
        'For multiple processes, provide projectorLease: new PostgresProjectorLease(...). ' +
        'Set allowConcurrentBridges: true, or RHINOQ_ALLOW_CONCURRENT_BRIDGES=1, only ' +
        'when duplicate projection is explicitly intended.',
    );
  }

  private duplicateScopeWarningEnabled(options: BullMQTaskBridgeOptions): boolean {
    if (options.allowConcurrentBridges) {
      return false;
    }
    const flag = globalThis.process?.env?.RHINOQ_ALLOW_CONCURRENT_BRIDGES;
    return flag !== '1' && flag !== 'true';
  }

  private async queue(jobId: string): Promise<void> {
    const execution = await this.find(jobId);
    if (execution) {
      await this.ensureTask(execution.taskId, 'queued');
    }
  }

  private async startJob(jobId: string, runtimeAttempt?: number): Promise<void> {
    const execution = await this.find(jobId);
    if (!execution) {
      return;
    }
    // A job going active again after its attempt finished is a retry. Without
    // this the terminal state machine simply refuses the move and the second
    // run disappears.
    const current = await this.openRetryAttempts(execution, runtimeAttempt);
    if (!current) {
      return;
    }
    await this.activate(current);
  }

  private async openRetryAttempts(
    execution: TaskExecution,
    runtimeAttempt?: number,
  ): Promise<TaskExecution | undefined> {
    let current: TaskExecution | undefined = execution;
    const observedAttempt = runtimeAttempt === undefined
      ? undefined
      : validateRuntimeAttempt(runtimeAttempt);
    while (
      current && (isTerminalExecution(current.state) ||
        (observedAttempt !== undefined && (current.attempt ?? 1) < observedAttempt))
    ) {
      // If the runtime has already advanced but the failed event was lost,
      // close the old attempt before opening the one BullMQ is running now.
      if (!isTerminalExecution(current.state)) {
        await this.ensureExecution(
          current.id,
          'failed',
          `runtime advanced to attempt ${observedAttempt} before the previous failure was projected`,
        );
        current = await this.find(execution.externalId ?? '');
        if (!current) return undefined;
        continue;
      }
      const next = await this.openRetryAttempt(current);
      if (!next) return undefined;
      current = next;
      if (observedAttempt === undefined || (current.attempt ?? 1) >= observedAttempt) {
        break;
      }
    }
    return current;
  }

  /**
   * Supersedes a finished attempt and returns the one that replaces it.
   *
   * Returns undefined when nothing should move: retry projection is off, the
   * client cannot record attempts, or another bridge already opened the next
   * attempt while this one was reading.
   */
  private async openRetryAttempt(previous: TaskExecution): Promise<TaskExecution | undefined> {
    if (this.retryProjection === 'ignore') {
      return undefined;
    }
    if (!this.client.retryTaskExecution) {
      // The Gateway client owns attempt identity for the runtimes it runs
      // itself, so this is not a defect there. Say it once rather than on
      // every retried job.
      if (!this.warnedAboutRetrySupport) {
        this.warnedAboutRetrySupport = true;
        this.warn(
          'RhinoQ: this Task client cannot record a retry as a new attempt, so a BullMQ retry ' +
            'of an already-finished job leaves no record. Use the embedded PostgreSQL client, ' +
            "or set retryProjection: 'ignore' to accept that.",
        );
      }
      return undefined;
    }
    // An attempt with no external ID was never bound to a job, so nothing can
    // have retried it. Looking it up with an empty ID would ask the store a
    // question with no answer, and a store that happens to have a row with a
    // NULL external ID would answer the wrong one.
    if (!previous.externalId) {
      return undefined;
    }
    const nextAttempt = (previous.attempt ?? 1) + 1;
    try {
      await this.client.retryTaskExecution(
        previous.id,
        previous.version,
        this.retryExecutionId(previous, nextAttempt),
      );
    } catch (error) {
      // A concurrent bridge, or a repeated projection of the same retry, wins
      // the supersede. The durable lookup is authoritative either way.
      if (
        !isVersionConflict(error) &&
        !isCode(error, 'RHINOQ_EXECUTION_SUPERSEDED') &&
        !isCode(error, 'RHINOQ_EXECUTION_ALREADY_EXISTS')
      ) {
        throw error;
      }
    }
    this.metrics?.increment('rhinoq_task_execution_retried_total', {
      ...(this.runtimeScope ? { scope: this.runtimeScope } : {}),
    });
    const replacement = await this.find(previous.externalId);
    if (!replacement || replacement.id === previous.id) {
      return undefined;
    }
    return replacement;
  }

  /**
   * Moves one attempt and its Task to running. The Execution goes first because
   * the store advances the Task version in the same transaction, so the
   * Snapshot returned here is the freshest one a caller can hold.
   */
  private async activate(execution: TaskExecution): Promise<TaskSnapshot> {
    await this.ensureExecution(execution.id, 'running');
    return this.ensureTask(execution.taskId, 'running');
  }

  private async reportProgress(event: BullMQEvent): Promise<void> {
    const progress = this.progress(event);
    if (!progress) {
      return;
    }
    await this.converge(async () => {
      const execution = await this.find(event.jobId);
      if (!execution) {
        return;
      }
      const task = await this.activate(execution);
      if (task.state !== 'running' && task.state !== 'cancel_requested') {
        return;
      }
      // QueueEvents re-delivers progress after a reconnect. The Gateway treats
      // an identical write as a no-op, so this only skips the round trip.
      if (sameProgress(task.progress, progress)) {
        return;
      }
      await this.client.reportTaskProgress(task.id, task.entityVersion, progress);
    });
  }

  private async complete(event: BullMQEvent): Promise<void> {
    const execution = await this.find(event.jobId);
    if (!execution) {
      return;
    }
    await this.activate(execution);
    await this.ensureExecution(execution.id, 'succeeded');

    // The reference belongs to the attempt that produced it. Recording it here
    // instead of only on the Task is what lets a fan-out answer "where did item
    // 37 land" without the application keeping a parallel item store — and it
    // is why `resultReference` used to do nothing at all in execution-only mode.
    const reference = await this.resultReference?.(event);
    if (reference) {
      await this.converge(async () => {
        const current = await this.client.getTaskExecution(execution.id);
        await this.client.attachTaskExecutionResult(current.id, current.version, reference);
      });
    }

    if (this.terminalProjection === 'execution-only') {
      await this.updateAggregate(execution.taskId);
      await this.signalSettlement(execution.taskId);
      return;
    }
    await this.signalSettlement(execution.taskId);
    // One job is the whole Task here, so its output is also the Task's.
    await this.ensureTask(execution.taskId, 'succeeded');
    if (reference) {
      await this.converge(async () => {
        const task = await this.client.getTask(execution.taskId);
        if (!task.hasResult) {
          await this.client.attachTaskResult(task.id, task.entityVersion, reference);
        }
      });
    }
  }

  private async failIfTerminal(event: BullMQEvent): Promise<void> {
    const terminal = this.isTerminalFailure
      ? await this.isTerminalFailure(event)
      : false;
    // Every failed QueueEvent ends the current runtime attempt. The classifier
    // only decides whether that failed attempt also ends the user-facing Task.
    // Keeping these two decisions separate is what lets `failed` → `active`
    // create a durable retry after the failed event was observed.
    await this.fail(event, terminal);
  }

  private async fail(event: BullMQEvent, terminal = true): Promise<void> {
    const execution = await this.find(event.jobId);
    if (!execution) {
      return;
    }
    await this.activate(execution);
    await this.ensureExecution(execution.id, 'failed', this.failureReason(event));
    if (terminal && this.terminalProjection === 'single-execution') {
      await this.ensureTask(execution.taskId, 'failed');
    } else if (terminal) {
      await this.updateAggregate(execution.taskId);
    }
    if (terminal) {
      await this.signalSettlement(execution.taskId);
    }
  }

  /**
   * Fires `onItemsSettled` for the one caller that closed the last item.
   *
   * The exactly-once decision is a single SQL statement, not a check in this
   * process, so it survives a crash, a re-delivered event and several bridges.
   */
  private async signalSettlement(taskId: string): Promise<void> {
    if (!this.onItemsSettled) {
      return;
    }
    if (!this.client.settleTaskItems) {
      if (!this.warnedAboutSettleSupport) {
        this.warnedAboutSettleSupport = true;
        this.warn(
          'RhinoQ: onItemsSettled was configured but this Task client cannot settle items, ' +
            'so the signal will never fire. Use the embedded PostgreSQL client.',
        );
      }
      return;
    }
    if (!(await this.client.settleTaskItems(taskId))) {
      return;
    }
    this.metrics?.increment('rhinoq_task_items_settled_total', {
      ...(this.runtimeScope ? { scope: this.runtimeScope } : {}),
    });
    await this.onItemsSettled(await this.client.getTask(taskId));
  }

  private async updateAggregate(taskId: string): Promise<void> {
    if (!this.aggregateProgress && this.aggregateTerminal === 'manual') {
      return;
    }
    await this.converge(async () => {
      let task = await this.client.getTask(taskId);
      const latest = latestExecutions(task.executions);
      const total = latest.length;
      if (total === 0) {
        return;
      }
      const terminal = latest.filter((execution) =>
        execution.state === 'succeeded' ||
        execution.state === 'failed' ||
        execution.state === 'cancelled');
      if (
        this.aggregateProgress &&
        (task.state === 'running' || task.state === 'cancel_requested') &&
        !sameProgress(task.progress, { completed: terminal.length, total })
      ) {
        task = await this.client.reportTaskProgress(
          task.id,
          task.entityVersion,
          { completed: terminal.length, total },
        );
      }
      if (terminal.length !== total || this.aggregateTerminal === 'manual') {
        return;
      }
      const succeeded = terminal.filter((execution) =>
        execution.state === 'succeeded').length;
      const target = this.aggregateTerminal === 'all-succeeded'
        ? (succeeded === total ? 'succeeded' : 'failed')
        : (succeeded > 0 ? 'succeeded' : 'failed');
      await this.ensureTask(task.id, target);
    });
  }

  private async find(jobId: string) {
    try {
      return await this.client.lookupTaskExecution(
        'bullmq',
        jobId,
        this.runtimeScope,
      );
    } catch (error) {
      if (isCode(error, 'RHINOQ_EXECUTION_NOT_FOUND')) {
        return undefined;
      }
      throw error;
    }
  }

  private resolveCancellation(
    taskId: string,
    status: 'acknowledged' | 'cannot_cancel_safely' | 'failed',
    reason?: string,
  ): Promise<TaskSnapshot> {
    return this.converge(async () => {
      const task = await this.client.getTask(taskId);
      return this.client.resolveTaskCancellation(task.id, task.entityVersion, status, reason);
    });
  }

  private async ensureExecution(
    executionId: string,
    target: 'running' | 'succeeded' | 'failed',
    reason?: string,
  ): Promise<void> {
    await this.converge(async () => {
      const execution = await this.client.getTaskExecution(executionId);
      if (execution.state === target) {
        return;
      }
      if ((target === 'succeeded' || target === 'failed') && execution.state === 'dispatched') {
        await this.ensureExecution(executionId, 'running');
        return this.ensureExecution(executionId, target, reason);
      }
      if (
        (execution.state === 'dispatched' && target === 'running') ||
        (execution.state === 'running' && (target === 'succeeded' || target === 'failed'))
      ) {
        await this.client.transitionTaskExecution(execution.id, execution.version, target, reason);
      }
    });
  }

  private async ensureTask(taskId: string, target: Exclude<TaskState, 'pending' | 'cancel_requested' | 'cancelled'>): Promise<TaskSnapshot> {
    return this.converge(async () => {
      let task = await this.client.getTask(taskId);
      if (task.state === target) {
        return task;
      }
      if (task.state === 'pending') {
        task = await this.client.transitionTask(task.id, task.entityVersion, 'queued');
      }
      if ((target === 'running' || target === 'succeeded' || target === 'failed') && task.state === 'queued') {
        task = await this.client.transitionTask(task.id, task.entityVersion, 'running');
      }
      if ((target === 'succeeded' || target === 'failed') && (task.state === 'running' || task.state === 'cancel_requested')) {
        task = await this.client.transitionTask(task.id, task.entityVersion, target);
      }
      return task;
    });
  }

  private async converge<T>(operation: () => Promise<T>): Promise<T> {
    let lastConflict: unknown;
    for (let attempt = 0; attempt < MAX_VERSION_CONVERGENCE_ATTEMPTS; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (!isVersionConflict(error)) {
          throw error;
        }
        // A conflict is expected and recoverable, but a rising count is how an
        // operator sees contention before it becomes a stalled projection.
        this.metrics?.increment('rhinoq_bridge_version_conflict_total', {
          ...(this.runtimeScope ? { scope: this.runtimeScope } : {}),
        });
        lastConflict = error;
      }
    }
    throw lastConflict;
  }

  private run(name: QueueEvent, event: BullMQEvent, operation: () => Promise<void>): void {
    void operation().catch(async (error: unknown) => {
      // A listener failure is otherwise invisible unless onError is wired: the
      // promise is not awaited by anyone. Counting it is what makes a bridge
      // that has silently stopped projecting show up on a dashboard.
      this.metrics?.increment('rhinoq_bridge_projection_failed_total', {
        ...(this.runtimeScope ? { scope: this.runtimeScope } : {}),
      });
      // Durable first. onError is a callback in a process that is often about
      // to die; the record has to exist before that happens.
      try {
        await this.recordProjectionFailure(name, event, error);
      } catch (sinkError) {
        this.report(sinkError, event);
      }
      this.report(error, event);
    });
  }

  /**
   * Hands an error to `onError` without letting that handler take the process
   * down with it.
   *
   * Nothing awaits a listener's promise, so a throwing `onError` becomes an
   * unhandled rejection — which in Node terminates the process by default. A
   * bridge whose error reporting is broken must not be worse than a bridge
   * with none, so the last resort is a warning that says which failed.
   */
  private report(error: unknown, event: BullMQEvent): void {
    if (!this.onError) {
      return;
    }
    try {
      this.onError(error, event);
    } catch (handlerError) {
      this.warn(
        `RhinoQ: onError threw while reporting a projection failure for job ${event.jobId}. ` +
          `Handler error: ${handlerError instanceof Error ? handlerError.message : String(handlerError)}. ` +
          `Original error: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }

  private async recordProjectionFailure(
    event: QueueEvent,
    observation: BullMQEvent,
    error: unknown,
  ): Promise<void> {
    if (!this.projectionFailures) {
      return;
    }
    const failure: ProjectionFailure = {
      schemaVersion: 1,
      event,
      runtime: 'bullmq',
      runtimeScope: this.runtimeScope,
      externalId: observation.jobId,
      observation: {
        jobId: observation.jobId,
        ...(observation.attempt === undefined ? {} : { attempt: observation.attempt }),
        ...(observation.data === undefined ? {} : { data: observation.data }),
        ...(observation.returnvalue === undefined ? {} : { returnvalue: observation.returnvalue }),
        ...(observation.failedReason === undefined ? {} : { failedReason: observation.failedReason }),
      },
      // The message, never the stack: a stack is not portable across processes
      // and leaks filesystem paths into a table somebody will read in a ticket.
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof RhinoQError ? { code: error.code } : {}),
      observedAt: new Date().toISOString(),
      attempts: 1,
    };
    await this.projectionFailures.record(failure);
  }
}

function isTerminalExecution(state: string): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

function releaseScope(scope: string): void {
  if (!scope) {
    return;
  }
  const remaining = (activeScopes.get(scope) ?? 1) - 1;
  if (remaining <= 0) {
    activeScopes.delete(scope);
    return;
  }
  activeScopes.set(scope, remaining);
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof RhinoQError && error.code === code;
}

function defaultFailureReason(event: BullMQEvent): string | undefined {
  const reason = event.failedReason?.trim();
  return reason ? reason : undefined;
}

function validateRuntimeAttempt(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError('BullMQ runtime attempt must be a positive integer');
  }
  return value;
}

function latestRuntimeReferences(
  references: TaskExecutionRuntimeRef[],
): TaskExecutionRuntimeRef[] {
  const latest = new Map<string, TaskExecutionRuntimeRef>();
  for (const reference of references) {
    const key = reference.itemKey || reference.executionId;
    const current = latest.get(key);
    if (!current || reference.attempt > current.attempt) {
      latest.set(key, reference);
    }
  }
  return [...latest.values()];
}

function isVersionConflict(error: unknown): boolean {
  return isCode(error, 'RHINOQ_VERSION_CONFLICT');
}

// The Snapshot omits an absent total and an empty message, so compare on the
// stored meaning rather than on key presence.
function sameProgress(current: TaskProgress, next: TaskProgress): boolean {
  return current.completed === next.completed &&
    current.total === next.total &&
    (current.message ?? '') === (next.message ?? '');
}

function defaultProgress(event: BullMQEvent): TaskProgress | undefined {
  if (typeof event.data === 'number') {
    throw new TypeError(
      'BullMQ numeric progress is ambiguous. Configure bullMQCountProgress ' +
        'for completed-item counts or bullMQPercentageProgress for percentages.',
    );
  }
  return structuredProgress(event.data);
}

/** Maps an explicit non-negative integer to an indeterminate completed count. */
export function bullMQCountProgress(event: BullMQEvent): TaskProgress | undefined {
  if (!isNonNegativeInteger(event.data)) {
    return structuredProgress(event.data);
  }
  return { completed: event.data };
}

/** Maps an explicit integer percentage in the inclusive 0..100 range. */
export function bullMQPercentageProgress(event: BullMQEvent): TaskProgress | undefined {
  if (
    typeof event.data !== 'number' ||
    !Number.isInteger(event.data) ||
    event.data < 0 ||
    event.data > 100
  ) {
    return structuredProgress(event.data);
  }
  return { completed: event.data, total: 100 };
}

function structuredProgress(data: unknown): TaskProgress | undefined {
  if (!isRecord(data) || !isNonNegativeInteger(data.completed)) {
    return undefined;
  }
  const total = isNonNegativeInteger(data.total) ? data.total : undefined;
  if (total !== undefined && total < data.completed) {
    return undefined;
  }
  return {
    completed: data.completed,
    ...(total === undefined ? {} : { total }),
    ...(typeof data.message === 'string' ? { message: data.message } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function assertConsistentBatch(inputs: readonly BullMQTaskDispatch[]): void {
  const first = inputs[0]!;
  const executionIds = new Set<string>();
  const jobIds = new Set<string>();
  const itemKeys = new Set<string>();
  for (const input of inputs) {
    if (
      input.task.type !== first.task.type ||
      input.task.ownerId !== first.task.ownerId ||
      input.task.definitionVersion !== first.task.definitionVersion
    ) {
      throw new TypeError('dispatchMany items must use one consistent Task definition');
    }
    if (executionIds.has(input.executionId)) {
      throw new TypeError(`dispatchMany contains duplicate Execution id ${input.executionId}`);
    }
    if (jobIds.has(input.jobId)) {
      throw new TypeError(`dispatchMany contains duplicate BullMQ job id ${input.jobId}`);
    }
    executionIds.add(input.executionId);
    jobIds.add(input.jobId);

    // itemKey is the idempotency key, not a label. Without one the store
    // records every item under `default`, which makes them attempts of one
    // item: the aggregate reads total 1 and an all-succeeded batch terminates
    // on the first finish. That is silent, and terminal Tasks never reopen.
    const itemKey = input.itemKey?.trim();
    if (!itemKey) {
      throw new TypeError(
        `dispatchMany requires an itemKey on every item (missing on Execution ${input.executionId}). ` +
          'It is the idempotency key: attempts are numbered per itemKey and the aggregate counts ' +
          'one item per key, so a fan-out without one becomes repeated attempts of a single item.',
      );
    }
    if (itemKeys.has(itemKey)) {
      throw new TypeError(
        `dispatchMany contains duplicate itemKey ${JSON.stringify(itemKey)}. Two items sharing a key ` +
          'are recorded as two attempts of the same item, and only the later one is counted.',
      );
    }
    itemKeys.add(itemKey);
  }
}

async function mapBounded<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<unknown>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next++;
      await operation(values[index]!);
    }
  };
  // Promise.all rejects before sibling workers finish, which can leak an old
  // batch into an immediate retry. Drain every worker, then surface the first
  // error so the caller gets a clean recovery boundary.
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failed) throw failed.reason;
}

function latestExecutions(
  executions: TaskSnapshot['executions'],
): TaskSnapshot['executions'] {
  const latest = new Map<string, TaskSnapshot['executions'][number]>();
  for (const execution of executions) {
    const key = execution.itemKey ?? execution.id;
    const current = latest.get(key);
    if (!current || execution.attempt > current.attempt) {
      latest.set(key, execution);
    }
  }
  return [...latest.values()];
}
