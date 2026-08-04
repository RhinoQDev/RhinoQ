/**
 * A projection that failed, in a shape that can be written down.
 *
 * `onError` is a callback. It fires once, in the process that failed, and if
 * that process is being killed — which is the common case, because the reason
 * the projection failed is often the reason the process is going away — the
 * event is gone. Nothing else knows the job ever happened.
 *
 * This record is deliberately self-contained: everything needed to replay the
 * projection is in it, so a sink can be a table, a file or another queue.
 */
export interface ProjectionFailure {
  /** Wire version of this record. Bump it before changing a field's meaning. */
  schemaVersion: 1;
  /** The queue event that could not be projected. */
  event: 'waiting' | 'active' | 'progress' | 'completed' | 'failed';
  /** External runtime identity, enough to look the job up again. */
  runtime: string;
  runtimeScope: string;
  externalId: string;
  /** The raw observation, as the runtime delivered it. */
  observation: {
    jobId: string;
    attempt?: number;
    data?: unknown;
    returnvalue?: unknown;
    failedReason?: string;
  };
  /** Error message. Never the stack: it is not portable and it leaks paths. */
  message: string;
  /** RhinoQ error code when the failure came from the store. */
  code?: string;
  /** ISO-8601, from the failing process's clock. */
  observedAt: string;
  /** How many times this projection has been recorded as failing. */
  attempts: number;
}

/**
 * Somewhere durable to put a failed projection.
 *
 * RhinoQ does not ship a PostgreSQL implementation of this. The Task-only
 * profile promises exactly three tables and a fourth would break that promise
 * for every adopter, including the ones who will never have a failed
 * projection. The application owns the table, and it should own it: replaying
 * a projection is a business decision, and the row belongs in the same
 * database as whatever the job was doing.
 */
export interface ProjectionFailureSink {
  /**
   * Persists one failure. It must be idempotent on
   * `(runtime, runtimeScope, externalId, event)`: the same projection can fail
   * repeatedly, and a sink that inserts a row each time turns one broken job
   * into an unbounded table.
   */
  record(failure: ProjectionFailure): Promise<void>;
}

/**
 * A sink that keeps failures in memory.
 *
 * Useful in tests and as a shape to copy. It is **not** durable, and it says
 * so rather than letting an application discover that after an incident.
 */
export class InMemoryProjectionFailureSink implements ProjectionFailureSink {
  private readonly failures = new Map<string, ProjectionFailure>();

  async record(failure: ProjectionFailure): Promise<void> {
    const key = projectionFailureKey(failure);
    const existing = this.failures.get(key);
    this.failures.set(key, existing
      ? { ...failure, attempts: existing.attempts + 1 }
      : failure);
  }

  list(): ProjectionFailure[] {
    return [...this.failures.values()].sort((left, right) =>
      projectionFailureKey(left).localeCompare(projectionFailureKey(right)));
  }

  resolve(failure: Pick<ProjectionFailure, 'runtime' | 'runtimeScope' | 'externalId' | 'event'>): boolean {
    return this.failures.delete(projectionFailureKey(failure));
  }

  get size(): number {
    return this.failures.size;
  }
}

/**
 * The idempotency key a durable sink should use as its primary key.
 *
 * The separator is NUL because a runtime scope or an external ID may contain
 * anything a queue accepts. A space or a colon would let two different tuples
 * produce one key, which in a deduplicating sink means one failure silently
 * overwriting another.
 */
export function projectionFailureKey(
  failure: Pick<ProjectionFailure, 'runtime' | 'runtimeScope' | 'externalId' | 'event'>,
): string {
  return [failure.runtime, failure.runtimeScope, failure.externalId, failure.event].join('\u0000');
}

/**
 * Example DDL for an application-owned sink. It is a string rather than a
 * migration this SDK runs, because the table belongs to the application's
 * schema and its retention is the application's decision.
 */
export const PROJECTION_FAILURE_TABLE_SQL = String.raw`
CREATE TABLE IF NOT EXISTS rhinoq_projection_failures (
  runtime text NOT NULL,
  runtime_scope text NOT NULL,
  external_id text NOT NULL,
  event text NOT NULL,
  observation jsonb NOT NULL,
  message text NOT NULL,
  code text,
  attempts integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (runtime, runtime_scope, external_id, event)
);
`;
