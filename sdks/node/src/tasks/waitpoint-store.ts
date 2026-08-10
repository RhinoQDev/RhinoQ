import type { TaskWaitpoint, TaskWaitpointResolveRequest } from '../gateway/types.js';

export interface TaskWaitpointClient {
  getTaskWaitpoint(taskId: string, waitpointId: string): Promise<TaskWaitpoint>;
  resolveTaskWaitpoint(taskId: string, waitpointId: string, request: TaskWaitpointResolveRequest): Promise<TaskWaitpoint>;
}
export interface TaskWaitpointStoreState { waitpoint?: TaskWaitpoint; loading: boolean; submitting: boolean; error?: unknown }

export class TaskWaitpointStore {
  private state: TaskWaitpointStoreState = { loading: false, submitting: false };
  private readonly listeners = new Set<() => void>();
  constructor(private readonly client: TaskWaitpointClient, private readonly taskId: string, private readonly waitpointId: string) {
    if (!client || !taskId?.trim() || !waitpointId?.trim()) throw new TypeError('waitpoint client, taskId and waitpointId are required');
  }
  readonly getSnapshot = (): TaskWaitpointStoreState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  async refresh(): Promise<TaskWaitpoint> {
    this.publish({ ...this.state, loading: true, error: undefined });
    try { const waitpoint = await this.client.getTaskWaitpoint(this.taskId, this.waitpointId); this.publish({ waitpoint, loading: false, submitting: false }); return waitpoint;
    } catch (error) { this.publish({ ...this.state, loading: false, error }); throw error; }
  }
  async submit(resolution: unknown, resolutionId: string, actor?: string): Promise<TaskWaitpoint> {
    const current = this.state.waitpoint ?? await this.refresh();
    if (current.state !== 'waiting') throw new Error(`waitpoint is ${current.state}`);
    if (!resolutionId?.trim()) throw new TypeError('resolutionId is required');
    this.publish({ ...this.state, submitting: true, error: undefined });
    try { const waitpoint = await this.client.resolveTaskWaitpoint(this.taskId, this.waitpointId, { expectedVersion: current.entityVersion, resolutionId, resolution, ...(actor ? { actor } : {}) }); this.publish({ waitpoint, loading: false, submitting: false }); return waitpoint;
    } catch (error) { this.publish({ ...this.state, submitting: false, error }); throw error; }
  }
  private publish(state: TaskWaitpointStoreState): void { this.state = state; for (const listener of this.listeners) listener(); }
}
