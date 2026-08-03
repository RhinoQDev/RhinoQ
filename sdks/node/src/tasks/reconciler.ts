import type { TaskSummary } from '../gateway/types.js';
import type { TaskMetrics } from '../observe/metrics.js';
import type { TaskStateQuery } from '../postgres/task-client.js';

/**
 * The narrow query surface a reconciler needs. `PostgresTaskClient` satisfies
 * it; a test can satisfy it with a function.
 */
export interface ReconcilableTaskSource {
  listTasksByState(query: TaskStateQuery): Promise<TaskSummary[]>;
}

export interface TaskReconcilerOptions {
  tasks: ReconcilableTaskSource;
  /**
   * Decides what to do about one stuck Task. RhinoQ does not guess: only the
   * application knows whether a batch that stopped moving three days ago
   * should be failed, retried, or left for a person.
   *
   * A throw is reported through `onError` and the Task stays selected, so the
   * next sweep sees it again.
   */
  reconcile(task: TaskSummary): Promise<void>;
  /** Which Tasks are worth looking at. Defaults to running for over an hour. */
  query?: Partial<TaskStateQuery>;
  /** Sweep interval. Defaults to 5 minutes; must be at least 1 second. */
  everyMs?: number;
  /**
   * Tasks handled per sweep before yielding until the next tick. Defaults to
   * the query limit. A sweep is not a migration: it must not hold the process
   * for the length of the backlog.
   */
  batchLimit?: number;
  metrics?: TaskMetrics;
  onError?: (error: unknown, task?: TaskSummary) => void;
  /** Injected for tests. Defaults to the global timer. */
  setTimer?: (handler: () => void, ms: number) => { unref?: () => void };
  clearTimer?: (handle: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const MINIMUM_INTERVAL_MS = 1_000;

/**
 * Runs a bounded reconciliation sweep on a schedule.
 *
 * `reconcile()` on the BullMQ bridge exists and nothing ever calls it
 * periodically, so a batch that got stuck at `running` — a bridge that died
 * mid-projection, a worker killed between the last item and the aggregate
 * call — stays stuck until a human notices. Three days later it is still
 * `running` and still silent.
 *
 * This is deliberately not a distributed scheduler. It is a timer in one
 * process, and several processes running it is safe but wasteful: each does
 * the same read and calls `reconcile` for the same Tasks, so the callback must
 * be idempotent. Electing one owner is a deployment decision, not something a
 * client library gets to make.
 */
export class TaskReconciler {
  private readonly options: TaskReconcilerOptions;
  private readonly everyMs: number;
  private readonly batchLimit: number;
  private readonly query: TaskStateQuery;
  private readonly setTimer: NonNullable<TaskReconcilerOptions['setTimer']>;
  private readonly clearTimer: (handle: unknown) => void;
  private handle: unknown;
  private running = false;
  private stopped = false;
  private sweeps = 0;

  constructor(options: TaskReconcilerOptions) {
    if (typeof options?.tasks?.listTasksByState !== 'function') {
      throw new TypeError('TaskReconciler requires a task source with listTasksByState');
    }
    if (typeof options.reconcile !== 'function') {
      throw new TypeError('TaskReconciler requires a reconcile callback');
    }
    this.everyMs = options.everyMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isFinite(this.everyMs) || this.everyMs < MINIMUM_INTERVAL_MS) {
      throw new RangeError(`everyMs must be at least ${MINIMUM_INTERVAL_MS}ms`);
    }
    this.query = {
      states: ['running'],
      idleForMs: 60 * 60_000,
      limit: 100,
      ...options.query,
    } as TaskStateQuery;
    this.batchLimit = options.batchLimit ?? this.query.limit ?? 100;
    if (!Number.isInteger(this.batchLimit) || this.batchLimit <= 0) {
      throw new RangeError('batchLimit must be a positive integer');
    }
    this.options = options;
    this.setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));
  }

  /**
   * Schedules the first sweep. It does not run one immediately.
   *
   * Calling it twice is a no-op. Calling it after `stop()` throws: a
   * reconciler that silently does nothing is the worst of the three
   * behaviours, because the symptom is a Task that stays stuck and nothing to
   * read about why.
   */
  start(): void {
    if (this.stopped) {
      throw new Error('TaskReconciler.start() after stop(); construct a new one');
    }
    if (this.handle !== undefined) {
      return;
    }
    this.schedule();
  }

  /** Ends the schedule permanently. A sweep already running is not aborted. */
  stop(): void {
    this.stopped = true;
    if (this.handle !== undefined) {
      this.clearTimer(this.handle);
      this.handle = undefined;
    }
  }

  /** Sweeps completed since construction. Exposed for tests and metrics. */
  get sweepCount(): number {
    return this.sweeps;
  }

  /**
   * Runs one bounded sweep and returns how many Tasks were reconciled.
   *
   * A failing callback does not abort the sweep: one Task that cannot be
   * reconciled must not hide every other stuck Task behind it.
   */
  async sweep(): Promise<number> {
    if (this.running) {
      // A sweep still running when the next tick arrives means the interval is
      // shorter than the work. Overlapping them would multiply the load on a
      // database that is already the reason the sweep is slow.
      this.options.metrics?.increment('rhinoq_reconciler_sweep_skipped_total');
      return 0;
    }
    this.running = true;
    let reconciled = 0;
    try {
      const tasks = await this.options.tasks.listTasksByState({
        ...this.query,
        limit: Math.min(this.batchLimit, this.query.limit ?? this.batchLimit),
      });
      this.options.metrics?.increment('rhinoq_reconciler_task_selected_total', {}, tasks.length);
      for (const task of tasks) {
        try {
          await this.options.reconcile(task);
          reconciled += 1;
          this.options.metrics?.increment('rhinoq_reconciler_task_reconciled_total');
        } catch (error) {
          this.options.metrics?.increment('rhinoq_reconciler_task_failed_total');
          this.options.onError?.(error, task);
        }
      }
    } catch (error) {
      // The read itself failed — the database is unreachable, or the schema is
      // behind. Report and let the next tick try again.
      this.options.metrics?.increment('rhinoq_reconciler_sweep_failed_total');
      this.options.onError?.(error);
    } finally {
      this.running = false;
      this.sweeps += 1;
    }
    return reconciled;
  }

  private schedule(): void {
    const timer = this.setTimer(() => {
      this.handle = undefined;
      void this.sweep().finally(() => {
        if (!this.stopped) {
          this.schedule();
        }
      });
    }, this.everyMs);
    // A reconciler must not be the reason a CLI or a test process refuses to
    // exit. Whoever wants it to hold the process open can say so themselves.
    timer.unref?.();
    this.handle = timer;
  }
}
