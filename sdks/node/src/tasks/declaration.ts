import type { TaskSnapshot } from '../gateway/types.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { PassThrough } from 'node:stream';
import { createRhinoQMediaContext, type RhinoQMediaContext } from './media.js';
import { waitForApproval, waitForInput, waitForWebhook, type WaitForInputOptions, type WaitpointLifecycleClient, type WaitpointOutcome } from './waitpoint.js';
import type { RhinoQRuntimeIntegration } from '../runtime/integration.js';

export interface RhinoQTaskRunContext {
  taskId: string;
  executionId: string;
  itemKey?: string;
  signal?: AbortSignal;
  progress(completed: number, total?: number, message?: string): Promise<void> | void;
  artifact: {
    file(data: Uint8Array | string, options: RhinoQArtifactFileOptions): Promise<import('../gateway/types.js').TaskArtifact>;
    stream(source: AsyncIterable<Uint8Array | string>, options: RhinoQArtifactStreamOptions): Promise<import('../gateway/types.js').TaskArtifact>;
    filePath(path: string, options?: Omit<RhinoQArtifactStreamOptions, 'sizeBytes' | 'name' | 'contentType'> & { sizeBytes?: number; name?: string; contentType?: string }): Promise<import('../gateway/types.js').TaskArtifact>;
  };
  output: RhinoQTaskOutputHelpers;
  media: RhinoQMediaContext;
  waitForInput<T = unknown>(options: Omit<WaitForInputOptions<T>, 'taskId'>): Promise<WaitpointOutcome<T>>;
  waitForApproval(options: Omit<WaitForInputOptions<boolean>, 'taskId' | 'kind' | 'parse'>): Promise<WaitpointOutcome<boolean>>;
  waitForWebhook<T = unknown>(options: Omit<WaitForInputOptions<T>, 'taskId' | 'kind'>): Promise<WaitpointOutcome<T>>;
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

export interface RhinoQTaskServices {
  artifacts?: {
    storage: RhinoQArtifactStorage;
    register(taskId: string, request: import('../gateway/types.js').TaskArtifactCreateRequest): Promise<import('../gateway/types.js').TaskArtifact>;
  };
  waitpoints?: WaitpointLifecycleClient;
  trace?: RhinoQTraceHooks;
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

export interface RhinoQTaskOptions<Input, Output> {
  name: string;
  version?: number;
  adapter: string;
  runtime: string;
  scope: string;
  /** Safe default is no automatic retry. Runtime retry requires an explicit bound. */
  retry?: RhinoQTaskRetryPolicy;
  /** Required when the handler mutates an external system. */
  effect?: RhinoQTaskEffectPolicy;
  externalEffect?: boolean;
  /** Enables bounded fan-out through the same declaration. Dispatch is ordered and visibly partial on runtime failure. */
  batch?: { maxItems?: number };
  /** Applied only by an adapter that explicitly advertises the policy. */
  execution?: { delayMs?: number; priority?: number };
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
          taskName: name, taskId: id, executionId,
          definitionVersion: version,
          retry,
          payload: request.payload,
          ...(options.effect ? { effect: options.effect } : {}),
          ...(trace ? { trace } : {}),
        },
      });
      return services.trace ? services.trace.run('rhinoq.task.dispatch', { 'rhinoq.task.name': name, 'rhinoq.task.id': id }, trace, operation) : operation();
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
      let snapshot: TaskSnapshot | undefined;
      for (const item of request.items) {
        const itemKey = required(item?.itemKey, 'Task batch itemKey');
        if (keys.has(itemKey)) throw new TypeError(`duplicate Task batch itemKey ${JSON.stringify(itemKey)}`);
        keys.add(itemKey);
        snapshot = await declaration.dispatch({
          id, ownerId, payload: item.payload, itemKey,
          ...(request.tenantId?.trim() ? { tenantId: request.tenantId.trim() } : {}),
          executionId: item.executionId?.trim() || `${id}:${itemKey}:attempt:1`,
          idempotencyKey: item.idempotencyKey?.trim() || `${id}:${itemKey}`,
        });
      }
      return snapshot!;
    },
    execute(input, context) { return Promise.resolve(options.run(input, context)); },
    workerHandler() {
      return async (job) => {
        const envelope = taskEnvelope<Input>(job?.data, name, version);
        const waitpoints = waitpointHelper(services, envelope.taskId);
        const operation = () => Promise.resolve(options.run(envelope.payload, {
          taskId: envelope.taskId,
          executionId: envelope.executionId,
          signal: job.signal,
          progress: async (completed, total, message) => {
            if (!Number.isFinite(completed) || completed < 0) throw new RangeError('Task progress completed must be non-negative');
            if (total !== undefined && (!Number.isFinite(total) || total < completed)) throw new RangeError('Task progress total must be at least completed');
            await job.updateProgress?.({ completed, ...(total === undefined ? {} : { total }), ...(message ? { message } : {}) });
          },
          artifact: artifactHelper(services, envelope.taskId, envelope.executionId, job.signal, async (completed, total, message) => {
            await job.updateProgress?.({ completed, ...(total === undefined ? {} : { total }), ...(message ? { message } : {}) });
          }),
          output: outputHelper(services, envelope.taskId, envelope.executionId, job.signal, async (completed, total, message) => {
            await job.updateProgress?.({ completed, ...(total === undefined ? {} : { total }), ...(message ? { message } : {}) });
          }),
          media: createRhinoQMediaContext(outputHelper(services, envelope.taskId, envelope.executionId, job.signal, async (completed, total, message) => {
            await job.updateProgress?.({ completed, ...(total === undefined ? {} : { total }), ...(message ? { message } : {}) });
          }), job.signal),
          ...waitpoints,
        }));
        return services.trace ? services.trace.run('rhinoq.task.run', { 'rhinoq.task.name': name, 'rhinoq.task.id': envelope.taskId, 'rhinoq.execution.id': envelope.executionId }, envelope.trace, operation) : operation();
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
): RhinoQTaskRunContext['artifact'] {
  const identity = (options: RhinoQArtifactFileOptions) => {
    const name = required(options?.name, 'artifact name');
    const contentType = required(options?.contentType, 'artifact contentType');
    const id = options.id?.trim() || `artifact-${createHash('sha256').update(`${taskId}\0${executionId}\0${name}`).digest('hex').slice(0, 32)}`;
    return { id, name, contentType };
  };
  const register = async (options: RhinoQArtifactFileOptions, value: { id: string; name: string; contentType: string; sizeBytes: number; checksumSha256: string; reference: string; expiresAt?: string }) => {
    const expiresAt = value.expiresAt ?? new Date(Date.now() + (options.expiresInMs ?? 3_600_000)).toISOString();
    if (!Number.isFinite(Date.parse(expiresAt))) throw new TypeError('artifact storage expiresAt must be an ISO timestamp');
    return services.artifacts!.register(taskId, {
      id: value.id, executionId, name: value.name, contentType: value.contentType,
      sizeBytes: value.sizeBytes, checksumSha256: value.checksumSha256,
      reference: required(value.reference, 'artifact storage reference'), expiresAt,
      ...(options.lineage ? { lineage: options.lineage } : {}),
    });
  };
  return Object.freeze({
    async file(data, options) {
      if (!services.artifacts) throw new TypeError('context.artifact.file requires createRhinoQApp({ artifactProvider })');
      const { id, name, contentType } = identity(options);
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
      const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
      const stored = await services.artifacts.storage.put({ id, taskId, executionId, name, contentType, data: bytes, checksumSha256 });
      return register(options, { id, name, contentType, sizeBytes: bytes.byteLength, checksumSha256, ...stored });
    },
    async stream(source, options) {
      if (!services.artifacts?.storage.putStream) throw new TypeError('context.artifact.stream requires an artifactProvider with streaming upload support');
      if (!source || typeof source[Symbol.asyncIterator] !== 'function') throw new TypeError('artifact stream must be an AsyncIterable');
      if (options.sizeBytes !== undefined && (!Number.isSafeInteger(options.sizeBytes) || options.sizeBytes < 0)) throw new RangeError('artifact stream sizeBytes must be a non-negative safe integer');
      const { id, name, contentType } = identity(options);
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
      return this.stream(createReadStream(path), { ...options, name, contentType, sizeBytes: info.size });
    },
  });
}

function outputHelper(services: RhinoQTaskServices, taskId: string, executionId: string, signal?: AbortSignal, progress?: RhinoQTaskRunContext['progress']): RhinoQTaskOutputHelpers {
  type FileOptions = { name?: string; contentType?: string; lineage?: string[] };
  type ZipOptions = { name?: string; maxItems?: number; lineage?: string[] };
  const artifact = artifactHelper(services, taskId, executionId, signal, progress);
  const file = (path: string, options: FileOptions = {}) => artifact.filePath(path, { ...options, reportProgress: true });
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
        while (next < selected.length) { const index = next++; results[index] = await file(selected[index]!); }
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

function taskEnvelope<Input>(value: unknown, name: string, version: number): { taskId: string; executionId: string; payload: Input; trace?: Record<string, string> } {
  if (!value || typeof value !== 'object') throw new TypeError('RhinoQ Task worker received an invalid envelope');
  const envelope = value as { taskName?: unknown; definitionVersion?: unknown; taskId?: unknown; executionId?: unknown; payload?: Input; trace?: unknown };
  if (envelope.taskName !== name || envelope.definitionVersion !== version) {
    throw new TypeError(`RhinoQ Task worker refuses an undeclared Task envelope; expected ${name}@${version}`);
  }
  if (typeof envelope.taskId !== 'string' || !envelope.taskId.trim() || typeof envelope.executionId !== 'string' || !envelope.executionId.trim()) {
    throw new TypeError('RhinoQ Task envelope requires taskId and executionId');
  }
  const trace = envelope.trace && typeof envelope.trace === 'object'
    ? Object.fromEntries(Object.entries(envelope.trace).filter((entry): entry is [string, string] => typeof entry[1] === 'string').slice(0, 32))
    : undefined;
  return { taskId: envelope.taskId, executionId: envelope.executionId, payload: envelope.payload as Input, ...(trace ? { trace } : {}) };
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
