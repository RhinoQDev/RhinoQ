import type { TaskExecutionPage, TaskSnapshot, TaskSummary } from '../gateway/types.js';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const MAX_CANCEL_CONVERGENCE_ATTEMPTS = 3;

export interface TaskBrowserClient {
  getTask(taskId: string): Promise<TaskSnapshot>;
	/** Used for polling when available; avoids shipping every execution. */
	getTaskSummary?(taskId: string): Promise<TaskSummary>;
	listTaskExecutions?(taskId: string, cursor?: string, limit?: number): Promise<TaskExecutionPage>;
  cancelTask(taskId: string, expectedVersion: number): Promise<TaskSnapshot>;
  getTaskResult(taskId: string): Promise<unknown>;
}

export interface TaskStoreState {
	snapshot?: TaskSummary | TaskSnapshot;
  status: 'idle' | 'loading' | 'connected' | 'reconnecting' | 'stopped';
  error?: unknown;
}

export interface TaskStoreOptions {
  pollIntervalMs?: number;
  /** Maximum reconnect delay after transport errors. Defaults to 30 seconds. */
  maxBackoffMs?: number;
  /** Defaults to true. */
  stopOnTerminal?: boolean;
  /** Pause background polling while the browser document is hidden. Defaults to true. */
  pauseWhenHidden?: boolean;
  /** A subscriber error must not stop polling or starve other subscribers. */
  onListenerError?: (error: unknown) => void;
}

export type TaskStoreListener = (state: Readonly<TaskStoreState>) => void;

/**
 * Browser-safe external store for React useSyncExternalStore and equivalent
 * framework adapters. Polls never overlap, stale snapshots never replace a
 * newer aggregate revision, and transient failures retry with bounded backoff.
 */
export class TaskStore {
  private readonly client: TaskBrowserClient;
  private readonly taskId: string;
  private readonly pollIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly stopOnTerminal: boolean;
  private readonly pauseWhenHidden: boolean;
  private readonly onListenerError?: (error: unknown) => void;
  private readonly listeners = new Set<TaskStoreListener>();
  private state: TaskStoreState = { status: 'idle' };
  private controller?: AbortController;
  private generation = 0;

  constructor(client: TaskBrowserClient, taskId: string, options: TaskStoreOptions = {}) {
    if (!client || typeof client.getTask !== 'function') {
      throw new TypeError('Task browser client is required');
    }
    if (!taskId?.trim()) {
      throw new TypeError('task id is required');
    }
    this.client = client;
    this.taskId = taskId;
    this.pollIntervalMs = positive(options.pollIntervalMs ?? 1_000, 'pollIntervalMs');
    this.maxBackoffMs = positive(options.maxBackoffMs ?? 30_000, 'maxBackoffMs');
    this.stopOnTerminal = options.stopOnTerminal ?? true;
    this.pauseWhenHidden = options.pauseWhenHidden ?? true;
    this.onListenerError = options.onListenerError;
  }

  getSnapshot = (): Readonly<TaskStoreState> => this.state;

  subscribe = (listener: TaskStoreListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    if (this.controller) return;
    this.controller = new AbortController();
    const generation = ++this.generation;
    this.setState({ ...this.state, status: this.state.snapshot ? 'connected' : 'loading', error: undefined });
    void this.poll(generation, this.controller.signal);
  }

  stop(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    this.setState({ ...this.state, status: 'stopped' });
  }

	async refresh(): Promise<TaskSummary | TaskSnapshot> {
		const snapshot = await this.readStatus();
    this.accept(snapshot);
    return snapshot;
  }

  async cancel(): Promise<TaskSnapshot> {
    let current = this.state.snapshot ?? await this.refresh();
    let conflict: unknown;
    for (let attempt = 0; attempt < MAX_CANCEL_CONVERGENCE_ATTEMPTS; attempt++) {
      try {
        const snapshot = await this.client.cancelTask(this.taskId, current.entityVersion);
        this.accept(snapshot);
        return snapshot;
      } catch (error) {
        if (!isVersionConflict(error)) throw error;
        conflict = error;
        const refreshed = await this.refresh();
        current = this.state.snapshot &&
          this.state.snapshot.entityVersion > refreshed.entityVersion
          ? this.state.snapshot
          : refreshed;
      }
    }
    throw conflict;
  }

  getResult(): Promise<unknown> {
    return this.client.getTaskResult(this.taskId);
  }

	listExecutions(cursor = '', limit = 100): Promise<TaskExecutionPage> {
		if (!this.client.listTaskExecutions) throw new TypeError('Task client does not support execution pagination');
		return this.client.listTaskExecutions(this.taskId, cursor, limit);
	}

  private async poll(generation: number, signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted && generation === this.generation) {
      if (this.pauseWhenHidden && !(await waitUntilVisible(signal))) return;
      try {
		const snapshot = await this.readStatus();
        if (signal.aborted || generation !== this.generation) return;
        this.accept(snapshot);
        failures = 0;
        if (this.stopOnTerminal && TERMINAL.has(snapshot.state)) {
          this.controller = undefined;
          this.setState({ ...this.state, status: 'stopped' });
          return;
        }
      } catch (error) {
        if (signal.aborted || generation !== this.generation) return;
        failures++;
        this.setState({ ...this.state, status: 'reconnecting', error });
      }
      const delay = failures === 0
        ? this.pollIntervalMs
        : Math.min(this.maxBackoffMs, this.pollIntervalMs * 2 ** Math.min(failures - 1, 10));
      if (!(await wait(delay, signal))) return;
    }
  }

	private readStatus(): Promise<TaskSummary | TaskSnapshot> {
		return this.client.getTaskSummary?.(this.taskId) ?? this.client.getTask(this.taskId);
	}

	private accept(snapshot: TaskSummary | TaskSnapshot): void {
    if (!this.state.snapshot || snapshot.entityVersion > this.state.snapshot.entityVersion) {
      this.setState({ snapshot, status: 'connected', error: undefined });
    } else if (this.state.status === 'reconnecting' || this.state.status === 'loading') {
      this.setState({ ...this.state, status: 'connected', error: undefined });
    }
  }

  private setState(state: TaskStoreState): void {
    this.state = state;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (error) {
        try {
          this.onListenerError?.(error);
        } catch {
          // Application diagnostics must not become Task delivery authority.
        }
      }
    }
  }
}

function isVersionConflict(error: unknown): boolean {
  return !!error && typeof error === 'object' &&
    'code' in error && error.code === 'RHINOQ_VERSION_CONFLICT';
}

function waitUntilVisible(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const finish = (result: boolean) => {
      signal.removeEventListener('abort', onAbort);
      document.removeEventListener('visibilitychange', onVisibility);
      resolve(result);
    };
    const onAbort = () => finish(false);
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') finish(true);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    document.addEventListener('visibilitychange', onVisibility);
  });
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive number`);
  return value;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(true), milliseconds);
    const finish = (result: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
