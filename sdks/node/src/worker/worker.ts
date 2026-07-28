import { RhinoQClient, RhinoQError } from '../gateway/client.js';
import { MAX_CLAIM_BATCH } from '../gateway/types.js';
import type {
  EffectRequest,
  HandshakeResult,
  LeaseToken,
  LeasedJob,
  RetryClass,
} from '../gateway/types.js';
import {
  ClassifiedError,
  PayloadDecodeError,
} from './errors.js';

export interface WorkerGateway {
  connect(): Promise<HandshakeResult>;
  claim(
    worker: string,
    limit: number,
    leaseForMs?: number,
    queues?: string[],
  ): Promise<LeasedJob[]>;
  heartbeat(
    lease: LeaseToken,
    extendMs?: number,
  ): Promise<{ expiresAt: string; cancelRequested: boolean }>;
  complete(lease: LeaseToken): Promise<void>;
  release(lease: LeaseToken): Promise<void>;
  fail(
    lease: LeaseToken,
    queue: string,
    error: unknown,
    options?: { retryClass?: RetryClass; retryAfterMs?: number },
  ): Promise<void>;
  effect<T>(
    lease: LeaseToken,
    request: EffectRequest,
    run: () => Promise<{ reference: string; value: T }>,
  ): Promise<T | undefined>;
}

export interface RhinoQWorkerOptions {
  client: RhinoQClient | WorkerGateway;
  /** Stable process identity written into every lease. */
  name: string;
  concurrency?: number;
  maxClaimBatch?: number;
  leaseForMs?: number;
  /** Defaults to the interval negotiated with the Gateway. */
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  shutdownGraceMs?: number;
  cancelGraceMs?: number;
  onError?: (error: unknown) => void;
}

export interface WorkerRunOptions {
  signal?: AbortSignal;
}

export type JobHandler<T = unknown> = (job: NodeJob<T>) => void | Promise<void>;

/**
 * Handlers are keyed by lane and contract together. NUL is the separator
 * because the engine rejects it inside either name, so two different pairs can
 * never produce the same key. A printable separator would let ("a b", "c") and
 * ("a", "b c") collide and silently route work to the wrong handler.
 */
const ROUTE_SEPARATOR = String.fromCharCode(0);

function routeKey(queueName: string, jobName: string): string {
  return `${queueName}${ROUTE_SEPARATOR}${jobName}`;
}

export class NodeJob<T = unknown> {
  readonly id: string;
  /** The execution lane this job was claimed from. */
  readonly queueName: string;
  /** The handler contract that routed it here. */
  readonly jobName: string;
  /** The business partition, usually a tenant. May be undefined. */
  readonly groupKey?: string;
  readonly attempts: number;
  readonly correlationId?: string;
  readonly rawPayload: Uint8Array;
  readonly signal: AbortSignal;

  private readonly lease: LeaseToken;
  private readonly client: WorkerGateway;
  private parsed = false;
  private parsedValue?: T;

  constructor(
    leased: LeasedJob,
    signal: AbortSignal,
    client: WorkerGateway,
  ) {
    this.id = leased.job.id;
    this.queueName = leased.job.queueName;
    this.jobName = leased.job.jobName;
    this.groupKey = leased.job.groupKey;
    this.attempts = leased.job.attempts;
    this.correlationId = leased.job.correlationId;
    this.rawPayload = leased.payload;
    this.signal = signal;
    this.lease = leased.lease;
    this.client = client;
  }

  /** Lazily decode the canonical JSON payload. */
  get data(): T {
    if (!this.parsed) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(this.rawPayload);
        this.parsedValue = JSON.parse(text) as T;
        this.parsed = true;
      } catch (error) {
        throw new PayloadDecodeError(this.jobName, error);
      }
    }
    return this.parsedValue as T;
  }

  effect<R>(
    request: EffectRequest,
    run: () => Promise<{ reference: string; value: R }>,
  ): Promise<R | undefined> {
    return this.client.effect(this.lease, request, run);
  }
}

