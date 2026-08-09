import type { TaskWaitpoint, TaskWaitpointCreateRequest, TaskWaitpointKind } from '../gateway/types.js';

export interface WaitpointLifecycleClient {
  createTaskWaitpoint(taskId: string, request: TaskWaitpointCreateRequest): Promise<TaskWaitpoint>;
}
export type WaitpointOutcome<T> =
  | { status: 'waiting' | 'expired' | 'cancelled'; waitpoint: TaskWaitpoint }
  | { status: 'resolved'; value: T; waitpoint: TaskWaitpoint };
export interface WaitForInputOptions<T> extends TaskWaitpointCreateRequest {
  taskId: string;
  parse?: (resolution: unknown) => T;
}

/**
 * Durable worker checkpoint. Re-enter with the same id/key after redelivery:
 * it returns the committed answer instead of registering a second wait.
 * It deliberately does not keep a worker/lease open while a human responds.
 */
export async function waitForInput<T = unknown>(client: WaitpointLifecycleClient, options: WaitForInputOptions<T>): Promise<WaitpointOutcome<T>> {
  const { taskId, parse, ...request } = options;
  const waitpoint = await client.createTaskWaitpoint(taskId, request);
  if (waitpoint.state !== 'resolved') return { status: waitpoint.state, waitpoint };
  const value = parse ? parse(waitpoint.resolution) : waitpoint.resolution as T;
  return { status: 'resolved', value, waitpoint };
}

export function waitForApproval(client: WaitpointLifecycleClient, options: Omit<WaitForInputOptions<boolean>, 'kind' | 'parse'>): Promise<WaitpointOutcome<boolean>> {
  return waitForInput(client, { ...options, kind: 'approval', parse: value => {
    if (typeof value === 'boolean') return value;
    if (value && typeof value === 'object' && typeof (value as { approved?: unknown }).approved === 'boolean') return (value as { approved: boolean }).approved;
    throw new TypeError('approval resolution must be boolean or { approved: boolean }');
  } });
}

export function waitForWebhook<T = unknown>(client: WaitpointLifecycleClient, options: Omit<WaitForInputOptions<T>, 'kind'>): Promise<WaitpointOutcome<T>> {
  return waitForInput(client, { ...options, kind: 'webhook' as TaskWaitpointKind });
}
