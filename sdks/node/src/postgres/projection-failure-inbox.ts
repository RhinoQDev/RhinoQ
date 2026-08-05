import type {
  ProjectionFailureIdentity,
  ProjectionFailureInbox,
  ProjectionFailureInboxItem,
  ProjectionFailureInboxQuery,
  ProjectionFailureState,
} from '../tasks/projection-failures.js';
import type { SqlExecutor } from './producer.js';

interface FailureInboxRow {
  schema_version: number;
  runtime: string;
  runtime_scope: string;
  external_id: string;
  event: ProjectionFailureInboxItem['event'];
  observed_at: Date | string;
  observation: ProjectionFailureInboxItem['observation'];
  message: string;
  code: string | null;
  attempts: number;
  state: ProjectionFailureState;
  replay_attempts: number;
  next_attempt_at: Date | string | null;
  claimed_by: string | null;
  claim_expires_at: Date | string | null;
  resolved_at: Date | string | null;
  resolution_reason: string | null;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
}

export const LIST_PROJECTION_FAILURES_SQL = `
SELECT schema_version, runtime, runtime_scope, external_id, event, observation,
  observed_at, message, code, attempts, state, replay_attempts, next_attempt_at,
  claimed_by, claim_expires_at, resolved_at, resolution_reason,
  first_seen_at, last_seen_at
FROM rhinoq_projection_failures
WHERE ($1::text IS NULL OR state = $1)
ORDER BY last_seen_at DESC, runtime, runtime_scope, external_id, event
LIMIT $2`;

export const CLAIM_PROJECTION_FAILURE_SQL = `
UPDATE rhinoq_projection_failures
SET state='replaying', replay_attempts=replay_attempts+1,
  claimed_by=$5, claim_expires_at=$6, next_attempt_at=NULL
WHERE runtime=$1 AND runtime_scope=$2 AND external_id=$3 AND event=$4
  AND state IN ('pending','replaying')
  AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp())
  AND (claim_expires_at IS NULL OR claim_expires_at <= clock_timestamp())
RETURNING schema_version, runtime, runtime_scope, external_id, event, observation,
  observed_at, message, code, attempts, state, replay_attempts, next_attempt_at,
  claimed_by, claim_expires_at, resolved_at, resolution_reason,
  first_seen_at, last_seen_at`;

const COMPLETE_PROJECTION_FAILURE_SQL = `
UPDATE rhinoq_projection_failures
SET state=$5, resolved_at=clock_timestamp(), resolution_reason=$6,
  claimed_by=NULL, claim_expires_at=NULL, next_attempt_at=NULL
WHERE runtime=$1 AND runtime_scope=$2 AND external_id=$3 AND event=$4
  AND state='replaying' AND claimed_by=$7 AND claim_expires_at > clock_timestamp()
RETURNING schema_version, runtime, runtime_scope, external_id, event, observation,
  observed_at, message, code, attempts, state, replay_attempts, next_attempt_at,
  claimed_by, claim_expires_at, resolved_at, resolution_reason,
  first_seen_at, last_seen_at`;

const RETRY_PROJECTION_FAILURE_SQL = `
UPDATE rhinoq_projection_failures
SET state='pending', next_attempt_at=$5, resolution_reason=$6,
  claimed_by=NULL, claim_expires_at=NULL
WHERE runtime=$1 AND runtime_scope=$2 AND external_id=$3 AND event=$4
  AND state='replaying' AND claimed_by=$7 AND claim_expires_at > clock_timestamp()
RETURNING schema_version, runtime, runtime_scope, external_id, event, observation,
  observed_at, message, code, attempts, state, replay_attempts, next_attempt_at,
  claimed_by, claim_expires_at, resolved_at, resolution_reason,
  first_seen_at, last_seen_at`;

