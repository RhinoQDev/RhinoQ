import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RuntimeDispatchUncertainError,
  createManualRuntimeAdapter,
  createRhinoQ,
} from '../dist/index.js';

const now = '2026-08-12T03:00:00.000Z';
const ref = { runtime: 'manual', scope: 'reports', externalId: 'job-1' };
const taskRequest = { id: 'task-1', type: 'report.export', ownerId: 'owner-1', definitionVersion: 1 };

test('manual adapter drives a Task lifecycle without importing BullMQ', async () => {
  const client = new MemoryTaskClient();
  const adapter = createManualRuntimeAdapter('manual', 'reports');
  const rhino = createRhinoQ({ client, terminalProjection: 'single-execution', adapters: [adapter] });

  await rhino.track({ task: taskRequest, executionId: 'execution-1', itemKey: 'report-1', ref });
  await rhino.start();
  await adapter.emit({ type: 'accepted', ref, occurredAt: now, attempt: 1 });
  await adapter.emit({ type: 'started', ref, occurredAt: now, attempt: 1 });
  await adapter.emit({
    type: 'progressed', ref, occurredAt: now, attempt: 1,
    progress: { completed: 1, total: 2, message: 'rendering' },
  });
  await adapter.emit({ type: 'succeeded', ref, occurredAt: now, attempt: 1, resultRef: 'object://report-1' });

  const task = await client.getTask('task-1');
  assert.equal(task.state, 'succeeded');
  assert.deepEqual(task.progress, { completed: 2, total: 2, message: 'rendering' });
  assert.equal(task.hasResult, true);
  assert.equal((await client.getTaskExecution('execution-1')).state, 'succeeded');
  assert.equal(client.executionResults.get('execution-1'), 'object://report-1');
  assert.equal(client.taskResults.get('task-1'), 'object://report-1');
  await rhino.close();
});

test('producer profile can start without opening a push-event subscription', async () => {
  let subscriptions = 0;
  const adapter = {
    name: 'push', scope: 'reports',
    capabilities: { events: 'push', dispatch: false, inspect: false, cancel: 'unsupported', progress: false, stableAttempts: true },
    async subscribe() { subscriptions++; return { dispose() {} }; },
  };
  const producer = createRhinoQ({ client: new MemoryTaskClient(), terminalProjection: 'single-execution', adapters: [adapter], observeEvents: false });
  await producer.start();
  assert.equal(subscriptions, 0);
  await producer.close();
  const worker = createRhinoQ({ client: new MemoryTaskClient(), terminalProjection: 'single-execution', adapters: [adapter] });
  await worker.start();
  assert.equal(subscriptions, 1);
  await worker.close();
});

test('single-execution success synchronizes default progress before the Task becomes terminal', async () => {
  const client = new MemoryTaskClient();
  const rhino = createRhinoQ({ client, terminalProjection: 'single-execution' });
  await rhino.track({ task: taskRequest, executionId: 'execution-1', ref });
  await rhino.observe({ type: 'succeeded', ref, occurredAt: now, attempt: 1, resultRef: 'object://report-1' });

  const task = await client.getTask('task-1');
  assert.equal(task.state, 'succeeded');
  assert.deepEqual(task.progress, { completed: 1, total: 1 });
  assert.equal(task.hasResult, true);
});

test('events for one runtime reference are serialized in arrival order', async () => {
  const client = new MemoryTaskClient();
  const rhino = createRhinoQ({ client, terminalProjection: 'single-execution' });
  await rhino.track({ task: taskRequest, executionId: 'execution-1', ref });

  await Promise.all([
    rhino.observe({ type: 'started', ref, occurredAt: now, attempt: 1 }),
    rhino.observe({ type: 'succeeded', ref, occurredAt: now, attempt: 1 }),
  ]);

  assert.deepEqual(client.executionTransitions, ['running', 'succeeded']);
  assert.equal((await client.getTask('task-1')).state, 'succeeded');
});

test('an uncertain runtime result fails closed instead of being treated as success', async () => {
  const client = new MemoryTaskClient();
  const rhino = createRhinoQ({ client, terminalProjection: 'single-execution' });
  await rhino.track({ task: taskRequest, executionId: 'execution-1', ref });
  await rhino.observe({ type: 'started', ref, occurredAt: now });
  await rhino.observe({ type: 'uncertain', ref, occurredAt: now, reason: 'result_unknown' });

  assert.equal((await client.getTask('task-1')).state, 'uncertain');
  assert.equal((await client.getTaskExecution('execution-1')).state, 'stalled');
});

