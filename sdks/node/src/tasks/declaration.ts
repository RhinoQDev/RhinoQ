import type { TaskSnapshot } from '../gateway/types.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { PassThrough } from 'node:stream';
import { createRhinoQMediaContext, type RhinoQMediaContext } from './media.js';
import { createRhinoQTaskIO, type RhinoQTaskIO } from './task-io.js';
import { createTaskWorkspace, type RhinoQTaskWorkspace } from './workspace.js';
import { createRhinoQProgressCoalescer } from './progress.js';
import { waitForApproval, waitForInput, waitForWebhook, type WaitForInputOptions, type WaitpointLifecycleClient, type WaitpointOutcome } from './waitpoint.js';
import type { RhinoQRuntimeIntegration } from '../runtime/integration.js';
import type { RhinoQDataPathOverrides } from './data-path.js';
import { createRhinoQTaskCheckpoint, type RhinoQTaskCheckpoint, type RhinoQTaskCheckpointClient } from './checkpoint.js';
import { createDurableTaskContext, isRhinoQUserCancellation, RhinoQUserCancellationError, RhinoQWorkerShutdownError, type DurableEffectClient, type DurableStepClient, type DurableTaskContext } from './durable.js';
import {
  createRhinoQResourceLeaseHeartbeat,
  normalizeRhinoQResourceVector,
  requiresRhinoQResources,
  validateRhinoQResourcePool,
  type RhinoQResourceLeaseClient,
  type RhinoQResourcePoolOptions,
} from './resource-lease.js';
import type { ArtifactUploadService } from './artifact-upload.js';

export interface RhinoQTaskRunContext {
  taskId: string;
  executionId: string;
  itemKey?: string;
  signal?: AbortSignal;
  /** A completed compatible step is reused after a worker crash or restart. */
  step: DurableTaskContext['step'];
  /** Safe external mutation backed by the existing ProviderOperation ledger. */
  effect: DurableTaskContext['effect'];
  progress(completed: number, total?: number, message?: string): Promise<void> | void;
  artifact: {
    file(data: Uint8Array | string, options: RhinoQArtifactFileOptions): Promise<import('../gateway/types.js').TaskArtifact>;
    stream(source: AsyncIterable<Uint8Array | string>, options: RhinoQArtifactStreamOptions): Promise<import('../gateway/types.js').TaskArtifact>;
    filePath(path: string, options?: Omit<RhinoQArtifactStreamOptions, 'sizeBytes' | 'name' | 'contentType'> & { sizeBytes?: number; name?: string; contentType?: string }): Promise<import('../gateway/types.js').TaskArtifact>;
  };
  output: RhinoQTaskOutputHelpers;
  media: RhinoQMediaContext;
  io: RhinoQTaskIO;
  /** Present when the Task declaration opts into an isolated auto-cleaned workspace. */
  workspace?: RhinoQTaskWorkspace;
  waitForInput<T = unknown>(options: Omit<WaitForInputOptions<T>, 'taskId'>): Promise<WaitpointOutcome<T>>;
  waitForApproval(options: Omit<WaitForInputOptions<boolean>, 'taskId' | 'kind' | 'parse'>): Promise<WaitpointOutcome<boolean>>;
  waitForWebhook<T = unknown>(options: Omit<WaitForInputOptions<T>, 'taskId' | 'kind'>): Promise<WaitpointOutcome<T>>;
  /** Selective resumable state for deterministic large-work units. */
  checkpoint: RhinoQTaskCheckpoint;
}

export interface RhinoQTaskOutputHelpers {
  file(path: string, options?: { name?: string; contentType?: string; lineage?: string[] }): Promise<import('../gateway/types.js').TaskArtifact>;
  video(path: string, options?: { name?: string; contentType?: string; lineage?: string[] }): Promise<import('../gateway/types.js').TaskArtifact>;
  pdf(path: string, options?: { name?: string; lineage?: string[] }): Promise<import('../gateway/types.js').TaskArtifact>;
  archive(path: string, options?: { name?: string; contentType?: string; lineage?: string[] }): Promise<import('../gateway/types.js').TaskArtifact>;
  files(paths: string[], options?: { maxItems?: number; concurrency?: number }): Promise<import('../gateway/types.js').TaskArtifact[]>;
  zip(paths: string[], options?: { name?: string; maxItems?: number; lineage?: string[] }): Promise<import('../gateway/types.js').TaskArtifact>;
}

export interface RhinoQArtifactFileOptions {
  id?: string;
  name: string;
  contentType: string;
  expiresInMs?: number;
  lineage?: string[];
}

export interface RhinoQArtifactStreamOptions extends RhinoQArtifactFileOptions {
  /** Expected byte count. Strongly recommended for multipart uploads and checked after transfer. */
  sizeBytes?: number;
  /** Report byte progress through the Task's existing progress channel. */
  reportProgress?: boolean;
}

export interface RhinoQArtifactStreamInput {
  id: string; taskId: string; executionId: string; name: string; contentType: string;
  source: AsyncIterable<Uint8Array>; sizeBytes?: number; signal?: AbortSignal;
}

