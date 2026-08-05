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
  schema_version, runtime, runtime_scope, external_id, event, observed_at, observation, message, code
) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
ON CONFLICT (runtime, runtime_scope, external_id, event)
DO UPDATE SET
  schema_version = EXCLUDED.schema_version,
  observed_at = EXCLUDED.observed_at,
  observation = EXCLUDED.observation,
  message = EXCLUDED.message,
  code = EXCLUDED.code,
  attempts = rhinoq_projection_failures.attempts + 1,
  state = CASE WHEN rhinoq_projection_failures.state IN ('replayed','ignored') THEN 'pending' ELSE rhinoq_projection_failures.state END,
  replay_attempts = CASE WHEN rhinoq_projection_failures.state IN ('replayed','ignored') THEN 0 ELSE rhinoq_projection_failures.replay_attempts END,
  claimed_by = CASE WHEN rhinoq_projection_failures.state IN ('replayed','ignored') THEN NULL ELSE rhinoq_projection_failures.claimed_by END,
  claim_expires_at = CASE WHEN rhinoq_projection_failures.state IN ('replayed','ignored') THEN NULL ELSE rhinoq_projection_failures.claim_expires_at END,
  resolved_at = CASE WHEN rhinoq_projection_failures.state IN ('replayed','ignored') THEN NULL ELSE rhinoq_projection_failures.resolved_at END,
  resolution_reason = CASE WHEN rhinoq_projection_failures.state IN ('replayed','ignored') THEN NULL ELSE rhinoq_projection_failures.resolution_reason END,
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
      failure.schemaVersion,
      failure.runtime,
      failure.runtimeScope,
      failure.externalId,
      failure.event,
      failure.observedAt,
      observation,
      failure.message,
      failure.code ?? null,
    ]);
  }
}
