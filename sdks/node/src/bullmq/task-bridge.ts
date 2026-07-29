import {
  RhinoQClient,
  RhinoQError,
} from '../gateway/client.js';
import type {
  TaskCreateRequest,
  TaskProgress,
  TaskSnapshot,
  TaskState,
} from '../gateway/types.js';

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

export interface BullMQEvent {
  jobId: string;
  data?: unknown;
  returnvalue?: unknown;
  failedReason?: string;
}

export interface BullMQTaskBinding {
  task: TaskCreateRequest;
  executionId: string;
  jobId: string;
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
  client: RhinoQClient;
  events: BullMQQueueEvents;
  /**
   * Controls whether one BullMQ job may terminate its parent Task.
   *
   * Use `single-execution` only when one job represents the whole user-facing
   * Task. Use `execution-only` for fan-out: the bridge records each Execution,
   * while the application completes/fails the Task after its aggregate
   * outcome is known.
   */
  terminalProjection?: 'single-execution' | 'execution-only';
  /** Maps BullMQ progress into the portable Task progress contract. */
  progress?: (event: BullMQEvent) => TaskProgress | undefined;
  /**
   * BullMQ can emit a failed event before retrying. Return true only after the
   * application's Queue/Job inspection has established that this job is truly
   * terminal. Omitting it leaves the Task running instead of falsely failing it.
   */
  isTerminalFailure?: (event: BullMQEvent) => Promise<boolean>;
  /** Maps a completed BullMQ return value to an application-owned result ref. */
  resultReference?: (event: BullMQEvent) => Promise<string | undefined>;
  onError?: (error: unknown, event: BullMQEvent) => void;
}

/**
 * BullMQTaskBridge observes jobs that already belong to an application and
 * projects their lifecycle into RhinoQ Tasks. It does not enqueue BullMQ jobs,
 * change worker handlers, implement cancellation, or pretend a BullMQ retry is
 * a new RhinoQ Execution; those require the later dispatch/retry contract.
 */
export class BullMQTaskBridge {
  private readonly client: RhinoQClient;
  private readonly events: BullMQQueueEvents;
  private readonly terminalProjection: 'single-execution' | 'execution-only';
  private readonly progress: (event: BullMQEvent) => TaskProgress | undefined;
  private readonly isTerminalFailure?: (event: BullMQEvent) => Promise<boolean>;
  private readonly resultReference?: (event: BullMQEvent) => Promise<string | undefined>;
  private readonly onError?: (error: unknown, event: BullMQEvent) => void;
  private readonly listeners: Array<[QueueEvent, (event: BullMQEvent) => void]>;

  constructor(options: BullMQTaskBridgeOptions) {
    this.client = options.client;
    this.events = options.events;
    this.terminalProjection = options.terminalProjection ?? 'single-execution';
    this.progress = options.progress ?? defaultProgress;
    this.isTerminalFailure = options.isTerminalFailure;
    this.resultReference = options.resultReference;
    this.onError = options.onError;
    this.listeners = [
      ['waiting', (event) => this.run(event, () => this.queue(event.jobId))],
      ['active', (event) => this.run(event, () => this.start(event.jobId))],
      ['progress', (event) => this.run(event, () => this.reportProgress(event))],
      ['completed', (event) => this.run(event, () => this.complete(event))],
      ['failed', (event) => this.run(event, () => this.failIfTerminal(event))],
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
      });
      snapshot = await this.client.bindTaskExecution(binding.executionId, {
        runtime: 'bullmq',
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
    if (!execution) {
      return;
    }
    await this.ensureTask(execution.taskId, 'running');
    await this.ensureExecution(execution.id, 'running');
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
      await this.start(event.jobId);
      const task = await this.client.getTask(execution.taskId);
      if (task.state === 'running' || task.state === 'cancel_requested') {
        await this.client.reportTaskProgress(task.id, task.entityVersion, progress);
      }
    });
  }

  private async complete(event: BullMQEvent): Promise<void> {
    const execution = await this.find(event.jobId);
    if (!execution) {
      return;
    }
    await this.start(event.jobId);
    await this.ensureExecution(execution.id, 'succeeded');
    if (this.terminalProjection === 'execution-only') {
      return;
    }
    let task = await this.ensureTask(execution.taskId, 'succeeded');
    if (this.resultReference) {
      const reference = await this.resultReference(event);
      if (reference) {
        await this.converge(async () => {
          task = await this.client.getTask(execution.taskId);
          if (!task.hasResult) {
            await this.client.attachTaskResult(task.id, task.entityVersion, reference);
          }
        });
      }
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
    await this.start(event.jobId);
    await this.ensureExecution(execution.id, 'failed');
    if (this.terminalProjection === 'single-execution') {
      await this.ensureTask(execution.taskId, 'failed');
    }
  }

  private async find(jobId: string) {
    try {
      return await this.client.lookupTaskExecution('bullmq', jobId);
    } catch (error) {
      if (isCode(error, 'RHINOQ_EXECUTION_NOT_FOUND')) {
        return undefined;
      }
      throw error;
    }
  }

  private async ensureExecution(executionId: string, target: 'running' | 'succeeded' | 'failed'): Promise<void> {
    await this.converge(async () => {
      const execution = await this.client.getTaskExecution(executionId);
      if (execution.state === target) {
        return;
      }
      if ((target === 'succeeded' || target === 'failed') && execution.state === 'dispatched') {
        await this.ensureExecution(executionId, 'running');
        return this.ensureExecution(executionId, target);
      }
      if (
        (execution.state === 'dispatched' && target === 'running') ||
        (execution.state === 'running' && (target === 'succeeded' || target === 'failed'))
      ) {
        await this.client.transitionTaskExecution(execution.id, execution.version, target);
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

function isVersionConflict(error: unknown): boolean {
  return isCode(error, 'RHINOQ_VERSION_CONFLICT');
}

function defaultProgress(event: BullMQEvent): TaskProgress | undefined {
  if (typeof event.data === 'number' && Number.isInteger(event.data) && event.data >= 0) {
    return { completed: event.data };
  }
  if (!isRecord(event.data) || !isNonNegativeInteger(event.data.completed)) {
    return undefined;
  }
  const total = isNonNegativeInteger(event.data.total) ? event.data.total : undefined;
  if (total !== undefined && total < event.data.completed) {
    return undefined;
  }
  return {
    completed: event.data.completed,
    ...(total === undefined ? {} : { total }),
    ...(typeof event.data.message === 'string' ? { message: event.data.message } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