interface Execution {
  controller: AbortController;
  heartbeatController: AbortController;
  forceStopped: boolean;
}

interface ExecutionOutcome {
  leaseUnsafe: boolean;
  cancelRequested: boolean;
}

export class RhinoQWorker {
  private readonly client: WorkerGateway;
  private readonly name: string;
  private readonly concurrency: number;
  private readonly maxClaimBatch: number;
  private readonly leaseForMs: number;
  private readonly configuredHeartbeatMs?: number;
  private readonly pollIntervalMs: number;
  private readonly maxPollIntervalMs: number;
  private readonly shutdownGraceMs: number;
  private readonly cancelGraceMs: number;
  private readonly onError?: (error: unknown) => void;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly active = new Set<Promise<void>>();
  private readonly executions = new Map<string, Execution>();

  private running = false;
  private stopping = false;
  private loopAbort?: AbortController;
  private heartbeatIntervalMs = 0;

  constructor(options: RhinoQWorkerOptions) {
    if (!options.client) {
      throw new TypeError('RhinoQ client is required');
    }
    if (!options.name) {
      throw new TypeError('worker name is required');
    }
    this.client = options.client;
    this.name = options.name;
    this.concurrency = positiveInteger(options.concurrency ?? 4, 'concurrency');
    this.maxClaimBatch = positiveInteger(options.maxClaimBatch ?? 50, 'maxClaimBatch');
    if (this.maxClaimBatch > MAX_CLAIM_BATCH) {
      throw new RangeError(`maxClaimBatch must not exceed ${MAX_CLAIM_BATCH}`);
    }
    this.leaseForMs = positiveNumber(options.leaseForMs ?? 60_000, 'leaseForMs');
    this.configuredHeartbeatMs = options.heartbeatIntervalMs;
    this.pollIntervalMs = positiveNumber(options.pollIntervalMs ?? 100, 'pollIntervalMs');
    this.maxPollIntervalMs = positiveNumber(
      options.maxPollIntervalMs ?? 2_000,
      'maxPollIntervalMs',
    );
    if (this.maxPollIntervalMs < this.pollIntervalMs) {
      throw new RangeError('maxPollIntervalMs must be at least pollIntervalMs');
    }
    this.shutdownGraceMs = positiveNumber(
      options.shutdownGraceMs ?? 30_000,
      'shutdownGraceMs',
    );
    this.cancelGraceMs = positiveNumber(options.cancelGraceMs ?? 10_000, 'cancelGraceMs');
    this.onError = options.onError;
  }

  /**
   * Bind a handler to one job contract inside one execution lane. The worker
   * claims from the lane and dispatches by contract, so unrelated contracts can
   * share a lane and one contract can be served in several lanes.
   */
  handle<T>(queueName: string, jobName: string, handler: JobHandler<T>): this {
    if (this.running) {
      throw new Error('handlers cannot be changed while the worker is running');
    }
    if (!queueName || !jobName || typeof handler !== 'function') {
      throw new TypeError('handler queue name, job name and function are required');
    }
    const key = routeKey(queueName, jobName);
    if (this.handlers.has(key)) {
      throw new Error(`handler already registered: ${jobName} in queue ${queueName}`);
    }
    // The cap is on lanes, not routes: the lane list is what becomes the claim
    // filter on the wire, so that is what must stay bounded.
    const lanes = this.subscribedQueues();
    if (!lanes.includes(queueName) && lanes.length >= 256) {
      throw new RangeError('a worker may subscribe to at most 256 queues');
    }
    this.handlers.set(key, handler as JobHandler);
    return this;
  }

  private subscribedQueues(): string[] {
    const names = new Set<string>();
    for (const key of this.handlers.keys()) {
      names.add(key.slice(0, key.indexOf(ROUTE_SEPARATOR)));
    }
    return [...names].sort();
  }

  /**
   * Stop claiming and begin graceful shutdown. Running handlers keep their
   * leases during the grace period.
   */
  stop(): void {
    this.stopping = true;
    this.loopAbort?.abort();
  }

