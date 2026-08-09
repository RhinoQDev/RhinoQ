import type { TaskExecutionResult, TaskExecutionSummary, TaskSnapshot } from '../gateway/types.js';

export interface TaskGroupItem {
  itemKey: string; executionId: string; attempt: number; state: string; hasResult: boolean; failureReason?: string;
}
export interface TaskGroupView {
  taskId: string; entityVersion: number; complete: boolean; partialFailure: boolean;
  counts: { total: number; pending: number; running: number; succeeded: number; failed: number; cancelled: number };
  items: TaskGroupItem[];
}
export interface TaskGroupRetryCommand {
  commandId: string; taskId: string; expectedVersion: number;
  sourceExecutionId: string; nextExecutionId: string; item: TaskGroupItem;
}
export interface TaskGroupCancelCommand { commandId: string; taskId: string; item: TaskGroupItem }

export function taskGroupView(task: TaskSnapshot): TaskGroupView {
  const latest = latestItems(task.executions);
  const counts = { total: latest.length, pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
  const items = latest.map(execution => {
    if (execution.state === 'pending_dispatch' || execution.state === 'dispatched') counts.pending++;
    else if (execution.state === 'running') counts.running++;
    else if (execution.state === 'succeeded') counts.succeeded++;
    else if (execution.state === 'failed' || execution.state === 'stalled') counts.failed++;
    else if (execution.state === 'cancelled') counts.cancelled++;
    return { itemKey: execution.itemKey ?? 'default', executionId: execution.id, attempt: execution.attempt, state: execution.state, hasResult: execution.hasResult === true, ...(execution.failureReason ? { failureReason: execution.failureReason } : {}) };
  });
  const complete = counts.total > 0 && counts.pending === 0 && counts.running === 0;
  return { taskId: task.id, entityVersion: task.entityVersion, complete, partialFailure: complete && counts.failed + counts.cancelled > 0 && counts.succeeded > 0, counts, items };
}

export class TaskGroupController {
  constructor(private readonly task: TaskSnapshot, private readonly concurrency = 8) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) throw new RangeError('TaskGroup concurrency must be 1..100');
  }
  view(): TaskGroupView { return taskGroupView(this.task); }
  async retryFailed(commandId: string, retry: (command: TaskGroupRetryCommand) => Promise<TaskSnapshot>): Promise<TaskSnapshot[]> {
    if (!commandId?.trim() || typeof retry !== 'function') throw new TypeError('retryFailed requires commandId and durable retry callback');
    const items = this.view().items.filter(item => item.state === 'failed' || item.state === 'stalled');
    const results: TaskSnapshot[] = []; let expectedVersion = this.task.entityVersion;
    // All children mutate one aggregate version, so carry each committed
    // snapshot forward instead of racing valid retries against one another.
    for (const item of items) {
      const childId = childCommand(commandId, item.itemKey);
      const snapshot = await retry({ commandId: childId, taskId: this.task.id, expectedVersion,
        sourceExecutionId: item.executionId, nextExecutionId: `${item.executionId}.retry.${commandSuffix(childId)}`, item });
      if (!snapshot || snapshot.id !== this.task.id || !Number.isInteger(snapshot.entityVersion) || snapshot.entityVersion <= expectedVersion) {
        throw new Error(`durable retry callback returned an invalid committed snapshot for item ${JSON.stringify(item.itemKey)}`);
      }
      expectedVersion = snapshot.entityVersion; results.push(snapshot);
    }
    return results;
  }
  cancelPending(commandId: string, cancel: (command: TaskGroupCancelCommand) => Promise<unknown>): Promise<unknown[]> {
    if (!commandId?.trim() || typeof cancel !== 'function') throw new TypeError('cancelPending requires commandId and fail-closed cancellation callback');
    const items = this.view().items.filter(item => item.state === 'pending_dispatch' || item.state === 'dispatched');
    return mapBounded(items, this.concurrency, item => cancel({ commandId: childCommand(commandId, item.itemKey), taskId: this.task.id, item }));
  }
}

export function failedTaskItems(task: TaskSnapshot, format: 'json' | 'csv' = 'json'): string {
  const rows = taskGroupView(task).items.filter(item => item.state === 'failed' || item.state === 'stalled');
  if (format === 'json') return JSON.stringify({ schemaVersion: 1, taskId: task.id, entityVersion: task.entityVersion, failed: rows }, null, 2);
  return ['taskId,itemKey,executionId,attempt,state,failureReason', ...rows.map(row => [task.id,row.itemKey,row.executionId,row.attempt,row.state,row.failureReason ?? ''].map(csv).join(','))].join('\r\n');
}

export function taskGroupManifest(task: TaskSnapshot, results: TaskExecutionResult[]) {
  const byExecution = new Map(results.map(result => [result.executionId, result]));
  return { schemaVersion: 1, taskId: task.id, entityVersion: task.entityVersion, partialFailure: taskGroupView(task).partialFailure,
    items: taskGroupView(task).items.map(item => ({ ...item, ...(byExecution.get(item.executionId)?.reference ? { reference: byExecution.get(item.executionId)!.reference } : {}) })) };
}

function latestItems(executions: TaskExecutionSummary[]): TaskExecutionSummary[] {
  const latest = new Map<string, TaskExecutionSummary>();
  for (const execution of executions) { const key = execution.itemKey ?? 'default'; const prior = latest.get(key); if (!prior || execution.attempt > prior.attempt) latest.set(key, execution); }
  return [...latest.values()].sort((a,b) => (a.itemKey ?? '').localeCompare(b.itemKey ?? ''));
}
function childCommand(parent: string, itemKey: string): string {
  // Stable FNV-1a identity is a namespace suffix, not a security digest.
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(itemKey)) { hash ^= BigInt(byte); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
  return `${parent}.${hash.toString(36)}`;
}
function commandSuffix(commandId: string): string { return commandId.slice(commandId.lastIndexOf('.') + 1); }
function csv(value: unknown): string { const text = String(value); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"','""')}"` : text; }
async function mapBounded<T,R>(items: T[], concurrency: number, operation: (item:T)=>Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { for (;;) { const index = next++; if (index >= items.length) return; result[index] = await operation(items[index]!); } }));
  return result;
}
