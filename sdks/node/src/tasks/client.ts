import type {
  TaskCancellationStatus,
  TaskCreateRequest,
  TaskExecution,
  TaskExecutionBinding,
  TaskExecutionCreateRequest,
  TaskExecutionResults,
  TaskProgress,
  TaskResult,
  TaskSnapshot,
  TaskState,
} from '../gateway/types.js';

/**
 * Runtime-neutral Task surface used by lifecycle adapters.
 *
 * Both the HTTP Gateway client and the embedded PostgreSQL client implement
 * this interface. Adapters depend on intent, not on a transport or process.
 */
export interface TaskClient {
  createTask(request: TaskCreateRequest): Promise<TaskSnapshot>;
  getTask(taskId: string): Promise<TaskSnapshot>;
  createTaskExecution(
    taskId: string,
    request: TaskExecutionCreateRequest,
  ): Promise<TaskSnapshot>;
  bindTaskExecution(
    executionId: string,
    binding: TaskExecutionBinding,
  ): Promise<TaskSnapshot>;
  lookupTaskExecution(
    runtime: string,
    externalId: string,
    runtimeScope?: string,
  ): Promise<TaskExecution>;
  getTaskExecution(executionId: string): Promise<TaskExecution>;
  transitionTaskExecution(
    executionId: string,
    expectedVersion: number,
    state: string,
    reason?: string,
  ): Promise<TaskSnapshot>;
  attachTaskExecutionResult(
    executionId: string,
    expectedVersion: number,
    reference: string,
  ): Promise<TaskSnapshot>;
  getTaskExecutionResults(taskId: string): Promise<TaskExecutionResults>;
  transitionTask(
    taskId: string,
    expectedVersion: number,
    state: Exclude<TaskState, 'pending'>,
  ): Promise<TaskSnapshot>;
  reportTaskProgress(
    taskId: string,
    expectedVersion: number,
    progress: TaskProgress,
  ): Promise<TaskSnapshot>;
  requestTaskCancellation(
    taskId: string,
    expectedVersion: number,
  ): Promise<TaskSnapshot>;
  resolveTaskCancellation(
    taskId: string,
    expectedVersion: number,
    status: Extract<
      TaskCancellationStatus,
      'acknowledged' | 'cannot_cancel_safely' | 'failed'
    >,
    reason?: string,
  ): Promise<TaskSnapshot>;
  attachTaskResult(
    taskId: string,
    expectedVersion: number,
    reference: string,
  ): Promise<TaskResult>;
  getTaskResult(taskId: string): Promise<TaskResult>;
}
