/**
 * A projection that failed, in a shape that can be written down.
 *
 * `onError` is a callback. It fires once, in the process that failed, and if
 * that process is being killed — which is the common case, because the reason
 * the projection failed is often the reason the process is going away — the
 * event is gone. Nothing else knows the job ever happened.
 *
 * This record is deliberately self-contained: everything needed to replay the
 * projection is in it, so a sink can be a table, a file or another queue.
 */
export interface ProjectionFailure {
  /** Wire version of this record. Bump it before changing a field's meaning. */
  schemaVersion: 1;
  /** The queue event that could not be projected. */
  event: 'waiting' | 'active' | 'progress' | 'completed' | 'failed';
  /** External runtime identity, enough to look the job up again. */
  runtime: string;
  runtimeScope: string;
  externalId: string;
  /** The raw observation, as the runtime delivered it. */
  observation: {
    jobId: string;
    attempt?: number;
    data?: unknown;
    returnvalue?: unknown;
    failedReason?: string;
  };
  /** Error message. Never the stack: it is not portable and it leaks paths. */
  message: string;
  /** RhinoQ error code when the failure came from the store. */
  code?: string;
  /** ISO-8601, from the failing process's clock. */
  observedAt: string;
  /** How many times this projection has been recorded as failing. */
  attempts: number;
}

/**
 * Somewhere durable to put a failed projection.
 *
 * `PostgresProjectionFailureSink` implements this, but the table is not part of
 * the Task-only profile: that promises exactly three tables and a fourth would
 * break the promise for every adopter, including the ones who will never have
 * a failed projection. Apply `PROJECTION_FAILURE_TABLE_SQL` in the
 * application's own migration first. The row belongs there anyway — replaying
 * a projection is a business decision, and it should live in the same database
 * as whatever the job was doing.
 */
export interface ProjectionFailureSink {
  /**
   * Persists one failure. It must be idempotent on
   * `(runtime, runtimeScope, externalId, event)`: the same projection can fail
   * repeatedly, and a sink that inserts a row each time turns one broken job
   * into an unbounded table.
   */
  record(failure: ProjectionFailure): Promise<void>;
}

export type ProjectionFailureState = 'pending' | 'replaying' | 'replayed' | 'ignored';

export interface ProjectionFailureIdentity {
  runtime: string;
  runtimeScope: string;
  externalId: string;
  event: ProjectionFailure['event'];
}

export interface ProjectionFailureInboxItem extends ProjectionFailure, ProjectionFailureIdentity {
  state: ProjectionFailureState;
  firstSeenAt: string;
  lastSeenAt: string;
  replayAttempts: number;
  nextAttemptAt?: string;
  claimedBy?: string;
  claimExpiresAt?: string;
  resolvedAt?: string;
  resolutionReason?: string;
}

export interface ProjectionFailureInboxQuery {
  state?: ProjectionFailureState;
  limit?: number;
}

/** Durable operator workflow for failures that cannot be projected inline. */
export interface ProjectionFailureInbox {
  list(query?: ProjectionFailureInboxQuery): Promise<ProjectionFailureInboxItem[]>;
  claim(identity: ProjectionFailureIdentity, owner: string, leaseMs: number): Promise<ProjectionFailureInboxItem | undefined>;
  markReplayed(identity: ProjectionFailureIdentity, owner: string, evidence?: string): Promise<ProjectionFailureInboxItem | undefined>;
  scheduleRetry(identity: ProjectionFailureIdentity, owner: string, nextAttemptAt: string, reason: string): Promise<ProjectionFailureInboxItem | undefined>;
  ignore(identity: ProjectionFailureIdentity, owner: string, reason: string): Promise<ProjectionFailureInboxItem | undefined>;
}

export class ProjectionFailureLeaseLostError extends Error {
  constructor(message = 'projection failure lease was lost; inspect before replaying again') {
    super(message);
    this.name = 'ProjectionFailureLeaseLostError';
  }
}

/**
 * Claims one failure, lets the application replay its runtime-specific event,
 * and only then marks it replayed. A callback error is scheduled for a later
 * attempt; a lost mark is surfaced instead of blindly running the callback a
 * second time.
 */
