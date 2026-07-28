/**
 * The whole SDK, in one file.
 *
 * Everything that has to be correct - claiming, ordering, leases, fencing,
 * retry classification, the effect ledger - lives in the Agent. A client in any
 * language only has to do four things: enqueue, receive work, report the
 * result, and record effects. That is why this file has no dependencies and no
 * state machine: a lease bug written once in Go is a lease bug fixed once,
 * instead of one per language.
 *
 * Porting this to Python, Java or C# means rewriting these ~200 lines, not
 * re-implementing a queue.
 */

export const PROTOCOL_VERSION = '1.0';

/** What this client can do. The Agent refuses a client that cannot fence. */
export const CLIENT_CAPABILITIES = [
  'claim',
  'heartbeat',
  'fencing',
  'cancel',
  'effect',
  'batch-claim',
] as const;

export type RetryClass =
  | 'transient'
  | 'permanent'
  | 'rate_limited'
  | 'dependency_down'
  | 'cancelled'
  | 'unknown';

export interface LeaseToken {
  jobId: string;
  owner: string;
  epoch: number;
}

export interface LeasedJob {
  job: { id: string; name: string; state: string; attempts: number; correlationId: string };
  /** Base64 in transit; decoded for you by `claim`. */
  payload: Uint8Array;
  lease: LeaseToken;
  expiresAt: string;
}

export interface AttemptEvent {
  sequence: number;
  jobId: string;
  attempt: number;
  leaseOwner: string;
  leaseEpoch: number;
  kind:
    | 'claimed'
    | 'succeeded'
    | 'retry_scheduled'
    | 'dead'
    | 'blocked'
    | 'cancelled'
    | 'released'
    | 'lease_expired';
  resultState?: string;
  failureClass?: RetryClass;
  blockedReason?: string;
  occurredAt: string;
}

export interface EnqueueRequest {
  name: string;
  payload: unknown;
  idempotencyKey?: string;
  correlationId?: string;
  priority?: number;
  class?: 'critical' | 'interactive' | 'standard' | 'batch' | 'maintenance';
  runAfterMs?: number;
}

export interface EffectRequest {
  name: string;
  key: string;
  irreversible?: boolean;
  confirm?: 'on-return' | 'external-signal' | 'verify' | 'predicate';
  completedStatus?: string;
}

export interface HandshakeResult {
  result: 'compatible' | 'degraded' | 'rejected';
  protocolVersion: string;
  capabilities: string[];
  missing?: string[];
  disabled?: string[];
  reason?: string;
  heartbeatIntervalMs: number;
  maxPayloadBytes: number;
}

/**
 * A RhinoQ error, already classified by the Agent. `retryable` says whether
 * repeating the same request could work; `retryAfterMs` says when.
 */
export class RhinoqError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RhinoqError';
  }
}

export interface ClientOptions {
  /** Agent base URL, for example http://localhost:8080 */
  url: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export class RhinoqClient {
  private readonly url: string;
  private readonly token?: string;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    this.url = options.url.replace(/\/$/, '');
    this.token = options.token;
    this.doFetch = options.fetch ?? globalThis.fetch;
  }

