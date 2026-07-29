import type { RhinoQClient } from '../gateway/client.js';
import type { TaskSnapshot, TaskState } from '../gateway/types.js';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const TERMINAL_TASK_STATES = new Set<TaskState>([
  'succeeded',
  'failed',
  'cancelled',
]);

export interface TaskWatchOptions {
  /** Delay between completed polls. Defaults to one second. */
  pollIntervalMs?: number;
  /** Stops polling without turning cancellation into an error. */
  signal?: AbortSignal;
  /** Defaults to true. Set false for history views that remain mounted. */
  stopOnTerminal?: boolean;
}

export type TaskPollingClient = Pick<RhinoQClient, 'getTask'>;

/**
 * Polls one durable Task snapshot without overlapping requests. Only a
 * strictly newer aggregate version is yielded, so an older response observed
 * after reconnect cannot replace state the caller has already rendered.
 *
 * Transport and authorization errors are intentionally thrown to the caller;
 * this helper does not hide an outage or invent retry policy.
 */
export async function* watchTask(
  client: TaskPollingClient,
  taskId: string,
  options: TaskWatchOptions = {},
): AsyncGenerator<TaskSnapshot, void, void> {
  if (!client || typeof client.getTask !== 'function') {
    throw new TypeError('Task polling client with getTask() is required');
  }
  if (!taskId?.trim()) {
    throw new TypeError('task id is required');
  }
  const pollIntervalMs = positiveNumber(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    'pollIntervalMs',
  );
  const stopOnTerminal = options.stopOnTerminal ?? true;
  let highestVersion = -1;

  while (!options.signal?.aborted) {
    const snapshot = await client.getTask(taskId);
    if (options.signal?.aborted) {
      return;
    }
    if (snapshot.entityVersion > highestVersion) {
      highestVersion = snapshot.entityVersion;
      yield snapshot;
      if (stopOnTerminal && TERMINAL_TASK_STATES.has(snapshot.state)) {
        return;
      }
    }
    if (!(await wait(pollIntervalMs, options.signal))) {
      return;
    }
  }
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number`);
  }
  return value;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(true), milliseconds);
    const onAbort = () => finish(false);
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
