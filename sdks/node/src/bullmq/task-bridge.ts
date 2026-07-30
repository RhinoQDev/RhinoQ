import {
  RhinoQError,
} from '../gateway/client.js';
import type {
  TaskCreateRequest,
  TaskExecution,
  TaskProgress,
  TaskSnapshot,
  TaskState,
} from '../gateway/types.js';
import type { TaskClient } from '../tasks/client.js';

type QueueEvent = 'waiting' | 'active' | 'progress' | 'completed' | 'failed';

// Queue events and browser/API writes can legitimately race. The Gateway
// rejects stale aggregate/execution versions, so the bridge must re-read and
// converge instead of treating one optimistic conflict as a dropped event.
const MAX_VERSION_CONVERGENCE_ATTEMPTS = 3;

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
}

export interface BullMQEvent {
  jobId: string;
  data?: unknown;
  returnvalue?: unknown;
  failedReason?: string;
}

export interface BullMQTaskBinding {
  task: TaskCreateRequest;
  executionId: string;
  /** Stable logical item; retries of the same item share this key. */
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

/**
 * A point-in-time observation read by the application from its BullMQ Job.
 * It is intentionally not a Queue scan contract: the application decides
 * which already-known jobs are worth reconciling after its bridge restarts.
 */
export interface BullMQTaskObservation extends BullMQEvent {
  state: BullMQObservedState;
  /** Required to make an observed failed job terminal in RhinoQ. */
  terminal?: boolean;
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
  onError?: (error: unknown, event: BullMQEvent) => void;
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
  private readonly terminalProjection: 'single-execution' | 'execution-only';
  private readonly aggregateProgress: boolean;
  private readonly aggregateTerminal:
    'manual' | 'all-succeeded' | 'at-least-one-succeeded';
  private readonly progress: (event: BullMQEvent) => TaskProgress | undefined;
  private readonly isTerminalFailure?: (event: BullMQEvent) => Promise<boolean>;
  private readonly resultReference?: (event: BullMQEvent) => Promise<string | undefined>;
  private readonly failureReason: (event: BullMQEvent) => string | undefined;
  private readonly onError?: (error: unknown, event: BullMQEvent) => void;
  private readonly listeners: Array<[QueueEvent, (event: BullMQEvent) => void]>;

  constructor(options: BullMQTaskBridgeOptions) {
    this.client = options.client;
    this.events = options.events;
    this.bullQueue = options.queue;
    this.runtimeScope = options.runtimeScope?.trim() ?? '';
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
    this.onError = options.onError;
    this.listeners = [
      ['waiting', (event) => this.run(event, () => this.project('waiting', event))],
      ['active', (event) => this.run(event, () => this.project('active', event))],
      ['progress', (event) => this.run(event, () => this.project('progress', event))],
      ['completed', (event) => this.run(event, () => this.project('completed', event))],
      ['failed', (event) => this.run(event, () => this.project('failed', event))],
    ];
    for (const [name, listener] of this.listeners) {
      this.events.on(name, listener);
    }
  }

  /**
   * Creates/binds the durable Task attempt for a job that was added through the
   * application's existing BullMQ Queue. Repeating the call is safe after a
   * bridge restart because the runtime/external ID lookup is durable.
   */
  async track(binding: BullMQTaskBinding): Promise<TaskSnapshot> {
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
      if (existing.taskId !== snapshot.id) {
        throw new Error(`BullMQ job ${binding.jobId} is already bound to Task ${existing.taskId}`);
      }
      return this.ensureTask(snapshot.id, 'queued');
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
      if (!raced || raced.taskId !== snapshot.id) {
        throw error;
      }
    }
    return this.ensureTask(snapshot.id, 'queued');
  }

