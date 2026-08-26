import type {
  TaskExecutionResult,
  TaskExecutionRuntimeRefs,
  TaskExecutionSummary,
  TaskSnapshot,
  TaskSummary,
  TaskVerificationRecord,
} from '../gateway/types.js';
import type { TaskStateQuery } from '../postgres/task-client.js';
import type { OwnerFacingTaskStore } from '../tasks/http.js';
import type { WorkbenchTaskSource } from '../workbench/handler.js';

type DemoTask = TaskSnapshot & { resultReference?: string };

export interface DemoTaskSource extends WorkbenchTaskSource, OwnerFacingTaskStore {
  start(): void;
  stop(): void;
  retryTask(taskId: string): Promise<TaskSnapshot>;
}

/**
 * A deterministic, disposable Task source for the first-value demo.
 *
 * This intentionally lives outside the PostgreSQL profile. It demonstrates
 * the user-visible Task loop without pretending to be runtime or provider
 * evidence. The Workbench still consumes the same Task/Flight Recorder
 * contracts as a real store.
 */
export function createDemoTaskSource(now = new Date()): DemoTaskSource {
  const created = now.getTime();
  const tasks = new Map<string, DemoTask>([
    ['demo-export', createTask({
      id: 'demo-export', type: 'report.export', ownerId: 'demo-user', state: 'running',
      progress: { completed: 28, total: 100, message: 'Đang xử lý bản ghi 28' },
      executions: [execution('demo-export:attempt:1', 'running', 1, 'report-export')],
      createdAt: iso(created - 12_000), updatedAt: iso(created),
    })],
    ['demo-complete', createTask({
      id: 'demo-complete', type: 'report.archive', ownerId: 'demo-user', state: 'succeeded',
      progress: { completed: 100, total: 100, message: 'Đã hoàn tất' }, hasResult: true,
      executions: [execution('demo-complete:attempt:1', 'succeeded', 1, 'report-archive', true)],
      resultReference: 'demo://result/report-archive.csv',
      createdAt: iso(created - 90_000), updatedAt: iso(created - 18_000),
    })],
    ['demo-failed', createTask({
      id: 'demo-failed', type: 'invoice.sync', ownerId: 'demo-user', state: 'failed',
      progress: { completed: 42, total: 50, message: 'Dừng ở bản ghi 42 để minh họa lỗi' },
      executions: [
        execution('demo-failed:attempt:1', 'failed', 1, 'invoice-sync', false, 'Provider returned a bounded demo 502'),
        execution('demo-failed:attempt:2', 'failed', 2, 'invoice-sync', false, 'Retry is available only after review'),
      ],
      createdAt: iso(created - 180_000), updatedAt: iso(created - 72_000),
    })],
    ['demo-confirmation', createTask({
      id: 'demo-confirmation', type: 'provider.publish', ownerId: 'demo-user', state: 'uncertain',
      progress: { completed: 1, total: 1, message: 'The provider accepted the request; final confirmation is still pending' },
      executions: [execution('demo-confirmation:attempt:1', 'succeeded', 1, 'provider-publish', false)],
      createdAt: iso(created - 210_000), updatedAt: iso(created - 48_000),
    })],
  ]);
  const results = new Map<string, TaskExecutionResult[]>([
    ['demo-export', []],
    ['demo-complete', [result('demo-complete:attempt:1', 1, 'succeeded', 'demo://result/report-archive.csv', created - 18_000)]],
    ['demo-failed', [
      result('demo-failed:attempt:1', 1, 'failed', undefined, created - 120_000, 'Provider returned a bounded demo 502'),
      result('demo-failed:attempt:2', 2, 'failed', undefined, created - 72_000, 'Retry is available only after review'),
    ]],
  ]);
  const verifications = new Map<string, TaskVerificationRecord[]>([
    ['demo-complete', [{
      schemaVersion: 1, id: 'demo-complete:verification:1', taskId: 'demo-complete', verifier: 'demo.archive.exists',
      status: 'verified', summary: 'The demo result is present and readable.', verifiedAt: iso(created - 17_000), createdAt: iso(created - 17_000),
    }]],
  ]);
  let timer: ReturnType<typeof setInterval> | undefined;
  const ownedTask = (taskId: string, ownerId: string): DemoTask => {
    const task = tasks.get(taskId);
    if (!task || task.ownerId !== ownerId) throw new Error('demo task was not found');
    return task;
  };

  const source: DemoTaskSource = {
    start() {
      if (timer) return;
      timer = setInterval(() => advanceDemo(tasks), 1_200);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },
    async listTasksByState(query: TaskStateQuery): Promise<TaskSummary[]> {
      const wanted = new Set(query.states);
      return [...tasks.values()]
        .filter((task) => wanted.has(task.state))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, query.limit ?? 100)
        .map(toSummary);
    },
    async listTasks(ownerId, limit = 50, offset = 0) {
      return [...tasks.values()]
        .filter((task) => task.ownerId === ownerId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(offset, offset + limit)
        .map(clone);
    },
    async listTasksPage(ownerId, options = {}) {
      const page = [...tasks.values()]
        .filter((task) => task.ownerId === ownerId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, options.limit ?? 50)
        .map(clone);
      return { schemaVersion: 1, tasks: page };
    },
    async getTask(taskId: string): Promise<TaskSnapshot> {
      const task = tasks.get(taskId);
      if (!task) throw new Error(`demo task ${taskId} was not found`);
      return clone(task);
    },
    async getTaskForOwner(taskId, ownerId) { return clone(ownedTask(taskId, ownerId)); },
    async getTaskSummaryForOwner(taskId, ownerId) { return toSummary(ownedTask(taskId, ownerId)); },
    async listTaskExecutionsForOwner(taskId, ownerId) {
      const task = ownedTask(taskId, ownerId);
      return { schemaVersion: 1, entityVersion: task.entityVersion, taskId, executions: clone(task.executions) };
    },
    async getTaskExecutionResults(taskId: string) {
      return { schemaVersion: 1 as const, entityVersion: tasks.get(taskId)?.entityVersion ?? 1, taskId, executions: [...(results.get(taskId) ?? [])] };
    },
    async getTaskExecutionResultsForOwner(taskId, ownerId) {
      const task = ownedTask(taskId, ownerId);
      return { schemaVersion: 1, entityVersion: task.entityVersion, taskId, executions: clone(results.get(taskId) ?? []) };
    },
    async listTaskExecutionRuntimeRefs(taskId: string): Promise<TaskExecutionRuntimeRefs> {
      const task = tasks.get(taskId);
      return {
        schemaVersion: 1, entityVersion: task?.entityVersion ?? 1, taskId,
        executions: (task?.executions ?? []).map((item) => ({
          executionId: item.id, itemKey: item.itemKey ?? 'default', attempt: item.attempt,
          runtime: item.runtime, runtimeScope: item.runtimeScope, externalId: `demo-job-${item.id}`,
          state: item.state,
        })),
      };
    },
    async listTaskWaitpoints() { return []; },
    async listTaskWaitpointsForOwner(taskId, ownerId) { ownedTask(taskId, ownerId); return []; },
    async listWaitingTaskWaitpointsForOwner() { return []; },
    async createTaskWaitpoint() { throw new Error('demo waitpoint creation is unavailable'); },
    async getTaskWaitpoint() { throw new Error('demo waitpoint was not found'); },
    async resolveTaskWaitpoint() { throw new Error('demo waitpoint resolution is unavailable'); },
    async listTaskVerifications(taskId: string) { return [...(verifications.get(taskId) ?? [])]; },
    async listTaskVerificationsForOwner(taskId, ownerId, limit = 50) { ownedTask(taskId, ownerId); return clone(verifications.get(taskId) ?? []).slice(0, limit); },
    async listRecentlyVerifiedForOwner(ownerId, limit = 20) {
      return [...tasks.values()].filter((task) => task.ownerId === ownerId)
        .flatMap((task) => clone(verifications.get(task.id) ?? [])).slice(0, limit);
    },
    async listTaskArtifacts() { return []; },
    async listTaskArtifactsForOwner(taskId, ownerId) { ownedTask(taskId, ownerId); return []; },
    async getTaskArtifactForOwner() { throw new Error('demo artifact was not found'); },
    async refreshTaskArtifact() { throw new Error('demo artifact refresh is unavailable'); },
    async listProviderOperationsByTask() { return []; },
    async requestTaskCancellation(taskId: string, expectedVersion: number): Promise<TaskSnapshot> {
      const task = tasks.get(taskId);
      if (!task) throw new Error(`demo task ${taskId} was not found`);
      if (task.entityVersion !== expectedVersion) throw new Error('demo task version conflict');
      if (task.state !== 'queued' && task.state !== 'running') return clone(task);
      const updated = clone(task);
      updated.entityVersion += 1;
      updated.state = 'cancelled';
      updated.updatedAt = new Date().toISOString();
      updated.cancellation = { status: 'cancelled', reason: 'Cancelled from the disposable demo.' };
      tasks.set(taskId, updated);
      return clone(updated);
    },
    async requestTaskCancellationForOwner(taskId, ownerId, expectedVersion) {
      ownedTask(taskId, ownerId);
      return source.requestTaskCancellation!(taskId, expectedVersion);
    },
    async retryTask(taskId) {
      const task = tasks.get(taskId);
      if (!task || task.state !== 'failed') throw new Error('only the failed demo Task can be retried');
      const updated: DemoTask = {
        ...task,
        state: 'running',
        entityVersion: task.entityVersion + 1,
        progress: { completed: 0, total: 1, message: 'Retry started with a new recorded attempt' },
        executions: [...task.executions, execution(`${task.id}:attempt:3`, 'running', 3, 'invoice-sync', false)],
        updatedAt: new Date().toISOString(),
      };
      tasks.set(taskId, updated);
      return clone(updated);
    },
    async getTaskResultForOwner(taskId, ownerId) {
      const task = ownedTask(taskId, ownerId);
      if (!task.resultReference) throw new Error('demo Task result was not found');
      return { schemaVersion: 1, entityVersion: task.entityVersion, taskId, reference: task.resultReference, updatedAt: task.updatedAt };
    },
  };
  return source;
}

