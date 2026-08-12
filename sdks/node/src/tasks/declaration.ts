import type { TaskSnapshot } from '../gateway/types.js';
import type { RhinoQRuntimeIntegration } from '../runtime/integration.js';

export interface RhinoQTaskRunContext {
  taskId: string;
  executionId: string;
  itemKey?: string;
  signal?: AbortSignal;
  progress(completed: number, total?: number, message?: string): Promise<void> | void;
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
}

export interface RhinoQDeclaredTask<Input, Output> {
  readonly name: string;
  readonly version: number;
  readonly retry: RhinoQTaskRetryPolicy;
  readonly effect?: RhinoQTaskEffectPolicy;
  dispatch(request: RhinoQTaskDispatch<Input>): Promise<TaskSnapshot>;
  execute(input: Input, context: RhinoQTaskRunContext): Promise<Output>;
  workerHandler(): (job: { data: unknown; updateProgress?(progress: { completed: number; total?: number; message?: string }): Promise<unknown> | unknown; signal?: AbortSignal }) => Promise<Output>;
  resultMetadata(output: Output): { ref: string; mediaType?: string; size?: number } | undefined;
}

/**
 * One declaration shared by producer registration and worker execution.
 * Runtime adapters remain the authority for dispatch/retry/lifecycle events;
 * this helper never implements a second queue or retry state machine.
 */
export function defineRhinoQTask<Input, Output>(
  integration: RhinoQRuntimeIntegration,
  options: RhinoQTaskOptions<Input, Output>,
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
      return integration.dispatch(adapter, {
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
        payload: {
          taskName: name, taskId: id, executionId,
          definitionVersion: version,
          retry,
          payload: request.payload,
          ...(options.effect ? { effect: options.effect } : {}),
        },
      });
    },
    execute(input, context) { return Promise.resolve(options.run(input, context)); },
    workerHandler() {
      return async (job) => {
        const envelope = taskEnvelope<Input>(job?.data, name, version);
        return options.run(envelope.payload, {
          taskId: envelope.taskId,
          executionId: envelope.executionId,
          signal: job.signal,
          progress: async (completed, total, message) => {
            if (!Number.isFinite(completed) || completed < 0) throw new RangeError('Task progress completed must be non-negative');
            if (total !== undefined && (!Number.isFinite(total) || total < completed)) throw new RangeError('Task progress total must be at least completed');
            await job.updateProgress?.({ completed, ...(total === undefined ? {} : { total }), ...(message ? { message } : {}) });
          },
        });
      };
    },
    resultMetadata(output) { return options.result?.(output); },
  };
  return Object.freeze(declaration);
}

function taskEnvelope<Input>(value: unknown, name: string, version: number): { taskId: string; executionId: string; payload: Input } {
  if (!value || typeof value !== 'object') throw new TypeError('RhinoQ Task worker received an invalid envelope');
  const envelope = value as { taskName?: unknown; definitionVersion?: unknown; taskId?: unknown; executionId?: unknown; payload?: Input };
  if (envelope.taskName !== name || envelope.definitionVersion !== version) {
    throw new TypeError(`RhinoQ Task worker refuses an undeclared Task envelope; expected ${name}@${version}`);
  }
  if (typeof envelope.taskId !== 'string' || !envelope.taskId.trim() || typeof envelope.executionId !== 'string' || !envelope.executionId.trim()) {
    throw new TypeError('RhinoQ Task envelope requires taskId and executionId');
  }
  return { taskId: envelope.taskId, executionId: envelope.executionId, payload: envelope.payload as Input };
}

function required(value: string | undefined, label: string): string {
  const result = value?.trim();
  if (!result) throw new TypeError(`${label} is required`);
  return result;
}