export interface RhinoQArtifactStorage {
  put(input: { id: string; taskId: string; executionId: string; name: string; contentType: string; data: Uint8Array; checksumSha256: string }): Promise<{ reference: string; expiresAt?: string }>;
  /** Optional large-object path. Implementations must consume with backpressure and honor AbortSignal. */
  putStream?(input: RhinoQArtifactStreamInput): Promise<{ reference: string; expiresAt?: string }>;
}

export interface RhinoQTaskCancellationClient {
  getTask(taskId: string): Promise<TaskSnapshot>;
  transitionTask(taskId: string, expectedVersion: number, state: 'cancelled'): Promise<TaskSnapshot>;
}

export interface RhinoQTaskServices {
  artifacts?: {
    storage: RhinoQArtifactStorage;
    register(taskId: string, request: import('../gateway/types.js').TaskArtifactCreateRequest): Promise<import('../gateway/types.js').TaskArtifact>;
    /** Optional S3-compatible recovery path for replayable local files only. */
    durableMultipart?: {
      uploads: ArtifactUploadService;
      /** Verifies the envelope's owner and tenant against the authoritative Task before provider access. */
      authorizeTask(taskId: string, ownerId: string, tenantId: string): Promise<void>;
    };
  };
  waitpoints?: WaitpointLifecycleClient;
  checkpoints?: RhinoQTaskCheckpointClient;
  /** Authoritative durable-step commands. The PostgreSQL profile supplies this. */
  steps?: DurableStepClient;
  /** Existing Go-owned ProviderOperation Effect Ledger facade. */
  effects?: DurableEffectClient;
  /** Stable worker identity used only when acquiring a durable step lease. */
  workerId?: string;
  /** Authoritative shared-capacity admission. A pool is tenant-scoped in PostgreSQL. */
  resources?: {
    client: RhinoQResourceLeaseClient;
    pool: RhinoQResourcePoolOptions;
  };
  /** Polls the authoritative Task state; only cancel_requested creates a terminal user cancellation. */
  cancellation?: {
    client: RhinoQTaskCancellationClient;
    pollIntervalMs?: number;
  };
  trace?: RhinoQTraceHooks;
  /** Read-only notification hook; realtime delivery must never change Task correctness. */
  onMutation?(mutation: RhinoQTaskMutation): Promise<void> | void;
}

export interface RhinoQTaskMutation {
  taskId: string;
  ownerId: string;
  tenantId?: string;
  entityVersion: number;
}

export interface RhinoQTraceHooks {
  inject?(): Record<string, string>;
  run<T>(name: string, attributes: Record<string, string>, carrier: Record<string, string> | undefined, operation: () => Promise<T>): Promise<T>;
}

export type RhinoQTaskRetryPolicy =
  | { mode: 'never' }
  | { mode: 'runtime'; maxAttempts: number; backoff?: { type: 'fixed' | 'exponential'; delayMs: number } };

export interface RhinoQTaskEffectPolicy {
  idempotency: 'provider' | 'application';
  confirmation: 'readback' | 'webhook' | 'predicate';
}

export type RhinoQTaskCapability = 'task' | 'batch' | 'media' | 'effect' | 'schedule';

export interface RhinoQTaskResourcePolicy {
  timeoutMs?: number;
  concurrency?: number;
  /** Integer CPU credits reserved from the configured shared pool. */
  cpu?: number;
  /** Bytes reserved from the configured shared pool; separate from maxRssBytes. */
  memoryBytes?: number;
  /** Bytes reserved from the configured shared pool; separate from workspace checks. */
  diskBytes?: number;
  /** Integer, application-defined network credits reserved from the shared pool. */
  network?: number;
  maxRssBytes?: number;
  workspaceBytes?: number;
  minDiskFreeBytes?: number;
  gpu?: string;
  region?: string;
  codec?: string;
}

export interface RhinoQTaskSchedulePolicy {
  expression: string;
  timezone?: string;
  enabled?: boolean;
}

export interface RhinoQTaskOptions<Input, Output> {
  name: string;
  version?: number;
  adapter: string;
  runtime: string;
  scope: string;
  /** Metadata marker used by the application compiler; it is not a workflow DSL. */
  capability?: RhinoQTaskCapability;
  /** Optional expert metadata override; the compiler supplies safe defaults. */
  dataPath?: RhinoQDataPathOverrides;
  /** Bounded execution/resource metadata for the compiled capsule. Enforcement stays runtime-owned. */
  resources?: RhinoQTaskResourcePolicy;
  /** Schedule declaration metadata; occurrence creation remains runtime/application-owned. */
  schedule?: RhinoQTaskSchedulePolicy;
  /** Safe default is no automatic retry. Runtime retry requires an explicit bound. */
  retry?: RhinoQTaskRetryPolicy;
  /** Required when the handler mutates an external system. */
  effect?: RhinoQTaskEffectPolicy;
  externalEffect?: boolean;
  /** Enables bounded fan-out through the same declaration. Dispatch is ordered and visibly partial on runtime failure. */
  batch?: { maxItems?: number };
  /** Applied only by an adapter that explicitly advertises the policy. */
  execution?: { delayMs?: number; priority?: number };
  /** Creates one isolated directory per execution and removes it in finally. */
  workspace?: { parent?: string; minimumFreeBytes?: number };
  run(input: Input, context: RhinoQTaskRunContext): Promise<Output> | Output;
  result?(output: Output): { ref: string; mediaType?: string; size?: number } | undefined;
}

