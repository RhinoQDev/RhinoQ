import type { TaskExecutionPage, TaskSnapshot, TaskSummary } from '../gateway/types.js';
import {
  TaskStore,
  type TaskBrowserClient,
  type TaskStoreOptions,
  type TaskStoreState,
} from './store.js';

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
  getResult(): Promise<unknown>;
	listExecutions(cursor?: string, limit?: number): Promise<TaskExecutionPage>;
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
    return {
      ...state,
      refresh: () => store.refresh(),
      cancel: () => store.cancel(),
      getResult: () => store.getResult(),
	  listExecutions: (cursor, limit) => store.listExecutions(cursor, limit),
    };
  };
}