  async run(options: WorkerRunOptions = {}): Promise<void> {
    if (this.running) {
      throw new Error('worker is already running');
    }
    if (this.handlers.size === 0) {
      throw new Error('register at least one handler before running the worker');
    }
    this.running = true;
    this.stopping = false;
    this.loopAbort = new AbortController();
    const externalAbort = () => this.stop();
    options.signal?.addEventListener('abort', externalAbort, { once: true });
    if (options.signal?.aborted) {
      externalAbort();
    }

    try {
      if (this.stopping) {
        return;
      }
      const handshake = await this.client.connect();
      if (handshake.result === 'rejected') {
        throw new Error(handshake.reason ?? 'RhinoQ Gateway rejected this SDK');
      }
      if (handshake.result === 'degraded') {
        this.report(new Error(`RhinoQ worker connected in degraded mode: ${handshake.reason}`));
      }
      this.heartbeatIntervalMs = this.configuredHeartbeatMs ?? handshake.heartbeatIntervalMs;
      if (
        !Number.isFinite(this.heartbeatIntervalMs) ||
        this.heartbeatIntervalMs <= 0 ||
        this.heartbeatIntervalMs >= this.leaseForMs
      ) {
        throw new RangeError('heartbeat interval must be positive and shorter than the lease');
      }
      const supportsQueueFilter =
        handshake.capabilities.includes('queue-filter') &&
        !handshake.disabled?.includes('queue-filter');
      const queues = supportsQueueFilter ? this.subscribedQueues() : [];
      if (!supportsQueueFilter) {
        this.report(
          new Error(
            'RhinoQ Gateway does not support queue-filter; unexpected jobs will be released without execution',
          ),
        );
      }
      await this.claimLoop(queues);
    } finally {
      options.signal?.removeEventListener('abort', externalAbort);
      this.stopping = true;
      this.loopAbort?.abort();
      await this.shutdown();
      this.loopAbort = undefined;
      this.running = false;
    }
  }

  private async claimLoop(queues: string[]): Promise<void> {
    let backoff = this.pollIntervalMs;
    while (!this.stopping) {
      const free = this.concurrency - this.active.size;
      if (free <= 0) {
        await this.waitForActiveOrStop();
        continue;
      }

      let jobs: LeasedJob[];
      try {
        jobs = await this.client.claim(
          this.name,
          Math.min(free, this.maxClaimBatch),
          this.leaseForMs,
          queues,
        );
      } catch (error) {
        if (this.stopping) {
          break;
        }
        this.report(error);
        if (error instanceof RhinoQError && !error.retryable) {
          throw error;
        }
        if (!(await wait(backoff, this.loopAbort?.signal))) {
          break;
        }
        backoff = Math.min(backoff * 2, this.maxPollIntervalMs);
        continue;
      }

      if (jobs.length === 0) {
        if (!(await wait(backoff, this.loopAbort?.signal))) {
          break;
        }
        backoff = Math.min(backoff * 2, this.maxPollIntervalMs);
        continue;
      }
      backoff = this.pollIntervalMs;
      for (const job of jobs) {
        if (this.stopping) {
          await this.safeRelease(job.lease);
          continue;
        }
        if (!this.handlers.has(routeKey(job.job.queueName, job.job.jobName))) {
          this.report(
            new Error(
              `Gateway returned unregistered route ${job.job.queueName}/${job.job.jobName}; releasing it without execution`,
            ),
          );
          await this.safeRelease(job.lease);
          continue;
        }
        this.dispatch(job);
      }
    }
  }

  private dispatch(job: LeasedJob): void {
    const task = this.process(job)
      .catch((error) => this.report(error))
      .finally(() => {
        this.active.delete(task);
      });
    this.active.add(task);
  }

