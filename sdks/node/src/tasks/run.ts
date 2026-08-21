import type { TaskSnapshot, TaskSummary } from '../gateway/types.js';
import { TaskStore, type TaskBrowserClient, type TaskStoreOptions, type TaskStoreState } from './store.js';

export type TaskRunSnapshot = TaskSummary | TaskSnapshot;

export interface TaskRunWaitOptions {
  /** Stop waiting with an error instead of hanging forever on an unavailable runtime. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface TaskRunHandleOptions extends TaskStoreOptions {
  /** Relative owner-facing URL used by `url()`. Defaults to `/task-center`. */
  taskCenterPath?: string;
}

/**
 * Small owner-facing facade for the common dispatch → observe → act flow.
 *
 * It composes the existing TaskStore rather than creating another polling or
 * state source. `wait()` therefore inherits SSE, polling fallback and stale
 * snapshot protection; `url()` only builds a local owner-surface link and
 * never embeds a credential.
 */
export class TaskRunHandle {
  readonly id: string;
  private readonly store: TaskStore;
  private readonly taskCenterPath: string;

  constructor(client: TaskBrowserClient, taskId: string, options: TaskRunHandleOptions = {}) {
    if (!taskId?.trim()) throw new TypeError('task id is required');
    this.id = taskId;
    this.store = new TaskStore(client, taskId, options);
    this.taskCenterPath = normalizePath(options.taskCenterPath ?? '/task-center');
  }

  get snapshot(): TaskRunSnapshot | undefined { return this.store.getSnapshot().snapshot; }
  get status(): TaskStoreState['status'] { return this.store.getSnapshot().status; }
  get state(): string | undefined { return this.snapshot?.state; }

  start(): this { this.store.start(); return this; }
  stop(): this { this.store.stop(); return this; }
  refresh(): Promise<TaskRunSnapshot> { return this.store.refresh(); }
  cancel(): Promise<TaskSnapshot> { return this.store.cancel(); }
  result(): Promise<unknown> { return this.store.getResult(); }
  downloadResult(open?: (url: string) => unknown): Promise<unknown> { return this.store.downloadResult(open); }
  subscribe(listener: (state: Readonly<TaskStoreState>) => void): () => void { return this.store.subscribe(listener); }

  /** Waits for a terminal snapshot while retaining the live/polling transport. */
  async wait(options: TaskRunWaitOptions = {}): Promise<TaskRunSnapshot> {
    const first = await this.store.refresh();
    if (isTerminal(first.state)) return first;
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('Task wait aborted');
    const timeoutMs = options.timeoutMs === undefined ? undefined : positive(options.timeoutMs, 'timeoutMs');
    return new Promise<TaskRunSnapshot>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = this.store.subscribe((state) => {
        if (state.status === 'reconnecting' && state.error && options.signal?.aborted) {
          finishReject(options.signal.reason ?? state.error);
          return;
        }
        if (state.snapshot && isTerminal(state.snapshot.state)) finishResolve(state.snapshot);
      });
      const onAbort = () => finishReject(options.signal?.reason ?? new Error('Task wait aborted'));
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(() => finishReject(new Error(`Task wait timed out after ${timeoutMs}ms`)), timeoutMs);
      this.store.start();

      function cleanup(): void {
        unsubscribe();
        options.signal?.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
      }
      function finishResolve(value: TaskRunSnapshot): void { cleanup(); resolve(value); }
      function finishReject(error: unknown): void { cleanup(); reject(error); }
    });
  }

  /** Builds a shareable owner-facing route without adding auth/query secrets. */
  url(origin?: string): string {
    const path = `${this.taskCenterPath}/${encodeURIComponent(this.id)}`;
    return origin ? new URL(path, origin).toString() : path;
  }
}

function isTerminal(state: string | undefined): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

function normalizePath(value: string): string {
  const path = value.trim();
  if (!path.startsWith('/') || path.includes('://') || path.includes('?') || path.includes('#')) {
    throw new TypeError('taskCenterPath must be a relative path without query or fragment');
  }
  return path.replace(/\/+$/, '') || '/';
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive number`);
  return value;
}
