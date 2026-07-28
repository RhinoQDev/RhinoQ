export const PROTOCOL_VERSION = '1.0';
export const SDK_VERSION = '0.1.0-dev';
export const MAX_CLAIM_BATCH = 1000;

export const CLIENT_CAPABILITIES = [
  'claim',
  'heartbeat',
  'fencing',
  'cancel',
  'effect',
  'batch-claim',
  'queue-filter',
] as const;

export type RetryClass =
  | 'transient'
  | 'permanent'
  | 'rate_limited'
  | 'dependency_down'
  | 'cancelled'
  | 'unknown';

export type JobClass =
  | 'critical'
  | 'interactive'
  | 'standard'
  | 'batch'
  | 'maintenance';

export type JobState =
  | 'pending'
  | 'leased'
  | 'retry_wait'
  | 'blocked'
  | 'dead'
  | 'succeeded'
  | 'cancelled';

export interface LeaseToken {
  jobId: string;
  owner: string;
  epoch: number;
}

export interface JobSummary {
  id: string;
  name: string;
  state: JobState;
  class: JobClass;
  priority: number;
  attempts: number;
  crashCount: number;
  blockedReason?: string;
  correlationId?: string;
  createdAt: string;
  notBefore: string;
  cancelRequested: boolean;
}

export interface LeasedJob {
  job: JobSummary;
  /** Raw UTF-8 payload bytes. Use `NodeJob.data` for JSON. */
  payload: Uint8Array;
  lease: LeaseToken;
  /** Database-authored lease deadline. */
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

export interface EnqueueRequest<T = unknown> {
  name: string;
  payload: T;
  idempotencyKey?: string;
  correlationId?: string;
  priority?: number;
  class?: JobClass;
  runAfterMs?: number;
}

export interface JobQuery {
  queue?: string;
  states?: JobState[];
  offset?: number;
  limit?: number;
}

export interface AttentionQuery {
  queue?: string;
  offset?: number;
  limit?: number;
}

export interface AttentionItem {
  kind:
    | 'dead_job'
    | 'execution_blocked'
    | 'effect_uncertain'
    | 'outcome_mismatch'
    | 'integrity_finding';
  jobId?: string;
  queue?: string;
  jobState?: JobState;
  referenceId?: string;
  reason: string;
  observedAt: string;
}

export interface AuditRecord {
  id: string;
  jobId: string;
  action: string;
  actor: string;
  reason: string;
  occurredAt: string;
  prevHash?: string;
  rowHash: string;
}

export interface EffectRequest {
  name: string;
  key: string;
  irreversible?: boolean;
  confirm?: 'on-return' | 'external-signal' | 'verify' | 'predicate';
  completedStatus?: string;
}

export interface EffectResult {
  id: string;
  name: string;
  state: 'pending' | 'confirmed' | 'uncertain' | 'rejected' | 'not_happened';
  externalRef?: string;
  irreversible: boolean;
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

export type FindingStatus =
  | 'open'
  | 'acknowledged'
  | 'repair_proposed'
  | 'repairing'
  | 'resolved'
  | 'false_positive'
  | 'ignored'
  | 'regressed';

export interface FindingKey {
  ruleId: string;
  subjectType: string;
  subjectId: string;
  invariantVersion: number;
}

export interface FindingRecord extends FindingKey {
  status: FindingStatus;
  firstSeen: string;
  lastSeen: string;
  occurrenceCount: number;
  latestEvidence?: string;
  actor?: string;
  reason?: string;
  suppressedUntil?: string;
  resolvedAt?: string;
  updatedAt: string;
}

export interface FindingQuery {
  ruleId?: string;
  subjectType?: string;
  subjectId?: string;
  statuses?: FindingStatus[];
  includeSuppressed?: boolean;
  offset?: number;
  limit?: number;
}

export interface FindingTransition {
  status: FindingStatus;
  actor: string;
  reason?: string;
  until?: string;
}

export interface FailureOptions {
  retryClass?: RetryClass;
  retryAfterMs?: number;
  fingerprint?: string;
  details?: Record<string, string>;
}
