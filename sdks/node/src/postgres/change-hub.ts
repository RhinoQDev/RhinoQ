import { isValidTenantId } from './tenant.js';

/**
 * One `LISTEN` connection per process, fanned out to every subscriber in memory.
 *
 * Without this, each SSE stream polls the database on its own timer for as long
 * as the browser tab stays open: at the default one-second interval and the
 * default cap of 1000 streams, a fully subscribed process asks PostgreSQL a
 * thousand questions a second and almost every answer is "nothing changed".
 * Database load scaled with the number of people watching, which is exactly
 * backwards — watchers are the cheap part.
 *
 * With it, a committed change announces itself once and reaches every
 * interested subscriber through memory. The database cost of a change is the
 * change, not the audience.
 *
 * **This is a hint, not a fact.** The payload carries identity only, because
 * `NOTIFY` is delivered outside row-level security and anything in it would be
 * readable by every session on the channel. A subscriber learns that a Task
 * moved and must still read it back through the owner-scoped path. Delivery is
 * also best-effort across a disconnect, so a poll remains as a safety net — a
 * long one, because it is no longer the mechanism.
 */

export interface TaskChange {
  readonly taskId: string;
  readonly version: number;
  readonly tenantId: string;
}

/** The bit of `pg.Client` this needs, so tests do not need a database. */
export interface NotificationConnection {
  query(text: string, values?: unknown[]): Promise<unknown>;
  on(event: 'notification', listener: (message: { channel: string; payload?: string }) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'end', listener: () => void): void;
  removeAllListeners?(): void;
  end(): Promise<void> | void;
}

export interface TaskChangeHubOptions {
  /** Opens a dedicated connection. It must not come from the shared pool: LISTEN occupies it for its lifetime. */
  connect(): Promise<NotificationConnection>;
  /** Backoff for the first reconnect attempt. Doubles up to maxReconnectDelayMs. */
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  /** Reported rather than thrown; a hub that cannot listen degrades to polling. */
  onError?(error: Error): void;
}

export const TASK_CHANGE_CHANNEL = 'rhinoq_task_changed';

type Listener = (change: TaskChange) => void;

export class TaskChangeHub {
  private readonly options: Required<Omit<TaskChangeHubOptions, 'onError'>> &
    Pick<TaskChangeHubOptions, 'onError'>;

  private readonly listeners = new Set<Listener>();
  private connection?: NotificationConnection;
  private starting?: Promise<void>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private delayMs: number;
  private stopped = false;

  constructor(options: TaskChangeHubOptions) {
    if (typeof options?.connect !== 'function') {
      throw new TypeError('TaskChangeHub requires a connect() that opens a dedicated connection');
    }
    const reconnectDelayMs = options.reconnectDelayMs ?? 250;
    const maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
    if (!Number.isInteger(reconnectDelayMs) || reconnectDelayMs <= 0) {
      throw new RangeError('reconnectDelayMs must be a positive integer');
    }
    if (maxReconnectDelayMs < reconnectDelayMs) {
      throw new RangeError('maxReconnectDelayMs must be at least reconnectDelayMs');
    }
    this.options = { connect: options.connect, reconnectDelayMs, maxReconnectDelayMs, onError: options.onError };
    this.delayMs = reconnectDelayMs;
  }

  /** True while a live LISTEN connection is held. Subscribers use it to decide how hard to poll. */
  get connected(): boolean {
    return this.connection !== undefined;
  }

  /**
   * Registers a listener and returns its removal function.
   *
   * Subscribing does not open the connection; `start()` does. That keeps a
   * process that never gets a subscriber from holding a connection it does not
   * use.
   */
  subscribe(listener: Listener): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('a change listener is required');
    }
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('TaskChangeHub has been stopped');
    if (this.connection) return;
    this.starting ??= this.open().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const connection = this.connection;
    this.connection = undefined;
    this.listeners.clear();
    if (connection) {
      connection.removeAllListeners?.();
      await Promise.resolve(connection.end()).catch(() => undefined);
    }
  }

  private async open(): Promise<void> {
    const connection = await this.options.connect();
    connection.on('notification', (message) => {
      if (message.channel !== TASK_CHANGE_CHANNEL) return;
      const change = parseChange(message.payload);
      if (!change) return;
      for (const listener of this.listeners) {
        // One bad listener must not stop the others from being told.
        try { listener(change); } catch (error) { this.report(error); }
      }
    });
    connection.on('error', (error) => {
      this.report(error);
      this.dropAndReconnect(connection);
    });
    connection.on('end', () => { this.dropAndReconnect(connection); });

    await connection.query(`LISTEN ${TASK_CHANGE_CHANNEL}`);
    this.connection = connection;
    this.delayMs = this.options.reconnectDelayMs;
  }

  private dropAndReconnect(source: NotificationConnection): void {
    // A late event from a connection that was already replaced must not cancel
    // the healthy one.
    if (this.connection && this.connection !== source) return;
    this.connection = undefined;
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.delayMs;
    this.delayMs = Math.min(this.options.maxReconnectDelayMs, this.delayMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopped) return;
      this.open().catch((error) => {
        this.report(error);
        this.dropAndReconnect(source);
      });
    }, delay);
    // A reconnect timer must not hold a process open by itself.
    this.reconnectTimer.unref?.();
  }

  private report(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

function parseChange(payload: string | undefined): TaskChange | undefined {
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(payload) as Partial<Record<keyof TaskChange, unknown>>;
    const taskId = typeof parsed.taskId === 'string' ? parsed.taskId.trim() : '';
    const version = Number(parsed.version);
    const tenantId = typeof parsed.tenantId === 'string' ? parsed.tenantId.trim() : '';
    // The payload arrives from the database rather than from a user, but it is
    // still parsed input, and a malformed one must be dropped rather than
    // pushed to every subscriber as a partially-filled object.
    if (!taskId || !Number.isFinite(version) || !isValidTenantId(tenantId)) return undefined;
    return { taskId, version, tenantId };
  } catch {
    return undefined;
  }
}
