/**
 * The narrow command surface needed by the waitpoint expiry loop.
 *
 * Expiry is a database-time decision made by `rhinoq_task.expire_waitpoints`.
 * This class only schedules bounded calls to that command and reports how many
 * waitpoints became expired. It does not decide whether an expired waitpoint
 * should notify, retry or fail a Task; that policy belongs to the application.
 */
export interface WaitpointExpirySource {
  expireTaskWaitpoints(limit?: number): Promise<number>;
}

export interface WaitpointExpirySchedulerOptions {
  tasks: WaitpointExpirySource;
  /** Defaults to five minutes; values below one second are rejected. */
  everyMs?: number;
  /** Defaults to 100 and is capped at the database command limit of 500. */
  batchLimit?: number;
  /** Called after a successful sweep when at least one waitpoint expired. */
  onExpired?: (count: number) => void | Promise<void>;
  onError?: (error: unknown) => void;
  /** Injected timers make lifecycle and overlap behavior deterministic in tests. */
  setTimer?: (handler: () => void, ms: number) => { unref?: () => void };
  clearTimer?: (handle: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const MINIMUM_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_LIMIT = 100;
const MAX_BATCH_LIMIT = 500;

export class WaitpointExpiryScheduler {
  private readonly options: WaitpointExpirySchedulerOptions;
  private readonly everyMs: number;
  private readonly batchLimit: number;
  private readonly setTimer: NonNullable<WaitpointExpirySchedulerOptions['setTimer']>;
  private readonly clearTimer: (handle: unknown) => void;
  private handle: unknown;
  private running = false;
  private stopped = false;
  private sweeps = 0;
  private lastExpired = 0;

  constructor(options: WaitpointExpirySchedulerOptions) {
    if (typeof options?.tasks?.expireTaskWaitpoints !== 'function') {
      throw new TypeError('WaitpointExpiryScheduler requires expireTaskWaitpoints');
    }
    this.everyMs = options.everyMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isFinite(this.everyMs) || this.everyMs < MINIMUM_INTERVAL_MS) {
      throw new RangeError(`everyMs must be at least ${MINIMUM_INTERVAL_MS}ms`);
    }
    this.batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
    if (!Number.isInteger(this.batchLimit) || this.batchLimit < 1 || this.batchLimit > MAX_BATCH_LIMIT) {
      throw new RangeError(`batchLimit must be between 1 and ${MAX_BATCH_LIMIT}`);
    }
    this.options = options;
    this.setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));
  }

  /** Schedules the first sweep; it does not touch the database immediately. */
  start(): void {
    if (this.stopped) throw new Error('WaitpointExpiryScheduler.start() after stop()');
    if (this.handle !== undefined) return;
    this.schedule();
  }

  /** Stops future sweeps. A sweep already in progress is allowed to finish. */
  stop(): void {
    this.stopped = true;
    if (this.handle !== undefined) {
      this.clearTimer(this.handle);
      this.handle = undefined;
    }
  }

  get sweepCount(): number { return this.sweeps; }
  get lastExpiredCount(): number { return this.lastExpired; }

  /** Runs one bounded, non-overlapping expiry sweep. */
  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const count = await this.options.tasks.expireTaskWaitpoints(this.batchLimit);
      this.lastExpired = count;
      if (count > 0) await this.options.onExpired?.(count);
      return count;
    } catch (error) {
      this.report(error);
      return 0;
    } finally {
      this.running = false;
      this.sweeps += 1;
    }
  }

  private schedule(): void {
    const timer = this.setTimer(() => {
      this.handle = undefined;
      void this.sweep().finally(() => {
        if (!this.stopped) this.schedule();
      });
    }, this.everyMs);
    timer.unref?.();
    this.handle = timer;
  }

  private report(error: unknown): void {
    try { this.options.onError?.(error); } catch { /* logging must not break the loop */ }
  }
}