export async function replayProjectionFailure(
  inbox: ProjectionFailureInbox,
  identity: ProjectionFailureIdentity,
  owner: string,
  replay: (failure: ProjectionFailureInboxItem) => Promise<void>,
  options: { retryDelayMs?: (attempt: number) => number; now?: () => Date } = {},
): Promise<ProjectionFailureInboxItem | undefined> {
  const item = await inbox.claim(identity, owner, 30_000);
  if (!item) return undefined;
  try {
    await replay(item);
    const completed = await inbox.markReplayed(identity, owner);
    if (!completed) throw new ProjectionFailureLeaseLostError();
    return completed;
  } catch (error) {
    const now = options.now?.() ?? new Date();
    const delay = options.retryDelayMs?.(item.replayAttempts) ?? Math.min(60 * 60_000, 1000 * 2 ** Math.min(item.replayAttempts - 1, 10));
    const scheduled = await inbox.scheduleRetry(
      identity, owner, new Date(now.getTime() + delay).toISOString(), error instanceof Error ? error.message : String(error),
    );
    if (!scheduled) throw new ProjectionFailureLeaseLostError('projection failure replay failed and its lease was lost');
    return scheduled;
  }
}

/**
 * A sink that keeps failures in memory.
 *
 * Useful in tests and as a shape to copy. It is **not** durable, and it says
 * so rather than letting an application discover that after an incident.
 */
export class InMemoryProjectionFailureSink implements ProjectionFailureSink {
  private readonly failures = new Map<string, ProjectionFailure>();

  async record(failure: ProjectionFailure): Promise<void> {
    const key = projectionFailureKey(failure);
    const existing = this.failures.get(key);
    this.failures.set(key, existing
      ? { ...failure, attempts: existing.attempts + 1 }
      : failure);
  }

  list(): ProjectionFailure[] {
    return [...this.failures.values()].sort((left, right) =>
      projectionFailureKey(left).localeCompare(projectionFailureKey(right)));
  }

  resolve(failure: Pick<ProjectionFailure, 'runtime' | 'runtimeScope' | 'externalId' | 'event'>): boolean {
    return this.failures.delete(projectionFailureKey(failure));
  }

  get size(): number {
    return this.failures.size;
  }
}

/** In-memory failure inbox for tests; it has the same lease semantics as SQL. */
export class InMemoryProjectionFailureInbox implements ProjectionFailureSink, ProjectionFailureInbox {
  private readonly failures = new Map<string, ProjectionFailureInboxItem>();

  async record(failure: ProjectionFailure): Promise<void> {
    const key = projectionFailureKey(failure);
    const existing = this.failures.get(key);
    const reopened = existing?.state === 'replayed' || existing?.state === 'ignored';
    this.failures.set(key, {
      ...(existing ?? failure),
      ...failure,
      state: reopened ? 'pending' : existing?.state ?? 'pending',
      replayAttempts: reopened ? 0 : existing?.replayAttempts ?? 0,
      firstSeenAt: existing?.firstSeenAt ?? failure.observedAt,
      lastSeenAt: failure.observedAt,
      ...(reopened ? { resolvedAt: undefined, resolutionReason: undefined, claimedBy: undefined, claimExpiresAt: undefined } : {}),
    });
  }

