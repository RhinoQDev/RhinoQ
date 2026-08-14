import type { TaskProgress } from '../gateway/types.js';
import type { RhinoQLifecycleModule } from './modules.js';

/** Durable identity of work in an application-owned runtime. */
export interface RuntimeRef {
  runtime: string;
  scope: string;
  externalId: string;
}

export type RuntimeEventType =
  | 'accepted'
  | 'started'
  | 'progressed'
  | 'attempt_ended'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'uncertain';

interface RuntimeEventBase {
  type: RuntimeEventType;
  ref: RuntimeRef;
  occurredAt: string;
  eventId?: string;
  attempt?: number;
  taskId?: string;
  itemKey?: string;
}

export interface RuntimeAccepted extends RuntimeEventBase { type: 'accepted' }
export interface RuntimeStarted extends RuntimeEventBase { type: 'started' }
export interface RuntimeProgressed extends RuntimeEventBase {
  type: 'progressed';
  progress: TaskProgress;
}
export interface RuntimeAttemptEnded extends RuntimeEventBase {
  type: 'attempt_ended';
  outcome: 'failed' | 'cancelled' | 'unknown';
  reason?: string;
}
export interface RuntimeSucceeded extends RuntimeEventBase {
  type: 'succeeded';
  resultRef?: string;
}
export interface RuntimeFailed extends RuntimeEventBase {
  type: 'failed';
  /** Adapter-owned fact. Core must never infer a runtime's retry policy. */
  terminal: boolean;
  reason?: string;
}
export interface RuntimeCancelled extends RuntimeEventBase { type: 'cancelled' }
export interface RuntimeUncertain extends RuntimeEventBase {
  type: 'uncertain';
  reason:
    | 'runtime_unreachable'
    | 'event_gap'
    | 'result_unknown'
    | 'evidence_missing'
    | (string & {});
}

export type RuntimeEvent =
  | RuntimeAccepted
  | RuntimeStarted
  | RuntimeProgressed
  | RuntimeAttemptEnded
  | RuntimeSucceeded
  | RuntimeFailed
  | RuntimeCancelled
  | RuntimeUncertain;

export interface RuntimeCapabilities {
  events: 'push' | 'poll' | 'none';
  dispatch: boolean;
  inspect: boolean;
  cancel: 'supported' | 'best_effort' | 'unsupported';
  progress: boolean;
  stableAttempts: boolean;
  /** Dispatch policies the adapter proves it applies; absent means unsupported. */
  dispatchPolicies?: { delay: boolean; priority: boolean };
}

export interface RuntimeObservation {
  ref: RuntimeRef;
  state: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  attempt?: number;
  /** Adapter-owned fact. False is valid for observations that may still retry. */
  terminal: boolean;
  observedAt: string;
  progress?: TaskProgress;
  resultRef?: string;
  reason?: string;
}

export interface RuntimeEventSink {
  observe(event: RuntimeEvent): Promise<void>;
}

export interface Disposable { dispose(): Promise<void> | void }

export interface DispatchCommand {
  taskId: string;
  itemKey?: string;
  payload: unknown;
  idempotencyKey: string;
  /** Adapter translates this bounded request; RhinoQ does not execute retries here. */
  retry?: { maxAttempts: number; backoff?: { type: 'fixed' | 'exponential'; delayMs: number } };
  delayMs?: number;
  priority?: number;
}

export interface DispatchReceipt { ref: RuntimeRef }

export type CancelResult =
  | { status: 'acknowledged' }
  | { status: 'cannot_cancel_safely' | 'unsupported' | 'failed'; reason: string };

export interface RuntimeHealth {
  status: 'healthy' | 'degraded' | 'unavailable' | 'unknown';
  checkedAt: string;
  reason?: string;
}

export interface RuntimeAdapter {
  readonly name: string;
  readonly scope: string;
  readonly capabilities: RuntimeCapabilities;
  /** Optional lifecycle for provider/runtime resources; correctness stays here in Go/Application. */
  readonly module?: RhinoQLifecycleModule;
  subscribe?(sink: RuntimeEventSink): Promise<Disposable>;
  dispatch?(command: DispatchCommand): Promise<DispatchReceipt>;
  inspect?(ref: RuntimeRef): Promise<RuntimeObservation>;
  cancel?(ref: RuntimeRef): Promise<CancelResult>;
  health?(): Promise<RuntimeHealth>;
}