export interface RhinoQTaskDispatch<Input> {
  id: string;
  ownerId: string;
  tenantId?: string;
  payload: Input;
  idempotencyKey?: string;
  executionId?: string;
  itemKey?: string;
  execution?: { delayMs?: number; priority?: number };
}

export interface RhinoQDeclaredTask<Input, Output> {
  readonly name: string;
  readonly version: number;
  readonly retry: RhinoQTaskRetryPolicy;
  readonly effect?: RhinoQTaskEffectPolicy;
  dispatch(request: RhinoQTaskDispatch<Input>): Promise<TaskSnapshot>;
  dispatchAfter(request: RhinoQTaskDispatch<Input>, delayMs: number): Promise<TaskSnapshot>;
  dispatchAt(request: RhinoQTaskDispatch<Input>, runAt: Date | string, now?: Date): Promise<TaskSnapshot>;
  dispatchBatch(request: RhinoQTaskBatchDispatch<Input>): Promise<TaskSnapshot>;
  execute(input: Input, context: RhinoQTaskRunContext): Promise<Output>;
  workerHandler(): (job: { data: unknown; updateProgress?(progress: { completed: number; total?: number; message?: string }): Promise<unknown> | unknown; signal?: AbortSignal }) => Promise<Output>;
  resultMetadata(output: Output): { ref: string; mediaType?: string; size?: number } | undefined;
}

export interface RhinoQTaskBatchDispatch<Input> {
  id: string;
  ownerId: string;
  tenantId?: string;
  items: Array<{ itemKey: string; payload: Input; idempotencyKey?: string; executionId?: string }>;
}

/**
 * One declaration shared by producer registration and worker execution.
 * Runtime adapters remain the authority for dispatch/retry/lifecycle events;
 * this helper never implements a second queue or retry state machine.
 */
