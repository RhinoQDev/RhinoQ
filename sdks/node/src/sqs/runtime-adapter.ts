import type {
  CancelResult, DispatchCommand, DispatchReceipt, RuntimeAdapter, RuntimeEvent,
  RuntimeHealth, RuntimeObservation, RuntimeRef,
} from '../runtime/contracts.js';

/** Minimal SQS message shape; the SDK deliberately does not own an AWS client. */
export interface SQSMessage {
  messageId: string;
  receiptHandle?: string;
  body?: unknown;
  attributes?: Record<string, string | undefined>;
}

export interface SQSReceiveObservation {
  message: SQSMessage;
  state: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  observedAt?: string;
  terminal?: boolean;
  resultRef?: string;
  reason?: string;
  progress?: { completed: number; total?: number };
}

export interface SQSRuntimeAdapterOptions {
  /** Queue URL or another application-owned scope. */
  scope: string;
  /** Optional application-owned send operation for Control mode. */
  send?: (input: { body: unknown; idempotencyKey: string; command: DispatchCommand }) => Promise<{ messageId: string }>;
  /** Optional application-owned readback; SQS itself cannot inspect by MessageId. */
  inspect?: (ref: RuntimeRef) => Promise<SQSReceiveObservation | undefined>;
  health?: () => Promise<RuntimeHealth>;
  /** Declare only policies the application-owned send callback actually applies. */
  dispatchPolicies?: { delay?: boolean; priority?: boolean };
}

/**
 * SQS proof adapter. Receive count is a redelivery signal, not a promise that
 * the handler ran exactly once. Cancellation is always unsupported because a
 * receipt handle can only delete a message after a consumer has received it.
 */
export class SQSRuntimeAdapter implements RuntimeAdapter {
  readonly name = 'sqs';
  readonly scope: string;
  readonly capabilities;

  constructor(private readonly options: SQSRuntimeAdapterOptions) {
    this.scope = options?.scope?.trim();
    if (!this.scope) throw new TypeError('SQSRuntimeAdapter requires scope');
    if (options.send && typeof options.send !== 'function') throw new TypeError('SQS send must be a function');
    if (options.inspect && typeof options.inspect !== 'function') throw new TypeError('SQS inspect must be a function');
    this.capabilities = {
      events: 'poll' as const,
      dispatch: Boolean(options.send),
      inspect: Boolean(options.inspect),
      cancel: 'unsupported' as const,
      progress: true,
      stableAttempts: false,
      dispatchPolicies: {
        delay: options.dispatchPolicies?.delay === true,
        priority: options.dispatchPolicies?.priority === true,
      },
    };
  }

  /** Translate one received message into a portable lifecycle event. */
  observeReceipt(input: SQSReceiveObservation): RuntimeEvent {
    const { message } = input;
    if (!message?.messageId?.trim()) throw new TypeError('SQS messageId is required');
    const observedAt = input.observedAt ?? new Date().toISOString();
    const ref = this.ref(message.messageId);
    const attempt = receiveCount(message);
    const base = {
      ref,
      occurredAt: observedAt,
      ...(attempt === undefined ? {} : { attempt }),
      ...(message.attributes?.SentTimestamp ? { eventId: `sqs:${message.messageId}:${message.attributes.SentTimestamp}:${attempt ?? 1}:${input.state}` } : {}),
    };
    if (input.progress && (input.state === 'accepted' || input.state === 'running')) {
      return { ...base, type: 'progressed', progress: input.progress };
    }
    switch (input.state) {
      case 'accepted': return { ...base, type: 'accepted' };
      case 'running': return { ...base, type: 'started' };
      case 'succeeded': return { ...base, type: 'succeeded', ...(input.resultRef ? { resultRef: input.resultRef } : {}) };
      case 'cancelled': return { ...base, type: 'cancelled' };
      case 'failed':
        if (input.terminal === undefined) throw new TypeError('SQS failed observation must supply terminal');
        return { ...base, type: 'failed', terminal: input.terminal, ...(input.reason ? { reason: input.reason } : {}) };
      case 'unknown':
        return { ...base, type: 'uncertain', reason: input.reason?.trim() || 'runtime_unreachable' };
    }
  }

