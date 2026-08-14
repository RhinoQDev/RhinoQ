import type { TaskCheckpoint, TaskCheckpointSaveRequest } from '../gateway/types.js';

export interface RhinoQTaskCheckpointClient {
  saveTaskCheckpoint(executionId: string, key: string, request: TaskCheckpointSaveRequest): Promise<TaskCheckpoint>;
  getTaskCheckpoint(executionId: string, key: string): Promise<TaskCheckpoint | undefined>;
  deleteTaskCheckpoints(executionId: string): Promise<number>;
}

export interface RhinoQTaskCheckpoint {
  save<T>(key: string, state: T, options: {
    inputChecksum: string;
    completed?: boolean;
    expectedVersion?: number;
  }): Promise<TaskCheckpoint>;
  load<T = unknown>(key: string): Promise<(TaskCheckpoint & { state: T }) | undefined>;
  clear(): Promise<number>;
}

/**
 * Binds one handler execution to the durable checkpoint client. The helper is
 * intentionally narrow: it stores resumable cursor/state only and has no
 * operation for external effects, retries or Task transitions.
 */
export function createRhinoQTaskCheckpoint(
  client: RhinoQTaskCheckpointClient | undefined,
  taskId: string,
  executionId: string,
  handlerVersion: number,
): RhinoQTaskCheckpoint {
  if (!taskId?.trim() || !executionId?.trim()) throw new TypeError('checkpoint taskId and executionId are required');
  if (!Number.isSafeInteger(handlerVersion) || handlerVersion < 1) throw new RangeError('checkpoint handlerVersion must be a positive integer');
  const requireClient = (): RhinoQTaskCheckpointClient => {
    if (!client) throw new TypeError('Task checkpoints require the PostgreSQL Task profile');
    return client;
  };
  return Object.freeze({
    save<T>(key: string, state: T, options: { inputChecksum: string; completed?: boolean; expectedVersion?: number }) {
      return requireClient().saveTaskCheckpoint(executionId, key, {
        taskId,
        handlerVersion,
        inputChecksum: options?.inputChecksum,
        state,
        ...(options?.completed === undefined ? {} : { completed: options.completed }),
        ...(options?.expectedVersion === undefined ? {} : { expectedVersion: options.expectedVersion }),
      });
    },
    async load<T = unknown>(key: string) {
      return await requireClient().getTaskCheckpoint(executionId, key) as (TaskCheckpoint & { state: T }) | undefined;
    },
    clear() { return requireClient().deleteTaskCheckpoints(executionId); },
  });
}

/** Computes a stable checksum for a JSON-compatible input or an explicit byte/string payload. */
export async function sha256RhinoQCheckpointInput(input: unknown): Promise<string> {
  const encoded = typeof input === 'string'
    ? input
    : input instanceof Uint8Array
      ? input
      : JSON.stringify(input);
  if (encoded === undefined) throw new TypeError('checkpoint input must be JSON serializable');
  const bytes = typeof encoded === 'string' ? new TextEncoder().encode(encoded) : encoded;
  const digestBytes = new Uint8Array(bytes.byteLength);
  digestBytes.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', digestBytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
