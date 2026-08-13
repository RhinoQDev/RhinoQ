import type { TaskProgress } from '../gateway/types.js';
import type {
  CancelResult, DispatchCommand, DispatchReceipt, Disposable, RuntimeAdapter,
  RuntimeEvent, RuntimeEventSink, RuntimeHealth, RuntimeObservation, RuntimeRef,
} from '../runtime/contracts.js';
import type {
  BullMQEvent, BullMQQueue, BullMQQueueEvents, BullMQTaskObservation,
} from './task-bridge.js';

type BullMQRuntimeEventName = 'waiting' | 'active' | 'progress' | 'completed' | 'failed' | 'delayed';

export interface BullMQRuntimeAdapterOptions {
  scope: string;
  events: BullMQQueueEvents;
  queue?: BullMQQueue;
  jobName?: string | ((command: DispatchCommand) => string);
  /** Must produce a BullMQ-safe stable ID. `:` is deliberately refused. */
  jobId?: (command: DispatchCommand) => string;
  jobOptions?: (command: DispatchCommand) => Record<string, unknown>;
  progress?: (event: BullMQEvent) => TaskProgress | undefined;
  terminalFailure?: (event: BullMQEvent) => Promise<boolean> | boolean;
  resultReference?: (event: BullMQEvent) => Promise<string | undefined> | string | undefined;
  inspect?: (ref: RuntimeRef) => Promise<BullMQTaskObservation | undefined>;
  cancel?: (ref: RuntimeRef) => Promise<CancelResult>;
  health?: () => Promise<RuntimeHealth>;
  onError?: (error: unknown, event: BullMQEvent) => void;
}

/** BullMQ translation/control adapter for the portable runtime integration. */
export class BullMQRuntimeAdapter implements RuntimeAdapter {
  readonly name = 'bullmq';
  readonly scope: string;
  readonly capabilities;
  private readonly listeners = new Map<BullMQRuntimeEventName, (event: BullMQEvent) => void>();
  private lastProjectionError?: { at: string; reason: string };

  constructor(private readonly options: BullMQRuntimeAdapterOptions) {
    this.scope = options?.scope?.trim();
    if (!this.scope) throw new TypeError('BullMQRuntimeAdapter requires scope');
    if (!options.events || typeof options.events.on !== 'function') {
      throw new TypeError('BullMQRuntimeAdapter requires QueueEvents');
    }
    if (options.queue && (!options.jobName || !options.jobId)) {
      throw new TypeError('BullMQRuntimeAdapter dispatch requires jobName and jobId');
    }
    this.capabilities = {
      events: 'push' as const,
      dispatch: Boolean(options.queue),
      inspect: Boolean(options.inspect),
      cancel: options.cancel ? 'best_effort' as const : 'unsupported' as const,
      progress: Boolean(options.progress),
      stableAttempts: false,
      dispatchPolicies: { delay: true, priority: true },
    };
  }

  async subscribe(sink: RuntimeEventSink): Promise<Disposable> {
    if (this.listeners.size > 0) throw new Error('BullMQRuntimeAdapter is already subscribed');
    for (const name of ['waiting', 'active', 'progress', 'completed', 'failed', 'delayed'] as const) {
      const listener = (event: BullMQEvent): void => {
        void this.translate(name, event).then((translated) => {
          if (translated) return sink.observe(translated);
          return undefined;
        }).catch((error: unknown) => {
          this.lastProjectionError = {
            at: new Date().toISOString(),
            reason: error instanceof Error ? error.message : String(error),
          };
          try { this.options.onError?.(error, event); } catch { /* error reporting cannot crash QueueEvents */ }
        });
      };
      this.listeners.set(name, listener);
      this.options.events.on(name, listener);
    }
    return { dispose: () => {
      for (const [name, listener] of this.listeners) this.options.events.off?.(name, listener);
      this.listeners.clear();
    } };
  }