export interface RuntimeAdapterReport {
  name: string;
  scope: string;
  capabilities: RuntimeCapabilities;
  health: RuntimeHealth;
  guaranteeGaps: string[];
}

/** Validate capability claims against the methods an adapter actually exposes. */
export function validateRuntimeAdapter(adapter: RuntimeAdapter): RuntimeAdapter {
  requireText(adapter.name, 'adapter.name');
  requireText(adapter.scope, 'adapter.scope');
  if (adapter.module && adapter.module.descriptor.namespace !== 'runtime') {
    throw new TypeError('adapter.module must use the runtime namespace');
  }
  const capabilities = adapter.capabilities;
  if (!capabilities || !['push', 'poll', 'none'].includes(capabilities.events)) {
    throw new TypeError('adapter.capabilities.events must be push, poll or none');
  }
  if (!['supported', 'best_effort', 'unsupported'].includes(capabilities.cancel)) {
    throw new TypeError('adapter.capabilities.cancel is invalid');
  }
  if (capabilities.events === 'push' && !adapter.subscribe) {
    throw new TypeError('adapter advertises push events without subscribe()');
  }
  if (capabilities.dispatch && !adapter.dispatch) {
    throw new TypeError('adapter advertises dispatch without dispatch()');
  }
  if (capabilities.inspect && !adapter.inspect) {
    throw new TypeError('adapter advertises inspect without inspect()');
  }
  if (capabilities.cancel !== 'unsupported' && !adapter.cancel) {
    throw new TypeError('adapter advertises cancellation without cancel()');
  }
  return adapter;
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) throw new TypeError(`${field} must be a non-empty string`);
}

function requireTimestamp(value: string, field: string): void {
  requireText(value, field);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${field} must be an ISO-8601 timestamp`);
}

function validateProgress(progress: TaskProgress): void {
  if (!Number.isInteger(progress.completed) || progress.completed < 0) {
    throw new RangeError('progress.completed must be a non-negative integer');
  }
  if (progress.total !== undefined && (!Number.isInteger(progress.total) || progress.total < progress.completed)) {
    throw new RangeError('progress.total must be an integer greater than or equal to completed');
  }
}

/** Validate untrusted adapter identity before it reaches projection or storage. */
export function validateRuntimeRef(ref: RuntimeRef): RuntimeRef {
  requireText(ref.runtime, 'ref.runtime');
  requireText(ref.scope, 'ref.scope');
  requireText(ref.externalId, 'ref.externalId');
  return ref;
}

/**
 * Fail-closed boundary for adapter events. In particular, failure terminality
 * must be supplied by the adapter and uncertainty must carry a reason.
 */
export function validateRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  validateRuntimeRef(event.ref);
  requireTimestamp(event.occurredAt, 'event.occurredAt');
  if (event.attempt !== undefined && (!Number.isInteger(event.attempt) || event.attempt < 1)) {
    throw new RangeError('event.attempt must be a positive integer');
  }
  if (event.type === 'progressed') validateProgress(event.progress);
  if (event.type === 'failed' && typeof event.terminal !== 'boolean') {
    throw new TypeError('failed event.terminal must be supplied by the runtime adapter');
  }
  if (event.type === 'uncertain') requireText(event.reason, 'uncertain event.reason');
  return event;
}

/** Validate a point-in-time adapter read before reconciliation compares it. */
export function validateRuntimeObservation(observation: RuntimeObservation): RuntimeObservation {
  validateRuntimeRef(observation.ref);
  requireTimestamp(observation.observedAt, 'observation.observedAt');
  if (typeof observation.terminal !== 'boolean') {
    throw new TypeError('observation.terminal must be supplied by the runtime adapter');
  }
  if (observation.attempt !== undefined && (!Number.isInteger(observation.attempt) || observation.attempt < 1)) {
    throw new RangeError('observation.attempt must be a positive integer');
  }
  if (observation.progress !== undefined) validateProgress(observation.progress);
  if (observation.state === 'unknown' && (observation.reason === undefined || observation.reason.trim() === '')) {
    throw new TypeError('unknown observation.reason must be supplied by the runtime adapter');
  }
  return observation;
}
