import type { TaskExecution, TaskSnapshot, TaskState } from '../gateway/types.js';
import type { TaskClient } from '../tasks/client.js';
import type { RuntimeEvent, RuntimeRef } from './contracts.js';
import { validateRuntimeEvent } from './contracts.js';

const MAX_CONVERGENCE_ATTEMPTS = 10;
const TERMINAL_EXECUTIONS = new Set(['succeeded', 'failed', 'stalled', 'cancelled']);

export interface RuntimeTaskProjectorOptions {
  client: TaskClient;
  /** Whether one runtime reference represents the whole Task or one fan-out item. */
  terminalProjection: 'single-execution' | 'execution-only';
  onUnboundEvent?(event: RuntimeEvent): Promise<void> | void;
  /** Optional event-driven projection hook; failures are isolated from lifecycle convergence. */
  onTaskMutation?(task: TaskSnapshot): Promise<void> | void;
}

/**
 * Runtime-neutral lifecycle projector. It only consumes portable facts and a
 * TaskClient; queue listeners, retry policy reads and dispatch remain adapters.
 */
export class RuntimeTaskProjector {
  private readonly client: TaskClient;
  private readonly terminalProjection: RuntimeTaskProjectorOptions['terminalProjection'];
  private readonly onUnboundEvent?: RuntimeTaskProjectorOptions['onUnboundEvent'];
  private readonly onTaskMutation?: RuntimeTaskProjectorOptions['onTaskMutation'];
  private readonly projections = new Map<string, Promise<void>>();

  constructor(options: RuntimeTaskProjectorOptions) {
    if (!options?.client) throw new TypeError('RuntimeTaskProjector requires a Task client');
    if (options.terminalProjection !== 'single-execution' && options.terminalProjection !== 'execution-only') {
      throw new TypeError("RuntimeTaskProjector requires terminalProjection: 'single-execution' or 'execution-only'");
    }
    this.client = options.client;
    this.terminalProjection = options.terminalProjection;
    this.onUnboundEvent = options.onUnboundEvent;
    this.onTaskMutation = options.onTaskMutation;
  }

  /** Projects events for one runtime identity in arrival order. */
  project(event: RuntimeEvent): Promise<void> {
    validateRuntimeEvent(event);
    const key = runtimeRefKey(event.ref);
    const previous = this.projections.get(key) ?? Promise.resolve();
    const current = previous.then(() => this.projectOne(event));
    this.projections.set(key, current);
    void current.finally(() => {
      if (this.projections.get(key) === current) this.projections.delete(key);
    }).catch(() => undefined);
    return current;
  }

  private async projectOne(event: RuntimeEvent): Promise<void> {
    let execution = await this.find(event.ref);
    if (!execution) {
      await this.onUnboundEvent?.(event);
      // Shadow Mode may have durably created/bound the Task while handling the
      // miss. Re-read once and apply the original event; dropping it would
      // leave a fast completed job permanently at queued.
      execution = await this.find(event.ref);
      if (!execution) return;
    }
    if (event.attempt !== undefined) execution = await this.openAttempts(execution, event.attempt);

    switch (event.type) {
      case 'accepted':
        await this.ensureExecution(execution.id, 'dispatched');
        await this.ensureTask(execution.taskId, 'queued');
        return;
      case 'started':
        await this.activate(execution);
        return;
      case 'progressed': {
        const task = await this.activate(execution);
        if (task.state !== 'running' && task.state !== 'cancel_requested') return;
        if (sameProgress(task.progress, event.progress)) return;
        const updated = await this.converge(async () => {
          const current = await this.client.getTask(task.id);
          if (current.state !== 'running' && current.state !== 'cancel_requested') return current;
          if (sameProgress(current.progress, event.progress)) return current;
          return this.client.reportTaskProgress(current.id, current.entityVersion, event.progress);
        });
        this.notifyTaskMutation(updated);
        return;
      }
      case 'attempt_ended':
        await this.ensureExecution(
          execution.id,
          event.outcome === 'cancelled' ? 'cancelled' : event.outcome === 'failed' ? 'failed' : 'stalled',
          event.reason,
        );
        await this.ensureTask(execution.taskId, event.outcome === 'unknown' ? 'uncertain' : 'running');
        return;
      case 'succeeded':
        await this.ensureExecution(execution.id, 'succeeded');
        await this.ensureTask(execution.taskId, 'running');
        if (event.resultRef) await this.attachExecutionResult(execution.id, event.resultRef);
        if (this.terminalProjection === 'single-execution') {
          await this.synchronizeSuccessfulProgress(execution.taskId);
          await this.ensureTask(execution.taskId, 'succeeded');
          if (event.resultRef) await this.attachTaskResult(execution.taskId, event.resultRef);
        }
        return;
      case 'failed':
        await this.ensureExecution(execution.id, 'failed', event.reason);
        await this.ensureTask(execution.taskId, 'running');
        if (event.terminal && this.terminalProjection === 'single-execution') {
          await this.ensureTask(execution.taskId, 'failed');
        }
        return;
      case 'cancelled': {
        await this.ensureExecution(execution.id, 'cancelled');
        const task = await this.client.getTask(execution.taskId);
        if (this.terminalProjection === 'single-execution' && task.state === 'cancel_requested') {
          await this.ensureTask(task.id, 'cancelled');
        }
        return;
      }
      case 'uncertain':
        await this.ensureExecution(execution.id, 'stalled', event.reason);
        await this.ensureTask(execution.taskId, 'uncertain');
        return;
    }
  }

