import { RhinoQError } from '../gateway/client.js';
import type {
  TaskCancellationStatus,
  TaskCreateRequest,
  TaskExecution,
  TaskExecutionBinding,
  TaskExecutionCreateRequest,
  TaskExecutionResult,
  TaskExecutionResults,
  TaskExecutionSummary,
  TaskProgress,
  TaskResult,
  TaskSnapshot,
  TaskState,
} from '../gateway/types.js';
import type { TaskClient } from '../tasks/client.js';
import type { SqlExecutor } from './producer.js';
import { migrateTaskSchema } from './task-schema.js';
import type { SqlPool } from './task-schema.js';

interface TaskRow {
  id: string;
  type: string;
  owner_id: string | null;
  definition_version: number;
  state: TaskState;
  progress_completed: string | number;
  progress_total: string | number | null;
  progress_message: string | null;
  result_ref: string | null;
  cancellation_status: TaskCancellationStatus;
  cancellation_reason: string | null;
  version: string | number;
  created_at: Date | string;
  updated_at: Date | string;
  executions: unknown;
}

interface ExecutionRow {
  id: string;
  task_id: string;
  item_key: string;
  attempt: number;
  runtime: string;
  runtime_scope: string;
  external_id: string | null;
  state: string;
  result_ref: string | null;
  failure_reason: string | null;
  version: string | number;
  updated_at: Date | string;
}

const SNAPSHOT_SQL = `
SELECT t.*,
       COALESCE(
         jsonb_agg(
           jsonb_build_object(
             'id', e.id,
             'itemKey', e.item_key,
             'attempt', e.attempt,
             'runtime', e.runtime,
             'runtimeScope', e.runtime_scope,
             'state', e.state,
             'version', e.version,
             'hasResult', e.result_ref IS NOT NULL,
             'failureReason', e.failure_reason
           )
           ORDER BY e.item_key, e.attempt, e.id
         ) FILTER (WHERE e.id IS NOT NULL),
         '[]'::jsonb
       ) AS executions
FROM rhinoq_task.tasks AS t
LEFT JOIN rhinoq_task.executions AS e ON e.task_id = t.id
WHERE t.id = $1
  AND ($2::text IS NULL OR t.owner_id = $2)
GROUP BY t.id`;

const LIST_SNAPSHOTS_SQL = `
WITH selected AS (
  SELECT id, updated_at
  FROM rhinoq_task.tasks
  WHERE owner_id = $1
  ORDER BY updated_at DESC, id
  LIMIT $2 OFFSET $3
)
SELECT t.*,
       COALESCE(
         jsonb_agg(
           jsonb_build_object(
             'id', e.id,
             'itemKey', e.item_key,
             'attempt', e.attempt,
             'runtime', e.runtime,
             'runtimeScope', e.runtime_scope,
             'state', e.state,
             'version', e.version,
             'hasResult', e.result_ref IS NOT NULL,
             'failureReason', e.failure_reason
           )
           ORDER BY e.item_key, e.attempt, e.id
         ) FILTER (WHERE e.id IS NOT NULL),
         '[]'::jsonb
       ) AS executions
FROM selected
JOIN rhinoq_task.tasks AS t ON t.id = selected.id
LEFT JOIN rhinoq_task.executions AS e ON e.task_id = t.id
GROUP BY t.id, selected.updated_at
ORDER BY selected.updated_at DESC, t.id`;

/**
 * Embedded Task client for Node applications already using PostgreSQL.
 *
 * Correctness lives in versioned `rhinoq_task.*` database commands. This
 * class validates call shape, maps rows to the public contract and reuses the
 * application's pool; it does not reimplement Task state machines.
 */