function createTask(input: Pick<DemoTask, 'id' | 'type' | 'ownerId' | 'state' | 'progress' | 'executions' | 'createdAt' | 'updatedAt'> & Partial<Pick<DemoTask, 'hasResult' | 'resultReference'>>): DemoTask {
  return {
    schemaVersion: 1, entityVersion: 1, id: input.id, type: input.type, ownerId: input.ownerId,
    state: input.state, cancellation: { status: 'none' }, progress: input.progress,
    hasResult: input.hasResult ?? false, executions: input.executions,
    createdAt: input.createdAt, updatedAt: input.updatedAt,
    ...(input.resultReference ? { resultReference: input.resultReference } : {}),
  };
}

function execution(id: string, state: string, attempt: number, itemKey: string, hasResult = false, failureReason?: string): TaskExecutionSummary {
  return {
    id, itemKey, attempt, runtime: 'demo', runtimeScope: 'disposable', state,
    version: attempt, hasResult, ...(failureReason ? { failureReason } : {}),
  };
}

function result(executionId: string, attempt: number, state: string, reference: string | undefined, timestamp: number, failureReason?: string): TaskExecutionResult {
  return { executionId, attempt, state, updatedAt: iso(timestamp), ...(reference ? { reference } : {}), ...(failureReason ? { failureReason } : {}) };
}