export function defineRhinoQTask<Input, Output>(
  integration: RhinoQRuntimeIntegration,
  options: RhinoQTaskOptions<Input, Output>,
  services: RhinoQTaskServices = {},
): RhinoQDeclaredTask<Input, Output> {
  if (!integration?.dispatch) throw new TypeError('RhinoQ runtime integration is required');
  const name = required(options?.name, 'task name');
  const adapter = required(options?.adapter, 'task adapter');
  const runtime = required(options?.runtime, 'task runtime');
  const scope = required(options?.scope, 'task runtime scope');
  if (typeof options.run !== 'function') throw new TypeError('task run handler is required');
  const version = options.version ?? 1;
  if (!Number.isInteger(version) || version < 1) throw new RangeError('task version must be a positive integer');
  const retry = options.retry ?? { mode: 'never' as const };
  if (retry.mode === 'runtime' && (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1)) {
    throw new RangeError('runtime retry maxAttempts must be a positive integer');
  }
  if (retry.mode === 'runtime' && retry.backoff && (!Number.isFinite(retry.backoff.delayMs) || retry.backoff.delayMs < 1)) {
    throw new RangeError('runtime retry backoff delayMs must be a positive number');
  }
  if (options.externalEffect && !options.effect) {
    throw new TypeError('external-effect Task requires explicit idempotency and confirmation policy');
  }
  if (options.execution?.delayMs !== undefined && (!Number.isInteger(options.execution.delayMs) || options.execution.delayMs < 0)) {
    throw new RangeError('Task execution delayMs must be a non-negative integer');
  }
  if (options.execution?.priority !== undefined && !Number.isInteger(options.execution.priority)) {
    throw new RangeError('Task execution priority must be an integer');
  }
  const resourceDemand = normalizeRhinoQResourceVector(options.resources);
  if (requiresRhinoQResources(resourceDemand)) {
    if (!services.resources) {
      throw new TypeError('Task resource admission requires createRhinoQApp({ resourcePool }) or an authoritative resource lease service');
    }
    if (!services.workerId) {
      throw new TypeError('Task resource admission requires a stable createRhinoQApp({ workerId }) identity for lease fencing');
    }
    validateRhinoQResourcePool(services.resources.pool);
  }
  if (services.cancellation?.pollIntervalMs !== undefined &&
      (!Number.isSafeInteger(services.cancellation.pollIntervalMs) || services.cancellation.pollIntervalMs < 250 || services.cancellation.pollIntervalMs > 60_000)) {
    throw new RangeError('Task cancellation pollIntervalMs must be 250..60000');
  }

  const declaration: RhinoQDeclaredTask<Input, Output> = {
    name,
    version,
    retry,
    ...(options.effect ? { effect: { ...options.effect } } : {}),
    dispatch(request) {
      const id = required(request?.id, 'Task id');
      const ownerId = required(request?.ownerId, 'Task ownerId');
      const executionId = request.executionId?.trim() || `${id}:attempt:1`;
      const idempotencyKey = request.idempotencyKey?.trim() || id;
      const execution = { ...options.execution, ...request.execution };
      validateExecution(execution);
      const trace = services.trace?.inject?.();
      const operation = () => integration.dispatch(adapter, {
        task: {
          id, type: name, ownerId, definitionVersion: version,
          ...(request.tenantId?.trim() ? { tenantId: request.tenantId.trim() } : {}),
        },
        executionId,
        ...(request.itemKey?.trim() ? { itemKey: request.itemKey.trim() } : {}),
        runtime,
        scope,
        taskId: id,
        idempotencyKey,
        retry: retry.mode === 'never' ? { maxAttempts: 1 } : {
          maxAttempts: retry.maxAttempts,
          ...(retry.backoff ? { backoff: retry.backoff } : {}),
        },
        ...(execution.delayMs === undefined ? {} : { delayMs: execution.delayMs }),
        ...(execution.priority === undefined ? {} : { priority: execution.priority }),
        payload: {
          taskName: name, taskId: id, executionId, ownerId, tenantId: request.tenantId?.trim() || 'default',
          definitionVersion: version,
          itemKey: request.itemKey?.trim() || 'default',
          retry,
          payload: request.payload,
          ...(options.effect ? { effect: options.effect } : {}),
          ...(trace ? { trace } : {}),
        },
      });
      const dispatched = services.trace
        ? services.trace.run('rhinoq.task.dispatch', { 'rhinoq.task.name': name, 'rhinoq.task.id': id }, trace, operation)
        : operation();
      return dispatched.then((snapshot) => {
        // Realtime is an acceleration path. A broken socket hub must not make
        // a durable dispatch fail or cause the producer to retry it.
        void Promise.resolve().then(() => services.onMutation?.({
          taskId: id,
          ownerId,
          ...(request.tenantId?.trim() ? { tenantId: request.tenantId.trim() } : {}),
          entityVersion: snapshot.entityVersion,
        })).catch(() => undefined);
        return snapshot;
      });
    },
    dispatchAfter(request, delayMs) {
      validateExecution({ delayMs });
      return declaration.dispatch({ ...request, execution: { ...request.execution, delayMs } });
    },
    dispatchAt(request, runAt, now = new Date()) {
      const target = runAt instanceof Date ? runAt : new Date(runAt);
      if (!Number.isFinite(target.getTime()) || !Number.isFinite(now.getTime())) throw new TypeError('Task dispatchAt requires valid dates');
      const delayMs = Math.max(0, target.getTime() - now.getTime());
      return declaration.dispatchAfter(request, delayMs);
    },
    async dispatchBatch(request) {
      const id = required(request?.id, 'Task id');
      const ownerId = required(request?.ownerId, 'Task ownerId');
      if (!Array.isArray(request.items) || request.items.length === 0) throw new RangeError('Task batch requires at least one item');
      const maximum = options.batch?.maxItems ?? 1_000;
      if (!Number.isInteger(maximum) || maximum < 1 || maximum > 10_000) throw new RangeError('Task batch maxItems must be 1..10000');
      if (request.items.length > maximum) throw new RangeError(`Task batch contains ${request.items.length} items; maxItems is ${maximum}`);
      const keys = new Set<string>();
	  const commands: Parameters<RhinoQRuntimeIntegration['dispatchMany']>[1] = [];
      for (const item of request.items) {
        const itemKey = required(item?.itemKey, 'Task batch itemKey');
        if (keys.has(itemKey)) throw new TypeError(`duplicate Task batch itemKey ${JSON.stringify(itemKey)}`);
        keys.add(itemKey);
		const executionId = item.executionId?.trim() || `${id}:${itemKey}:attempt:1`;
		commands.push({
		  task: { id, type: name, ownerId, definitionVersion: version, ...(request.tenantId?.trim() ? { tenantId: request.tenantId.trim() } : {}) },
		  executionId, itemKey, runtime, scope, taskId: id,
		  idempotencyKey: item.idempotencyKey?.trim() || `${id}:${itemKey}`,
		  retry: retry.mode === 'never' ? { maxAttempts: 1 } : { maxAttempts: retry.maxAttempts, ...(retry.backoff ? { backoff: retry.backoff } : {}) },
		  ...(options.execution?.delayMs === undefined ? {} : { delayMs: options.execution.delayMs }),
		  ...(options.execution?.priority === undefined ? {} : { priority: options.execution.priority }),
		  payload: { taskName: name, taskId: id, executionId, ownerId, tenantId: request.tenantId?.trim() || 'default', definitionVersion: version, itemKey, retry, payload: item.payload, ...(options.effect ? { effect: options.effect } : {}) },
		});
      }
	  const snapshots = integration.dispatchMany
		? await integration.dispatchMany(adapter, commands)
		: await commands.reduce<Promise<TaskSnapshot[]>>(async (pending, command) => [...await pending, await integration.dispatch(adapter, command)], Promise.resolve([]));
	  const snapshot = snapshots[snapshots.length - 1]!;
	  void Promise.resolve().then(() => services.onMutation?.({ taskId: id, ownerId, ...(request.tenantId?.trim() ? { tenantId: request.tenantId.trim() } : {}), entityVersion: snapshot.entityVersion })).catch(() => undefined);
	  return snapshot;
    },
    execute(input, context) { return Promise.resolve(options.run(input, context)); },
    workerHandler() {
      return async (job) => {
        const envelope = taskEnvelope<Input>(job?.data, name, version);
        const cancellation = createTaskCancellationMonitor(services, envelope.taskId, job.signal);
        const waitpoints = waitpointHelper(services, envelope.taskId);
        const operation = async () => {
          await cancellation.ready;
          const progress = createRhinoQProgressCoalescer(async (update) => job.updateProgress?.(update));
          let workspace: RhinoQTaskWorkspace | undefined;
          let failed = false;
          let resourceHeartbeat: ReturnType<typeof createRhinoQResourceLeaseHeartbeat> | undefined;
          try {
            cancellation.signal.throwIfAborted();
            if (requiresRhinoQResources(resourceDemand)) {
              const resourceService = services.resources!;
              const pool = validateRhinoQResourcePool(resourceService.pool);
              const lease = await resourceService.client.acquireResourceLease({
                pool, taskId: envelope.taskId, executionId: envelope.executionId,
                owner: services.workerId!, resources: resourceDemand,
              });
              resourceHeartbeat = createRhinoQResourceLeaseHeartbeat(resourceService.client, lease, pool.leaseMs!);
            }
            workspace = options.workspace ? await createTaskWorkspace({ parent: options.workspace.parent, minimumFreeBytes: options.workspace.minimumFreeBytes, prefix: `rhinoq-${safeWorkspaceSegment(envelope.taskId)}-` }) : undefined;
            const reportProgress: RhinoQTaskRunContext['progress'] = async (completed, total, message) => {
              await progress.report({ completed, ...(total === undefined ? {} : { total }), ...(message ? { message } : {}) });
            };
            const durable = createDurableTaskContext({
              taskId: envelope.taskId,
              executionId: envelope.executionId,
              itemKey: envelope.itemKey,
              taskVersion: version,
              signal: cancellation.signal,
              steps: services.steps,
              effects: services.effects,
              workerId: services.workerId,
            });
            const workerArtifactIdentity = envelope.ownerId && envelope.tenantId ? { ownerId: envelope.ownerId, tenantId: envelope.tenantId } : undefined;
            const artifact = artifactHelper(services, envelope.taskId, envelope.executionId, cancellation.signal, reportProgress, undefined, workerArtifactIdentity);
            const outputHelpers = outputHelper(services, envelope.taskId, envelope.executionId, cancellation.signal, reportProgress, workerArtifactIdentity);
            const output = await Promise.resolve(options.run(envelope.payload, {
              taskId: envelope.taskId,
              executionId: envelope.executionId,
              itemKey: envelope.itemKey,
              signal: cancellation.signal,
              step: durable.step,
              effect: durable.effect,
              progress: reportProgress,
              artifact,
              output: outputHelpers,
              media: createRhinoQMediaContext(outputHelpers, cancellation.signal),
              io: createRhinoQTaskIO(cancellation.signal),
              checkpoint: createRhinoQTaskCheckpoint(services.checkpoints, envelope.taskId, envelope.executionId, version),
              ...(workspace ? { workspace } : {}),
              ...waitpoints,
            }));
            await resourceHeartbeat?.stop();
            resourceHeartbeat?.assertOwned();
            cancellation.signal.throwIfAborted();
            return output;
          } catch (error) {
            if (isRhinoQUserCancellation(error)) {
              try {
                await terminalizeUserCancellation(services, envelope.taskId);
              } catch (terminalError) {
                if (error instanceof Error && terminalError instanceof Error) error.cause ??= terminalError;
              }
            }
            failed = true;
            throw error;
          } finally {
            try {
              await progress.close();
            } catch (error) {
              if (!failed) {
                try {
                  await workspace?.cleanup();
                } finally {
                  if (resourceHeartbeat) {
                    try {
                      await resourceHeartbeat.stop();
                      await services.resources!.client.releaseResourceLease(resourceHeartbeat.lease());
                    } catch (releaseError) {
                      if (!failed) throw releaseError;
                    }
                  }
                }
                throw error;
              }
            }
            try {
              await workspace?.cleanup();
            } finally {
              if (resourceHeartbeat) {
                try {
                  await resourceHeartbeat.stop();
                  await services.resources!.client.releaseResourceLease(resourceHeartbeat.lease());
                } catch (releaseError) {
                  if (!failed) throw releaseError;
                }
              }
            }
          }
        };
        return Promise.resolve(services.trace ? services.trace.run('rhinoq.task.run', { 'rhinoq.task.name': name, 'rhinoq.task.id': envelope.taskId, 'rhinoq.execution.id': envelope.executionId }, envelope.trace, operation) : operation()).finally(() => cancellation.stop());
      };
    },
    resultMetadata(output) { return options.result?.(output); },
  };
  return Object.freeze(declaration);
}