  /**
   * Agree on a protocol before doing anything else. A `degraded` result is not
   * an error, but it must be logged: the worker is running with named features
   * turned off, and an operator has to be able to see that.
   */
  async handshake(): Promise<HandshakeResult> {
    return this.send<HandshakeResult>('POST', '/v1/handshake', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [...CLIENT_CAPABILITIES],
      payloadCodec: 'json',
      language: 'typescript',
    });
  }

  async enqueue(request: EnqueueRequest): Promise<string> {
    const response = await this.send<{ jobId: string }>('POST', '/v1/jobs', {
      ...request,
      payload: encodePayload(request.payload),
    });
    return response.jobId;
  }

  async cancel(jobId: string): Promise<void> {
    await this.send('POST', `/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {});
  }

  async counts(queue: string): Promise<Record<string, number>> {
    const response = await this.send<{ counts: Record<string, number> }>(
      'GET',
      `/v1/queues/${encodeURIComponent(queue)}/counts`,
    );
    return response.counts;
  }

  async attempts(jobId: string, offset = 0, limit = 50): Promise<AttemptEvent[]> {
    const response = await this.send<{ attempts: AttemptEvent[] }>(
      'GET',
      `/v1/jobs/${encodeURIComponent(jobId)}/attempts?offset=${offset}&limit=${limit}`,
    );
    return response.attempts;
  }

  async claim(worker: string, limit: number, leaseForMs = 60_000): Promise<LeasedJob[]> {
    const response = await this.send<{ jobs: (Omit<LeasedJob, 'payload'> & { payload: string })[] }>(
      'POST',
      '/v1/claim',
      { worker, limit, leaseForMs },
    );
    return (response.jobs ?? []).map((job) => ({ ...job, payload: decodePayload(job.payload) }));
  }

  /** Renewing a lease also tells you whether the job has been cancelled. */
  async heartbeat(lease: LeaseToken, extendMs = 60_000): Promise<{ expiresAt: string; cancelRequested: boolean }> {
    return this.send('POST', '/v1/leases/heartbeat', { lease, extendMs });
  }

  async complete(lease: LeaseToken): Promise<void> {
    await this.send('POST', '/v1/leases/complete', { lease });
  }

  /** Hand back a job that was claimed but never started. */
  async release(lease: LeaseToken): Promise<void> {
    await this.send('POST', '/v1/leases/release', { lease });
  }

  /**
   * Report a failure. Classifying the error is the client's job; deciding what
   * happens to the job is the Agent's. An unclassified error becomes `unknown`,
   * which is retried cautiously and then parked - never retried blindly.
   */
  async fail(lease: LeaseToken, queue: string, error: unknown, retryClass: RetryClass = 'unknown'): Promise<void> {
    await this.send('POST', '/v1/leases/fail', {
      lease,
      queue,
      error: {
        type: error instanceof Error ? error.name : typeof error,
        retryClass,
        message: error instanceof Error ? error.message : String(error),
        language: 'typescript',
      },
    });
  }

  /**
   * Run an external side effect under the ledger. The Agent decides whether the
   * call may happen at all: an effect a previous attempt already confirmed is
   * skipped, and one it left uncertain stops the job instead of charging twice.
   */
  async effect<T>(
    lease: LeaseToken,
    request: EffectRequest,
    run: () => Promise<{ reference: string; value: T }>,
  ): Promise<T | undefined> {
    try {
      await this.send('POST', '/v1/effects/begin', { lease, effect: request });
    } catch (error) {
      if (error instanceof RhinoqError && error.code === 'RHINOQ_EFFECT_ALREADY_CONFIRMED') {
        return undefined;
      }
      throw error;
    }

    let outcome: { reference: string; value: T };
    try {
      outcome = await run();
    } catch (error) {
      // An unknown result is not a failure to retry: the provider may have done
      // the work. Say so, and let an operator decide.
      await this.send('POST', '/v1/effects/resolve', {
        lease,
        effect: request,
        outcome: isNeverHappened(error) ? 'not-happened' : 'unknown',
      });
      throw error;
    }
    await this.send('POST', '/v1/effects/resolve', {
      lease,
      effect: request,
      reference: outcome.reference,
      outcome: 'succeeded',
    });
    return outcome.value;
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.doFetch(`${this.url}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const envelope = parsed as { error?: { code: string; message: string; retryable: boolean; retryAfterMs?: number } };
      const detail = envelope.error;
      throw new RhinoqError(
        detail?.code ?? 'RHINOQ_UNKNOWN',
        detail?.message ?? text,
        detail?.retryable ?? false,
        detail?.retryAfterMs,
        response.status,
      );
    }
    return parsed as T;
  }
}

/** Mark an error as one that provably never reached the provider. */
const NEVER_HAPPENED = Symbol.for('rhinoq.neverHappened');

export function neverHappened<E extends object>(error: E): E {
  return Object.assign(error, { [NEVER_HAPPENED]: true });
}

function isNeverHappened(error: unknown): boolean {
  return typeof error === 'object' && error !== null && NEVER_HAPPENED in error;
}

function encodePayload(payload: unknown): string {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function decodePayload(payload: string): Uint8Array {
  return Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
}
