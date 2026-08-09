import { RhinoQError } from '../gateway/client.js';
import type {
  TaskCancellationStatus,
  TaskCreateRequest,
  TaskExecution,
  TaskExecutionBinding,
  TaskExecutionCreateRequest,
  TaskExecutionResult,
  TaskExecutionResults,
  TaskExecutionRuntimeRefs,
	TaskExecutionPage,
  TaskExecutionSummary,
  TaskProgress,
  TaskResult,
  TaskSnapshot,
	TaskSummary,
  TaskState,
	TaskWaitpoint,
	TaskWaitpointCreateRequest,
	TaskWaitpointResolveRequest,
} from '../gateway/types.js';
import type { TaskClient } from '../tasks/client.js';
import type { SqlExecutor } from './producer.js';
import { migrateTaskSchema } from './task-schema.js';
import type { SqlConnection, SqlPool } from './task-schema.js';

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
  execution_total: string | number;
  execution_pending_dispatch: string | number;
  execution_dispatched: string | number;
  execution_running: string | number;
  execution_succeeded: string | number;
  execution_failed: string | number;
  execution_stalled: string | number;
  execution_cancelled: string | number;
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
  superseded_at: Date | string | null;
  version: string | number;
  updated_at: Date | string;
	created_at: Date | string;
}

interface WaitpointRow {
  id: string; task_id: string; key: string; kind: TaskWaitpoint['kind']; state: TaskWaitpoint['state'];
  payload_version: number; deadline: Date | string | null; resolution: unknown; resolved_by: string | null;
  resolved_at: Date | string | null; version: string | number; created_at: Date | string; updated_at: Date | string;
}

interface ExecutionCursor { id: string }