function toSummary(task: DemoTask): TaskSummary {
  const { executions, resultReference: _resultReference, ...rest } = clone(task);
  const counts = countExecutions(executions);
  return { ...rest, executionCounts: counts, itemCounts: { ...counts, retries: Math.max(0, executions.length - counts.total) } };
}

function countExecutions(executions: DemoTask['executions']) {
  return {
    total: executions.length, pendingDispatch: executions.filter((item) => item.state === 'pending_dispatch').length,
    dispatched: executions.filter((item) => item.state === 'dispatched').length, running: executions.filter((item) => item.state === 'running').length,
    succeeded: executions.filter((item) => item.state === 'succeeded').length, failed: executions.filter((item) => item.state === 'failed').length,
    stalled: executions.filter((item) => item.state === 'stalled').length, cancelled: executions.filter((item) => item.state === 'cancelled').length,
  };
}

function advanceDemo(tasks: Map<string, DemoTask>): void {
  const task = tasks.get('demo-export');
  if (!task || task.state !== 'running') return;
  const completed = Math.min(task.progress.total ?? 100, task.progress.completed + 7);
  const updated = clone(task);
  updated.entityVersion += 1;
  updated.progress = { completed, total: 100, message: completed >= 100 ? 'Đã hoàn tất và ghi nhận kết quả' : `Đang xử lý bản ghi ${completed}` };
  updated.updatedAt = new Date().toISOString();
  const attempt = updated.executions[0];
  if (!attempt) return;
  if (completed >= 100) {
    updated.state = 'succeeded';
    updated.hasResult = true;
    updated.resultReference = 'demo://result/report-export.csv';
    updated.executions = [{ ...attempt, state: 'succeeded', hasResult: true, version: attempt.version + 1 }];
  }
  tasks.set(updated.id, updated);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function iso(timestamp: number): string { return new Date(timestamp).toISOString(); }