test('a later stable attempt opens a new durable Execution', async () => {
  const client = new MemoryTaskClient();
  const rhino = createRhinoQ({ client, terminalProjection: 'single-execution' });
  await rhino.track({ task: taskRequest, executionId: 'execution-1', ref });
  await rhino.observe({ type: 'started', ref, occurredAt: now, attempt: 1 });
  await rhino.observe({ type: 'failed', ref, occurredAt: now, attempt: 1, terminal: false, reason: 'retrying' });
  await rhino.observe({ type: 'started', ref, occurredAt: now, attempt: 2 });

  const current = await client.lookupTaskExecution('manual', 'job-1', 'reports');
  assert.equal(current.id, 'execution-1#2');
  assert.equal(current.attempt, 2);
  assert.equal(current.state, 'running');
  assert.equal((await client.getTask('task-1')).state, 'running');
});

test('generic dispatch refuses an adapter that reports unsupported capability', async () => {
  const client = new MemoryTaskClient();
  const adapter = createManualRuntimeAdapter('manual', 'reports');
  const rhino = createRhinoQ({ client, terminalProjection: 'single-execution', adapters: [adapter] });
  await assert.rejects(
    rhino.dispatch('manual', {
      task: taskRequest, executionId: 'execution-1', runtime: 'manual', scope: 'reports',
      taskId: 'task-1', payload: {}, idempotencyKey: 'report-1',
    }),
    /does not support dispatch/,
  );
});

test('track resumes safely after a process died between reserve and bind', async () => {
  const client = new MemoryTaskClient();
  const rhino = createRhinoQ({ client, terminalProjection: 'single-execution' });
  await rhino.reserve({
    task: taskRequest, executionId: 'execution-1', itemKey: 'report-1',
    runtime: 'manual', scope: 'reports',
  });
  const task = await rhino.track({
    task: taskRequest, executionId: 'execution-1', itemKey: 'report-1', ref,
  });
  assert.equal(task.state, 'queued');
  assert.equal((await client.lookupTaskExecution('manual', 'job-1', 'reports')).id, 'execution-1');
});

test('a committed runtime dispatch with failed binding is uncertain and never retryable', async () => {
  const client = new MemoryTaskClient();
  const originalBind = client.bindTaskExecution.bind(client);
  client.bindTaskExecution = async () => { throw new Error('database unavailable'); };
  let dispatches = 0;
  const adapter = {
    name: 'controlled', scope: 'reports',
    capabilities: {
      events: 'none', dispatch: true, inspect: false, cancel: 'unsupported',
      progress: false, stableAttempts: true,
    },
    async dispatch() {
      dispatches += 1;
      return { ref: { runtime: 'controlled', scope: 'reports', externalId: 'job-committed' } };
    },
  };
  const rhino = createRhinoQ({ client, terminalProjection: 'single-execution', adapters: [adapter] });
  const error = await rhino.dispatch('controlled', {
    task: taskRequest, executionId: 'execution-1', runtime: 'controlled', scope: 'reports',
    taskId: 'task-1', payload: {}, idempotencyKey: 'report-1',
  }).then(() => undefined, (caught) => caught);

  assert.equal(dispatches, 1);
  assert.ok(error instanceof RuntimeDispatchUncertainError);
  assert.equal(error.code, 'RHINOQ_RUNTIME_DISPATCH_UNCERTAIN');
  assert.equal(error.retryable, false);
  assert.equal(error.receipt.ref.externalId, 'job-committed');

  client.bindTaskExecution = originalBind;
  await rhino.bind('execution-1', error.receipt.ref);
  assert.equal((await client.lookupTaskExecution('controlled', 'job-committed', 'reports')).id, 'execution-1');
});

test('generic reconciliation projects inspected unknown and succeeded outcomes', async () => {
  const client = new MemoryTaskClient();
  let observation = { ref, state: 'unknown', terminal: false, observedAt: now, reason: 'event_gap' };
  const adapter = inspectAdapter(() => observation);
  const rhino = createRhinoQ({ client, terminalProjection: 'single-execution', adapters: [adapter] });
  await rhino.track({ task: taskRequest, executionId: 'execution-1', ref });
  await rhino.observe({ type: 'started', ref, occurredAt: now });

  await rhino.reconcile('manual', ref);
  assert.equal((await client.getTask('task-1')).state, 'uncertain');

  observation = { ref, state: 'succeeded', terminal: true, observedAt: now, resultRef: 'report://reconciled' };
  await rhino.reconcile('manual', ref);
  assert.equal((await client.getTask('task-1')).state, 'succeeded');
  assert.equal(client.taskResults.get('task-1'), 'report://reconciled');
});

