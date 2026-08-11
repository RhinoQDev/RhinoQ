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
  private session?: LeaseSession;

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
    const session = this.session;
    if (!session) {
      return false;
    }
    try {
      await session.connection.query('SELECT 1', []);
      return true;
    } catch {
      // The session is gone; so is the lock. Drop the connection rather than
      // returning it to the pool, and let acquire() start over honestly.
      this.discard(session);
      return false;
    }
  }

  async acquire(): Promise<boolean> {
    if (this.session) {
      return true;
    }
    const connection = await this.pool.connect() as ObservableSqlConnection;
    const session: LeaseSession = {
      connection,
      discarded: false,
      onError: () => this.discard(session),
    };
    connection.on?.('error', session.onError);
    // Install the session before the first round trip: PostgreSQL may emit the
    // client error event just before the query promise rejects.
    this.session = session;
    try {
      const result = await connection.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS acquired`,
        [`rhinoq:bullmq:projector:${this.scope}`, 7_246_466_201],
      );
      if (result.rows[0]?.acquired !== true) {
        if (this.session === session) this.session = undefined;
        connection.removeListener?.('error', session.onError);
        connection.release();
        return false;
      }
      if (session.discarded || this.session !== session) return false;
      return true;
    } catch (error) {
      this.discard(session);
      throw error;
    }
  }

  async release(): Promise<void> {
    const session = this.session;
    if (!session) {
      return;
    }
    this.session = undefined;
    let failure: unknown;
    try {
      await session.connection.query(
        `SELECT pg_advisory_unlock(hashtextextended($1, $2))`,
        [`rhinoq:bullmq:projector:${this.scope}`, 7_246_466_201],
      );
    } catch (error) {
      failure = error;
    } finally {
      session.connection.removeListener?.('error', session.onError);
      if (!session.discarded) {
        session.discarded = true;
        session.connection.release(failure ? true : undefined);
      }
    }
    if (failure) {
      throw failure;
    }
  }

  /** Consume pg's checked-out-client error event and destroy the dead session. */
  private discard(session: LeaseSession): void {
    if (this.session === session) this.session = undefined;
    if (session.discarded) return;
    session.discarded = true;
    try { session.connection.release(true); } catch { /* ownership is already gone */ }
  }
}

interface ObservableSqlConnection extends SqlConnection {
  on?(event: 'error', listener: (error: unknown) => void): unknown;
  removeListener?(event: 'error', listener: (error: unknown) => void): unknown;
  release(error?: boolean): void;
}

interface LeaseSession {
  connection: ObservableSqlConnection;
  onError: (error: unknown) => void;
  discarded: boolean;
}
