import type {
  TaskCancellationStatus,
  TaskCreateRequest,
  TaskExecution,
  TaskExecutionBinding,
  TaskExecutionCreateAck,
  TaskExecutionCreateRequest,
  TaskExecutionResults,
	TaskExecutionRuntimeRefs,
	TaskExecutionPage,
	TaskExecutionWriteAck,
  TaskProgress,
  TaskResult,
  TaskSnapshot,
  TaskSummary,
  TaskState,
	TaskWaitpoint,
	TaskWaitpointCreateRequest,
	TaskWaitpointResolveRequest,
  TaskCheckpoint,
  TaskCheckpointSaveRequest,
} from '../gateway/types.js';

/**
 * Runtime-neutral Task surface used by lifecycle adapters.
 *
 * Both the HTTP Gateway client and the embedded PostgreSQL client implement
 * this interface. Adapters depend on intent, not on a transport or process.
 *
 * **Two version axes.** Every command is fenced, and there are two fences:
 *
 * - a Task command takes `expectedTaskVersion` — `TaskSnapshot.entityVersion`;
 * - an Execution command takes `expectedExecutionVersion` — the `version` of
 *   the `TaskExecution`, which is not the Task's and does not move with it.
 *
 * They used to share the name `expectedVersion`, and passing the Task's version
 * to an Execution command produced `RHINOQ_VERSION_CONFLICT` — the same code a
 * real race produces, so the natural response is to re-read and retry, which
 * never terminates. The server now answers that specific mistake with
 * `RHINOQ_WRONG_VERSION_SCOPE` and a message that names both axes.
 *
 * ```ts
 * const execution = await tasks.getTaskExecution(executionId);
 * await tasks.transitionTaskExecution(execution.id, execution.version, 'succeeded');
 * //                                                ^^^^^^^^^^^^^^^^^ not task.entityVersion
 * ```
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
  /**
   * Runtime/adapter read only. Do not expose this unscoped method to tenant
   * callers; owner-facing code must use the owner-scoped Postgres surface.
   */
  getTaskExecution(executionId: string): Promise<TaskExecution>;
  /**
   * Returns server-side runtime identities for reconciliation. Optional so the
   * legacy Gateway client can keep its existing contract; the embedded Task
   * profile implements it in one bounded query.
   */
  listTaskExecutionRuntimeRefs?(taskId: string): Promise<TaskExecutionRuntimeRefs>;
  /*
   * Acknowledged Execution writes.
   *
   * Same commands as the Snapshot-returning methods below, returning the new
   * Execution version instead of re-reading the whole Task. A fan-out's writes
   * are the hot path and the projector discards the Snapshot it is handed, so
   * on a batch of N items the Snapshot form moves O(N²) bytes for a number.
   *
   * Optional so the Gateway client keeps its contract; a caller that wants the
   * cheap path checks for the method and falls back to the Snapshot form.
   */
  createTaskExecutionAck?(
    taskId: string,
    request: TaskExecutionCreateRequest,
  ): Promise<TaskExecutionCreateAck>;
  bindTaskExecutionAck?(
    executionId: string,
    binding: TaskExecutionBinding,
  ): Promise<TaskExecutionWriteAck>;
  transitionTaskExecutionAck?(
    executionId: string,
    expectedExecutionVersion: number,
    state: string,
    reason?: string,
  ): Promise<TaskExecutionWriteAck>;
  attachTaskExecutionResultAck?(
    executionId: string,
    expectedExecutionVersion: number,
    reference: string,
  ): Promise<TaskExecutionWriteAck>;
  /**
   * Runtime/adapter transition only. Do not expose this unscoped method to
   * tenant callers; owner-facing code must use the owner-scoped Postgres
   * surface, which requires tenant and owner identity.
   */
  transitionTaskExecution(
    executionId: string,
    expectedExecutionVersion: number,
    state: string,
    reason?: string,
  ): Promise<TaskSnapshot>;
  /**
   * Runtime/adapter result mutation only. Do not expose this unscoped method
   * to tenant callers; owner-facing APIs must enforce owner and tenant first.
   */
  attachTaskExecutionResult(
    executionId: string,
    expectedExecutionVersion: number,
    reference: string,
  ): Promise<TaskSnapshot>;
  getTaskExecutionResults(taskId: string): Promise<TaskExecutionResults>;
  /**
   * Closes a finished attempt and opens the next one for the same item.
   *
   * Optional: the Gateway client does not implement it, because the Go engine
   * owns attempt identity for the runtimes it runs itself. It exists for
   * external runtimes that reuse one job identity across retries, where
   * otherwise the second run leaves no record at all. This is a runtime/adapter
   * primitive and has no owner/tenant fence.
   */
  retryTaskExecution?(
    executionId: string,
    expectedExecutionVersion: number,
    nextExecutionId: string,
  ): Promise<TaskSnapshot>;
  /**
   * Marks a Task as having every item finished, returning true only for the
   * caller that did it. Optional for the same reason as `retryTaskExecution`.
   */
  settleTaskItems?(taskId: string): Promise<boolean>;
  /**
   * Recomputes fan-out progress from the items, with no version to supply and
   * none to lose. Optional for the same reason as `retryTaskExecution`.
   */
  syncTaskItemProgress?(taskId: string): Promise<number>;
  transitionTask(
    taskId: string,
    expectedTaskVersion: number,
    state: Exclude<TaskState, 'pending'>,
  ): Promise<TaskSnapshot>;
  reportTaskProgress(
    taskId: string,
    expectedTaskVersion: number,
    progress: TaskProgress,
  ): Promise<TaskSnapshot>;
  requestTaskCancellation(
    taskId: string,
    expectedTaskVersion: number,
  ): Promise<TaskSnapshot>;
  resolveTaskCancellation(
    taskId: string,
    expectedTaskVersion: number,
    status: Extract<
      TaskCancellationStatus,
      'acknowledged' | 'cannot_cancel_safely' | 'failed'
    >,
    reason?: string,
  ): Promise<TaskSnapshot>;
  attachTaskResult(
    taskId: string,
    expectedTaskVersion: number,
    reference: string,
  ): Promise<TaskResult>;
  getTaskResult(taskId: string): Promise<TaskResult>;
	createTaskWaitpoint?(taskId: string, request: TaskWaitpointCreateRequest): Promise<TaskWaitpoint>;
	getTaskWaitpoint?(id: string, ownerId: string): Promise<TaskWaitpoint>;
	resolveTaskWaitpoint?(id: string, ownerId: string, request: TaskWaitpointResolveRequest): Promise<TaskWaitpoint>;
	/**
	 * Bounded resumable execution state. The embedded PostgreSQL profile owns
	 * versioning and compatibility checks; adapters only carry the intent.
	 */
	saveTaskCheckpoint?(executionId: string, key: string, request: TaskCheckpointSaveRequest): Promise<TaskCheckpoint>;
	getTaskCheckpoint?(executionId: string, key: string): Promise<TaskCheckpoint | undefined>;
	deleteTaskCheckpoints?(executionId: string): Promise<number>;
}