function waitpointHelper(services: RhinoQTaskServices, taskId: string): Pick<RhinoQTaskRunContext, 'waitForInput' | 'waitForApproval' | 'waitForWebhook'> {
  const client = () => {
    if (!services.waitpoints) throw new TypeError('Task waitpoints require the PostgreSQL Task profile');
    return services.waitpoints;
  };
  return {
    waitForInput: (options) => waitForInput(client(), { ...options, taskId }),
    waitForApproval: (options) => waitForApproval(client(), { ...options, taskId }),
    waitForWebhook: (options) => waitForWebhook(client(), { ...options, taskId }),
  };
}

function artifactHelper(
  services: RhinoQTaskServices,
  taskId: string,
  executionId: string,
  signal?: AbortSignal,
  progress?: RhinoQTaskRunContext['progress'],
  registrationQueue?: { enqueue<T>(operation: () => Promise<T>): Promise<T> },
  workerArtifactIdentity?: { ownerId: string; tenantId: string },
): RhinoQTaskRunContext['artifact'] {
  const artifactIdentity = (options: RhinoQArtifactFileOptions) => {
    const name = required(options?.name, 'artifact name');
    const contentType = required(options?.contentType, 'artifact contentType');
    const id = options.id?.trim() || `artifact-${createHash('sha256').update(`${taskId}\0${executionId}\0${name}`).digest('hex').slice(0, 32)}`;
    return { id, name, contentType };
  };
  const register = async (options: RhinoQArtifactFileOptions, value: { id: string; name: string; contentType: string; sizeBytes: number; checksumSha256: string; reference: string; expiresAt?: string }) => {
    const expiresAt = value.expiresAt ?? new Date(Date.now() + (options.expiresInMs ?? 3_600_000)).toISOString();
    if (!Number.isFinite(Date.parse(expiresAt))) throw new TypeError('artifact storage expiresAt must be an ISO timestamp');
    const request = {
      id: value.id, executionId, name: value.name, contentType: value.contentType,
      sizeBytes: value.sizeBytes, checksumSha256: value.checksumSha256,
      reference: required(value.reference, 'artifact storage reference'), expiresAt,
      ...(options.lineage ? { lineage: options.lineage } : {}),
    };
    const registerArtifact = () => services.artifacts!.register(taskId, request);
    return registrationQueue ? registrationQueue.enqueue(registerArtifact) : registerArtifact();
  };
  return Object.freeze({
    async file(data, options) {
      if (!services.artifacts) throw new TypeError('context.artifact.file requires createRhinoQApp({ artifactProvider })');
      const { id, name, contentType } = artifactIdentity(options);
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
      const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
      const stored = await services.artifacts.storage.put({ id, taskId, executionId, name, contentType, data: bytes, checksumSha256 });
      return register(options, { id, name, contentType, sizeBytes: bytes.byteLength, checksumSha256, ...stored });
    },
    async stream(source, options) {
      if (!services.artifacts?.storage.putStream) throw new TypeError('context.artifact.stream requires an artifactProvider with streaming upload support');
      if (!source || typeof source[Symbol.asyncIterator] !== 'function') throw new TypeError('artifact stream must be an AsyncIterable');
      if (options.sizeBytes !== undefined && (!Number.isSafeInteger(options.sizeBytes) || options.sizeBytes < 0)) throw new RangeError('artifact stream sizeBytes must be a non-negative safe integer');
      const { id, name, contentType } = artifactIdentity(options);
      const hash = createHash('sha256');
      let sizeBytes = 0;
      const measured = (async function* () {
        for await (const chunk of source) {
          if (signal?.aborted) throw signal.reason ?? new Error('artifact upload aborted');
          const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
          sizeBytes += bytes.byteLength;
          if (options.sizeBytes !== undefined && sizeBytes > options.sizeBytes) throw new RangeError('artifact stream exceeded its declared sizeBytes');
          hash.update(bytes);
          if (options.reportProgress) await progress?.(sizeBytes, options.sizeBytes, `Uploading ${name}`);
          yield bytes;
        }
      })();
      const stored = await services.artifacts.storage.putStream({ id, taskId, executionId, name, contentType, source: measured, ...(options.sizeBytes === undefined ? {} : { sizeBytes: options.sizeBytes }), ...(signal ? { signal } : {}) });
      if (options.sizeBytes !== undefined && sizeBytes !== options.sizeBytes) throw new RangeError(`artifact stream ended at ${sizeBytes} bytes; expected ${options.sizeBytes}`);
      return register(options, { id, name, contentType, sizeBytes, checksumSha256: hash.digest('hex'), ...stored });
    },
    async filePath(path, options) {
      const info = await stat(path);
      if (!info.isFile()) throw new TypeError('artifact filePath must point to a regular file');
      if (options?.sizeBytes !== undefined && options.sizeBytes !== info.size) throw new RangeError(`artifact file size is ${info.size} bytes; expected ${options.sizeBytes}`);
      const name = options?.name?.trim() || basename(path);
      const contentType = options?.contentType?.trim() || contentTypeFor(name);
      const durableMultipart = services.artifacts?.durableMultipart;
      if (durableMultipart && info.size > 0) {
        if (!workerArtifactIdentity) throw new TypeError('durable worker artifact upload requires an ownerId and tenantId in the Task envelope; redispatch an envelope produced by this RhinoQ version');
        const artifactOptions = { ...(options ?? {}), name, contentType };
        const { id } = artifactIdentity(artifactOptions);
        await durableMultipart.authorizeTask(taskId, workerArtifactIdentity.ownerId, workerArtifactIdentity.tenantId);
        const uploaded = await durableMultipart.uploads.uploadWorkerFile({
          path, taskId, executionId, artifactId: id, name, contentType,
          ownerId: workerArtifactIdentity.ownerId, tenantId: workerArtifactIdentity.tenantId,
          ...(signal ? { signal } : {}),
          ...(options?.reportProgress ? { onProgress: ({ uploadedBytes, totalBytes }) => progress?.(uploadedBytes, totalBytes, `Uploading ${name}`) } : {}),
        });
        const checksumSha256 = uploaded.session.checksumSha256;
        if (!checksumSha256) throw new Error('durable worker artifact upload completed without a checksum');
        return register(artifactOptions, { id, name, contentType, sizeBytes: uploaded.session.sizeBytes, checksumSha256, reference: uploaded.session.reference, expiresAt: uploaded.session.artifactExpiresAt });
      }
      return this.stream(createReadStream(path), { ...options, name, contentType, sizeBytes: info.size });
    },
  });
}