  /**
   * Reserves the durable Task/Execution before adding the BullMQ job, then
   * binds and queues it. Repeating with the same IDs is safe after a crash.
   */
  async dispatch(input: BullMQTaskDispatch): Promise<TaskSnapshot> {
    if (!this.bullQueue) {
      throw new TypeError('BullMQTaskBridge dispatch requires a queue');
    }
    if (!this.runtimeScope) {
      throw new TypeError('BullMQTaskBridge dispatch requires runtimeScope');
    }
    const snapshot = await this.reserve(input);
    await this.bullQueue.add(input.job.name, input.job.data, {
      ...(input.job.options ?? {}),
      jobId: input.jobId,
    });
    const execution = await this.client.getTaskExecution(input.executionId);
    if (execution.state === 'pending_dispatch') {
      await this.client.bindTaskExecution(input.executionId, {
        runtime: 'bullmq',
        runtimeScope: this.runtimeScope,
        externalId: input.jobId,
      });
    }
    return this.ensureTask(snapshot.id, 'queued');
  }

  /**
   * Reserves every fan-out item before dispatching any job. This makes the
   * expected item set durable and lets a repeated call recover a partial
   * dispatch without inventing another Task or attempt.
   */
  async dispatchMany(inputs: BullMQTaskDispatch[]): Promise<TaskSnapshot> {
    if (inputs.length === 0) {
      throw new RangeError('dispatchMany requires at least one item');
    }
    const taskId = inputs[0]?.task.id;
    if (!taskId || inputs.some((input) => input.task.id !== taskId)) {
      throw new TypeError('dispatchMany items must belong to one Task');
    }
    for (const input of inputs) {
      await this.reserve(input);
    }
    let snapshot: TaskSnapshot | undefined;
    for (const input of inputs) {
      snapshot = await this.dispatch(input);
    }
    if (!snapshot) {
      throw new Error('dispatchMany produced no Task snapshot');
    }
    return snapshot;
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
      if (existing.taskId !== snapshot.id) {
        throw new Error(
          `BullMQ job ${binding.jobId} is already bound to Task ${existing.taskId}`,
        );
      }
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
      if (!raced || raced.taskId !== snapshot.id) {
        throw error;
      }
      return this.client.getTask(snapshot.id);
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
        await this.start(observation.jobId);
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

  /**
   * Awaitable event projection. QueueEvents listeners use the same path, but
   * applications and tests can await this method when they need proof that an
   * observation is durable before continuing.
   */
  async project(event: QueueEvent, observation: BullMQEvent): Promise<void> {
    switch (event) {
      case 'waiting':
        return this.queue(observation.jobId);
      case 'active':
        return this.start(observation.jobId);
      case 'progress':
        return this.reportProgress(observation);
      case 'completed':
        return this.complete(observation);
      case 'failed':
        return this.failIfTerminal(observation);
    }
  }

  close(): void {
    for (const [name, listener] of this.listeners) {
      this.events.off?.(name, listener);
    }
  }

  private async queue(jobId: string): Promise<void> {
    const execution = await this.find(jobId);
    if (execution) {
      await this.ensureTask(execution.taskId, 'queued');
    }
  }

  private async start(jobId: string): Promise<void> {
    const execution = await this.find(jobId);
    if (execution) {
      await this.activate(execution);
    }
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
      return;
    }
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
    if (!this.isTerminalFailure || !(await this.isTerminalFailure(event))) {
      return;
    }
    await this.fail(event);
  }

  private async fail(event: BullMQEvent): Promise<void> {
    const execution = await this.find(event.jobId);
    if (!execution) {
      return;
    }
    await this.activate(execution);
    await this.ensureExecution(execution.id, 'failed', this.failureReason(event));
    if (this.terminalProjection === 'single-execution') {
      await this.ensureTask(execution.taskId, 'failed');
    } else {
      await this.updateAggregate(execution.taskId);
    }
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
        lastConflict = error;
      }
    }
    throw lastConflict;
  }

  private run(event: BullMQEvent, operation: () => Promise<void>): void {
    void operation().catch((error: unknown) => this.onError?.(error, event));
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof RhinoQError && error.code === code;
}

function defaultFailureReason(event: BullMQEvent): string | undefined {
  const reason = event.failedReason?.trim();
  return reason ? reason : undefined;
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
