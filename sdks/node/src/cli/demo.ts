import type {
  TaskExecutionResult,
  TaskExecutionRuntimeRefs,
  TaskExecutionSummary,
  TaskArtifactRecord,
  TaskCheckpoint,
  TaskSnapshot,
  TaskSummary,
  TaskVerificationRecord,
  TaskWaitpoint,
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
    ['demo-approval', createTask({
      id: 'demo-approval', type: 'budget.approval', ownerId: 'demo-user', state: 'pending',
      progress: { completed: 0, total: 1, message: 'Waiting for your approval' },
      executions: [], createdAt: iso(created - 150_000), updatedAt: iso(created - 36_000),
    })],
  ]);
  const results = new Map<string, TaskExecutionResult[]>([
    ['demo-export', []],
    ['demo-complete', [result('demo-complete:attempt:1', 1, 'succeeded', 'demo://result/report-archive.csv', created - 18_000)]],
    ['demo-failed', [
      result('demo-failed:attempt:1', 1, 'failed', undefined, created - 120_000, 'Provider returned a bounded demo 502'),
      result('demo-failed:attempt:2', 2, 'failed', undefined, created - 72_000, 'Retry is available only after review'),
    ]],
    ['demo-approval', []],
  ]);
  const verifications = new Map<string, TaskVerificationRecord[]>([
    ['demo-complete', [{
      schemaVersion: 1, id: 'demo-complete:verification:1', taskId: 'demo-complete', verifier: 'demo.archive.exists',
      status: 'verified', summary: 'The demo result is present and readable.',
      finding: { ruleId: 'demo.archive.exists', subjectType: 'report', subjectId: 'demo-complete', invariantVersion: 3, deepLink: '/rhinoq?task=demo-complete' },
      verifiedAt: iso(created - 17_000), createdAt: iso(created - 17_000),
    }]],
  ]);
  const waitpoints = new Map<string, TaskWaitpoint[]>([
    ['demo-approval', [{
      schemaVersion: 1, entityVersion: 1, id: 'demo-approval:waitpoint:review', taskId: 'demo-approval',
      key: 'review-marketing-budget', kind: 'approval', state: 'waiting', payloadVersion: 1,
      deadline: iso(created + 86_400_000), createdAt: iso(created - 36_000), updatedAt: iso(created - 36_000),
    }]],
    ['demo-confirmation', [{
      schemaVersion: 1, entityVersion: 1, id: 'demo-confirmation:waitpoint:provider', taskId: 'demo-confirmation',
      key: 'provider-readback', kind: 'webhook', state: 'waiting', payloadVersion: 1,
      createdAt: iso(created - 48_000), updatedAt: iso(created - 48_000),
    }]],
  ]);
  const artifacts = new Map<string, TaskArtifactRecord[]>([
    ['demo-complete', [
      { schemaVersion: 1, entityVersion: 1, id: 'demo-complete:artifact:csv', taskId: 'demo-complete', executionId: 'demo-complete:attempt:1', name: 'report-archive.csv', contentType: 'text/csv', sizeBytes: 1842, checksumSha256: 'b9f0d8a44f4497b8e3c82dbe37d4139e82bf4273e778b512bbf1944f051c25c1', expiresAt: iso(created + 3_600_000), lineage: [], reference: 'demo://artifact/report-archive.csv', createdAt: iso(created - 18_000), updatedAt: iso(created - 18_000) },
      { schemaVersion: 1, entityVersion: 1, id: 'demo-complete:artifact:preview', taskId: 'demo-complete', executionId: 'demo-complete:attempt:1', name: 'report-preview.svg', contentType: 'image/svg+xml', sizeBytes: 1260, checksumSha256: '28ac5e4728b16a43b6601d37d78619579c5a8264e173f24cee3396c1c57e7a4b', expiresAt: iso(created + 3_600_000), lineage: ['demo-complete:artifact:csv'], reference: 'demo://artifact/report-preview.svg', createdAt: iso(created - 17_000), updatedAt: iso(created - 17_000) },
    ]],
  ]);
  const checkpoints = new Map<string, TaskCheckpoint[]>([
    ['demo-export', [{ schemaVersion: 1, id: 'demo-export:checkpoint:records', taskId: 'demo-export', executionId: 'demo-export:attempt:1', key: 'records-page', handlerVersion: 4, inputChecksum: '9adf5f3d24d854819afcc8b17be6d16ca4e075972659fec64ce2a4a99db46cd8', state: { offset: 28 }, completed: false, version: 3, createdAt: iso(created - 10_000), updatedAt: iso(created - 2_000) }]],
    ['demo-complete', [{ schemaVersion: 1, id: 'demo-complete:checkpoint:archive', taskId: 'demo-complete', executionId: 'demo-complete:attempt:1', key: 'archive-written', handlerVersion: 2, inputChecksum: '2a7b9eb72f6fd44d2b7d9f80b8f76f28fb86140676f47d4c77690e0f9a91335b', state: { artifactId: 'demo-complete:artifact:csv' }, completed: true, version: 1, createdAt: iso(created - 19_000), updatedAt: iso(created - 18_000) }]],
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
      timer = setInterval(() => advanceDemo(tasks), 2_000);
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
    async listTaskWaitpoints(taskId) { return clone(waitpoints.get(taskId) ?? []); },
    async listTaskWaitpointsForOwner(taskId, ownerId, limit = 100) { ownedTask(taskId, ownerId); return clone(waitpoints.get(taskId) ?? []).slice(0, limit); },
    async listWaitingTaskWaitpointsForOwner(ownerId, limit = 50) {
      return [...waitpoints.entries()].filter(([taskId]) => ownedTask(taskId, ownerId)).flatMap(([, records]) => clone(records)).filter((item) => item.state === 'waiting').slice(0, limit);
    },
    async createTaskWaitpoint() { throw new Error('demo waitpoint creation is unavailable'); },
    async getTaskWaitpoint(id, ownerId) {
      const record = [...waitpoints.values()].flat().find((item) => item.id === id);
      if (!record || !ownerId) throw new Error('demo waitpoint was not found');
      ownedTask(record.taskId, ownerId); return clone(record);
    },
    async resolveTaskWaitpoint(id, ownerId, request) {
      const record = await source.getTaskWaitpoint(id, ownerId);
      if (record.entityVersion !== request.expectedVersion || record.state !== 'waiting') throw new Error('demo waitpoint version conflict');
      const changed: TaskWaitpoint = { ...record, entityVersion: record.entityVersion + 1, state: 'resolved', resolution: request.resolution, resolvedBy: ownerId, resolvedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      waitpoints.set(record.taskId, (waitpoints.get(record.taskId) ?? []).map((item) => item.id === id ? changed : item));
      const task = ownedTask(record.taskId, ownerId);
      const approved = request.resolution === true;
      tasks.set(task.id, { ...task, entityVersion: task.entityVersion + 1, state: approved ? 'queued' : 'cancelled', progress: approved ? { completed: 0, total: 1, message: 'Approved and ready to start' } : { completed: 0, total: 1, message: 'Declined by the requester' }, cancellation: approved ? task.cancellation : { status: 'cancelled', reason: 'The approval was declined.' }, updatedAt: changed.updatedAt });
      return clone(changed);
    },
    async listTaskVerifications(taskId: string) { return [...(verifications.get(taskId) ?? [])]; },
    async listTaskVerificationsForOwner(taskId, ownerId, limit = 50) { ownedTask(taskId, ownerId); return clone(verifications.get(taskId) ?? []).slice(0, limit); },
    async listRecentlyVerifiedForOwner(ownerId, limit = 20) {
      return [...tasks.values()].filter((task) => task.ownerId === ownerId)
        .flatMap((task) => clone(verifications.get(task.id) ?? [])).slice(0, limit);
    },
    async listTaskArtifacts(taskId) { return clone(artifacts.get(taskId) ?? []); },
    async listTaskCheckpoints(taskId, limit = 100) { return clone(checkpoints.get(taskId) ?? []).slice(0, limit); },
    async listTaskArtifactsForOwner(taskId, ownerId, limit = 100) { ownedTask(taskId, ownerId); return clone(artifacts.get(taskId) ?? []).slice(0, limit); },
    async getTaskArtifactForOwner(id, ownerId) {
      const artifact = [...artifacts.values()].flat().find((item) => item.id === id);
      if (!artifact) throw new Error('demo artifact was not found');
      ownedTask(artifact.taskId, ownerId); return clone(artifact);
    },
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
  return { ...rest, executionCounts: counts, itemCounts: countItems(executions) };
}

function countItems(executions: DemoTask['executions']) {
  const latest = new Map<string, DemoTask['executions'][number]>();
  for (const execution of executions) {
    const key = execution.itemKey ?? execution.id;
    const current = latest.get(key);
    if (!current || execution.attempt > current.attempt) latest.set(key, execution);
  }
  const items = [...latest.values()];
  return {
    total: items.length,
    pendingDispatch: items.filter((item) => item.state === 'pending_dispatch').length,
    dispatched: items.filter((item) => item.state === 'dispatched').length,
    running: items.filter((item) => item.state === 'running').length,
    succeeded: items.filter((item) => item.state === 'succeeded').length,
    failed: items.filter((item) => item.state === 'failed').length,
    stalled: items.filter((item) => item.state === 'stalled').length,
    cancelled: items.filter((item) => item.state === 'cancelled').length,
    retries: Math.max(0, executions.length - items.length),
  };
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
  const completed = Math.min(task.progress.total ?? 100, task.progress.completed + 1);
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