export class PostgresTaskClient implements TaskClient {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    if (!executor || typeof executor.query !== 'function') {
      throw new TypeError('a PostgreSQL query executor is required');
    }
    this.executor = executor;
  }

  async createTask(request: TaskCreateRequest): Promise<TaskSnapshot> {
    if (!request?.id || !request.type) {
      throw new TypeError('task id and type are required');
    }
    if (!Number.isInteger(request.definitionVersion) || request.definitionVersion <= 0) {
      throw new RangeError('task definitionVersion must be a positive integer');
    }
    await this.execute(
      `SELECT rhinoq_task.create_task($1, $2, $3, $4)`,
      [request.id, request.type, request.ownerId ?? null, request.definitionVersion],
    );
    return this.getTask(request.id);
  }

  getTask(taskId: string): Promise<TaskSnapshot> {
    return this.readTask(taskId);
  }

  getTaskForOwner(taskId: string, ownerId: string): Promise<TaskSnapshot> {
    return this.readTask(taskId, ownerId);
  }

  async listTasks(ownerId: string, limit = 50, offset = 0): Promise<TaskSnapshot[]> {
    if (!ownerId?.trim()) {
      throw new TypeError('owner id is required');
    }
    if (!Number.isInteger(limit) || limit <= 0 || limit > 200 ||
        !Number.isInteger(offset) || offset < 0) {
      throw new RangeError('limit must be 1..200 and offset must be non-negative');
    }
    const result = await this.execute<TaskRow>(
      LIST_SNAPSHOTS_SQL,
      [ownerId, limit, offset],
    );
    return result.rows.map(mapSnapshot);
  }

  async createTaskExecution(
    taskId: string,
    request: TaskExecutionCreateRequest,
  ): Promise<TaskSnapshot> {
    if (!taskId || !request?.id || !request.runtime) {
      throw new TypeError('task id, execution id and runtime are required');
    }
    await this.execute(
      `SELECT rhinoq_task.create_execution($1, $2, $3, $4, $5, $6)`,
      [
        request.id,
        taskId,
        request.itemKey ?? 'default',
        request.runtime,
        request.runtimeScope ?? '',
        request.externalId ?? null,
      ],
    );
    return this.getTask(taskId);
  }

  async bindTaskExecution(
    executionId: string,
    binding: TaskExecutionBinding,
  ): Promise<TaskSnapshot> {
    const execution = await this.getTaskExecution(executionId);
    const externalId = binding.externalId ?? binding.jobId;
    if (!binding?.runtime || !externalId) {
      throw new TypeError('execution runtime and external id are required');
    }
    await this.execute(
      `SELECT rhinoq_task.bind_execution($1, $2, $3, $4, $5)`,
      [
        executionId,
        execution.version,
        binding.runtime,
        binding.runtimeScope ?? '',
        externalId,
      ],
    );
    return this.getTask(execution.taskId);
  }

  async lookupTaskExecution(
    runtime: string,
    externalId: string,
    runtimeScope = '',
  ): Promise<TaskExecution> {
    const result = await this.execute<ExecutionRow>(
      `SELECT * FROM rhinoq_task.executions
       WHERE runtime = $1 AND runtime_scope = $2 AND external_id = $3`,
      [runtime, runtimeScope, externalId],
    );
    const row = result.rows[0];
    if (!row) {
      throw taskError('RHINOQ_EXECUTION_NOT_FOUND', externalId);
    }
    return mapExecution(row);
  }

  async getTaskExecution(executionId: string): Promise<TaskExecution> {
    const result = await this.execute<ExecutionRow>(
      `SELECT * FROM rhinoq_task.executions WHERE id = $1`,
      [executionId],
    );
    const row = result.rows[0];
    if (!row) {
      throw taskError('RHINOQ_EXECUTION_NOT_FOUND', executionId);
    }
    return mapExecution(row);
  }

  async transitionTaskExecution(
    executionId: string,
    expectedVersion: number,
    state: string,
    reason?: string,
  ): Promise<TaskSnapshot> {
    validateVersion(expectedVersion);
    const execution = await this.getTaskExecution(executionId);
    await this.execute(
      `SELECT rhinoq_task.transition_execution($1, $2, $3, $4)`,
      [executionId, expectedVersion, state, reason ?? null],
    );
    return this.getTask(execution.taskId);
  }

  async attachTaskExecutionResult(
    executionId: string,
    expectedVersion: number,
    reference: string,
  ): Promise<TaskSnapshot> {
    validateVersion(expectedVersion);
    if (!reference?.trim()) {
      throw new TypeError('execution result reference is required');
    }
    const execution = await this.getTaskExecution(executionId);
    await this.execute(
      `SELECT rhinoq_task.attach_execution_result($1, $2, $3)`,
      [executionId, expectedVersion, reference],
    );
    return this.getTask(execution.taskId);
  }

  async getTaskExecutionResults(taskId: string): Promise<TaskExecutionResults> {
    const task = await this.getTask(taskId);
    const result = await this.execute<ExecutionRow>(
      `SELECT * FROM rhinoq_task.executions
       WHERE task_id = $1 ORDER BY item_key, attempt, id`,
      [taskId],
    );
    return {
      schemaVersion: 1,
      entityVersion: task.entityVersion,
      taskId,
      executions: result.rows.map(mapExecutionResult),
    };
  }

  async getTaskExecutionResultsForOwner(
    taskId: string,
    ownerId: string,
  ): Promise<TaskExecutionResults> {
    await this.getTaskForOwner(taskId, ownerId);
    return this.getTaskExecutionResults(taskId);
  }

  async transitionTask(
    taskId: string,
    expectedVersion: number,
    state: Exclude<TaskState, 'pending'>,
  ): Promise<TaskSnapshot> {
    validateVersion(expectedVersion);
    await this.execute(
      `SELECT rhinoq_task.transition_task($1, $2, $3)`,
      [taskId, expectedVersion, state],
    );
    return this.getTask(taskId);
  }

  async reportTaskProgress(
    taskId: string,
    expectedVersion: number,
    progress: TaskProgress,
  ): Promise<TaskSnapshot> {
    validateVersion(expectedVersion);
    validateProgress(progress);
    await this.execute(
      `SELECT rhinoq_task.report_progress($1, $2, $3, $4, $5, $6)`,
      [
        taskId,
        expectedVersion,
        progress.completed,
        progress.total ?? 0,
        progress.total !== undefined,
        progress.message ?? null,
      ],
    );
    return this.getTask(taskId);
  }

  async requestTaskCancellation(
    taskId: string,
    expectedVersion: number,
  ): Promise<TaskSnapshot> {
    validateVersion(expectedVersion);
    await this.execute(
      `SELECT rhinoq_task.request_cancellation($1, $2)`,
      [taskId, expectedVersion],
    );
    return this.getTask(taskId);
  }

  async requestTaskCancellationForOwner(
    taskId: string,
    ownerId: string,
    expectedVersion: number,
  ): Promise<TaskSnapshot> {
    await this.getTaskForOwner(taskId, ownerId);
    return this.requestTaskCancellation(taskId, expectedVersion);
  }

  async resolveTaskCancellation(
    taskId: string,
    expectedVersion: number,
    status: Extract<
      TaskCancellationStatus,
      'acknowledged' | 'cannot_cancel_safely' | 'failed'
    >,
    reason?: string,
  ): Promise<TaskSnapshot> {
    validateVersion(expectedVersion);
    await this.execute(
      `SELECT rhinoq_task.resolve_cancellation($1, $2, $3, $4)`,
      [taskId, expectedVersion, status, reason ?? null],
    );
    return this.getTask(taskId);
  }

  async attachTaskResult(
    taskId: string,
    expectedVersion: number,
    reference: string,
  ): Promise<TaskResult> {
    validateVersion(expectedVersion);
    if (!reference?.trim()) {
      throw new TypeError('task result reference is required');
    }
    await this.execute(
      `SELECT rhinoq_task.attach_task_result($1, $2, $3)`,
      [taskId, expectedVersion, reference],
    );
    return this.getTaskResult(taskId);
  }

  async getTaskResult(taskId: string): Promise<TaskResult> {
    const task = await this.getTask(taskId);
    const result = await this.execute<{
      result_ref: string | null;
      updated_at: Date | string;
    }>(
      `SELECT result_ref, updated_at
       FROM rhinoq_task.tasks WHERE id = $1`,
      [taskId],
    );
    const row = result.rows[0];
    if (!row?.result_ref) {
      throw taskError('RHINOQ_TASK_RESULT_NOT_FOUND', taskId);
    }
    return {
      schemaVersion: 1,
      entityVersion: task.entityVersion,
      taskId,
      reference: row.result_ref,
      updatedAt: timestamp(row.updated_at),
    };
  }

  async getTaskResultForOwner(
    taskId: string,
    ownerId: string,
  ): Promise<TaskResult> {
    await this.getTaskForOwner(taskId, ownerId);
    return this.getTaskResult(taskId);
  }

  private async readTask(taskId: string, ownerId?: string): Promise<TaskSnapshot> {
    if (!taskId?.trim()) {
      throw new TypeError('task id is required');
    }
    const result = await this.execute<TaskRow>(
      SNAPSHOT_SQL,
      [taskId, ownerId ?? null],
    );
    const row = result.rows[0];
    if (!row) {
      throw taskError('RHINOQ_TASK_NOT_FOUND', taskId);
    }
    return mapSnapshot(row);
  }

  private async execute<Row>(
    text: string,
    values: unknown[],
  ): Promise<{ rows: Row[] }> {
    try {
      return await this.executor.query<Row>(text, values);
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }
}

