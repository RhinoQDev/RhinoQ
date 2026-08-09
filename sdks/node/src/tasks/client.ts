import type {
  TaskCancellationStatus,
  TaskCreateRequest,
  TaskExecution,
  TaskExecutionBinding,
  TaskExecutionCreateRequest,
  TaskExecutionResults,
	TaskExecutionRuntimeRefs,
	TaskExecutionPage,
  TaskProgress,
  TaskResult,
  TaskSnapshot,
  TaskSummary,
  TaskState,
	TaskWaitpoint,
	TaskWaitpointCreateRequest,
	TaskWaitpointResolveRequest,
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
	getTaskSummary(taskId: string): Promise<TaskSummary>;
	listTaskExecutions(taskId: string, cursor?: string, limit?: number): Promise<TaskExecutionPage>;
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
  /**
   * Returns server-side runtime identities for reconciliation. Optional so the
   * legacy Gateway client can keep its existing contract; the embedded Task
   * profile implements it in one bounded query.
   */
  listTaskExecutionRuntimeRefs?(taskId: string): Promise<TaskExecutionRuntimeRefs>;
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
  /**
   * Closes a finished attempt and opens the next one for the same item.
   *
   * Optional: the Gateway client does not implement it, because the Go engine
   * owns attempt identity for the runtimes it runs itself. It exists for
   * external runtimes that reuse one job identity across retries, where
   * otherwise the second run leaves no record at all.
   */
  retryTaskExecution?(
    executionId: string,
    expectedVersion: number,
    nextExecutionId: string,
  ): Promise<TaskSnapshot>;
  /**
   * Marks a Task as having every item finished, returning true only for the
   * caller that did it. Optional for the same reason as `retryTaskExecution`.
   */
  settleTaskItems?(taskId: string): Promise<boolean>;
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
	createTaskWaitpoint?(taskId: string, request: TaskWaitpointCreateRequest): Promise<TaskWaitpoint>;
	getTaskWaitpoint?(id: string, ownerId: string): Promise<TaskWaitpoint>;
	resolveTaskWaitpoint?(id: string, ownerId: string, request: TaskWaitpointResolveRequest): Promise<TaskWaitpoint>;
}
