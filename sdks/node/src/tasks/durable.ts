import { AsyncLocalStorage } from 'node:async_hooks';
import type { EffectOptions, ProviderOperationRecord } from '../gateway/types.js';
import { sha256RhinoQCheckpointInput } from './checkpoint.js';

/** Authoritative durable-step state, persisted by the selected runtime store. */
export type DurableStepState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface DurableStepRetryPolicy {
  /** The runtime may make a later attempt only while this bound remains. */
  attempts: number;
}

export interface DurableStepOptions {
  /** Version fences reuse after a handler/deployment change. Defaults to 1. */
  version?: number;
  /** Validated now; runtime-enforced interruption is a later profile capability. */
  timeoutMs?: number;
  /** Runtime retry budget for an incomplete step. Defaults to one attempt. */
  retry?: DurableStepRetryPolicy;
}

export interface DurableStepLease {
  stepId: string;
  attemptId: string;
  owner: string;
  epoch: number;
  expiresAt: string;
  attempt: number;
}

export interface DurableStepAcquireRequest {
  taskId: string;
  executionId: string;
  itemKey: string;
  taskVersion: number;
  stepKey: string;
  stepVersion: number;
  owner: string;
  leaseMs: number;
  maxAttempts: number;
}

export interface DurableStepAcquireResult {
  /** `reused` means the compatible completed result was read without executing user code. */
  action: 'acquired' | 'reused';
  state: DurableStepState;
  result?: unknown;
  resultRef?: string;
  lease?: DurableStepLease;
}