function outputHelper(services: RhinoQTaskServices, taskId: string, executionId: string, signal?: AbortSignal, progress?: RhinoQTaskRunContext['progress'], workerArtifactIdentity?: { ownerId: string; tenantId: string }): RhinoQTaskOutputHelpers {
  type FileOptions = { name?: string; contentType?: string; lineage?: string[] };
  type ZipOptions = { name?: string; maxItems?: number; lineage?: string[] };
  const artifact = artifactHelper(services, taskId, executionId, signal, progress, undefined, workerArtifactIdentity);
  const registrationQueue = {
    tail: Promise.resolve(),
    enqueue<T>(operation: () => Promise<T>): Promise<T> {
      const result = this.tail.then(operation, operation);
      this.tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
  const orderedArtifact = artifactHelper(services, taskId, executionId, signal, progress, registrationQueue, workerArtifactIdentity);
  const file = (path: string, options: FileOptions = {}) => artifact.filePath(path, { ...options, reportProgress: true });
  const orderedFile = (path: string, options: FileOptions = {}) => orderedArtifact.filePath(path, { ...options, reportProgress: true });
  const paths = (values: string[], maximum = 100, hardMaximum = 1_000) => {
    if (!Array.isArray(values) || values.length === 0) throw new RangeError('output files requires at least one path');
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > hardMaximum) throw new RangeError(`output maxItems must be 1..${hardMaximum}`);
    if (values.length > maximum) throw new RangeError(`output contains ${values.length} files; maxItems is ${maximum}`);
    const names = values.map((value) => basename(required(value, 'output file path')));
    if (new Set(names).size !== names.length) throw new TypeError('output file basenames must be unique');
    return values;
  };
  return Object.freeze({
    file,
    video: (path: string, options: FileOptions = {}) => file(path, { ...options, contentType: options.contentType ?? videoTypeFor(options.name ?? path) }),
    pdf: (path: string, options: Omit<FileOptions, 'contentType'> = {}) => file(path, { ...options, contentType: 'application/pdf' }),
    archive: (path: string, options: FileOptions = {}) => file(path, { ...options, contentType: options.contentType ?? archiveTypeFor(options.name ?? path) }),
    async files(values: string[], options: { maxItems?: number; concurrency?: number } = {}) {
      const selected = paths(values, options.maxItems, 100);
      const concurrency = options.concurrency ?? 4;
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new RangeError('output files concurrency must be 1..16');
      const results = new Array<import('../gateway/types.js').TaskArtifact>(selected.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
        while (next < selected.length) { const index = next++; results[index] = await orderedFile(selected[index]!); }
      }));
      return results;
    },
    async zip(values: string[], options: ZipOptions = {}) {
      const selected = paths(values, options.maxItems, 1_000);
      const module = await optionalTaskImport('archiver');
      const createArchive = (module.default ?? module) as (format: string, options: Record<string, unknown>) => { pipe(target: NodeJS.WritableStream): unknown; file(path: string, options: { name: string }): unknown; finalize(): Promise<void>; abort(): unknown; on(event: string, listener: (error: Error) => void): unknown };
      if (typeof createArchive !== 'function') throw new TypeError('archiver default export is unavailable');
      const zip = createArchive('zip', { zlib: { level: 6 } });
      const stream = new PassThrough();
      zip.pipe(stream);
      for (const path of selected) zip.file(path, { name: basename(path) });
      const abort = () => { zip.abort(); stream.destroy(signal?.reason instanceof Error ? signal.reason : new Error('ZIP output aborted')); };
      signal?.addEventListener('abort', abort, { once: true });
      zip.on('error', (error) => stream.destroy(error));
      void zip.finalize().catch((error) => stream.destroy(error)).finally(() => signal?.removeEventListener('abort', abort));
      return artifact.stream(stream, { name: options.name?.trim() || 'files.zip', contentType: 'application/zip', reportProgress: true, ...(options.lineage ? { lineage: options.lineage } : {}) });
    },
  });
}