  async list(query: ProjectionFailureInboxQuery = {}): Promise<ProjectionFailureInboxItem[]> {
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) throw new RangeError('failure inbox limit must be 1..1000');
    return [...this.failures.values()]
      .filter((item) => !query.state || item.state === query.state)
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, limit)
      .map(cloneFailureInboxItem);
  }

  async claim(identity: ProjectionFailureIdentity, owner: string, leaseMs: number): Promise<ProjectionFailureInboxItem | undefined> {
    const item = this.failures.get(projectionFailureKey(identity));
    const now = Date.now();
    if (!item || (item.state !== 'pending' && item.state !== 'replaying') ||
      (item.nextAttemptAt && Date.parse(item.nextAttemptAt) > now) ||
      (item.claimExpiresAt && Date.parse(item.claimExpiresAt) > now)) return undefined;
    const claimed = { ...item, state: 'replaying' as const, replayAttempts: item.replayAttempts + 1,
      claimedBy: owner, claimExpiresAt: new Date(now + leaseMs).toISOString() };
    this.failures.set(projectionFailureKey(identity), claimed);
    return cloneFailureInboxItem(claimed);
  }

  async markReplayed(identity: ProjectionFailureIdentity, owner: string, evidence?: string): Promise<ProjectionFailureInboxItem | undefined> {
    return this.finish(identity, owner, 'replayed', evidence);
  }

  async scheduleRetry(identity: ProjectionFailureIdentity, owner: string, nextAttemptAt: string, reason: string): Promise<ProjectionFailureInboxItem | undefined> {
    if (!reason.trim() || Number.isNaN(Date.parse(nextAttemptAt))) throw new TypeError('failure retry requires reason and valid nextAttemptAt');
    const item = this.failures.get(projectionFailureKey(identity));
    if (!item || item.state !== 'replaying' || item.claimedBy !== owner || !item.claimExpiresAt || Date.parse(item.claimExpiresAt) <= Date.now()) return undefined;
    const updated = { ...item, state: 'pending' as const, nextAttemptAt, resolutionReason: reason, claimedBy: undefined, claimExpiresAt: undefined };
    this.failures.set(projectionFailureKey(identity), updated);
    return cloneFailureInboxItem(updated);
  }

  async ignore(identity: ProjectionFailureIdentity, owner: string, reason: string): Promise<ProjectionFailureInboxItem | undefined> {
    if (!reason.trim()) throw new TypeError('failure ignore requires a reason');
    return this.finish(identity, owner, 'ignored', reason);
  }

  private finish(identity: ProjectionFailureIdentity, owner: string, state: 'replayed' | 'ignored', reason?: string): ProjectionFailureInboxItem | undefined {
    const item = this.failures.get(projectionFailureKey(identity));
    if (!item || item.state !== 'replaying' || item.claimedBy !== owner || !item.claimExpiresAt || Date.parse(item.claimExpiresAt) <= Date.now()) return undefined;
    const updated = { ...item, state, resolvedAt: new Date().toISOString(), ...(reason ? { resolutionReason: reason } : {}), claimedBy: undefined, claimExpiresAt: undefined };
    this.failures.set(projectionFailureKey(identity), updated);
    return cloneFailureInboxItem(updated);
  }
}

function cloneFailureInboxItem(item: ProjectionFailureInboxItem): ProjectionFailureInboxItem {
  return { ...item, observation: item.observation && JSON.parse(JSON.stringify(item.observation)) };
}

/**
 * The idempotency key a durable sink should use as its primary key.
 *
 * The separator is NUL because a runtime scope or an external ID may contain
 * anything a queue accepts. A space or a colon would let two different tuples
 * produce one key, which in a deduplicating sink means one failure silently
 * overwriting another.
 */
export function projectionFailureKey(
  failure: ProjectionFailureIdentity,
): string {
  return [failure.runtime, failure.runtimeScope, failure.externalId, failure.event].join('\u0000');
}

/**
 * Example DDL for an application-owned sink. It is a string rather than a
 * migration this SDK runs, because the table belongs to the application's
 * schema and its retention is the application's decision.
 */
export const PROJECTION_FAILURE_TABLE_SQL = String.raw`
CREATE TABLE IF NOT EXISTS rhinoq_projection_failures (
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  runtime text NOT NULL,
  runtime_scope text NOT NULL,
  external_id text NOT NULL,
  event text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  observation jsonb NOT NULL,
  message text NOT NULL,
  code text,
  attempts integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','replaying','replayed','ignored')),
  replay_attempts integer NOT NULL DEFAULT 0 CHECK (replay_attempts >= 0),
  next_attempt_at timestamptz,
  claimed_by text,
  claim_expires_at timestamptz,
  resolved_at timestamptz,
  resolution_reason text,
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (runtime, runtime_scope, external_id, event)
);
`;

/** Upgrade SQL for adopters who installed the first sink-only table. */
export const PROJECTION_FAILURE_TABLE_MIGRATION_SQL = String.raw`
ALTER TABLE rhinoq_projection_failures
  ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN IF NOT EXISTS replay_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_by text,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolution_reason text;
`;
