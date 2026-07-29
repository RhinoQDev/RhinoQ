import {
  CLIENT_CAPABILITIES,
  MAX_CLAIM_BATCH,
  PROTOCOL_VERSION,
  SDK_VERSION,
  type AuditRecord,
  type AttentionItem,
  type AttentionQuery,
  type AttemptEvent,
  type EffectRequest,
  type EffectResult,
  type EnqueueRequest,
  type FailureOptions,
  type FindingKey,
  type FindingQuery,
  type FindingRecord,
  type FindingTransition,
  type HandshakeResult,
  type JobQuery,
  type JobSummary,
  type LeaseToken,
  type LeasedJob,
  type TaskCreateRequest,
  type TaskExecutionBinding,
  type TaskExecutionCreateRequest,
	  type TaskExecution,
  type TaskProgress,
  type TaskResult,
  type TaskSnapshot,
  type TaskState,
} from './types.js';

export class RhinoQError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;

  constructor(
    code: string,
    message: string,
    retryable: boolean,
    options: { retryAfterMs?: number; status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'RhinoQError';
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
  }
}

export interface ClientOptions {
  /** HTTP Gateway base URL, for example http://localhost:8080. */
  url: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  /** Bounds each HTTP call. Defaults to 10 seconds. */
  timeoutMs?: number;
}

export class RhinoQClient {
  private readonly url: string;
  private readonly token?: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private connection?: Promise<HandshakeResult>;

  constructor(options: ClientOptions) {
    const url = options.url?.replace(/\/+$/, '');
    if (!url) {
      throw new TypeError('RhinoQ Gateway URL is required');
    }
    if (typeof (options.fetch ?? globalThis.fetch) !== 'function') {
      throw new TypeError('global fetch is unavailable; RhinoQ Node requires Node.js 22 or newer');
    }
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new RangeError('timeoutMs must be a positive number');
    }
    this.url = url;
    this.token = options.token;
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** Negotiate and cache the wire contract before starting a worker. */
  connect(): Promise<HandshakeResult> {
    this.connection ??= this.handshake().catch((error) => {
      this.connection = undefined;
      throw error;
    });
    return this.connection;
  }