test('inspection refuses an observation for a different runtime identity', async () => {
  const client = new MemoryTaskClient();
  const adapter = inspectAdapter(() => ({
    ref: { ...ref, externalId: 'other-job' }, state: 'running', terminal: false, observedAt: now,
  }));
  const rhino = createRhinoQ({ client, terminalProjection: 'single-execution', adapters: [adapter] });
  await rhino.track({ task: taskRequest, executionId: 'execution-1', ref });
  await assert.rejects(rhino.reconcile('manual', ref), /different reference/);
});

test('runtime reports expose exact capability gaps and fail-closed health', async () => {
  const client = new MemoryTaskClient();
  const adapter = createManualRuntimeAdapter('manual', 'reports');
  const rhino = createRhinoQ({ client, terminalProjection: 'single-execution', adapters: [adapter] });
  const [report] = await rhino.runtimeReports();
  assert.equal(report.health.status, 'unknown');
  assert.deepEqual(report.guaranteeGaps, [
    'no reconciliation inspection',
    'observe/track only; no controlled dispatch',
    'cancellation unsupported',
  ]);
});

test('unsupported cancel is rejected before mutating the Task', async () => {
  const client = new MemoryTaskClient();
  const adapter = createManualRuntimeAdapter('manual', 'reports');
  const rhino = createRhinoQ({ client, terminalProjection: 'single-execution', adapters: [adapter] });
  await rhino.track({ task: taskRequest, executionId: 'execution-1', ref });
  await assert.rejects(rhino.cancel('task-1', 'manual', ref), /does not support cancel/);
  assert.equal((await client.getTask('task-1')).state, 'queued');
});

test('guarded cancel records cannot-cancel evidence instead of claiming success', async () => {
  const client = new MemoryTaskClient();
  const adapter = {
    ...inspectAdapter(() => ({ ref, state: 'running', terminal: false, observedAt: now })),
    capabilities: {
      events: 'none', dispatch: false, inspect: true, cancel: 'best_effort', progress: false, stableAttempts: true,
    },
    async cancel() { return { status: 'cannot_cancel_safely', reason: 'provider effect may have happened' }; },
  };
  const rhino = createRhinoQ({ client, terminalProjection: 'single-execution', adapters: [adapter] });
  await rhino.track({ task: taskRequest, executionId: 'execution-1', ref });
  await rhino.observe({ type: 'started', ref, occurredAt: now });
  const result = await rhino.cancel('task-1', 'manual', ref);
  assert.equal(result.status, 'cannot_cancel_safely');
  assert.equal((await client.getTask('task-1')).cancellation.status, 'cannot_cancel_safely');
});

test('Shadow Mode binds an unowned runtime event and replays that same event', async () => {
  const client = new MemoryTaskClient();
  const adapter = createManualRuntimeAdapter('manual', 'reports');
  let resolutions = 0;
  const rhino = createRhinoQ({
    client, terminalProjection: 'single-execution', adapters: [adapter],
    resolveUnboundEvent(event) {
      resolutions += 1;
      return { task: taskRequest, executionId: 'execution-shadow', itemKey: 'report-1', ref: event.ref };
    },
  });
  await rhino.start();
  await adapter.emit({ type: 'succeeded', ref, occurredAt: now, resultRef: 'report://shadow' });
  await adapter.emit({ type: 'succeeded', ref, occurredAt: now, resultRef: 'report://shadow' });

  assert.equal(resolutions, 1, 'the durable binding makes a repeated event skip resolution');
  assert.equal((await client.getTask('task-1')).state, 'succeeded');
  assert.equal((await client.lookupTaskExecution('manual', 'job-1', 'reports')).id, 'execution-shadow');
  const report = await rhino.adoptionReport();
  assert.equal(report.observedEvents, 2);
  assert.equal(report.runtimeReferences, 1);
  assert.equal(report.tasksBound, 1);
  assert.equal(report.bindingsCreated, 1);
  assert.equal(report.unboundEvents, 1);
  assert.equal(report.unresolvedEvents, 0);
  assert.deepEqual(report.guaranteeGaps, [
    'no reconciliation inspection',
    'observe/track only; no controlled dispatch',
    'cancellation unsupported',
  ]);
  await rhino.close();
});

