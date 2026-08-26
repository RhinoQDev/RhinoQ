import type { TaskSnapshot } from '../gateway/types.js';
import type { TaskStreamEvent } from './sse.js';

export interface TaskListClient {
  listTasks(limit?: number, offset?: number): Promise<TaskSnapshot[]>;
  streamTasks?(limit?: number, offset?: number, options?: { signal?: AbortSignal }): AsyncIterable<TaskStreamEvent>;
}

export interface TaskListQuery {
  states?: readonly string[];
  types?: readonly string[];
  limit?: number;
  offset?: number;
}

export interface TaskListState {
  tasks: TaskSnapshot[];
  status: 'idle' | 'loading' | 'connected' | 'reconnecting' | 'stopped';
  error?: unknown;
  transport?: 'polling' | 'live' | 'polling_fallback';
  /** Client-observed time of the newest accepted authoritative page/snapshot. */
  lastAuthoritativeAt?: string;
  /** Consecutive transport reconnects since the last live event. */
  reconnectAttempts?: number;
  /** Client-observed time of the most recent transport failure. */
  lastErrorAt?: string;
}

export class TaskListStore {
  private state: TaskListState = { tasks: [], status: 'idle' };
  private readonly listeners = new Set<(state: Readonly<TaskListState>) => void>();
  private controller?: AbortController;

  constructor(
    private readonly client: TaskListClient,
    private readonly query: TaskListQuery = {},
    private readonly pollIntervalMs = 2_000,
  ) {
    if (!client || typeof client.listTasks !== 'function') throw new TypeError('Task list client is required');
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 250) throw new RangeError('pollIntervalMs must be at least 250');
  }

  getSnapshot = (): Readonly<TaskListState> => this.state;
  subscribe = (listener: (state: Readonly<TaskListState>) => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  start(): void {
    if (this.controller) return;
    this.controller = new AbortController();
    this.set({ ...this.state, status: this.state.tasks.length ? 'connected' : 'loading', error: undefined });
    void this.run(this.controller.signal);
  }

  stop(): void { this.controller?.abort(); this.controller = undefined; this.set({ ...this.state, status: 'stopped' }); }

  async refresh(): Promise<TaskSnapshot[]> {
    const tasks = await this.client.listTasks(this.query.limit ?? 50, this.query.offset ?? 0);
    const page = mergeNewestPage(this.state.tasks, tasks);
    const filtered = page.filter((task) =>
      (!this.query.states?.length || this.query.states.includes(task.state)) &&
      (!this.query.types?.length || this.query.types.includes(task.type)));
    this.set({ ...this.state, tasks: filtered, status: 'connected', error: undefined, lastAuthoritativeAt: new Date().toISOString() });
    return this.state.tasks;
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try { await this.refresh(); failures = 0; this.set({ ...this.state, transport: 'polling' }); }
      catch (error) { failures++; this.set({ ...this.state, status: 'reconnecting', error, reconnectAttempts: failures, lastErrorAt: new Date().toISOString() }); }
      if (!(await delay(Math.min(30_000, this.pollIntervalMs * 2 ** Math.min(failures, 4)), signal))) return;
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    if (!this.client.streamTasks) { await this.poll(signal); return; }
    let failures = 0;
    while (!signal.aborted) {
      try {
        for await (const event of this.client.streamTasks(this.query.limit ?? 50, this.query.offset ?? 0, { signal })) {
          if (signal.aborted) return;
          if (event.type === 'task.error') throw new Error(event.code);
          if (event.type === 'task.page') {
            const tasks = mergeNewestPage([], event.tasks).filter((task) =>
              (!this.query.states?.length || this.query.states.includes(task.state)) &&
              (!this.query.types?.length || this.query.types.includes(task.type)));
            this.set({ tasks, status: 'connected', transport: 'live', error: undefined, lastAuthoritativeAt: new Date().toISOString(), reconnectAttempts: 0 });
            continue;
          }
          if (event.type !== 'task.snapshot' || 'executions' in event.task === false) continue;
          const tasks = mergeNewestSnapshots(this.state.tasks, [event.task as TaskSnapshot]);
          const filtered = tasks.filter((task) =>
            (!this.query.states?.length || this.query.states.includes(task.state)) &&
            (!this.query.types?.length || this.query.types.includes(task.type)));
          this.set({ tasks: filtered, status: 'connected', transport: 'live', error: undefined, lastAuthoritativeAt: new Date().toISOString(), reconnectAttempts: 0 });
        }
        if (signal.aborted) return;
        throw new Error('Task inbox event stream ended');
      } catch (error) {
        if (signal.aborted) return;
        failures++;
        this.set({ ...this.state, status: 'reconnecting', transport: 'polling_fallback', error, reconnectAttempts: failures, lastErrorAt: new Date().toISOString() });
        try { await this.refresh(); this.set({ ...this.state, transport: 'polling_fallback' }); } catch { /* retry stream */ }
        if (!(await delay(Math.min(30_000, this.pollIntervalMs * 2 ** Math.min(failures - 1, 4)), signal))) return;
      }
    }
  }

  private set(state: TaskListState): void { this.state = state; for (const listener of this.listeners) { try { listener(state); } catch { /* UI listeners are not delivery authority. */ } } }
}

function mergeNewestPage(current: TaskSnapshot[], incoming: TaskSnapshot[]): TaskSnapshot[] {
  const previous = new Map(current.map((task) => [task.id, task]));
  const byId = new Map<string, TaskSnapshot>();
  for (const task of incoming) {
    const old = previous.get(task.id);
    if (!old || task.entityVersion >= old.entityVersion) byId.set(task.id, task);
    else byId.set(task.id, old);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** A point update must not evict unrelated Tasks from the authoritative page. */
function mergeNewestSnapshots(current: TaskSnapshot[], incoming: TaskSnapshot[]): TaskSnapshot[] {
  const byId = new Map(current.map((task) => [task.id, task]));
  for (const task of incoming) {
    const old = byId.get(task.id);
    if (!old || task.entityVersion >= old.entityVersion) byId.set(task.id, task);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(true), ms);
    const abort = () => finish(false);
    const finish = (value: boolean) => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(value); };
    signal.addEventListener('abort', abort, { once: true });
  });
}
