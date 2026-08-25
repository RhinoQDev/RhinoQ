import type { TaskCreateRequest, TaskSnapshot } from '../gateway/types.js';
import type { TaskClient } from '../tasks/client.js';
import type {
  CancelResult, DispatchCommand, Disposable, RuntimeAdapter, RuntimeAdapterReport,
  RuntimeEvent, RuntimeEventSink, RuntimeObservation, RuntimeRef,
} from './contracts.js';
import {
  validateRuntimeAdapter, validateRuntimeEvent, validateRuntimeObservation, validateRuntimeRef,
} from './contracts.js';
import { RuntimeTaskProjector, type RuntimeTaskProjectorOptions } from './projector.js';
import {
  adoptionEventFromRuntime,
  type AdoptionReportStore,
  type DurableAdoptionReport,
} from './adoption.js';

export interface RuntimeTaskBinding {
  task: TaskCreateRequest;
  executionId: string;
  itemKey?: string;
  ref: RuntimeRef;
}

export interface RuntimeTaskReservation {
  task: TaskCreateRequest;
  executionId: string;
  itemKey?: string;
  runtime: string;
  scope: string;
}

export interface CreateRhinoQOptions extends RuntimeTaskProjectorOptions {
  adapters?: RuntimeAdapter[];
  /** Durable append-only adoption facts shared by every replica. */
  adoptionStore?: AdoptionReportStore;
  /** Stable process/deployment identity used to count participating replicas. */
  adoptionReplicaId?: string;
  /** Observe-only mapping for runtime work that was not reserved through RhinoQ. */
  resolveUnboundEvent?(event: RuntimeEvent): Promise<RuntimeTaskBinding | undefined> | RuntimeTaskBinding | undefined;
  /** Producer/API/operator profiles disable unsolicited event subscriptions. */
  observeEvents?: boolean;
}

export interface ShadowAdoptionReport {
  schemaVersion: 1;
  mode: 'observe';
  startedAt: string;
  generatedAt: string;
  observedEvents: number;
  runtimeReferences: number;
  tasksBound: number;
  bindingsCreated: number;
  unboundEvents: number;
  unresolvedEvents: number;
  uncertainOutcomes: number;
  terminalFailures: number;
  retryAttemptsObserved: number;
  guaranteeGaps: string[];
  /** Number of distinct replicas that contributed durable facts, when enabled. */
  replicas?: number;
  checklist: AdoptionChecklistItem[];
}

export interface AdoptionChecklistItem {
  id: 'runtime_identity' | 'owner_identity' | 'tenant_identity' | 'result_resolver' |
    'business_verifier' | 'cancellation' | 'reconciliation' | 'durable_reporting';
  status: 'observed' | 'configured' | 'required' | 'unsupported';
  guarantee: string;
  nextAction?: string;
}