test('Shadow Mode reports work it could not identify without inventing a Task', async () => {
  const client = new MemoryTaskClient();
  const rhino = createRhinoQ({
    client, terminalProjection: 'single-execution', resolveUnboundEvent: () => undefined,
  });
  await rhino.observe({ type: 'started', ref, occurredAt: now });
  const report = await rhino.adoptionReport();
  assert.equal(report.unboundEvents, 1);
  assert.equal(report.unresolvedEvents, 1);
  assert.equal(report.checklist.find((item) => item.id === 'runtime_identity').status, 'required');
  assert.match(report.checklist.find((item) => item.id === 'business_verifier').nextAction, /verifier/);
  assert.equal(report.checklist.find((item) => item.id === 'durable_reporting').status, 'required');
  assert.equal(report.tasksBound, 0);
  await assert.rejects(client.getTask('task-1'), /RHINOQ_TASK_NOT_FOUND/);
});

test('Shadow Mode fails closed when resolver identity does not match the event', async () => {
  const client = new MemoryTaskClient();
  const rhino = createRhinoQ({
    client, terminalProjection: 'single-execution',
    resolveUnboundEvent() {
      return {
        task: taskRequest, executionId: 'execution-shadow',
        ref: { ...ref, externalId: 'different-job' },
      };
    },
  });
  await assert.rejects(
    rhino.observe({ type: 'started', ref, occurredAt: now }),
    /different runtime reference/,
  );
  await assert.rejects(client.getTask('task-1'), /RHINOQ_TASK_NOT_FOUND/);
});

test('adoption report counts only measured retry and outcome evidence', async () => {
  const client = new MemoryTaskClient();
  const rhino = createRhinoQ({ client, terminalProjection: 'single-execution' });
  await rhino.track({ task: taskRequest, executionId: 'execution-1', ref });
  await rhino.observe({ type: 'started', ref, occurredAt: now, attempt: 1 });
  await rhino.observe({ type: 'failed', ref, occurredAt: now, attempt: 1, terminal: false, reason: 'retrying' });
  await rhino.observe({ type: 'started', ref, occurredAt: now, attempt: 2 });
  await rhino.observe({ type: 'uncertain', ref, occurredAt: now, attempt: 2, reason: 'result_unknown' });
  const report = await rhino.adoptionReport();
  assert.equal(report.retryAttemptsObserved, 1);
  assert.equal(report.uncertainOutcomes, 1);
  assert.equal(report.terminalFailures, 0);
  assert.equal(report.observedEvents, 4);
});

class MemoryTaskClient {
  tasks = new Map();
  executions = new Map();
  executionResults = new Map();
  taskResults = new Map();
  executionTransitions = [];

