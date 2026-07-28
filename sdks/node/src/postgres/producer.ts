import type { JobClass } from '../gateway/types.js';

export interface SqlQueryResult<Row> {
  rows: Row[];
}

/**
 * Minimal shape implemented by `pg.Pool` and `pg.PoolClient`. Wrapping another
 * driver in this interface keeps RhinoQ from owning the application's pool.
 */
export interface SqlExecutor {
  query<Row = Record<string, unknown>>(
    text: string,
    values: unknown[],
  ): Promise<SqlQueryResult<Row>>;
}

export interface PostgresProducerOptions {
  /** Local fail-fast ceiling; PostgreSQL still enforces each allowlist limit. */
  maxPayloadBytes?: number;
}

export interface PostgresEnqueueRequest<T = unknown> {
  /**
   * jobName is the handler contract. The execution lane is NOT sent: it comes
   * from rhinoq.job_allowlist, so a producer cannot place its work into a lane
   * that was not granted to it.
   */
  jobName: string;
  payload: T;
  idempotencyKey?: string;
  correlationId?: string;
  priority?: number;
  resourceClass?: JobClass;
  groupKey?: string;
  runAfterMs?: number;
  payloadSchema?: string;
}

export const ENQUEUE_SQL = `
SELECT rhinoq.enqueue(
  job_name        => $1,
  payload         => $2::jsonb,
  idempotency_key => $3,
  correlation_id  => $4,
  priority        => $5,
  job_class       => $6,
  run_after       => ($7::bigint * interval '1 millisecond'),
  payload_schema  => $8,
  group_key       => $9
) AS job_id`;

/**
 * Producer-only integration. Pass a `pg.Pool` for ordinary enqueue or the
 * current `pg.PoolClient` to commit a business write and its job atomically.
 */
export class PostgresProducer {
  private readonly executor: SqlExecutor;
  private readonly maxPayloadBytes: number;

  constructor(executor: SqlExecutor, options: PostgresProducerOptions = {}) {
    if (!executor || typeof executor.query !== 'function') {
      throw new TypeError('a PostgreSQL query executor is required');
    }
    const limit = options.maxPayloadBytes ?? 1_048_576;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError('maxPayloadBytes must be a positive integer');
    }
    this.executor = executor;
    this.maxPayloadBytes = limit;
  }

  async enqueue<T>(request: PostgresEnqueueRequest<T>): Promise<string> {
    validateRequest(request);
    const payload = serializePayload(request.payload);
    const payloadBytes = new TextEncoder().encode(payload).byteLength;
    if (payloadBytes > this.maxPayloadBytes) {
      throw new RangeError(
        `payload is ${payloadBytes} bytes and exceeds the local ${this.maxPayloadBytes} byte limit`,
      );
    }
    const result = await this.executor.query<{ job_id: string }>(ENQUEUE_SQL, [
      request.jobName,
      payload,
      request.idempotencyKey ?? null,
      request.correlationId ?? null,
      request.priority ?? null,
      request.resourceClass ?? null,
      request.runAfterMs ?? null,
      request.payloadSchema ?? null,
      request.groupKey ?? null,
    ]);
    const jobId = result.rows[0]?.job_id;
    if (!jobId) {
      throw new Error('rhinoq.enqueue() returned no job id');
    }
    return jobId;
  }
}

function validateRequest(request: PostgresEnqueueRequest): void {
  if (!request || !request.jobName) {
    throw new TypeError('jobName is required');
  }
  if (request.priority !== undefined && (!Number.isInteger(request.priority) || request.priority < -100 || request.priority > 100)) {
    throw new RangeError('priority must be an integer between -100 and 100');
  }
  if (request.runAfterMs !== undefined && (!Number.isFinite(request.runAfterMs) || request.runAfterMs < 0)) {
    throw new RangeError('runAfterMs must be zero or positive');
  }
}

function serializePayload(payload: unknown): string {
  try {
    const encoded = JSON.stringify(payload === undefined ? {} : payload);
    if (encoded === undefined) {
      throw new TypeError('JSON.stringify returned undefined');
    }
    return encoded;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TypeError(`payload must be JSON serializable: ${message}`);
  }
}