export class PostgresProjectionFailureInbox implements ProjectionFailureInbox {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    if (!executor || typeof executor.query !== 'function') {
      throw new TypeError('PostgresProjectionFailureInbox requires a PostgreSQL query executor');
    }
    this.executor = executor;
  }

  async list(query: ProjectionFailureInboxQuery = {}): Promise<ProjectionFailureInboxItem[]> {
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) throw new RangeError('failure inbox limit must be 1..1000');
    const result = await this.executor.query<FailureInboxRow>(LIST_PROJECTION_FAILURES_SQL, [query.state ?? null, limit]);
    return result.rows.map(toFailureInboxItem);
  }

  async claim(identity: ProjectionFailureIdentity, owner: string, leaseMs: number): Promise<ProjectionFailureInboxItem | undefined> {
    validateIdentity(identity);
    if (!owner?.trim() || !Number.isInteger(leaseMs) || leaseMs <= 0) throw new TypeError('failure claim requires owner and positive leaseMs');
    const result = await this.executor.query<FailureInboxRow>(CLAIM_PROJECTION_FAILURE_SQL, [
      identity.runtime, identity.runtimeScope, identity.externalId, identity.event, owner, new Date(Date.now() + leaseMs),
    ]);
    return result.rows[0] ? toFailureInboxItem(result.rows[0]) : undefined;
  }

  async markReplayed(identity: ProjectionFailureIdentity, owner: string, evidence?: string): Promise<ProjectionFailureInboxItem | undefined> {
    return this.complete(identity, owner, 'replayed', evidence);
  }

  async ignore(identity: ProjectionFailureIdentity, owner: string, reason: string): Promise<ProjectionFailureInboxItem | undefined> {
    if (!reason?.trim()) throw new TypeError('failure ignore requires a reason');
    return this.complete(identity, owner, 'ignored', reason);
  }

  async scheduleRetry(identity: ProjectionFailureIdentity, owner: string, nextAttemptAt: string, reason: string): Promise<ProjectionFailureInboxItem | undefined> {
    validateIdentity(identity);
    if (!owner?.trim() || !reason?.trim() || Number.isNaN(Date.parse(nextAttemptAt))) throw new TypeError('failure retry requires owner, reason and valid nextAttemptAt');
    const result = await this.executor.query<FailureInboxRow>(RETRY_PROJECTION_FAILURE_SQL, [
      identity.runtime, identity.runtimeScope, identity.externalId, identity.event, new Date(nextAttemptAt), reason, owner,
    ]);
    return result.rows[0] ? toFailureInboxItem(result.rows[0]) : undefined;
  }

  private async complete(identity: ProjectionFailureIdentity, owner: string, state: 'replayed' | 'ignored', reason?: string): Promise<ProjectionFailureInboxItem | undefined> {
    validateIdentity(identity);
    if (!owner?.trim()) throw new TypeError('failure completion requires owner');
    const result = await this.executor.query<FailureInboxRow>(COMPLETE_PROJECTION_FAILURE_SQL, [
      identity.runtime, identity.runtimeScope, identity.externalId, identity.event, state, reason ?? null, owner,
    ]);
    return result.rows[0] ? toFailureInboxItem(result.rows[0]) : undefined;
  }
}

function validateIdentity(identity: ProjectionFailureIdentity): void {
  if (!identity?.runtime || !identity.runtimeScope || !identity.externalId || !identity.event) throw new TypeError('projection failure identity is required');
}

function toFailureInboxItem(row: FailureInboxRow): ProjectionFailureInboxItem {
  return {
    schemaVersion: Number(row.schema_version) as 1, event: row.event, runtime: row.runtime,
    runtimeScope: row.runtime_scope, externalId: row.external_id, observation: row.observation,
    message: row.message, ...(row.code ? { code: row.code } : {}), observedAt: iso(row.observed_at),
    attempts: Number(row.attempts), state: row.state, replayAttempts: Number(row.replay_attempts),
    firstSeenAt: iso(row.first_seen_at), lastSeenAt: iso(row.last_seen_at),
    ...(row.next_attempt_at ? { nextAttemptAt: iso(row.next_attempt_at) } : {}),
    ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
    ...(row.claim_expires_at ? { claimExpiresAt: iso(row.claim_expires_at) } : {}),
    ...(row.resolved_at ? { resolvedAt: iso(row.resolved_at) } : {}),
    ...(row.resolution_reason ? { resolutionReason: row.resolution_reason } : {}),
  };
}

function iso(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