export interface DurableStepRecord {
  id: string;
  taskId: string;
  executionId?: string;
  itemKey: string;
  key: string;
  taskVersion: number;
  stepVersion: number;
  state: DurableStepState;
  result?: unknown;
  resultRef?: string;
  error?: string;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/**
 * A store is the correctness boundary for durable steps. SDK code merely
 * supplies handler lifecycle callbacks; it never decides fencing or reuse.
 */
export interface DurableStepClient {
  acquireDurableStep(request: DurableStepAcquireRequest): Promise<DurableStepAcquireResult>;
  completeDurableStep(lease: DurableStepLease, result: unknown, resultRef?: string): Promise<DurableStepRecord>;
  failDurableStep(lease: DurableStepLease, error: unknown): Promise<DurableStepRecord>;
  cancelDurableStep(lease: DurableStepLease, reason?: string): Promise<DurableStepRecord>;
  renewDurableStep(lease: DurableStepLease, leaseMs: number): Promise<DurableStepLease>;
  listDurableSteps(taskId: string, itemKey?: string): Promise<DurableStepRecord[]>;
}

/** Narrow facade over the existing Go-owned ProviderOperation Effect Ledger. */
export interface DurableEffectClient {
  effect<T>(options: EffectOptions<T>): Promise<ProviderOperationRecord>;
}

export interface DurableEffectOptions<T> {
  /** Stable application/provider identity; defaults to `application`. */
  provider?: string;
  /** Defaults to the durable effect key. It must remain stable across retries. */
  operation?: string;
  /** Stable external idempotency component supplied by the application. */
  key: string;
  /** JSON-shaped command input used only to fingerprint the effect. */
  request?: unknown;
  confirmation?: EffectOptions<T>['confirmation'];
  retryPolicy?: EffectOptions<T>['retryPolicy'];
  execute: (idempotencyKey: string) => Promise<T>;
  /** Independent read-back. It is never used to repeat the mutation. */
  verify?: EffectOptions<T>['confirm'];
  providerId?: EffectOptions<T>['providerId'];
  evidence?: EffectOptions<T>['evidence'];
}

export interface DurableTaskContext {
  readonly taskId: string;
  readonly executionId: string;
  readonly itemKey: string;
  readonly signal?: AbortSignal;
  step<T>(key: string, run: () => Promise<T> | T): Promise<T>;
  step<T>(key: string, options: DurableStepOptions, run: () => Promise<T> | T): Promise<T>;
  effect<T>(key: string, options: DurableEffectOptions<T>): Promise<ProviderOperationRecord>;
}

export interface CreateDurableTaskContextOptions {
  taskId: string;
  executionId: string;
  itemKey?: string;
  taskVersion: number;
  signal?: AbortSignal;
  steps?: DurableStepClient;
  effects?: DurableEffectClient;
  workerId?: string;
  stepLeaseMs?: number;
}

const DEFAULT_STEP_LEASE_MS = 60_000;

/**
 * Creates the `ctx.step()` / `ctx.effect()` facade used inside a declared Task.
 * Reuse and stale-lease rejection are delegated to the durable store. This
 * in-memory object only detects a duplicate declaration in one handler pass.
 */
export function createDurableTaskContext(options: CreateDurableTaskContextOptions): DurableTaskContext {
  const taskId = required(options?.taskId, 'durable taskId');
  const executionId = required(options?.executionId, 'durable executionId');
  const itemKey = options.itemKey?.trim() || 'default';
  const taskVersion = positive(options?.taskVersion, 'durable task version');
  const workerId = options.workerId?.trim() || `node:${process.pid}`;
  const stepLeaseMs = bounded(options.stepLeaseMs ?? DEFAULT_STEP_LEASE_MS, 1_000, 3_600_000, 'stepLeaseMs');
  const declaredSteps = new Set<string>();
  const declaredEffects = new Set<string>();
  const activeStepKey = new AsyncLocalStorage<string>();

  const requireSteps = (): DurableStepClient => {
    if (!options.steps) throw new TypeError('ctx.step() requires the PostgreSQL Durable Step profile');
    return options.steps;
  };
  const requireEffects = (): DurableEffectClient => {
    if (!options.effects) throw new TypeError('ctx.effect() requires a configured ProviderOperation Effect Ledger client');
    return options.effects;
  };

  const step = async <T>(key: string, first: DurableStepOptions | (() => Promise<T> | T), second?: () => Promise<T> | T): Promise<T> => {
    const stepKey = stableKey(key, 'step');
    if (declaredSteps.has(stepKey)) {
      throw new Error(`Step ${JSON.stringify(stepKey)} was declared twice in Task ${JSON.stringify(taskId)}. Each durable step needs a stable unique key; use a different key or reuse the value from the first call.`);
    }
    declaredSteps.add(stepKey);
    const { declaration, run } = normalizeStepArguments(first, second);
    const stepVersion = declaration.version ?? 1;
    const steps = requireSteps();
    const lease = await steps.acquireDurableStep({
      taskId, executionId, itemKey, taskVersion, stepKey, stepVersion, owner: workerId,
      leaseMs: stepLeaseMs, maxAttempts: declaration.retry?.attempts ?? 1,
    });
    if (lease.action === 'reused') return lease.result as T;
    if (!lease.lease) throw new Error(`Durable step ${JSON.stringify(stepKey)} was acquired without a lease`);
    const heartbeat = keepStepLeaseAlive(steps, lease.lease, stepLeaseMs);
    try {
      options.signal?.throwIfAborted();
      const value = await activeStepKey.run(stepKey, async () => run());
      await heartbeat.stop();
      heartbeat.assertOwned();
      options.signal?.throwIfAborted();
      await steps.completeDurableStep(heartbeat.lease(), value, artifactResultReference(value));
      return value;
    } catch (error) {
      try {
        await heartbeat.stop();
        if (isRhinoQUserCancellation(error)) {
          await steps.cancelDurableStep(heartbeat.lease(), error.message);
        } else {
          await steps.failDurableStep(heartbeat.lease(), error);
        }
      } catch (recordError) {
        // The original business failure remains the useful error. A failed
        // fenced write is still surfaced as its cause for operator diagnosis.
        if (error instanceof Error && recordError instanceof Error) error.cause ??= recordError;
      }
      throw error;
    }
  };

  return Object.freeze({
    taskId,
    executionId,
    itemKey,
    ...(options.signal ? { signal: options.signal } : {}),
    step: step as DurableTaskContext['step'],
    async effect<T>(key: string, effect: DurableEffectOptions<T>): Promise<ProviderOperationRecord> {
      const effectKey = stableKey(key, 'effect');
      if (declaredEffects.has(effectKey)) {
        throw new Error(`Effect ${JSON.stringify(effectKey)} was declared twice in Task ${JSON.stringify(taskId)}. Each durable effect needs a stable unique key.`);
      }
      declaredEffects.add(effectKey);
      if (!effect || typeof effect.execute !== 'function') throw new TypeError('ctx.effect() requires an execute callback');
      const provider = effectNamePart(effect.provider ?? 'application', 'effect provider');
      const operation = effectNamePart(effect.operation ?? effectKey, 'effect operation');
      const externalKey = stableKey(effect.key, 'effect key');
      options.signal?.throwIfAborted();
      const commandId = `durable:${(await sha256RhinoQCheckpointInput([taskId, itemKey, activeStepKey.getStore() ?? 'task', effectKey, externalKey].join('\0'))).slice(0, 48)}`;
      const result = await requireEffects().effect({
        taskId,
        provider,
        operation,
        commandId,
        request: effect.request,
        confirmation: effect.confirmation ?? (effect.verify ? 'readback' : 'on-return'),
        retryPolicy: effect.retryPolicy ?? 'when-not-happened',
        execute: effect.execute,
        confirm: effect.verify,
        providerId: effect.providerId,
        evidence: effect.evidence,
      });
      if (result.state === 'uncertain' || result.state === 'accepted' || result.state === 'pending') {
        throw new DurableEffectUncertainError(effectKey, result);
      }
      if (result.state === 'failed') throw new Error(`Effect ${JSON.stringify(effectKey)} failed: ${result.reason ?? 'the provider reported failure'}`);
      if (result.state === 'not_happened') throw new DurableEffectNotConfirmedError(effectKey, result);
      return result;
    },
  });
}

/** A Task must not progress past a provider result that is still unknown. */
export class DurableEffectUncertainError extends Error {
  constructor(readonly effectKey: string, readonly record: ProviderOperationRecord) {
    super(`Effect ${JSON.stringify(effectKey)} is uncertain. RhinoQ will verify the provider state before any retry; no duplicate mutation was sent.`);
    this.name = 'DurableEffectUncertainError';
  }
}

/** The ledger proved no mutation; the Task must retry or compensate explicitly. */
export class DurableEffectNotConfirmedError extends Error {
  constructor(readonly effectKey: string, readonly record: ProviderOperationRecord) {
    super(`Effect ${JSON.stringify(effectKey)} was not applied. RhinoQ did not advance the Task; retry only through the Effect Ledger.`);
    this.name = 'DurableEffectNotConfirmedError';
  }
}

/** A requested end-user cancellation is terminal, unlike process shutdown or deployment interruption. */
export class RhinoQUserCancellationError extends Error {
  readonly retryable = false;
  constructor(readonly taskId: string, reason = 'Task cancelled by user.') {
    super(reason);
    this.name = 'RhinoQUserCancellationError';
  }
}

/** A worker lifecycle interruption must reach the selected runtime as retryable work. */
export class RhinoQWorkerShutdownError extends Error {
  readonly retryable = true;
  constructor(reason = 'Worker shutdown or deployment interrupted the Task.', options: { cause?: unknown } = {}) {
    super(reason, options);
    this.name = 'RhinoQWorkerShutdownError';
  }
}

export function isRhinoQUserCancellation(error: unknown): error is RhinoQUserCancellationError {
  return error instanceof RhinoQUserCancellationError;
}

interface StepLeaseHeartbeat {
  lease(): DurableStepLease;
  stop(): Promise<void>;
  assertOwned(): void;
}

/**
 * The PostgreSQL profile remains the fencing authority. This timer only keeps
 * its currently-owned lease alive while a cooperative callback is awaiting;
 * a renewal failure prevents that callback from committing a stale result.
 */
function keepStepLeaseAlive(client: DurableStepClient, initial: DurableStepLease, leaseMs: number): StepLeaseHeartbeat {
  let lease = initial;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewal = Promise.resolve();
  let failure: unknown;
  const intervalMs = Math.max(250, Math.floor(leaseMs / 2));

  const schedule = () => {
    timer = setTimeout(() => {
      if (stopped) return;
      renewal = client.renewDurableStep(lease, leaseMs)
        .then((renewed) => { lease = renewed; })
        .catch((error) => { failure ??= error; })
        .finally(() => { if (!stopped && !failure) schedule(); });
    }, intervalMs);
  };
  schedule();
  return {
    lease: () => lease,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await renewal;
    },
    assertOwned() {
      if (failure) throw new DurableStepLeaseLostError(lease.stepId, failure);
    },
  };
}