  async dispatch(command: DispatchCommand): Promise<DispatchReceipt> {
    const queue = this.options.queue;
    if (!queue || !this.options.jobName || !this.options.jobId) {
      throw new TypeError('BullMQRuntimeAdapter does not support dispatch');
    }
    const jobId = this.options.jobId(command).trim();
    if (!jobId) throw new TypeError('BullMQRuntimeAdapter jobId must be non-empty');
    if (jobId.includes(':')) throw new TypeError('BullMQ custom jobId must not contain :');
    const name = typeof this.options.jobName === 'function' ? this.options.jobName(command) : this.options.jobName;
    if (!name.trim()) throw new TypeError('BullMQRuntimeAdapter jobName must be non-empty');
    const result = await queue.add(name, command.payload, {
      ...(this.options.jobOptions?.(command) ?? {}),
      ...(command.retry ? {
        attempts: command.retry.maxAttempts,
        ...(command.retry.backoff ? { backoff: command.retry.backoff } : {}),
      } : {}),
      ...(command.delayMs === undefined ? {} : { delay: command.delayMs }),
      ...(command.priority === undefined ? {} : { priority: command.priority }),
      jobId,
    });
    const externalId = result?.id === undefined ? jobId : String(result.id);
    if (externalId !== jobId) {
      throw new Error(`BullMQ returned job id ${JSON.stringify(externalId)} for reserved id ${JSON.stringify(jobId)}`);
    }
    return { ref: { runtime: 'bullmq', scope: this.scope, externalId } };
  }

  ref(externalId: string): RuntimeRef {
    if (!externalId?.trim()) throw new TypeError('BullMQ externalId must be non-empty');
    return { runtime: 'bullmq', scope: this.scope, externalId };
  }

  async inspect(ref: RuntimeRef): Promise<RuntimeObservation> {
    if (!this.options.inspect) throw new TypeError('BullMQRuntimeAdapter does not support inspect');
    this.assertRef(ref);
    const observedAt = new Date().toISOString();
    const observation = await this.options.inspect(ref);
    if (!observation) {
      return { ref, state: 'unknown', terminal: false, observedAt, reason: 'event_gap' };
    }
    const base = {
      ref, observedAt,
      ...(observation.attempt === undefined ? {} : { attempt: observation.attempt }),
    };
    switch (observation.state) {
      case 'waiting': return { ...base, state: 'accepted', terminal: false };
      case 'active': return { ...base, state: 'running', terminal: false };
      case 'completed': {
        const resultRef = await this.options.resultReference?.(observation);
        return { ...base, state: 'succeeded', terminal: true, ...(resultRef ? { resultRef } : {}) };
      }
      case 'failed': return {
        ...base, state: 'failed', terminal: observation.terminal === true,
        ...(observation.failedReason ? { reason: observation.failedReason } : {}),
      };
    }
  }

  cancel(ref: RuntimeRef): Promise<CancelResult> {
    if (!this.options.cancel) throw new TypeError('BullMQRuntimeAdapter does not support cancel');
    this.assertRef(ref);
    return this.options.cancel(ref);
  }

  async health(): Promise<RuntimeHealth> {
    if (this.lastProjectionError) {
      return {
        status: 'degraded', checkedAt: new Date().toISOString(),
        reason: `runtime event projection failed at ${this.lastProjectionError.at}: ${this.lastProjectionError.reason}`,
      };
    }
    return this.options.health
      ? await this.options.health()
      : {
        status: 'unknown', checkedAt: new Date().toISOString(), reason: 'BullMQ health reader is not configured',
      };
  }

  private async translate(name: BullMQRuntimeEventName, event: BullMQEvent): Promise<RuntimeEvent | undefined> {
    if (!event?.jobId?.trim()) throw new TypeError(`BullMQ ${name} event requires jobId`);
    const base = {
      ref: { runtime: 'bullmq', scope: this.scope, externalId: event.jobId },
      occurredAt: new Date().toISOString(),
      ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
    };
    switch (name) {
      case 'waiting': return { ...base, type: 'accepted' };
      case 'active': return { ...base, type: 'started' };
      case 'progress': {
        const progress = this.options.progress?.(event);
        return progress ? { ...base, type: 'progressed', progress } : undefined;
      }
      case 'completed': {
        const resultRef = await this.options.resultReference?.(event);
        return { ...base, type: 'succeeded', ...(resultRef ? { resultRef } : {}) };
      }
      case 'failed': return {
        ...base, type: 'failed', terminal: await this.options.terminalFailure?.(event) ?? false,
        ...(event.failedReason ? { reason: event.failedReason } : {}),
      };
      case 'delayed': return {
        ...base, type: 'attempt_ended', outcome: 'failed',
        ...(event.failedReason ? { reason: event.failedReason } : {}),
      };
    }
  }

  private assertRef(ref: RuntimeRef): void {
    if (ref.runtime !== 'bullmq' || ref.scope !== this.scope) {
      throw new TypeError('RuntimeRef does not belong to this BullMQ adapter');
    }
  }
}

export function createBullMQRuntimeAdapter(options: BullMQRuntimeAdapterOptions): BullMQRuntimeAdapter {
  return new BullMQRuntimeAdapter(options);
}