const CONTENT_TYPES: Record<string, string> = { '.pdf':'application/pdf','.zip':'application/zip','.tar':'application/x-tar','.gz':'application/gzip','.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mkv':'video/x-matroska','.csv':'text/csv','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg' };
function contentTypeFor(path: string): string { return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'; }
function videoTypeFor(path: string): string { const value = contentTypeFor(path); if (!value.startsWith('video/')) throw new TypeError('output.video requires a known video extension or explicit contentType'); return value; }
function archiveTypeFor(path: string): string { const value = contentTypeFor(path); if (!['application/zip','application/x-tar','application/gzip'].includes(value)) throw new TypeError('output.archive requires .zip, .tar, .gz or explicit contentType'); return value; }
async function optionalTaskImport(specifier: string): Promise<Record<string, unknown>> { try { return await import(specifier) as Record<string, unknown>; } catch (error) { throw new Error(`context.output.zip requires ${specifier}; install archiver`, { cause: error }); } }

function createTaskCancellationMonitor(
  services: RhinoQTaskServices,
  taskId: string,
  upstream?: AbortSignal,
): { signal: AbortSignal; ready: Promise<void>; stop(): Promise<void> } {
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inspection: Promise<void> = Promise.resolve();
  const forwardUpstreamAbort = () => {
    if (controller.signal.aborted) return;
    const reason = upstream?.reason;
    controller.abort(reason instanceof RhinoQUserCancellationError
      ? reason
      : new RhinoQWorkerShutdownError('Worker shutdown or deployment interrupted the Task.', { cause: reason }));
  };
  if (upstream?.aborted) forwardUpstreamAbort();
  else upstream?.addEventListener('abort', forwardUpstreamAbort, { once: true });

  const inspect = async () => {
    if (stopped || controller.signal.aborted || !services.cancellation) return;
    try {
      const task = await services.cancellation.client.getTask(taskId);
      if (task.state === 'cancel_requested') {
        controller.abort(new RhinoQUserCancellationError(taskId, task.cancellation?.reason ?? 'Task cancelled by user.'));
      }
    } catch {
      // An unavailable read is not proof of a user cancellation. The runtime
      // retains retry ownership; the next bounded poll can still observe it.
    }
  };
  const schedule = () => {
    if (stopped || controller.signal.aborted || !services.cancellation) return;
    const delay = services.cancellation.pollIntervalMs ?? 1_000;
    timer = setTimeout(() => {
      inspection = inspect().finally(schedule);
    }, delay);
    timer.unref?.();
  };
  inspection = inspect().finally(schedule);
  return {
    signal: controller.signal,
    ready: inspection,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      upstream?.removeEventListener('abort', forwardUpstreamAbort);
      await inspection;
    },
  };
}

