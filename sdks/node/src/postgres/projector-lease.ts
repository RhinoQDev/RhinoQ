import type { SqlPool, SqlConnection } from './task-schema.js';

/**
 * A PostgreSQL session-level advisory lock used to elect one BullMQ
 * projector for a runtime scope. It adds no table to the Task-only profile;
 * the checked-out connection is the lease, so a lost database session also
 * releases ownership automatically.
 */
export class PostgresProjectorLease {
  private readonly pool: SqlPool;
  private readonly scope: string;
  private connection?: SqlConnection;

  constructor(pool: SqlPool, runtimeScope: string) {
    if (!pool || typeof pool.connect !== 'function') {
      throw new TypeError('PostgresProjectorLease requires a PostgreSQL pool');
    }
    const scope = runtimeScope?.trim();
    if (!scope) {
      throw new TypeError('PostgresProjectorLease requires a runtimeScope');
    }
    this.pool = pool;
    this.scope = scope;
  }

  async acquire(): Promise<boolean> {
    if (this.connection) {
      return true;
    }
    const connection = await this.pool.connect();
    try {
      const result = await connection.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS acquired`,
        [`rhinoq:bullmq:projector:${this.scope}`, 7_246_466_201],
      );
      if (result.rows[0]?.acquired !== true) {
        connection.release();
        return false;
      }
      this.connection = connection;
      return true;
    } catch (error) {
      connection.release();
      throw error;
    }
  }

  async release(): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      return;
    }
    this.connection = undefined;
    let failure: unknown;
    try {
      await connection.query(
        `SELECT pg_advisory_unlock(hashtextextended($1, $2))`,
        [`rhinoq:bullmq:projector:${this.scope}`, 7_246_466_201],
      );
    } catch (error) {
      failure = error;
    } finally {
      connection.release();
    }
    if (failure) {
      throw failure;
    }
  }
}
