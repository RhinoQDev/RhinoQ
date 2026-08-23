/**
 * A resource pool is a tenant-scoped shared worker budget. Units are discrete:
 * CPU and network are application-defined credits; memory and disk are bytes.
 * PostgreSQL, rather than a Node process, decides admission and lease fencing.
 */
export interface RhinoQResourceVector {
  cpu?: number;
  memoryBytes?: number;
  diskBytes?: number;
  network?: number;
}

export interface RhinoQResourcePoolOptions {
  /** Stable capacity group shared by every worker that executes this profile. */
  key: string;
  capacity: Required<RhinoQResourceVector>;
  /** Database lease duration. The runtime renews while a handler is pending. */
  leaseMs?: number;
  /** Retry hint for a runtime that can delay an admission rejection. */
  retryAfterMs?: number;
}

export interface RhinoQResourceLease {
  id: string;
  poolKey: string;
  taskId: string;
  executionId: string;
  owner: string;
  epoch: number;
  resources: Required<RhinoQResourceVector>;
  expiresAt: string;
}

export interface RhinoQResourceLeaseAcquireRequest {
  pool: RhinoQResourcePoolOptions;
  taskId: string;
  executionId: string;
  owner: string;
  resources: Required<RhinoQResourceVector>;
}

/** Authoritative shared-capacity commands supplied by the PostgreSQL Task profile. */
export interface RhinoQResourceLeaseClient {
  acquireResourceLease(request: RhinoQResourceLeaseAcquireRequest): Promise<RhinoQResourceLease>;
  renewResourceLease(lease: RhinoQResourceLease, leaseMs: number): Promise<RhinoQResourceLease>;
  releaseResourceLease(lease: RhinoQResourceLease): Promise<void>;
}

/** Admission did not mutate the Task or run the handler; a retry may be scheduled by its runtime policy. */
export class RhinoQResourceUnavailableError extends Error {
  readonly retryable = true;
  constructor(
    readonly poolKey: string,
    readonly resources: Required<RhinoQResourceVector>,
    readonly retryAfterMs: number,
    options: { cause?: unknown } = {},
  ) {
    super(`Resource pool ${JSON.stringify(poolKey)} cannot currently admit the requested work. The handler was not started.`, options);
    this.name = 'RhinoQResourceUnavailableError';
  }
}

/** A handler must discard its result when it cannot prove it still owns the resource lease. */
export class RhinoQResourceLeaseLostError extends Error {
  constructor(readonly leaseId: string, options: { cause?: unknown } = {}) {
    super(`Resource lease ${JSON.stringify(leaseId)} was lost before the handler settled. Its result was not accepted.`, options);
    this.name = 'RhinoQResourceLeaseLostError';
  }
}

export function normalizeRhinoQResourceVector(value: RhinoQResourceVector | undefined, label = 'resources'): Required<RhinoQResourceVector> {
  const vector = {
    cpu: value?.cpu ?? 0,
    memoryBytes: value?.memoryBytes ?? 0,
    diskBytes: value?.diskBytes ?? 0,
    network: value?.network ?? 0,
  };
  for (const [name, amount] of Object.entries(vector)) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError(`${label}.${name} must be a non-negative safe integer`);
  }
  return vector;
}

export function requiresRhinoQResources(value: RhinoQResourceVector | undefined): boolean {
  const vector = normalizeRhinoQResourceVector(value);
  return vector.cpu > 0 || vector.memoryBytes > 0 || vector.diskBytes > 0 || vector.network > 0;
}

export function validateRhinoQResourcePool(value: RhinoQResourcePoolOptions): RhinoQResourcePoolOptions {
  if (!value || typeof value !== 'object') throw new TypeError('a resource pool is required');
  const key = value.key?.trim();
  if (!key || key.length > 128) throw new RangeError('resource pool key must be 1..128 characters');
  const capacity = normalizeRhinoQResourceVector(value.capacity, 'resource pool capacity');
  if (!requiresRhinoQResources(capacity)) throw new RangeError('resource pool capacity must contain at least one positive dimension');
  const leaseMs = value.leaseMs ?? 60_000;
  const retryAfterMs = value.retryAfterMs ?? 5_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) throw new RangeError('resource pool leaseMs must be 1000..3600000');
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 1 || retryAfterMs > 3_600_000) throw new RangeError('resource pool retryAfterMs must be 1..3600000');
  return { key, capacity, leaseMs, retryAfterMs };
}

/** Keeps an admitted resource lease alive and makes loss observable before a handler result escapes. */
export function createRhinoQResourceLeaseHeartbeat(
  client: RhinoQResourceLeaseClient,
  initialLease: RhinoQResourceLease,
  leaseMs: number,
): { lease(): RhinoQResourceLease; stop(): Promise<void>; assertOwned(): void } {
  let lease = initialLease;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewal: Promise<void> = Promise.resolve();
  let stopped = false;
  let failure: unknown;
  const intervalMs = Math.max(250, Math.floor(leaseMs / 2));

  const schedule = () => {
    timer = setTimeout(() => {
      if (stopped) return;
      renewal = client.renewResourceLease(lease, leaseMs)
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
      if (failure) throw new RhinoQResourceLeaseLostError(lease.id, { cause: failure });
    },
  };
}