/**
 * One-call setup for applications that allow migrations during startup.
 *
 * The migration is transactional, advisory-lock protected and idempotent.
 * Applications with a separate deployment migration phase can keep calling
 * `migrateTaskSchema()` there and construct `PostgresTaskClient` directly.
 */
export async function installPostgresTaskProfile(
  executor: SqlPool,
): Promise<PostgresTaskClient> {
  await migrateTaskSchema(executor);
  return new PostgresTaskClient(executor);
}

function mapSnapshot(row: TaskRow): TaskSnapshot {
  const executions = Array.isArray(row.executions)
    ? row.executions.map(mapExecutionSummary)
    : [];
  return {
    schemaVersion: 1,
    entityVersion: Number(row.version),
    id: row.id,
    type: row.type,
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    state: row.state,
    cancellation: {
      status: row.cancellation_status,
      ...(row.cancellation_reason ? { reason: row.cancellation_reason } : {}),
    },
    progress: {
      completed: Number(row.progress_completed),
      ...(row.progress_total === null ? {} : { total: Number(row.progress_total) }),
      ...(row.progress_message ? { message: row.progress_message } : {}),
    },
    hasResult: row.result_ref !== null,
    executions,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function mapExecutionSummary(value: unknown): TaskExecutionSummary {
  if (!isRecord(value)) {
    throw new TypeError('PostgreSQL returned an invalid Task execution summary');
  }
  return {
    id: String(value.id),
    itemKey: String(value.itemKey),
    attempt: Number(value.attempt),
    runtime: String(value.runtime),
    ...(value.runtimeScope ? { runtimeScope: String(value.runtimeScope) } : {}),
    state: String(value.state),
    version: Number(value.version),
    hasResult: value.hasResult === true,
    ...(value.failureReason ? { failureReason: String(value.failureReason) } : {}),
  };
}

function mapExecution(row: ExecutionRow): TaskExecution {
  return {
    id: row.id,
    taskId: row.task_id,
    itemKey: row.item_key,
    attempt: row.attempt,
    runtime: row.runtime,
    ...(row.runtime_scope ? { runtimeScope: row.runtime_scope } : {}),
    ...(row.external_id ? { externalId: row.external_id } : {}),
    state: row.state,
    version: Number(row.version),
  };
}

function mapExecutionResult(row: ExecutionRow): TaskExecutionResult {
  return {
    executionId: row.id,
    itemKey: row.item_key,
    attempt: row.attempt,
    state: row.state,
    ...(row.result_ref ? { reference: row.result_ref } : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    updatedAt: timestamp(row.updated_at),
  };
}

function mapDatabaseError(error: unknown): RhinoQError {
  if (error instanceof RhinoQError) {
    return error;
  }
  const record = isRecord(error) ? error : {};
  const message = typeof record.message === 'string' ? record.message : '';
  if (message.startsWith('RHINOQ_')) {
    return taskError(
      message,
      typeof record.detail === 'string' ? record.detail : message,
      error,
    );
  }
  return new RhinoQError(
    'RHINOQ_POSTGRES_UNREACHABLE',
    message || 'PostgreSQL Task command failed',
    true,
    { cause: error },
  );
}

function taskError(code: string, detail: string, cause?: unknown): RhinoQError {
  const status = code.includes('NOT_FOUND') ? 404 :
    code.includes('CONFLICT') || code.includes('ALREADY') ? 409 : 400;
  return new RhinoQError(code, detail, false, { status, cause });
}

function validateVersion(version: number): void {
  if (!Number.isInteger(version) || version <= 0) {
    throw new RangeError('expectedVersion must be a positive integer');
  }
}

function validateProgress(progress: TaskProgress): void {
  if (!Number.isInteger(progress?.completed) || progress.completed < 0) {
    throw new RangeError('task progress completed must be a non-negative integer');
  }
  if (progress.total !== undefined &&
      (!Number.isInteger(progress.total) || progress.total < progress.completed)) {
    throw new RangeError('task progress total must be at least completed');
  }
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