  private async find(ref: RuntimeRef): Promise<TaskExecution | undefined> {
    try {
      return await this.client.lookupTaskExecution(ref.runtime, ref.externalId, ref.scope);
    } catch (error) {
      if (hasCode(error, 'RHINOQ_EXECUTION_NOT_FOUND')) return undefined;
      throw error;
    }
  }

  private async openAttempts(execution: TaskExecution, observedAttempt: number): Promise<TaskExecution> {
    let current = execution;
    while ((current.attempt ?? 1) < observedAttempt) {
      if (!TERMINAL_EXECUTIONS.has(current.state)) await this.ensureExecution(current.id, 'stalled');
      if (!this.client.retryTaskExecution || !current.externalId) return current;
      const nextAttempt = (current.attempt ?? 1) + 1;
      try {
        await this.client.retryTaskExecution(current.id, current.version, `${current.id}#${nextAttempt}`);
      } catch (error) {
        if (!isConvergenceError(error)) throw error;
      }
      const replacement = await this.find({
        runtime: current.runtime,
        scope: current.runtimeScope ?? '',
        externalId: current.externalId,
      });
      if (!replacement || replacement.id === current.id) return current;
      current = replacement;
    }
    return current;
  }

  private async activate(execution: TaskExecution): Promise<TaskSnapshot> {
    await this.ensureExecution(execution.id, 'running');
    return this.ensureTask(execution.taskId, 'running');
  }

  private async ensureExecution(
    executionId: string,
    target: 'dispatched' | 'running' | 'succeeded' | 'failed' | 'stalled' | 'cancelled',
    reason?: string,
  ): Promise<void> {
    await this.converge(async () => {
      const execution = await this.client.getTaskExecution(executionId);
      if (execution.state === target || TERMINAL_EXECUTIONS.has(execution.state)) return;
      try {
        await this.client.transitionTaskExecution(execution.id, execution.version, target, reason);
      } catch (error) {
        if (
          execution.state !== 'running' && target !== 'running' && target !== 'dispatched' &&
          hasCode(error, 'RHINOQ_INVALID_EXECUTION_TRANSITION')
        ) {
          await this.ensureExecution(executionId, 'running');
          await this.ensureExecution(executionId, target, reason);
          return;
        }
        throw error;
      }
    });
  }

  private async ensureTask(taskId: string, target: Exclude<TaskState, 'pending' | 'cancel_requested'>): Promise<TaskSnapshot> {
    const task = await this.converge(async () => {
      let task = await this.client.getTask(taskId);
      if (task.state === target || task.state === 'succeeded' || task.state === 'failed' || task.state === 'cancelled') return task;
      if (task.state === 'pending') task = await this.client.transitionTask(task.id, task.entityVersion, 'queued');
      if (target === 'queued') return task;
      if (task.state === 'queued') task = await this.client.transitionTask(task.id, task.entityVersion, 'running');
      if (target === 'running') return task;
      if (target === 'cancelled' && task.state !== 'cancel_requested') return task;
      if (task.state === 'running' || task.state === 'uncertain' || task.state === 'cancel_requested') {
        task = await this.client.transitionTask(task.id, task.entityVersion, target);
      }
      return task;
    });
    this.notifyTaskMutation(task);
    return task;
  }

  private attachExecutionResult(executionId: string, reference: string): Promise<unknown> {
    return this.converge(async () => {
      const execution = await this.client.getTaskExecution(executionId);
      return this.client.attachTaskExecutionResult(execution.id, execution.version, reference);
    });
  }

  private attachTaskResult(taskId: string, reference: string): Promise<unknown> {
    return this.converge(async () => {
      const task = await this.client.getTask(taskId);
      if (task.hasResult) return task;
      await this.client.attachTaskResult(task.id, task.entityVersion, reference);
      const updated = await this.client.getTask(task.id);
      this.notifyTaskMutation(updated);
      return updated;
    });
  }

  private synchronizeSuccessfulProgress(taskId: string): Promise<TaskSnapshot> {
    return this.converge(async () => {
      const task = await this.client.getTask(taskId);
      if (task.state !== 'running' && task.state !== 'cancel_requested') return task;
      const total = task.progress.total ?? Math.max(1, task.progress.completed);
      if (task.progress.completed >= total) return task;
      const updated = await this.client.reportTaskProgress(task.id, task.entityVersion, {
        ...task.progress,
        completed: total,
        total,
      });
      this.notifyTaskMutation(updated);
      return updated;
    });
  }

  private notifyTaskMutation(task: TaskSnapshot): void {
    void Promise.resolve().then(() => this.onTaskMutation?.(task)).catch(() => undefined);
  }

  private async converge<T>(operation: () => Promise<T>): Promise<T> {
    let conflict: unknown;
    for (let attempt = 0; attempt < MAX_CONVERGENCE_ATTEMPTS; attempt += 1) {
      try { return await operation(); } catch (error) {
        if (!hasCode(error, 'RHINOQ_VERSION_CONFLICT')) throw error;
        conflict = error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** attempt, 32)));
      }
    }
    throw conflict;
  }
}

export function runtimeRefKey(ref: RuntimeRef): string {
  return JSON.stringify([ref.runtime, ref.scope, ref.externalId]);
}

function sameProgress(left: { completed: number; total?: number; message?: string }, right: { completed: number; total?: number; message?: string }): boolean {
  return left.completed === right.completed && left.total === right.total && left.message === right.message;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function isConvergenceError(error: unknown): boolean {
  return hasCode(error, 'RHINOQ_VERSION_CONFLICT') || hasCode(error, 'RHINOQ_EXECUTION_SUPERSEDED') ||
    hasCode(error, 'RHINOQ_EXECUTION_ALREADY_EXISTS');
}