  async dispatch(command: DispatchCommand): Promise<DispatchReceipt> {
    if (!this.options.send) throw new TypeError('SQS adapter does not support dispatch');
    const result = await this.options.send({ body: command.payload, idempotencyKey: command.idempotencyKey, command });
    if (!result?.messageId?.trim()) throw new Error('SQS send returned no messageId; dispatch outcome is uncertain');
    return { ref: this.ref(result.messageId) };
  }

  async inspect(ref: RuntimeRef): Promise<RuntimeObservation> {
    if (!this.options.inspect) throw new TypeError('SQS adapter does not support inspect');
    this.assertRef(ref);
    const observedAt = new Date().toISOString();
    const result = await this.options.inspect(ref);
    if (!result) return { ref, state: 'unknown', terminal: false, observedAt, reason: 'event_gap' };
    const event = this.observeReceipt({ ...result, observedAt });
    switch (event.type) {
      case 'accepted': return { ref, state: 'accepted', terminal: false, observedAt, ...(event.attempt ? { attempt: event.attempt } : {}) };
      case 'started': return { ref, state: 'running', terminal: false, observedAt, ...(event.attempt ? { attempt: event.attempt } : {}) };
      case 'progressed': return {
        ref,
        state: result.state === 'accepted' ? 'accepted' : result.state === 'running' ? 'running' : 'unknown',
        terminal: result.terminal === true,
        observedAt,
        ...(event.attempt ? { attempt: event.attempt } : {}),
        progress: event.progress,
        ...(result.state === 'unknown' ? { reason: result.reason?.trim() || 'event_gap' } : {}),
      };
      case 'succeeded': return { ref, state: 'succeeded', terminal: true, observedAt, ...(event.attempt ? { attempt: event.attempt } : {}), ...(event.resultRef ? { resultRef: event.resultRef } : {}) };
      case 'failed': return { ref, state: 'failed', terminal: event.terminal, observedAt, ...(event.attempt ? { attempt: event.attempt } : {}), ...(event.reason ? { reason: event.reason } : {}) };
      case 'cancelled': return { ref, state: 'cancelled', terminal: true, observedAt, ...(event.attempt ? { attempt: event.attempt } : {}) };
      case 'uncertain': return { ref, state: 'unknown', terminal: false, observedAt, reason: event.reason };
      default: return { ref, state: 'unknown', terminal: false, observedAt, reason: 'event_gap' };
    }
  }

  async health(): Promise<RuntimeHealth> {
    return this.options.health
      ? this.options.health()
      : { status: 'unknown', checkedAt: new Date().toISOString(), reason: 'SQS health reader is not configured' };
  }

  /** Explicit fail-closed cancellation surface for callers that probe it. */
  cancel(_ref: RuntimeRef): Promise<CancelResult> {
    return Promise.resolve({ status: 'unsupported', reason: 'SQS cannot cancel a message by MessageId; delete requires a current receipt handle' });
  }

  ref(messageId: string): RuntimeRef {
    if (!messageId?.trim()) throw new TypeError('SQS messageId is required');
    return { runtime: this.name, scope: this.scope, externalId: messageId };
  }

  private assertRef(ref: RuntimeRef): void {
    if (ref.runtime !== this.name || ref.scope !== this.scope) throw new TypeError('RuntimeRef does not belong to this SQS adapter');
  }
}

export function createSQSRuntimeAdapter(options: SQSRuntimeAdapterOptions): SQSRuntimeAdapter {
  return new SQSRuntimeAdapter(options);
}

function receiveCount(message: SQSMessage): number | undefined {
  const raw = message.attributes?.ApproximateReceiveCount;
  if (raw === undefined) return undefined;
  const count = Number(raw);
  return Number.isInteger(count) && count > 0 ? count : undefined;
}