  private async process(leased: LeasedJob): Promise<void> {
    const execution: Execution = {
      controller: new AbortController(),
      heartbeatController: new AbortController(),
      forceStopped: false,
    };
    this.executions.set(leased.job.id, execution);
    const outcome: ExecutionOutcome = {
      leaseUnsafe: false,
      cancelRequested: false,
    };
    const heartbeat = this.heartbeat(
      leased,
      execution,
      outcome,
      execution.heartbeatController.signal,
    );

    let handlerError: unknown;
    try {
      const handler = this.handlers.get(routeKey(leased.job.queueName, leased.job.jobName));
      if (!handler) {
        await this.safeRelease(leased.lease);
        return;
      }
      await handler(new NodeJob(leased, execution.controller.signal, this.client));
    } catch (error) {
      handlerError = error;
    } finally {
      execution.heartbeatController.abort();
      await heartbeat;
      this.executions.delete(leased.job.id);
    }

    if (outcome.leaseUnsafe) {
      return;
    }
    if (outcome.cancelRequested) {
      await this.client.fail(leased.lease, leased.job.jobName, new Error("job was cancelled"), {
        retryClass: 'cancelled',
      });
      return;
    }
    if (execution.forceStopped) {
      await this.client.fail(
        leased.lease,
        leased.job.jobName,
        new Error('worker shutdown grace expired'),
        { retryClass: 'transient' },
      );
      return;
    }
    if (handlerError !== undefined) {
      const classified = classifyHandlerError(handlerError);
      await this.client.fail(leased.lease, leased.job.jobName, handlerError, classified);
      return;
    }
    await this.client.complete(leased.lease);
  }

  private async heartbeat(
    leased: LeasedJob,
    execution: Execution,
    outcome: ExecutionOutcome,
    stop: AbortSignal,
  ): Promise<void> {
    while (await wait(this.heartbeatIntervalMs, stop)) {
      try {
        const state = await this.client.heartbeat(leased.lease, this.leaseForMs);
        if (state.cancelRequested) {
          outcome.cancelRequested = true;
          execution.controller.abort(new Error('job was cancelled'));
          return;
        }
      } catch (error) {
        // Without a successful renewal the SDK cannot prove it still owns the
        // job. Stop the handler and let the server-side lease/reaper decide.
        outcome.leaseUnsafe = true;
        execution.controller.abort(error);
        this.report(error);
        return;
      }
    }
  }

  private async waitForActiveOrStop(): Promise<void> {
    if (this.active.size === 0) {
      return;
    }
    await Promise.race([
      ...this.active,
      aborted(this.loopAbort?.signal),
    ]);
  }

  private async shutdown(): Promise<void> {
    if (await settle(this.active, this.shutdownGraceMs)) {
      return;
    }
    for (const execution of this.executions.values()) {
      execution.forceStopped = true;
      execution.controller.abort(new Error('worker shutdown grace expired'));
      execution.heartbeatController.abort();
    }
    if (!(await settle(this.active, this.cancelGraceMs))) {
      this.report(
        new Error(
          `${this.active.size} handler(s) ignored cancellation; their leases will expire server-side`,
        ),
      );
    }
  }

  private async safeRelease(lease: LeaseToken): Promise<void> {
    try {
      await this.client.release(lease);
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Observability callbacks must never stop lease processing.
    }
  }
}

function classifyHandlerError(
  error: unknown,
): { retryClass: RetryClass; retryAfterMs?: number } {
  if (error instanceof PayloadDecodeError) {
    return { retryClass: 'permanent' };
  }
  if (error instanceof ClassifiedError) {
    return {
      retryClass: error.retryClass,
      retryAfterMs: error.retryAfterMs,
    };
  }
  return { retryClass: 'unknown' };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be positive`);
  }
  return value;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve(true);
    }, milliseconds);
    const stop = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

function aborted(signal?: AbortSignal): Promise<void> {
  if (!signal || signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

async function settle(active: Set<Promise<void>>, timeoutMs: number): Promise<boolean> {
  if (active.size === 0) {
    return true;
  }
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        resolve(false);
      }
    }, timeoutMs);
    void Promise.allSettled([...active]).then(() => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
}
