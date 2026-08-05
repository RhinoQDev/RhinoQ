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

  /**
   * Reports whether this process still holds the lease.
   *
   * The lock lives in the database session, so losing the session loses the
   * lock — a failover, a restart, a partition or `pg_terminate_backend` all
   * release it server-side while this object still has a connection object in
   * hand. Without this check `acquire()` keeps answering true from that cached
   * field, a second process acquires the lock it was told nobody held, and two
   * projectors run believing each is the only one. That is the situation the
   * lease exists to prevent, and nothing else would report it.
   *
   * A round trip on the held connection is what settles it: the lock cannot
   * outlive the session, so a session that still answers still owns it. This
   * does not read `pg_locks` — the key encoding for advisory locks is awkward
   * to reconstruct portably, and it would only re-prove what liveness already
   * establishes.
   */
  async verify(): Promise<boolean> {
    const connection = this.connection;
    if (!connection) {
      return false;
    }
    try {
      await connection.query('SELECT 1', []);
      return true;
    } catch {
      // The session is gone; so is the lock. Drop the connection rather than
      // returning it to the pool, and let acquire() start over honestly.
      this.connection = undefined;
      try {
        connection.release();
      } catch {
        // A broken connection may refuse release. Ownership is already lost.
      }
      return false;
    }
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