export interface RhinoQRuntimeIntegration extends RuntimeEventSink {
  readonly projector: RuntimeTaskProjector;
  observe(event: RuntimeEvent): Promise<void>;
  track(binding: RuntimeTaskBinding): Promise<TaskSnapshot>;
  reserve(input: RuntimeTaskReservation): Promise<TaskSnapshot>;
  bind(executionId: string, ref: RuntimeRef): Promise<TaskSnapshot>;
  dispatch(adapterName: string, command: DispatchCommand & RuntimeTaskReservation): Promise<TaskSnapshot>;
  dispatchMany(adapterName: string, commands: Array<DispatchCommand & RuntimeTaskReservation>): Promise<TaskSnapshot[]>;
  reconcile(adapterName: string, ref: RuntimeRef): Promise<RuntimeObservation>;
  cancel(taskId: string, adapterName: string, ref: RuntimeRef): Promise<CancelResult>;
  runtimeReports(): Promise<RuntimeAdapterReport[]>;
  adoptionReport(): Promise<ShadowAdoptionReport>;
  start(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Dispatch reached the runtime but its durable binding did not commit. Retrying
 * dispatch is unsafe; reconcile the receipt and repeat bind instead.
 */
export class RuntimeDispatchUncertainError extends Error {
  readonly code = 'RHINOQ_RUNTIME_DISPATCH_UNCERTAIN';
  readonly retryable = false;

  constructor(
    readonly executionId: string,
    readonly receipt: { ref: RuntimeRef },
    options: { cause: unknown },
  ) {
    super(
      `Runtime dispatch returned ${JSON.stringify(receipt.ref)} but Execution ` +
        `${JSON.stringify(executionId)} could not be bound; do not dispatch again, reconcile and bind the receipt`,
      options,
    );
    this.name = 'RuntimeDispatchUncertainError';
  }
}

export function createRhinoQ(options: CreateRhinoQOptions): RhinoQRuntimeIntegration {
  if (!options?.client) throw new TypeError('createRhinoQ requires a Task client');
  const adapters = new Map<string, RuntimeAdapter>();
  for (const adapter of options.adapters ?? []) {
    validateRuntimeAdapter(adapter);
    if (adapters.has(adapter.name)) throw new TypeError(`duplicate runtime adapter ${JSON.stringify(adapter.name)}`);
    adapters.set(adapter.name, adapter);
  }
  const startedAt = new Date().toISOString();
  const observedRefs = new Set<string>();
  const boundTasks = new Set<string>();
  const retryAttempts = new Set<string>();
  const adoptionStore = options.adoptionStore;
  const adoptionReplicaId = options.adoptionReplicaId?.trim() || undefined;
  let observedEvents = 0;
  let bindingsCreated = 0;
  let unboundEvents = 0;
  let unresolvedEvents = 0;
  let uncertainOutcomes = 0;
  let terminalFailures = 0;
  const projector = new RuntimeTaskProjector({
    ...options,
    async onUnboundEvent(event) {
      unboundEvents += 1;
      if (adoptionStore) {
        await adoptionStore.append({
          ...adoptionEventFromRuntime(event),
          eventId: `unbound:${adoptionReplicaId ?? 'local'}:${runtimeRefIdentity(event.ref)}:${event.eventId ?? event.occurredAt}`.slice(0, 512),
          kind: 'unbound',
          ...(adoptionReplicaId ? { replicaId: adoptionReplicaId } : {}),
        });
      }
      const binding = await options.resolveUnboundEvent?.(event);
      if (binding) {
        if (runtimeRefIdentity(binding.ref) !== runtimeRefIdentity(event.ref)) {
          throw new TypeError('Shadow Mode resolver returned a binding for a different runtime reference');
        }
        await track(options.client, binding);
        boundTasks.add(binding.task.id);
        bindingsCreated += 1;
        if (adoptionStore) {
          await adoptionStore.append({
            ...adoptionEventFromRuntime(event),
            eventId: `binding:${adoptionReplicaId ?? 'local'}:${runtimeRefIdentity(event.ref)}:${binding.task.id}`.slice(0, 512),
            kind: 'binding_created', taskId: binding.task.id,
            ...(adoptionReplicaId ? { replicaId: adoptionReplicaId } : {}),
          });
        }
      } else {
        unresolvedEvents += 1;
        if (adoptionStore) {
          await adoptionStore.append({
            ...adoptionEventFromRuntime(event),
            eventId: `unresolved:${adoptionReplicaId ?? 'local'}:${runtimeRefIdentity(event.ref)}:${event.eventId ?? event.occurredAt}`.slice(0, 512),
            kind: 'unresolved',
            ...(adoptionReplicaId ? { replicaId: adoptionReplicaId } : {}),
          });
        }
      }
      await options.onUnboundEvent?.(event);
    },
  });
  const subscriptions: Disposable[] = [];
  let started = false;

  const integration: RhinoQRuntimeIntegration = {
    projector,
    observe(event) {
      validateRuntimeEvent(event);
      observedEvents += 1;
      const identity = runtimeRefIdentity(event.ref);
      observedRefs.add(identity);
      if (event.attempt !== undefined && event.attempt > 1) retryAttempts.add(`${identity}:${event.attempt}`);
      if (event.type === 'uncertain') uncertainOutcomes += 1;
      if (event.type === 'failed' && event.terminal) terminalFailures += 1;
      const persist = adoptionStore
        ? adoptionStore.append({
            ...adoptionEventFromRuntime(event),
            ...(adoptionReplicaId ? { replicaId: adoptionReplicaId } : {}),
          })
        : Promise.resolve();
      return persist.then(() => projector.project(event));
    },
    async track(binding) {
      const result = await track(options.client, binding);
      boundTasks.add(binding.task.id);
      if (adoptionStore) {
        await adoptionStore.append({
          eventId: `bound:${adoptionReplicaId ?? 'local'}:${runtimeRefIdentity(binding.ref)}:${binding.task.id}`.slice(0, 512),
          kind: 'bound', runtime: binding.ref.runtime, scope: binding.ref.scope,
          externalId: binding.ref.externalId, occurredAt: new Date().toISOString(),
          taskId: binding.task.id,
          ...(adoptionReplicaId ? { replicaId: adoptionReplicaId } : {}),
        });
      }
      return result;
    },
    async reserve(input) {
      const result = await reserve(options.client, input);
      boundTasks.add(input.task.id);
      return result;
    },
    bind(executionId, ref) { return bind(options.client, executionId, ref); },
    async dispatch(adapterName, command) {
      const adapter = adapters.get(adapterName);
      if (!adapter) throw new TypeError(`unknown runtime adapter ${JSON.stringify(adapterName)}`);
      if (!adapter.capabilities.dispatch || !adapter.dispatch) {
        throw new TypeError(`runtime adapter ${JSON.stringify(adapterName)} does not support dispatch`);
      }
      if (command.delayMs !== undefined && !adapter.capabilities.dispatchPolicies?.delay) {
        throw new TypeError(`runtime adapter ${JSON.stringify(adapterName)} does not support delayed dispatch`);
      }
      if (command.priority !== undefined && !adapter.capabilities.dispatchPolicies?.priority) {
        throw new TypeError(`runtime adapter ${JSON.stringify(adapterName)} does not support priority dispatch`);
      }
      await reserve(options.client, command);
      const receipt = await adapter.dispatch(command);
      validateRuntimeRef(receipt.ref);
      if (receipt.ref.runtime !== command.runtime || receipt.ref.scope !== command.scope) {
        throw new TypeError('runtime dispatch receipt does not match the reserved runtime and scope');
      }
      try {
        return await bind(options.client, command.executionId, receipt.ref);
      } catch (error) {
        throw new RuntimeDispatchUncertainError(command.executionId, receipt, { cause: error });
      }
    },
    async dispatchMany(adapterName, commands) {
      if (!Array.isArray(commands) || commands.length === 0) throw new RangeError('runtime batch requires at least one command');
      const adapter = adapters.get(adapterName);
      if (!adapter) throw new TypeError(`unknown runtime adapter ${JSON.stringify(adapterName)}`);
      if (!adapter.dispatchMany) {
        // Compatibility path stays explicit and ordered; adapters that need a
        // network fast path advertise dispatchMany instead of changing the
        // meaning of dispatch().
        const snapshots: TaskSnapshot[] = [];
        for (const command of commands) snapshots.push(await integration.dispatch(adapterName, command));
        return snapshots;
      }
      for (const command of commands) await reserve(options.client, command);
      const receipts = await adapter.dispatchMany({ items: commands });
      if (!Array.isArray(receipts) || receipts.length !== commands.length) {
        throw new TypeError('runtime batch receipt count must match command count');
      }
      const snapshots: TaskSnapshot[] = [];
      for (let index = 0; index < commands.length; index++) {
        const receipt = receipts[index]!;
        const command = commands[index]!;
        validateRuntimeRef(receipt.ref);
        if (receipt.ref.runtime !== command.runtime || receipt.ref.scope !== command.scope) {
          throw new TypeError('runtime batch receipt does not match its reserved runtime and scope');
        }
        try { snapshots.push(await bind(options.client, command.executionId, receipt.ref)); }
        catch (error) { throw new RuntimeDispatchUncertainError(command.executionId, receipt, { cause: error }); }
      }
      return snapshots;
    },
    async reconcile(adapterName, ref) {
      validateRuntimeRef(ref);
      const adapter = requireAdapter(adapters, adapterName);
      if (!adapter.capabilities.inspect || !adapter.inspect) {
        throw new TypeError(`runtime adapter ${JSON.stringify(adapterName)} does not support inspect`);
      }
      assertAdapterRef(adapter, ref);
      const observation = validateRuntimeObservation(await adapter.inspect(ref));
      if (runtimeRefIdentity(observation.ref) !== runtimeRefIdentity(ref)) {
        throw new TypeError('runtime inspection returned an observation for a different reference');
      }
      await integration.observe(observationEvent(observation));
      return observation;
    },
    async cancel(taskId, adapterName, ref) {
      validateRuntimeRef(ref);
      const adapter = requireAdapter(adapters, adapterName);
      assertAdapterRef(adapter, ref);
      if (adapter.capabilities.cancel === 'unsupported' || !adapter.cancel) {
        throw new TypeError(`runtime adapter ${JSON.stringify(adapterName)} does not support cancel`);
      }
      const execution = await options.client.lookupTaskExecution(ref.runtime, ref.externalId, ref.scope);
      if (execution.taskId !== taskId) throw new TypeError('runtime reference does not belong to the requested Task');
      let task = await options.client.getTask(taskId);
      if (task.state !== 'cancel_requested') {
        task = await options.client.requestTaskCancellation(task.id, task.entityVersion);
      }
      let result: CancelResult;
      try {
        result = await adapter.cancel(ref);
      } catch (error) {
        result = { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
      }
      const latest = await options.client.getTask(taskId);
      if (result.status === 'unsupported') {
        const resolved = { status: 'cannot_cancel_safely' as const, reason: result.reason };
        await options.client.resolveTaskCancellation(
          latest.id, latest.entityVersion, resolved.status, resolved.reason,
        );
        return resolved;
      }
      await options.client.resolveTaskCancellation(
        latest.id,
        latest.entityVersion,
        result.status,
        result.status === 'acknowledged' ? undefined : result.reason,
      );
      return result;
    },
    async runtimeReports() {
      const reports: RuntimeAdapterReport[] = [];
      for (const adapter of adapters.values()) {
        let health;
        try {
          health = adapter.health
            ? await adapter.health()
            : { status: 'unknown' as const, checkedAt: new Date().toISOString(), reason: 'adapter does not expose health' };
        } catch (error) {
          health = {
            status: 'unavailable' as const,
            checkedAt: new Date().toISOString(),
            reason: error instanceof Error ? error.message : String(error),
          };
        }
        reports.push({
          name: adapter.name,
          scope: adapter.scope,
          capabilities: { ...adapter.capabilities },
          health,
          guaranteeGaps: guaranteeGaps(adapter),
        });
      }
      return reports;
    },
    async adoptionReport() {
      const reports = await integration.runtimeReports();
      const durable: DurableAdoptionReport | undefined = adoptionStore
        ? await adoptionStore.snapshot()
        : undefined;
      const facts: Omit<ShadowAdoptionReport, 'checklist'> = {
        schemaVersion: 1,
        mode: 'observe',
        startedAt: durable?.startedAt ?? startedAt,
        generatedAt: new Date().toISOString(),
        observedEvents: durable?.observedEvents ?? observedEvents,
        runtimeReferences: durable?.runtimeReferences ?? observedRefs.size,
        tasksBound: durable?.tasksBound ?? boundTasks.size,
        bindingsCreated: durable?.bindingsCreated ?? bindingsCreated,
        unboundEvents: durable?.unboundEvents ?? unboundEvents,
        unresolvedEvents: durable?.unresolvedEvents ?? unresolvedEvents,
        uncertainOutcomes: durable?.uncertainOutcomes ?? uncertainOutcomes,
        terminalFailures: durable?.terminalFailures ?? terminalFailures,
        retryAttemptsObserved: durable?.retryAttemptsObserved ?? retryAttempts.size,
        ...(durable ? { replicas: durable.replicas } : {}),
        guaranteeGaps: [...new Set(reports.flatMap((report) => report.guaranteeGaps))],
      };
      return { ...facts, checklist: adoptionChecklist(facts, reports, Boolean(adoptionStore), Boolean(options.resolveUnboundEvent)) };
    },
    async start() {
      if (started) return;
      started = true;
      try {
        for (const adapter of adapters.values()) {
          if (options.observeEvents === false) continue;
          if (adapter.capabilities.events === 'push') {
            if (!adapter.subscribe) throw new TypeError(`runtime adapter ${JSON.stringify(adapter.name)} advertises push events without subscribe()`);
            subscriptions.push(await adapter.subscribe(integration));
          }
        }
      } catch (error) {
        started = false;
        await disposeAll(subscriptions);
        throw error;
      }
    },
    async close() { started = false; await disposeAll(subscriptions); },
  };
  return integration;
}

function adoptionChecklist(
  facts: Omit<ShadowAdoptionReport, 'checklist'>,
  reports: RuntimeAdapterReport[],
  durableReporting: boolean,
  hasIdentityResolver: boolean,
): AdoptionChecklistItem[] {
  const anyInspect = reports.some((report) => report.capabilities.inspect);
  const anyCancel = reports.some((report) => report.capabilities.cancel !== 'unsupported');
  return [
    {
      id: 'runtime_identity', status: facts.tasksBound > 0 ? 'observed' : facts.unresolvedEvents > 0 ? 'required' : hasIdentityResolver ? 'configured' : 'required',
      guarantee: 'Every runtime reference maps deterministically to one Task and Execution.',
      ...(facts.tasksBound > 0 || (hasIdentityResolver && facts.unresolvedEvents === 0) ? {} : { nextAction: 'Implement resolveUnboundEvent without guessing identity.' }),
    },
    { id: 'owner_identity', status: 'required', guarantee: 'Every Task is scoped to a stable authenticated owner.', nextAction: 'Configure ownerFromRequest/ownerFromNodeRequest and run owner A/B isolation tests.' },
    { id: 'tenant_identity', status: 'required', guarantee: 'Tenant context is resolved server-side for every owner request.', nextAction: 'Configure tenantFromRequest and an explicit tenant authorization policy.' },
    { id: 'result_resolver', status: 'required', guarantee: 'Private result references never reach the browser.', nextAction: 'Configure resolveResult with owner and tenant authorization.' },
    { id: 'business_verifier', status: 'required', guarantee: 'Runtime success is independently checked against the business outcome.', nextAction: 'Register a verifier that preserves verified, mismatch and unverifiable outcomes.' },
    { id: 'cancellation', status: anyCancel ? 'configured' : 'unsupported', guarantee: 'Cancellation eligibility follows runtime evidence and fails before Task mutation when unavailable.', ...(anyCancel ? {} : { nextAction: 'Keep cancel hidden or provide an application-owned safe cancellation workflow.' }) },
    { id: 'reconciliation', status: anyInspect ? 'configured' : 'required', guarantee: 'Known runtime references can be inspected after event loss.', ...(anyInspect ? {} : { nextAction: 'Implement bounded inspect(ref) or document the reconciliation gap.' }) },
    { id: 'durable_reporting', status: durableReporting ? 'configured' : 'required', guarantee: 'Adoption facts deduplicate and aggregate across replicas.', ...(durableReporting ? {} : { nextAction: 'Install PostgresAdoptionReportStore before multi-replica evaluation.' }) },
  ];
}

async function track(client: TaskClient, binding: RuntimeTaskBinding): Promise<TaskSnapshot> {
  validateRuntimeRef(binding.ref);
  let task = await getOrCreateTask(client, binding.task);
  let existing;
  try {
    existing = await client.lookupTaskExecution(binding.ref.runtime, binding.ref.externalId, binding.ref.scope);
  } catch (error) {
    if (!hasCode(error, 'RHINOQ_EXECUTION_NOT_FOUND')) throw error;
  }
  if (existing) {
    if (existing.taskId !== task.id || existing.id !== binding.executionId ||
        (existing.itemKey ?? 'default') !== (binding.itemKey ?? 'default')) {
      throw new TypeError('runtime reference is already bound to different Task work');
    }
  } else {
    const reserved = await getExecution(client, binding.executionId);
    if (reserved) {
      assertReservation(reserved, task.id, binding.executionId, binding.itemKey, binding.ref.runtime, binding.ref.scope);
    } else {
      task = await client.createTaskExecution(task.id, {
        id: binding.executionId, runtime: binding.ref.runtime, runtimeScope: binding.ref.scope,
        ...(binding.itemKey ? { itemKey: binding.itemKey } : {}),
      });
    }
    task = await client.bindTaskExecution(binding.executionId, {
      runtime: binding.ref.runtime, runtimeScope: binding.ref.scope, externalId: binding.ref.externalId,
    });
  }
  return ensureQueued(client, task.id);
}

async function reserve(client: TaskClient, input: RuntimeTaskReservation): Promise<TaskSnapshot> {
  validateName(input.runtime, 'runtime');
  validateName(input.scope, 'scope');
  let task = await getOrCreateTask(client, input.task);
  const existing = await getExecution(client, input.executionId);
  if (existing) {
    assertReservation(existing, task.id, input.executionId, input.itemKey, input.runtime, input.scope);
  } else {
    task = await client.createTaskExecution(task.id, {
        id: input.executionId, runtime: input.runtime, runtimeScope: input.scope,
        ...(input.itemKey ? { itemKey: input.itemKey } : {}),
      });
  }
  return task;
}

async function bind(client: TaskClient, executionId: string, ref: RuntimeRef): Promise<TaskSnapshot> {
  validateRuntimeRef(ref);
  return client.bindTaskExecution(executionId, {
    runtime: ref.runtime, runtimeScope: ref.scope, externalId: ref.externalId,
  });
}

async function getOrCreateTask(client: TaskClient, request: TaskCreateRequest): Promise<TaskSnapshot> {
  try { return await client.getTask(request.id); } catch (error) {
    if (!hasCode(error, 'RHINOQ_TASK_NOT_FOUND')) throw error;
    return client.createTask(request);
  }
}

async function ensureQueued(client: TaskClient, taskId: string): Promise<TaskSnapshot> {
  const task = await client.getTask(taskId);
  if (task.state !== 'pending') return task;
  return client.transitionTask(task.id, task.entityVersion, 'queued');
}

async function disposeAll(subscriptions: Disposable[]): Promise<void> {
  const current = subscriptions.splice(0).reverse();
  await Promise.all(current.map(async (subscription) => subscription.dispose()));
}

function validateName(value: string, field: string): void {
  if (!value?.trim()) throw new TypeError(`${field} must be a non-empty string`);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function requireAdapter(adapters: Map<string, RuntimeAdapter>, name: string): RuntimeAdapter {
  const adapter = adapters.get(name);
  if (!adapter) throw new TypeError(`unknown runtime adapter ${JSON.stringify(name)}`);
  return adapter;
}

function assertAdapterRef(adapter: RuntimeAdapter, ref: RuntimeRef): void {
  if (ref.runtime !== adapter.name || ref.scope !== adapter.scope) {
    throw new TypeError('runtime reference does not match the selected adapter name and scope');
  }
}

function runtimeRefIdentity(ref: RuntimeRef): string {
  return JSON.stringify([ref.runtime, ref.scope, ref.externalId]);
}

function observationEvent(observation: RuntimeObservation): RuntimeEvent {
  const base = {
    ref: observation.ref,
    occurredAt: observation.observedAt,
    ...(observation.attempt === undefined ? {} : { attempt: observation.attempt }),
  };
  switch (observation.state) {
    case 'accepted': return { ...base, type: 'accepted' };
    case 'running':
      return observation.progress
        ? { ...base, type: 'progressed', progress: observation.progress }
        : { ...base, type: 'started' };
    case 'succeeded': return { ...base, type: 'succeeded', ...(observation.resultRef ? { resultRef: observation.resultRef } : {}) };
    case 'failed': return { ...base, type: 'failed', terminal: observation.terminal, ...(observation.reason ? { reason: observation.reason } : {}) };
    case 'cancelled': return { ...base, type: 'cancelled' };
    case 'unknown': return { ...base, type: 'uncertain', reason: observation.reason ?? 'runtime_unreachable' };
  }
}

function guaranteeGaps(adapter: RuntimeAdapter): string[] {
  const gaps: string[] = [];
  if (adapter.capabilities.events === 'none') gaps.push('no runtime events');
  if (!adapter.capabilities.inspect) gaps.push('no reconciliation inspection');
  if (!adapter.capabilities.dispatch) gaps.push('observe/track only; no controlled dispatch');
  if (adapter.capabilities.cancel === 'unsupported') gaps.push('cancellation unsupported');
  if (adapter.capabilities.cancel === 'best_effort') gaps.push('cancellation is best effort');
  if (!adapter.capabilities.progress) gaps.push('progress unavailable');
  if (!adapter.capabilities.stableAttempts) gaps.push('attempt identity is not stable');
  return gaps;
}

async function getExecution(client: TaskClient, executionId: string) {
  try { return await client.getTaskExecution(executionId); } catch (error) {
    if (hasCode(error, 'RHINOQ_EXECUTION_NOT_FOUND')) return undefined;
    throw error;
  }
}

function assertReservation(
  execution: Awaited<ReturnType<TaskClient['getTaskExecution']>>,
  taskId: string,
  executionId: string,
  itemKey: string | undefined,
  runtime: string,
  scope: string,
): void {
  if (execution.taskId !== taskId || execution.id !== executionId ||
      (execution.itemKey ?? 'default') !== (itemKey ?? 'default') ||
      execution.runtime !== runtime || (execution.runtimeScope ?? '') !== scope) {
    throw new TypeError('execution id is already reserved for different Task work');
  }
}

/** Push-only adapter for custom runtimes and deterministic tests. */
export function createManualRuntimeAdapter(name: string, scope: string): RuntimeAdapter & {
  emit(event: RuntimeEvent): Promise<void>;
} {
  validateName(name, 'adapter name');
  validateName(scope, 'adapter scope');
  let sink: RuntimeEventSink | undefined;
  return {
    name, scope,
    capabilities: {
      events: 'push', dispatch: false, inspect: false, cancel: 'unsupported',
      progress: true, stableAttempts: true,
    },
    async subscribe(next) {
      if (sink) throw new Error('manual runtime adapter already has a subscriber');
      sink = next;
      return { dispose() { if (sink === next) sink = undefined; } };
    },
    async emit(event) {
      validateRuntimeEvent(event);
      if (event.ref.runtime !== name || event.ref.scope !== scope) {
        throw new TypeError('manual runtime event does not match the adapter name and scope');
      }
      if (!sink) throw new Error('manual runtime adapter is not started');
      await sink.observe(event);
    },
  };
}
