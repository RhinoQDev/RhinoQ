import type { TaskProgress, TaskSnapshot, TaskState } from '../gateway/types.js';

/**
 * The Task write methods a handle threads a version through. Kept minimal so the
 * handle works with either the embedded PostgreSQL client or the Gateway client.
 */
export interface TaskHandleClient {
  getTask(taskId: string): Promise<TaskSnapshot>;
  transitionTask(taskId: string, expectedTaskVersion: number, state: Exclude<TaskState, 'pending'>): Promise<TaskSnapshot>;
  reportTaskProgress(taskId: string, expectedTaskVersion: number, progress: TaskProgress): Promise<TaskSnapshot>;
  requestTaskCancellation(taskId: string, expectedTaskVersion: number): Promise<TaskSnapshot>;
  attachTaskResult(taskId: string, expectedTaskVersion: number, reference: string): Promise<unknown>;
}

/**
 * A stateful view of one Task that threads `entityVersion` for you.
 *
 * Two frictions this removes, both raised as findings against the low-level
 * client:
 *
 * 1. The happy path exposed too much lifecycle. A worker had to call
 *    `transitionTask(id, v, 'queued')`, then `transitionTask(id, v', 'running')`,
 *    then `reportTaskProgress(id, v'', ...)`, then `transitionTask(...)` — the
 *    mechanics of a state machine spelled out at the call site. `handle.start()`
 *    / `handle.reportProgress()` / `handle.succeed()` say the intent instead.
 *
 * 2. Every write took `expectedTaskVersion` and returned a new snapshot whose
 *    version the caller then had to carry to the next call. The handle holds the
 *    latest snapshot and passes its version for you, so a linear worker never
 *    threads a version by hand.
 *
 * What it deliberately does NOT do is hide optimistic concurrency. When two
 * writers touch the same Task the losing write still raises
 * `RHINOQ_VERSION_CONFLICT` — auto-retrying it here could silently repeat an
 * effect. A handle that lost a race is stale; call `refresh()` and decide. In
 * the common single-writer case (one worker owns one Task's progress) there is
 * no race and the version tracking simply works.
 *
 * The methods return `this`, so a linear flow chains:
 * `await (await client.openTask(id)).start()` then `.reportProgress({...})`.
 */
export class TaskHandle {
  private current: TaskSnapshot;

  constructor(private readonly client: TaskHandleClient, snapshot: TaskSnapshot) {
    if (!client || typeof client.transitionTask !== 'function') {
      throw new TypeError('TaskHandle requires a Task client');
    }
    if (!snapshot?.id) {
      throw new TypeError('TaskHandle requires a Task snapshot');
    }
    this.current = snapshot;
  }

  /** The latest snapshot this handle has observed. */
  get snapshot(): TaskSnapshot { return this.current; }
  get id(): string { return this.current.id; }
  get version(): number { return this.current.entityVersion; }
  get state(): TaskState { return this.current.state; }
  get isTerminal(): boolean {
    return this.current.state === 'succeeded' || this.current.state === 'failed' || this.current.state === 'cancelled';
  }

  /**
   * Moves a freshly created Task to `running`, doing the intermediate `queued`
   * step only if needed. Idempotent from any earlier state on the path.
   */
  async start(): Promise<this> {
    if (this.current.state === 'pending') await this.transitionTo('queued');
    if (this.current.state === 'queued') await this.transitionTo('running');
    return this;
  }

  async transitionTo(state: Exclude<TaskState, 'pending'>): Promise<this> {
    this.current = await this.client.transitionTask(this.id, this.current.entityVersion, state);
    return this;
  }

  async reportProgress(progress: TaskProgress): Promise<this> {
    this.current = await this.client.reportTaskProgress(this.id, this.current.entityVersion, progress);
    return this;
  }

  async succeed(): Promise<this> { return this.transitionTo('succeeded'); }
  async fail(): Promise<this> { return this.transitionTo('failed'); }

  /**
   * Completes a Task in the safe order: start if needed, attach the optional
   * result reference, then transition to succeeded. Each command remains
   * version-fenced; this is a convenience composition, not an atomic claim.
   */
  async complete(resultRef?: string): Promise<this> {
    await this.start();
    if (resultRef !== undefined) await this.attachResult(resultRef);
    if (this.current.state !== 'succeeded') await this.succeed();
    return this;
  }

  async requestCancel(): Promise<this> {
    this.current = await this.client.requestTaskCancellation(this.id, this.current.entityVersion);
    return this;
  }

  /**
   * Attaches a result reference, then refreshes: the result write advances the
   * version, and the handle must not keep a stale one for the next call.
   */
  async attachResult(reference: string): Promise<this> {
    await this.client.attachTaskResult(this.id, this.current.entityVersion, reference);
    return this.refresh();
  }

  /** Re-reads the Task. Use it after a version conflict to resume from truth. */
  async refresh(): Promise<this> {
    this.current = await this.client.getTask(this.id);
    return this;
  }
}