const SUMMARY_SQL = `
SELECT t.*, '[]'::jsonb AS executions
FROM rhinoq_task.tasks AS t
WHERE t.id = $1 AND ($2::text IS NULL OR t.owner_id = $2)`;

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

  async createTaskWaitpoint(taskId: string, request: TaskWaitpointCreateRequest): Promise<TaskWaitpoint> {
    if (!taskId?.trim() || !request?.id?.trim() || !request.key?.trim() ||
        !['input','approval','webhook'].includes(request.kind) || !Number.isInteger(request.payloadVersion) || request.payloadVersion <= 0) {
      throw new TypeError('valid task, waitpoint identity, kind and payloadVersion are required');
    }
    await this.execute(`SELECT rhinoq_task.create_waitpoint($1,$2,$3,$4,$5,$6)`,
      [request.id, taskId, request.key, request.kind, request.payloadVersion, request.deadline ?? null]);
    return this.readWaitpoint(request.id);
  }

  getTaskWaitpoint(id: string, ownerId: string): Promise<TaskWaitpoint> { return this.readWaitpoint(id, ownerId); }

  async resolveTaskWaitpoint(id: string, ownerId: string, request: TaskWaitpointResolveRequest): Promise<TaskWaitpoint> {
    if (!id?.trim() || !ownerId?.trim() || !Number.isInteger(request?.expectedVersion) || request.expectedVersion <= 0 ||
        !request.resolutionId?.trim() || request.resolution === undefined) throw new TypeError('valid waitpoint resolution is required');
    const encoded = JSON.stringify(request.resolution);
    if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > 65_536) throw new RangeError('waitpoint resolution must be JSON up to 64 KiB');
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('');
    await this.execute(`SELECT rhinoq_task.resolve_waitpoint($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [id, ownerId, request.expectedVersion, request.resolutionId, request.actor?.trim() || ownerId, encoded, hash]);
    return this.readWaitpoint(id, ownerId);
  }

  async expireTaskWaitpoints(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new RangeError('waitpoint expiry limit must be 1..500');
    const result = await this.execute<{ count: number | string }>(`SELECT rhinoq_task.expire_waitpoints($1) AS count`, [limit]);
    return Number(result.rows[0]?.count ?? 0);
  }

  private async readWaitpoint(id: string, ownerId?: string): Promise<TaskWaitpoint> {
    const result = await this.execute<WaitpointRow>(`SELECT w.* FROM rhinoq_task.waitpoints w JOIN rhinoq_task.tasks t ON t.id=w.task_id
      WHERE w.id=$1 AND ($2::text IS NULL OR t.owner_id=$2)`, [id, ownerId ?? null]);
    const row = result.rows[0]; if (!row) throw new RhinoQError('RHINOQ_WAITPOINT_NOT_FOUND', 'Waitpoint not found', false, { status: 404 });
    return mapWaitpoint(row);
  }

  getTask(taskId: string): Promise<TaskSnapshot> {
    return this.readTask(taskId);
  }

  getTaskForOwner(taskId: string, ownerId: string): Promise<TaskSnapshot> {
    return this.readTask(taskId, ownerId);
  }

	getTaskSummary(taskId: string): Promise<TaskSummary> {
		return this.readTaskSummary(taskId);
	}

	getTaskSummaryForOwner(taskId: string, ownerId: string): Promise<TaskSummary> {
		return this.readTaskSummary(taskId, ownerId);
	}

	async listTaskExecutions(taskId: string, cursor = '', limit = 100): Promise<TaskExecutionPage> {
		if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
			throw new RangeError('execution page limit must be between 1 and 500');
		}
		const task = await this.getTaskSummary(taskId);
		const after = decodeExecutionCursor(cursor);
		if (after) {
			const cursorRow = await this.execute<{ id: string }>(
				`SELECT id FROM rhinoq_task.executions WHERE task_id = $1 AND id = $2`,
				[taskId, after.id],
			);
			if (!cursorRow.rows[0]) throw new TypeError('invalid execution cursor');
		}
		const result = await this.execute<ExecutionRow>(
			`SELECT * FROM rhinoq_task.executions
			 WHERE task_id = $1
			   AND ($2::text = '' OR (created_at, id) > (
			     SELECT created_at, id FROM rhinoq_task.executions WHERE task_id = $1 AND id = $2
			   ))
			 ORDER BY created_at, id LIMIT $3`,
			[taskId, after?.id ?? '', limit + 1],
		);
		const more = result.rows.length > limit;
		const rows = more ? result.rows.slice(0, limit) : result.rows;
		return {
			schemaVersion: 1, entityVersion: task.entityVersion, taskId,
			executions: rows.map(mapExecutionSummaryRow),
			...(more && rows.length > 0 ? { nextCursor: encodeExecutionCursor(rows[rows.length - 1]!) } : {}),
		};
	}

	async listTaskExecutionsForOwner(taskId: string, ownerId: string, cursor = '', limit = 100): Promise<TaskExecutionPage> {
		await this.getTaskSummaryForOwner(taskId, ownerId);
		return this.listTaskExecutions(taskId, cursor, limit);
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

  /**
   * Runs one named application effect at most once for an item, with the
   * claim and the caller's business writes in one PostgreSQL transaction.
   *
   * The callback must use the supplied transaction connection. A retry after a
   * committed callback returns `{ executed: false }`; a callback error rolls
   * the claim back so a later retry can try again. This protects transactional
   * application writes such as credit logs or inventory rows. It does not make
   * an HTTP/provider call exactly-once; use ProviderOperation for that boundary.
   */
  async onceForItem<T>(
    executionId: string,
    effectKey: string,
    operation: (transaction: SqlConnection) => Promise<T>,
  ): Promise<{ executed: boolean; value?: T }> {
    if (!executionId?.trim() || !effectKey?.trim()) {
      throw new TypeError('executionId and effectKey are required');
    }
    if (typeof operation !== 'function') {
      throw new TypeError('onceForItem requires a transaction callback');
    }
    const pool = this.executor as Partial<SqlPool>;
    if (typeof pool.connect !== 'function') {
      throw new TypeError('onceForItem requires a PostgreSQL pool-backed Task client');
    }

    const connection = await pool.connect();
    let inTransaction = false;
    try {
      await connection.query('BEGIN', []);
      inTransaction = true;
      let claimed: boolean;
      try {
        const result = await connection.query<{ claimed: boolean }>(
          `SELECT rhinoq_task.claim_item_effect($1, $2) AS claimed`,
          [executionId, effectKey],
        );
        claimed = result.rows[0]?.claimed === true;
      } catch (error) {
        await connection.query('ROLLBACK', []).catch(() => undefined);
        inTransaction = false;
        throw mapDatabaseError(error);
      }

      if (!claimed) {
        await connection.query('COMMIT', []);
        inTransaction = false;
        return { executed: false };
      }

      let value: T;
      try {
        value = await operation(connection);
      } catch (error) {
        await connection.query('ROLLBACK', []).catch(() => undefined);
        inTransaction = false;
        throw error;
      }

      try {
        await connection.query('COMMIT', []);
        inTransaction = false;
      } catch (error) {
        await connection.query('ROLLBACK', []).catch(() => undefined);
        inTransaction = false;
        throw mapDatabaseError(error);
      }
      return { executed: true, value };
    } finally {
      if (inTransaction) {
        await connection.query('ROLLBACK', []).catch(() => undefined);
      }
      connection.release();
    }
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
    // An external runtime reuses its job ID across retries, so one external ID
    // can now own several attempts. Only one of them is live; the superseded
    // ones are history and must never be returned as the current attempt.
    const result = await this.execute<ExecutionRow>(
      `SELECT * FROM rhinoq_task.executions
       WHERE runtime = $1 AND runtime_scope = $2 AND external_id = $3
         AND superseded_at IS NULL`,
      [runtime, runtimeScope, externalId],
    );
    const row = result.rows[0];
    if (!row) {
      throw taskError('RHINOQ_EXECUTION_NOT_FOUND', externalId);
    }
    return mapExecution(row);
  }

  /**
   * Marks the Task as having every item finished, and reports whether *this*
   * call was the one that did it.
   *
   * Exactly one caller gets true, because the UPDATE filters on
   * `items_settled_at IS NULL`. That is the whole point: every adopter of a
   * fan-out wrote "did I just see the last item?" by counting, and that answer
   * is wrong the moment two workers finish concurrently or an event is
   * re-delivered.
   *
   * Returns false when items are still open, when the Task has no items, and
   * on every call after the first.
   */
  async settleTaskItems(taskId: string): Promise<boolean> {
    if (!taskId?.trim()) {
      throw new TypeError('task id is required');
    }
    const result = await this.execute<{ settled: boolean }>(
      `SELECT rhinoq_task.settle_items($1) AS settled`,
      [taskId],
    );
    return result.rows[0]?.settled === true;
  }

  /**
   * Finds Tasks by state and age, oldest first.
   *
   * This is the query a reconciler needs and the one the embedded profile did
   * not have: "which batches have been running for more than an hour". Without
   * it an application either scans its own tables and guesses, or a Task stuck
   * at `running` because a bridge died stays stuck until a human notices.
   *
   * `olderThan` filters on `updated_at`, not `created_at`. A Task that is still
   * making progress is not stuck, however long it has been going.
   */
  async listTasksByState(query: TaskStateQuery): Promise<TaskSummary[]> {
    const states = query?.states ?? [];
    if (states.length === 0 || states.length > 8) {
      throw new RangeError('between 1 and 8 states are required');
    }
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
      throw new RangeError('limit must be between 1 and 500');
    }
    const idleFor = query.idleForMs ?? 0;
    if (!Number.isFinite(idleFor) || idleFor < 0) {
      throw new RangeError('idleForMs must be a non-negative number');
    }
    const result = await this.execute<TaskRow>(
      `SELECT t.*, '[]'::jsonb AS executions
       FROM rhinoq_task.tasks AS t
       WHERE t.state = ANY($1::text[])
         AND t.updated_at <= clock_timestamp() - make_interval(secs => $2::double precision)
         AND ($3::boolean IS NULL OR (t.items_settled_at IS NOT NULL) = $3::boolean)
         AND ($4::text = '' OR t.owner_id = $4)
       ORDER BY t.updated_at, t.id
       LIMIT $5`,
      [states, idleFor / 1000, query.itemsSettled ?? null, query.ownerId ?? '', limit],
    );
    return result.rows.map(mapSummary);
  }

  /**
   * Closes a finished attempt and opens the next one for the same item.
   *
   * This is how an external runtime's retry becomes visible. BullMQ reuses its
   * job ID, so before this the second run had nowhere to go: the first attempt
   * was already terminal, its state machine refused to move, and the retry
   * left no record at all.
   *
   * The superseded row keeps its outcome and its reason. That is the point —
   * "attempt 1 failed with a 502, attempt 2 succeeded" is the answer to the
   * only question anyone asks about a retried job.
   */
  async retryTaskExecution(
    executionId: string,
    expectedVersion: number,
    nextExecutionId: string,
  ): Promise<TaskSnapshot> {
    const execution = await this.getTaskExecution(executionId);
    await this.execute(
      `SELECT rhinoq_task.retry_execution($1,$2,$3)`,
      [executionId, expectedVersion, nextExecutionId],
    );
    return this.getTask(execution.taskId);
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

  /**
   * Every attempt's runtime identity for one Task, in a single query.
   *
   * Cancelling a fan-out has to name the jobs to stop, and reading them back
   * one Execution at a time costs a round trip per item. They are not on the
   * snapshot on purpose — that is polled and reaches browsers through the
   * owner-scoped routes — so this is the server-side read that replaces the
   * loop. There is deliberately no owner-scoped variant: an end user must not
   * reach it, and adding one would be the leak this method exists to avoid.
   */
  async listTaskExecutionRuntimeRefs(taskId: string): Promise<TaskExecutionRuntimeRefs> {
    const task = await this.getTask(taskId);
    const result = await this.execute<ExecutionRow>(
      `SELECT id, item_key, attempt, runtime, runtime_scope, external_id, state
       FROM rhinoq_task.executions
       WHERE task_id = $1 ORDER BY item_key, attempt, id`,
      [taskId],
    );
    return {
      schemaVersion: 1,
      entityVersion: task.entityVersion,
      taskId,
      executions: result.rows.map((row) => ({
        executionId: row.id,
        itemKey: row.item_key,
        attempt: row.attempt,
        runtime: row.runtime,
        ...(row.runtime_scope ? { runtimeScope: row.runtime_scope } : {}),
        ...(row.external_id ? { externalId: row.external_id } : {}),
        state: row.state,
      })),
    };
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

	private async readTaskSummary(taskId: string, ownerId?: string): Promise<TaskSummary> {
		if (!taskId?.trim()) throw new TypeError('task id is required');
		const result = await this.execute<TaskRow>(SUMMARY_SQL, [taskId, ownerId ?? null]);
		const row = result.rows[0];
		if (!row) throw taskError('RHINOQ_TASK_NOT_FOUND', taskId);
		return mapSummary(row);
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

/** Which Tasks a reconciler is looking for. */
export interface TaskStateQuery {
  /** One to eight Task states, e.g. `['running', 'cancel_requested']`. */
  states: TaskState[];
  /**
   * Only Tasks untouched for at least this long. Filters `updated_at`, not
   * `created_at`: a Task still making progress is not stuck, however old.
   */
  idleForMs?: number;
  /** Restrict to Tasks whose items have (or have not) all finished. */
  itemsSettled?: boolean;
  ownerId?: string;
  /** Defaults to 100, capped at 500. A reconciler walks pages, not the table. */
  limit?: number;
}

function mapSummary(row: TaskRow): TaskSummary {
  const { executions: _executions, ...summary } = mapSnapshot(row);
  return {
    ...summary,
    executionCounts: {
      total: Number(row.execution_total),
      pendingDispatch: Number(row.execution_pending_dispatch),
      dispatched: Number(row.execution_dispatched),
      running: Number(row.execution_running),
      succeeded: Number(row.execution_succeeded),
      failed: Number(row.execution_failed),
      stalled: Number(row.execution_stalled),
      cancelled: Number(row.execution_cancelled),
    },
  };
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

function mapWaitpoint(row: WaitpointRow): TaskWaitpoint {
  return { schemaVersion: 1, entityVersion: Number(row.version), id: row.id, taskId: row.task_id,
    key: row.key, kind: row.kind, state: row.state, payloadVersion: Number(row.payload_version),
    ...(row.deadline ? { deadline: timestamp(row.deadline) } : {}),
    ...(row.resolution === null ? {} : { resolution: row.resolution }),
    ...(row.resolved_by ? { resolvedBy: row.resolved_by } : {}),
    ...(row.resolved_at ? { resolvedAt: timestamp(row.resolved_at) } : {}),
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) };
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

function mapExecutionSummaryRow(row: ExecutionRow): TaskExecutionSummary {
	return {
		id: row.id, itemKey: row.item_key, attempt: row.attempt,
		runtime: row.runtime, ...(row.runtime_scope ? { runtimeScope: row.runtime_scope } : {}),
		state: row.state, version: Number(row.version), hasResult: row.result_ref !== null,
		...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
	};
}

function encodeExecutionCursor(row: ExecutionRow): string {
	return Buffer.from(JSON.stringify({ id: row.id }), 'utf8').toString('base64url');
}

function decodeExecutionCursor(value: string): ExecutionCursor | undefined {
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<ExecutionCursor>;
		if (!parsed.id) throw new Error();
		return { id: parsed.id };
	} catch {
		throw new TypeError('invalid execution cursor');
	}
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