/** The callback result was discarded because ownership could no longer be proved. */
export class DurableStepLeaseLostError extends Error {
  constructor(readonly stepId: string, cause: unknown) {
    super(`Durable Step ${JSON.stringify(stepId)} lost its lease before it could be committed. The result was not persisted.`, { cause });
    this.name = 'DurableStepLeaseLostError';
  }
}

function normalizeStepArguments<T>(first: DurableStepOptions | (() => Promise<T> | T), second?: () => Promise<T> | T): { declaration: DurableStepOptions; run: () => Promise<T> | T } {

  if (typeof first === 'function') return { declaration: {}, run: first };
  if (!first || typeof first !== 'object' || typeof second !== 'function') throw new TypeError('ctx.step() requires a callback or options plus a callback');
  if (first.version !== undefined) positive(first.version, 'step version');
  if (first.timeoutMs !== undefined) bounded(first.timeoutMs, 1, 86_400_000, 'step timeoutMs');
  if (first.retry?.attempts !== undefined) bounded(first.retry.attempts, 1, 100, 'step retry attempts');
  return { declaration: first, run: second };
}

function artifactResultReference(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const artifact = value as { id?: unknown; taskId?: unknown; contentType?: unknown; name?: unknown };
  return typeof artifact.id === 'string' && typeof artifact.taskId === 'string' &&
    typeof artifact.contentType === 'string' && typeof artifact.name === 'string'
    ? `artifact:${artifact.id}` : undefined;
}

function required(value: string | undefined, label: string): string {
  const result = value?.trim();
  if (!result) throw new TypeError(`${label} is required`);
  return result;
}
function stableKey(value: string | undefined, label: string, maxLength = 256): string {
  const result = required(value, label);
  if (result.length > maxLength) throw new RangeError(`${label} must be at most ${maxLength} characters`);
  return result;
}
function effectNamePart(value: string | undefined, label: string): string {
  const result = stableKey(value, label, 64);
  if (result.includes('.')) throw new TypeError(`${label} must not contain dots`);
  return result;
}
function positive(value: number | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive integer`);
  return value;
}
function bounded(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${label} must be ${min}..${max}`);
  return value;
}