  async handshake(): Promise<HandshakeResult> {
    return this.send<HandshakeResult>('POST', '/v1/handshake', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [...CLIENT_CAPABILITIES],
      payloadCodec: 'json',
      language: 'node',
      sdkVersion: SDK_VERSION,
    });
  }

  async enqueue<T>(request: EnqueueRequest<T>): Promise<string> {
    validateEnqueue(request);
    const response = await this.send<{ jobId: string }>('POST', '/v1/jobs', {
      ...request,
      payload: encodePayload(request.payload),
    });
    return response.jobId;
  }

  async createTask(request: TaskCreateRequest): Promise<TaskSnapshot> {
    if (!request?.id || !request.type) {
      throw new TypeError('task id and type are required');
    }
    if (!Number.isInteger(request.definitionVersion) || request.definitionVersion <= 0) {
      throw new RangeError('task definitionVersion must be a positive integer');
    }
    return this.send<TaskSnapshot>('POST', '/v1/tasks', request);
  }

  async getTask(taskId: string): Promise<TaskSnapshot> {
    return this.send<TaskSnapshot>(
      'GET',
      `/v1/tasks/${requiredPath(taskId, 'task id')}`,
    );
  }

  async createTaskExecution(
    taskId: string,
    request: TaskExecutionCreateRequest,
  ): Promise<TaskSnapshot> {
    if (!request?.id || !request.runtime) {
      throw new TypeError('execution id and runtime are required');
    }
    return this.send<TaskSnapshot>(
      'POST',
      `/v1/tasks/${requiredPath(taskId, 'task id')}/executions`,
      request,
    );
  }

  async bindTaskExecution(
    executionId: string,
    binding: TaskExecutionBinding,
  ): Promise<TaskSnapshot> {
    if (!binding?.runtime) {
      throw new TypeError('execution runtime is required');
    }
    return this.send<TaskSnapshot>(
      'POST',
      `/v1/task-executions/${requiredPath(executionId, 'execution id')}/bind`,
      binding,
    );
  }

  async lookupTaskExecution(runtime: string, externalId: string): Promise<TaskExecution> {
    if (!runtime?.trim() || !externalId?.trim()) {
      throw new TypeError('execution runtime and external id are required');
    }
    return this.send<TaskExecution>(
      'GET',
      `/v1/task-executions/lookup?${queryString({ runtime, externalId })}`,
    );
  }

  async getTaskExecution(executionId: string): Promise<TaskExecution> {
    return this.send<TaskExecution>(
      'GET',
      `/v1/task-executions/${requiredPath(executionId, 'execution id')}`,
    );
  }

  async transitionTaskExecution(
    executionId: string,
    expectedVersion: number,
    state: string,
  ): Promise<TaskSnapshot> {
    validateEntityVersion(expectedVersion);
    if (!state?.trim()) {
      throw new TypeError('execution state is required');
    }
    return this.send<TaskSnapshot>(
      'POST',
      `/v1/task-executions/${requiredPath(executionId, 'execution id')}/state`,
      { expectedVersion, state },
    );
  }

  async attachTaskResult(
    taskId: string,
    expectedVersion: number,
    reference: string,
  ): Promise<TaskResult> {
    validateEntityVersion(expectedVersion);
    if (!reference?.trim()) {
      throw new TypeError('task result reference is required');
    }
    return this.send<TaskResult>(
      'POST',
      `/v1/tasks/${requiredPath(taskId, 'task id')}/result`,
      { expectedVersion, reference },
    );
  }

  async getTaskResult(taskId: string): Promise<TaskResult> {
    return this.send<TaskResult>(
      'GET',
      `/v1/tasks/${requiredPath(taskId, 'task id')}/result`,
    );
  }

  async transitionTask(
    taskId: string,
    expectedVersion: number,
    state: Exclude<TaskState, 'pending'>,
  ): Promise<TaskSnapshot> {
    validateEntityVersion(expectedVersion);
    return this.send<TaskSnapshot>(
      'POST',
      `/v1/tasks/${requiredPath(taskId, 'task id')}/state`,
      { expectedVersion, state },
    );
  }

  async reportTaskProgress(
    taskId: string,
    expectedVersion: number,
    progress: TaskProgress,
  ): Promise<TaskSnapshot> {
    validateEntityVersion(expectedVersion);
    if (!Number.isInteger(progress?.completed) || progress.completed < 0) {
      throw new RangeError('task progress completed must be a non-negative integer');
    }
    if (progress.total !== undefined &&
      (!Number.isInteger(progress.total) || progress.total < progress.completed)) {
      throw new RangeError('task progress total must be an integer at or above completed');
    }
    return this.send<TaskSnapshot>(
      'POST',
      `/v1/tasks/${requiredPath(taskId, 'task id')}/progress`,
      { expectedVersion, progress },
    );
  }

  async listJobs(query: JobQuery = {}): Promise<JobSummary[]> {
    const response = await this.send<{ jobs: JobSummary[] }>(
      'GET',
      `/v1/jobs?${queryString({
        queueName: query.queueName,
        jobName: query.jobName,
        groupKey: query.groupKey,
        states: query.states?.join(','),
        offset: query.offset,
        limit: query.limit,
      })}`,
    );
    return response.jobs ?? [];
  }

  async cancel(jobId: string): Promise<void> {
    await this.send('POST', `/v1/jobs/${requiredPath(jobId, 'job id')}/cancel`, {});
  }

  async replay(
    jobId: string,
    decision: { actor: string; reason: string },
  ): Promise<{ job: JobSummary; audit: AuditRecord }> {
    if (!decision.actor || !decision.reason) {
      throw new TypeError('replay requires actor and reason');
    }
    return this.send(
      'POST',
      `/v1/jobs/${requiredPath(jobId, 'job id')}/replay`,
      decision,
    );
  }

  async audit(jobId: string, offset = 0, limit = 50): Promise<AuditRecord[]> {
    const response = await this.send<{ audit: AuditRecord[] }>(
      'GET',
      `/v1/jobs/${requiredPath(jobId, 'job id')}/audit?${queryString({ offset, limit })}`,
    );
    return response.audit ?? [];
  }

  async counts(queue: string): Promise<Record<string, number>> {
    const response = await this.send<{ counts: Record<string, number> }>(
      'GET',
      `/v1/queues/${requiredPath(queue, 'queue name')}/counts`,
    );
    return response.counts;
  }

  async pause(queue: string): Promise<void> {
    await this.send('POST', `/v1/queues/${requiredPath(queue, 'queue name')}/pause`, {});
  }

  async resume(queue: string): Promise<void> {
    await this.send('POST', `/v1/queues/${requiredPath(queue, 'queue name')}/resume`, {});
  }

  async attention(query: AttentionQuery = {}): Promise<AttentionItem[]> {
    const response = await this.send<{ items: AttentionItem[] }>(
      'GET',
      `/v1/attention?${queryString({
        queue: query.queue,
        offset: query.offset,
        limit: query.limit,
      })}`,
    );
    return response.items ?? [];
  }

  async attempts(jobId: string, offset = 0, limit = 50): Promise<AttemptEvent[]> {
    const response = await this.send<{ attempts: AttemptEvent[] }>(
      'GET',
      `/v1/jobs/${requiredPath(jobId, 'job id')}/attempts?${queryString({ offset, limit })}`,
    );
    return response.attempts ?? [];
  }

  async findings(query: FindingQuery = {}): Promise<FindingRecord[]> {
    const response = await this.send<{ findings: FindingRecord[] }>(
      'GET',
      `/v1/findings?${queryString({
        ruleId: query.ruleId,
        subjectType: query.subjectType,
        subjectId: query.subjectId,
        statuses: query.statuses?.join(','),
        includeSuppressed: query.includeSuppressed,
        offset: query.offset,
        limit: query.limit,
      })}`,
    );
    return response.findings ?? [];
  }

  async transitionFinding(
    key: FindingKey,
    transition: FindingTransition,
  ): Promise<FindingRecord> {
    const response = await this.send<{ finding: FindingRecord }>(
      'POST',
      '/v1/findings/transition',
      { key, transition },
    );
    return response.finding;
  }

  async claim(
    worker: string,
    limit: number,
    leaseForMs = 60_000,
    queueNames: string[] = [],
  ): Promise<LeasedJob[]> {
    if (!worker) {
      throw new TypeError('worker name is required');
    }
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError('claim limit must be a positive integer');
    }
    if (limit > MAX_CLAIM_BATCH) {
      throw new RangeError(`claim limit must not exceed ${MAX_CLAIM_BATCH}`);
    }
    if (!Number.isFinite(leaseForMs) || leaseForMs <= 0) {
      throw new RangeError('leaseForMs must be positive');
    }
    const response = await this.send<{
      jobs: Array<Omit<LeasedJob, 'payload'> & { payload: string }>;
    }>('POST', '/v1/claim', {
      worker,
      limit,
      leaseForMs,
      ...(queueNames.length > 0 ? { queueNames } : {}),
    });
    return (response.jobs ?? []).map((job) => ({
      ...job,
      payload: decodeBase64(job.payload),
    }));
  }

  async heartbeat(
    lease: LeaseToken,
    extendMs = 60_000,
  ): Promise<{ expiresAt: string; cancelRequested: boolean }> {
    return this.send('POST', '/v1/leases/heartbeat', { lease, extendMs });
  }

  async complete(lease: LeaseToken): Promise<void> {
    await this.send('POST', '/v1/leases/complete', { lease });
  }

  async release(lease: LeaseToken): Promise<void> {
    await this.send('POST', '/v1/leases/release', { lease });
  }

  async fail(
    lease: LeaseToken,
    queue: string,
    error: unknown,
    options: FailureOptions = {},
  ): Promise<void> {
    await this.send('POST', '/v1/leases/fail', {
      lease,
      queue,
      error: {
        type: error instanceof Error ? error.name : typeof error,
        retryClass: options.retryClass ?? 'unknown',
        retryAfterMs: options.retryAfterMs,
        fingerprint: options.fingerprint,
        details: options.details,
        message: error instanceof Error ? error.message : String(error),
        language: 'node',
      },
    });
  }

  async effect<T>(
    lease: LeaseToken,
    request: EffectRequest,
    run: () => Promise<{ reference: string; value: T }>,
  ): Promise<T | undefined> {
    try {
      await this.send<EffectResult>('POST', '/v1/effects/begin', {
        lease,
        effect: request,
      });
    } catch (error) {
      if (error instanceof RhinoQError && error.code === 'RHINOQ_EFFECT_ALREADY_CONFIRMED') {
        return undefined;
      }
      throw error;
    }

    let outcome: { reference: string; value: T };
    try {
      outcome = await run();
    } catch (error) {
      try {
        await this.send<EffectResult>('POST', '/v1/effects/resolve', {
          lease,
          effect: request,
          outcome: isNeverHappened(error) ? 'not-happened' : 'unknown',
        });
      } catch (resolutionError) {
        throw new AggregateError(
          [error, resolutionError],
          'provider call failed and RhinoQ could not record its outcome',
        );
      }
      throw error;
    }
    await this.send<EffectResult>('POST', '/v1/effects/resolve', {
      lease,
      effect: request,
      reference: outcome.reference,
      outcome: 'succeeded',
    });
    return outcome.value;
  }

  /**
   * Record provider/application evidence that confirms a previously pending
   * external-signal or verified effect.
   */
  async confirmEffect(
    jobId: string,
    effect: { name: string; key: string; reference: string },
  ): Promise<EffectResult> {
    if (!jobId || !effect?.name || !effect.key || !effect.reference) {
      throw new TypeError('effect confirmation requires jobId, name, key and reference');
    }
    return this.send<EffectResult>('POST', '/v1/effects/confirm', {
      jobId,
      ...effect,
    });
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.doFetch(`${this.url}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = parseResponse(text);
      if (!response.ok) {
        const envelope = parsed as {
          error?: {
            code?: string;
            message?: string;
            retryable?: boolean;
            retryAfterMs?: number;
          };
          reason?: string;
        };
        throw new RhinoQError(
          envelope.error?.code ?? 'RHINOQ_GATEWAY_REJECTED',
          envelope.error?.message ??
            envelope.reason ??
            (text || `HTTP ${response.status}`),
          envelope.error?.retryable ?? false,
          {
            retryAfterMs: envelope.error?.retryAfterMs,
            status: response.status,
          },
        );
      }
      return parsed as T;
    } catch (error) {
      if (error instanceof RhinoQError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new RhinoQError(
          'RHINOQ_GATEWAY_TIMEOUT',
          `RhinoQ Gateway did not answer within ${this.timeoutMs}ms`,
          true,
          { cause: error },
        );
      }
      throw new RhinoQError(
        'RHINOQ_GATEWAY_UNREACHABLE',
        `RhinoQ Gateway request failed: ${messageOf(error)}`,
        true,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

const NEVER_HAPPENED = Symbol.for('rhinoq.neverHappened');

/** Mark an error as proof that a provider request was never sent. */
export function neverHappened<E extends object>(error: E): E {
  return Object.assign(error, { [NEVER_HAPPENED]: true });
}

function isNeverHappened(error: unknown): boolean {
  return typeof error === 'object' && error !== null && NEVER_HAPPENED in error;
}

function validateEnqueue(request: EnqueueRequest): void {
  if (!request || !request.queueName || !request.jobName) {
    throw new TypeError('queueName and jobName are required');
  }
  if (request.runAfterMs !== undefined && (!Number.isFinite(request.runAfterMs) || request.runAfterMs < 0)) {
    throw new RangeError('runAfterMs must be zero or positive');
  }
  if (request.priority !== undefined && (!Number.isInteger(request.priority) || request.priority < -100 || request.priority > 100)) {
    throw new RangeError('priority must be an integer between -100 and 100');
  }
}

function validateEntityVersion(version: number): void {
  if (!Number.isInteger(version) || version <= 0) {
    throw new RangeError('expectedVersion must be a positive integer');
  }
}

function encodePayload(payload: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(payload === undefined ? {} : payload);
  } catch (error) {
    throw new TypeError(`payload must be JSON serializable: ${messageOf(error)}`);
  }
  if (text === undefined) {
    throw new TypeError('payload must be JSON serializable');
  }
  return encodeBase64(new TextEncoder().encode(text));
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function requiredPath(value: string, label: string): string {
  if (!value) {
    throw new TypeError(`${label} is required`);
  }
  return encodeURIComponent(value);
}

function queryString(values: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') {
      query.set(key, String(value));
    }
  }
  return query.toString();
}

function parseResponse(text: string): unknown {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RhinoQError(
      'RHINOQ_GATEWAY_INVALID_RESPONSE',
      'RhinoQ Gateway returned a response that was not valid JSON',
      false,
      { cause: error },
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
