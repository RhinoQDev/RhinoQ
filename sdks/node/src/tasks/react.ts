import type { TaskExecutionPage, TaskSnapshot, TaskSummary } from '../gateway/types.js';
import {
  TaskStore,
  type TaskBrowserClient,
  type TaskStoreOptions,
  type TaskStoreState,
} from './store.js';
import { TaskListStore, type TaskListClient, type TaskListQuery, type TaskListState } from './list-store.js';
import { taskUIModel, type TaskUIModel } from './ui.js';
import { TaskWaitpointStore, type TaskWaitpointClient, type TaskWaitpointStoreState } from './waitpoint-store.js';
import type { TaskWaitpoint } from '../gateway/types.js';

export interface ReactTaskHooks {
  useEffect(effect: () => (() => void), dependencies: readonly unknown[]): void;
  useMemo<T>(factory: () => T, dependencies: readonly unknown[]): T;
  useSyncExternalStore<T>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ): T;
}

export interface UseRhinoTaskResult extends Readonly<TaskStoreState> {
	refresh(): Promise<TaskSummary | TaskSnapshot>;
  cancel(): Promise<TaskSnapshot>;
  retry(commandId: string): Promise<TaskSnapshot>;
  getResult(): Promise<unknown>;
	downloadResult(open?: (url: string) => unknown): Promise<unknown>;
	listExecutions(cursor?: string, limit?: number): Promise<TaskExecutionPage>;
  ui?: TaskUIModel;
  canCancel: boolean;
  canRetry: boolean;
  attentionReason?: string;
}

export interface UseRhinoTasksResult extends Readonly<TaskListState> {
  refresh(): Promise<TaskSnapshot[]>;
}

export interface UseRhinoTaskInputResult extends Readonly<TaskWaitpointStoreState> {
  refresh(): Promise<TaskWaitpoint>;
  submit(resolution: unknown, resolutionId: string, actor?: string): Promise<TaskWaitpoint>;
  canSubmit: boolean;
  status: 'loading' | 'waiting' | 'submitting' | 'resolved' | 'expired' | 'cancelled' | 'error';
}

export function createUseRhinoTaskInput(react: ReactTaskHooks) {
  return function useRhinoTaskInput(client: TaskWaitpointClient, taskId: string, waitpointId: string): UseRhinoTaskInputResult {
    const store = react.useMemo(() => new TaskWaitpointStore(client, taskId, waitpointId), [client, taskId, waitpointId]);
    react.useEffect(() => { void store.refresh().catch(() => undefined); return () => undefined; }, [store]);
    const state = react.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const status = state.submitting ? 'submitting' : state.loading ? 'loading' : state.error ? 'error' : state.waitpoint?.state ?? 'loading';
    return { ...state, refresh: () => store.refresh(), submit: (value, id, actor) => store.submit(value, id, actor), canSubmit: status === 'waiting', status };
  };
}

/**
 * Creates a React hook without making React a runtime dependency of the core
 * Node/browser package. Pass React's three hooks once in the application.
 */
export function createUseRhinoTask(react: ReactTaskHooks) {
  if (
    !react ||
    typeof react.useEffect !== 'function' ||
    typeof react.useMemo !== 'function' ||
    typeof react.useSyncExternalStore !== 'function'
  ) {
    throw new TypeError('React useEffect, useMemo and useSyncExternalStore are required');
  }
  return function useRhinoTask(
    client: TaskBrowserClient,
    taskId: string,
    options: TaskStoreOptions = {},
  ): UseRhinoTaskResult {
    const store = react.useMemo(
      () => new TaskStore(client, taskId, options),
      [
        client,
        taskId,
        options.pollIntervalMs,
        options.maxBackoffMs,
        options.stopOnTerminal,
        options.pauseWhenHidden,
        options.onListenerError,
        options.preferStream,
      ],
    );
    react.useEffect(() => {
      store.start();
      return () => store.stop();
    }, [store]);
    const state = react.useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getSnapshot,
    );
    const ui = state.snapshot ? taskUIModel(state.snapshot) : undefined;
    return {
      ...state,
      refresh: () => store.refresh(),
      cancel: () => store.cancel(),
      retry: (commandId) => store.retry(commandId),
      getResult: () => store.getResult(),
	  downloadResult: (open) => store.downloadResult(open),
	  listExecutions: (cursor, limit) => store.listExecutions(cursor, limit),
      ...(ui ? { ui } : {}),
      canCancel: ui?.canCancel ?? false,
      canRetry: ui?.canRetry ?? false,
      ...(ui?.attention
        ? { attentionReason: ui.attention.message }
        : {}),
    };
  };
}

/** Explicit live-first alias. It fails over to snapshot polling on transport loss. */
export function createUseRhinoTaskLive(react: ReactTaskHooks) {
  const useTask = createUseRhinoTask(react);
  return (client: TaskBrowserClient, taskId: string, options: TaskStoreOptions = {}) =>
    useTask(client, taskId, { ...options, preferStream: true });
}

/** The inbox store automatically consumes owner-scoped SSE when available. */
export const createUseRhinoTasksLive = createUseRhinoTasks;

/** Polling Task inbox with stale-version convergence and owner-scoped client reads. */
export function createUseRhinoTasks(react: ReactTaskHooks) {
  if (!react || typeof react.useEffect !== 'function' || typeof react.useMemo !== 'function' ||
      typeof react.useSyncExternalStore !== 'function') {
    throw new TypeError('React useEffect, useMemo and useSyncExternalStore are required');
  }
  return function useRhinoTasks(
    client: TaskListClient,
    query: TaskListQuery = {},
    options: { pollIntervalMs?: number } = {},
  ): UseRhinoTasksResult {
    const stateKey = query.states?.join(',') ?? '';
    const typeKey = query.types?.join(',') ?? '';
    const store = react.useMemo(
      () => new TaskListStore(client, query, options.pollIntervalMs),
      [client, stateKey, typeKey, query.limit, query.offset, options.pollIntervalMs],
    );
    react.useEffect(() => { store.start(); return () => store.stop(); }, [store]);
    const state = react.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    return { ...state, refresh: () => store.refresh() };
  };
}
