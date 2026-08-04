import type { ProjectionFailure, ProjectionFailureSink } from '../tasks/projection-failures.js';
import type { SqlExecutor } from './producer.js';

/**
 * One idempotent write to the application-owned projection-failure table.
 *
 * The table deliberately does not belong to `rhinoq_task`: the Task-only
 * profile has exactly three tables. Apply `PROJECTION_FAILURE_TABLE_SQL` in
 * the application's migration before constructing this sink.
 */
export const UPSERT_PROJECTION_FAILURE_SQL = `
INSERT INTO rhinoq_projection_failures (
  runtime, runtime_scope, external_id, event, observation, message, code
) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
ON CONFLICT (runtime, runtime_scope, external_id, event)
DO UPDATE SET
  observation = EXCLUDED.observation,
  message = EXCLUDED.message,
  code = EXCLUDED.code,
  attempts = rhinoq_projection_failures.attempts + 1,
  last_seen_at = clock_timestamp()`;

/**
 * Durable PostgreSQL implementation of `ProjectionFailureSink`.
 *
 * It intentionally records failures only. Reading a runtime and deciding how
 * to replay it remains application-owned, because RhinoQ must not scan or
 * mutate an application's BullMQ queue on its own.
 */
export class PostgresProjectionFailureSink implements ProjectionFailureSink {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    if (!executor || typeof executor.query !== 'function') {
      throw new TypeError('PostgresProjectionFailureSink requires a PostgreSQL query executor');
    }
    this.executor = executor;
  }

  async record(failure: ProjectionFailure): Promise<void> {
    const observation = JSON.stringify(failure.observation);
    if (observation === undefined) {
      throw new TypeError('ProjectionFailure observation must be JSON serializable');
    }
    await this.executor.query(UPSERT_PROJECTION_FAILURE_SQL, [
      failure.runtime,
      failure.runtimeScope,
      failure.externalId,
      failure.event,
      observation,
      failure.message,
      failure.code ?? null,
    ]);
  }
}