  async createTask(request) {
    const task = {
      schemaVersion: 1, entityVersion: 1, id: request.id, type: request.type,
      ownerId: request.ownerId, state: 'pending', cancellation: { status: 'none' },
      progress: { completed: 0 }, hasResult: false, executions: [],
      createdAt: now, updatedAt: now,
    };
    this.tasks.set(task.id, task);
    return structuredClone(task);
  }
  async getTask(id) {
    const task = this.tasks.get(id);
    if (!task) throw coded('RHINOQ_TASK_NOT_FOUND');
    return this.snapshot(task);
  }
  async createTaskExecution(taskId, request) {
    if (this.executions.has(request.id)) throw coded('RHINOQ_EXECUTION_ALREADY_EXISTS');
    const execution = {
      id: request.id, taskId, itemKey: request.itemKey, attempt: 1, runtime: request.runtime,
      runtimeScope: request.runtimeScope, externalId: request.externalId,
      state: request.externalId ? 'dispatched' : 'pending_dispatch', version: 1,
    };
    this.executions.set(execution.id, execution);
    this.bump(taskId);
    return this.getTask(taskId);
  }
  async bindTaskExecution(id, binding) {
    const execution = this.mustExecution(id);
    execution.runtime = binding.runtime;
    execution.runtimeScope = binding.runtimeScope;
    execution.externalId = binding.externalId ?? binding.jobId;
    execution.state = 'dispatched'; execution.version += 1;
    this.bump(execution.taskId);
    return this.getTask(execution.taskId);
  }
  async lookupTaskExecution(runtime, externalId, scope = '') {
    const execution = [...this.executions.values()].find((candidate) =>
      candidate.runtime === runtime && candidate.runtimeScope === scope &&
      candidate.externalId === externalId && !candidate.superseded);
    if (!execution) throw coded('RHINOQ_EXECUTION_NOT_FOUND');
    return structuredClone(execution);
  }
  async getTaskExecution(id) { return structuredClone(this.mustExecution(id)); }
  async transitionTaskExecution(id, expectedVersion, state, reason) {
    const execution = this.mustExecution(id);
    if (execution.version !== expectedVersion) throw coded('RHINOQ_VERSION_CONFLICT');
    execution.state = state; execution.reason = reason; execution.version += 1;
    this.executionTransitions.push(state);
    this.bump(execution.taskId);
    return this.getTask(execution.taskId);
  }
  async retryTaskExecution(id, expectedVersion, nextId) {
    const previous = this.mustExecution(id);
    if (previous.version !== expectedVersion) throw coded('RHINOQ_VERSION_CONFLICT');
    previous.superseded = true;
    this.executions.set(nextId, {
      ...previous, id: nextId, attempt: previous.attempt + 1, state: 'dispatched', version: 1,
      superseded: false,
    });
    this.bump(previous.taskId);
    return this.getTask(previous.taskId);
  }
  async transitionTask(id, expectedVersion, state) {
    const task = this.mustTask(id);
    if (task.entityVersion !== expectedVersion) throw coded('RHINOQ_VERSION_CONFLICT');
    task.state = state; task.entityVersion += 1;
    return this.getTask(id);
  }
  async reportTaskProgress(id, expectedVersion, progress) {
    const task = this.mustTask(id);
    if (task.entityVersion !== expectedVersion) throw coded('RHINOQ_VERSION_CONFLICT');
    task.progress = structuredClone(progress); task.entityVersion += 1;
    return this.getTask(id);
  }
  async attachTaskExecutionResult(id, expectedVersion, reference) {
    const execution = this.mustExecution(id);
    if (execution.version !== expectedVersion) throw coded('RHINOQ_VERSION_CONFLICT');
    execution.version += 1; this.executionResults.set(id, reference); this.bump(execution.taskId);
    return this.getTask(execution.taskId);
  }
  async attachTaskResult(id, expectedVersion, reference) {
    const task = this.mustTask(id);
    if (task.entityVersion !== expectedVersion) throw coded('RHINOQ_VERSION_CONFLICT');
    task.hasResult = true; task.entityVersion += 1; this.taskResults.set(id, reference);
    return { schemaVersion: 1, entityVersion: task.entityVersion, taskId: id, reference, updatedAt: now };
  }
  async requestTaskCancellation(id, expectedVersion) {
    const task = this.mustTask(id);
    if (task.entityVersion !== expectedVersion) throw coded('RHINOQ_VERSION_CONFLICT');
    task.state = 'cancel_requested'; task.cancellation = { status: 'requested' }; task.entityVersion += 1;
    return this.getTask(id);
  }
  async resolveTaskCancellation(id, expectedVersion, status, reason) {
    const task = this.mustTask(id);
    if (task.entityVersion !== expectedVersion) throw coded('RHINOQ_VERSION_CONFLICT');
    task.cancellation = { status, ...(reason ? { reason } : {}) }; task.entityVersion += 1;
    return this.getTask(id);
  }
  snapshot(task) {
    return structuredClone({
      ...task,
      executions: [...this.executions.values()].filter((execution) => execution.taskId === task.id)
        .map((execution) => ({ ...execution })),
    });
  }
  bump(taskId) { this.mustTask(taskId).entityVersion += 1; }
  mustTask(id) { const value = this.tasks.get(id); if (!value) throw coded('RHINOQ_TASK_NOT_FOUND'); return value; }
  mustExecution(id) { const value = this.executions.get(id); if (!value) throw coded('RHINOQ_EXECUTION_NOT_FOUND'); return value; }
}

function coded(code) { return Object.assign(new Error(code), { code }); }

function inspectAdapter(inspect) {
  return {
    name: 'manual', scope: 'reports', inspect,
    capabilities: {
      events: 'none', dispatch: false, inspect: true, cancel: 'unsupported', progress: false, stableAttempts: true,
    },
  };
}
