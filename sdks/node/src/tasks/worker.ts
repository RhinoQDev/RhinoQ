import type { TaskProgress } from '../gateway/types.js';
import { TaskHandle } from './handle.js';

/** The small client surface needed by the high-level worker helper. */
export interface TaskWorkerClient {
  openTask(taskId: string): Promise<TaskHandle>;
}

export interface TaskWorkerJob<Input> {
  taskId: string;
  payload: Input;
  /** Optional runtime identity check; the durable Task type is always checked. */
  type?: string;
  signal?: AbortSignal;
  /** Best-effort runtime progress projection; durable Task progress is authoritative. */
  updateProgress?(progress: TaskProgress): Promise<unknown> | unknown;
}

export interface TaskWorkerContext {
  task: TaskHandle;
  signal?: AbortSignal;
  progress(progress: TaskProgress): Promise<void>;
}

export interface CreateTaskWorkerOptions<Input, Output> {
  client: TaskWorkerClient;
  type: string;
  handler(payload: Input, context: TaskWorkerContext): Promise<Output> | Output;
  resultRef?(output: Output): Promise<string | undefined> | string | undefined;
}

/**
 * Creates a lifecycle wrapper for one runtime-selected Task job.
 *
 * The selected runtime still owns claim, lease, heartbeat and retry. This
 * helper only validates the registered Task type, hides version threading,
 * serializes durable progress writes and records the one-attempt outcome.
 */
export function createTaskWorker<Input, Output>(
  options: CreateTaskWorkerOptions<Input, Output>,
): (job: TaskWorkerJob<Input>) => Promise<Output> {
  const client = options?.client;
  const type = required(options?.type, 'Task worker type');
  if (!client || typeof client.openTask !== 'function') {
    throw new TypeError('Task worker client with openTask() is required');
  }
  if (typeof options.handler !== 'function') {
    throw new TypeError('Task worker handler is required');
  }

  return async (job) => {
    const taskId = required(job?.taskId, 'Task worker taskId');
    if (job.type !== undefined && job.type !== type) {
      throw new TypeError(`Task worker refuses type ${JSON.stringify(job.type)}; expected ${JSON.stringify(type)}`);
    }
    job.signal?.throwIfAborted();

    const task = await client.openTask(taskId);
    if (task.snapshot.type !== type) {
      throw new TypeError(`Task worker refuses Task ${JSON.stringify(taskId)} of type ${JSON.stringify(task.snapshot.type)}; expected ${JSON.stringify(type)}`);
    }
    if (task.isTerminal || !['pending', 'queued', 'running'].includes(task.state)) {
      throw new TypeError(`Task worker cannot run Task ${JSON.stringify(taskId)} in state ${JSON.stringify(task.state)}`);
    }

    await task.start();
    let progressTail = Promise.resolve();
    const progress = (value: TaskProgress): Promise<void> => {
      const next = progressTail.then(async () => {
        await task.reportProgress(value);
        await Promise.resolve(job.updateProgress?.(value)).catch(() => undefined);
      });
      progressTail = next;
      return next;
    };

    try {
      const output = await options.handler(job.payload, {
        task,
        signal: job.signal,
        progress,
      });
      await progressTail;
      const resultRef = options.resultRef ? await options.resultRef(output) : undefined;
      await task.complete(resultRef);
      return output;
    } catch (error) {
      await progressTail.catch(() => undefined);
      try {
        if (!task.isTerminal) await task.fail();
      } catch {
        // Preserve the handler/progress error; a concurrent writer may already
        // have settled the Task and that outcome must remain visible to caller.
      }
      throw error;
    }
  };
}

function required(value: string | undefined, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  return value.trim();
}