async function terminalizeUserCancellation(services: RhinoQTaskServices, taskId: string): Promise<void> {
  const client = services.cancellation?.client;
  if (!client) return;
  const task = await client.getTask(taskId);
  if (task.state === 'cancel_requested') {
    await client.transitionTask(taskId, task.entityVersion, 'cancelled');
  }
}

function taskEnvelope<Input>(value: unknown, name: string, version: number): { taskId: string; executionId: string; itemKey: string; payload: Input; ownerId?: string; tenantId?: string; trace?: Record<string, string> } {
  if (!value || typeof value !== 'object') throw new TypeError('RhinoQ Task worker received an invalid envelope');
  const envelope = value as { taskName?: unknown; definitionVersion?: unknown; taskId?: unknown; executionId?: unknown; itemKey?: unknown; payload?: Input; ownerId?: unknown; tenantId?: unknown; trace?: unknown };
  if (envelope.taskName !== name || envelope.definitionVersion !== version) {
    throw new TypeError(`RhinoQ Task worker refuses an undeclared Task envelope; expected ${name}@${version}`);
  }
  if (typeof envelope.taskId !== 'string' || !envelope.taskId.trim() || typeof envelope.executionId !== 'string' || !envelope.executionId.trim()) {
    throw new TypeError('RhinoQ Task envelope requires taskId and executionId');
  }
  if (envelope.itemKey !== undefined && (typeof envelope.itemKey !== 'string' || !envelope.itemKey.trim())) {
    throw new TypeError('RhinoQ Task envelope itemKey must be a non-empty string when supplied');
  }
  const trace = envelope.trace && typeof envelope.trace === 'object'
    ? Object.fromEntries(Object.entries(envelope.trace).filter((entry): entry is [string, string] => typeof entry[1] === 'string').slice(0, 32))
    : undefined;
  return { taskId: envelope.taskId, executionId: envelope.executionId, itemKey: envelope.itemKey?.trim() || 'default', payload: envelope.payload as Input,
    ...(typeof envelope.ownerId === 'string' && envelope.ownerId.trim() ? { ownerId: envelope.ownerId.trim() } : {}),
    ...(typeof envelope.tenantId === 'string' && envelope.tenantId.trim() ? { tenantId: envelope.tenantId.trim() } : {}),
    ...(trace ? { trace } : {}) };
}

function required(value: string | undefined, label: string): string {
  const result = value?.trim();
  if (!result) throw new TypeError(`${label} is required`);
  return result;
}

function validateExecution(execution: { delayMs?: number; priority?: number }): void {
  if (execution.delayMs !== undefined && (!Number.isInteger(execution.delayMs) || execution.delayMs < 0)) {
    throw new RangeError('Task execution delayMs must be a non-negative integer');
  }
  if (execution.priority !== undefined && !Number.isInteger(execution.priority)) {
    throw new RangeError('Task execution priority must be an integer');
  }
}
function safeWorkspaceSegment(value:string):string{return value.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,64)||'task';}
