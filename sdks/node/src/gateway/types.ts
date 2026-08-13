export const PROTOCOL_VERSION = '1.0';
export const SDK_VERSION = '0.1.0-beta.13';
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

export type TaskState =
  | 'pending'
  | 'queued'
  | 'running'
  | 'uncertain'
  | 'succeeded'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled';

export interface TaskCreateRequest {
  id: string;
  type: string;
  /** Stable application tenant boundary. Defaults to `default` for single-tenant apps. */
  tenantId?: string;
  ownerId?: string;
  definitionVersion: number;
}

export interface TaskProgress {
  completed: number;
  total?: number;
  message?: string;
}

export interface TaskExecutionSummary {
  id: string;
  /** Stable logical item within a fan-out; retries share the same item key. */
  itemKey?: string;
  attempt: number;
  runtime: string;
  runtimeScope?: string;
  state: string;
  version: number;
  /**
   * Whether this attempt recorded its own artifact. The reference itself is
   * not in the snapshot: polling must not repeatedly ship a storage location.
   * Read it with `getTaskExecutionResults`.
   */
  hasResult?: boolean;
  /** User-facing prose for one failed item; bounded by the Gateway. */
  failureReason?: string;
}

/** One item's outcome in a fan-out, read separately from the snapshot. */
export interface TaskExecutionResult {
  executionId: string;
  itemKey?: string;
  attempt: number;
  state: string;
  reference?: string;
  failureReason?: string;
  updatedAt: string;
}

export interface TaskExecutionResults {
  schemaVersion: 1;
  /** The Task version this list was read at. */
  entityVersion: number;
  taskId: string;
  executions: TaskExecutionResult[];
}

/**
 * One attempt's identity in its own runtime — the BullMQ job ID, for instance.
 *
 * Deliberately not on `TaskExecutionSummary`. The snapshot is polled, and the
 * owner-scoped routes serve it straight to a browser; a runtime job ID is
 * infrastructure identity that an end user has no business holding, for the
 * same reason a storage reference is kept out of it. Cancelling a fan-out
 * still needs every job ID at once, so it gets its own server-side read
 * instead of one `getTaskExecution` per Execution.
 */
export interface TaskExecutionRuntimeRef {
  executionId: string;
  itemKey: string;
  attempt: number;
  runtime: string;
  runtimeScope?: string;
  /** Absent until dispatch reserves it: that attempt has no job to stop. */
  externalId?: string;
  state: string;
}

/** Read at a Task version, so a caller can tell it apart from a stale read. */
export interface TaskExecutionRuntimeRefs {
  schemaVersion: 1;
  entityVersion: number;
  taskId: string;
  executions: TaskExecutionRuntimeRef[];
}

export interface TaskExecutionCreateRequest {
  id: string;
  runtime: string;
  itemKey?: string;
  runtimeScope?: string;
  /** Reserve a deterministic runtime identity before dispatch. */
  externalId?: string;
}

export type TaskCancellationStatus =
  | 'none'
  | 'requested'
  | 'acknowledged'
  | 'cancelled'
  | 'too_late'
  | 'cannot_cancel_safely'
  | 'failed';

export interface TaskCancellation {
  status: TaskCancellationStatus;
  reason?: string;
}

export interface TaskExecutionBinding {
  runtime: string;
  runtimeScope?: string;
  jobId?: string;
  externalId?: string;
}

/** Adapter-facing attempt lookup; it is not the end-user Task snapshot. */
export interface TaskExecution {
  id: string;
  taskId: string;
  itemKey?: string;
  attempt?: number;
  runtime: string;
  runtimeScope?: string;
  externalId?: string;
  state: string;
  version: number;
}

export interface TaskSnapshot {
  schemaVersion: 1;
  /** Monotonic for one Task; ignore responses older than the latest seen value. */
  entityVersion: number;
  id: string;
  type: string;
  ownerId?: string;
  state: TaskState;
  /** Absent only when reading from a pre-beta.2 Gateway. */
  cancellation?: TaskCancellation;
  progress: TaskProgress;
  hasResult: boolean;
  executions: TaskExecutionSummary[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskExecutionCounts {
  total: number;
  pendingDispatch: number;
  dispatched: number;
  running: number;
  succeeded: number;
  failed: number;
  stalled: number;
  cancelled: number;
}

/**
 * The same buckets counted once per item instead of once per attempt.
 *
 * `executionCounts` counts attempts, so a 200-URL batch with three retries
 * reads `total: 203` — and that number is what a browser polling the summary
 * puts on the screen next to the 200 URLs the user pasted in. `itemCounts`
 * counts the live attempt of each distinct `itemKey`, so `total` is the item
 * count the user submitted and `retries` carries the difference.
 *
 * Show `itemCounts` to users; keep `executionCounts` for operators, where the
 * attempt is the thing being looked at.
 */
export interface TaskItemCounts extends TaskExecutionCounts {
  /** Superseded attempts: `executionCounts.total - itemCounts.total`. */
  retries: number;
}

export type TaskSummary = Omit<TaskSnapshot, 'executions'> & {
  /** One entry per attempt, retries included. Operator-facing. */
  executionCounts: TaskExecutionCounts;
  /**
   * One entry per item. This is the shape to render for an end user.
   * Absent only when reading from a Gateway older than beta.10.
   */
  itemCounts?: TaskItemCounts;
};

export interface TaskExecutionPage {
	readonly schemaVersion: 1;
	readonly entityVersion: number;
	readonly taskId: string;
	readonly executions: TaskExecutionSummary[];
	readonly nextCursor?: string;
}

export interface TaskResult {
  schemaVersion: 1;
  entityVersion: number;
  taskId: string;
  reference: string;
  updatedAt: string;
}

export type TaskWaitpointKind = 'input' | 'approval' | 'webhook';
export type TaskWaitpointState = 'waiting' | 'resolved' | 'expired' | 'cancelled';
export interface TaskWaitpoint {
  schemaVersion: 1;
  entityVersion: number;
  id: string;
  taskId: string;
  key: string;
  kind: TaskWaitpointKind;
  state: TaskWaitpointState;
  payloadVersion: number;
  deadline?: string;
  resolution?: unknown;
  resolvedBy?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface TaskWaitpointCreateRequest {
  id: string; key: string; kind: TaskWaitpointKind; payloadVersion: number; deadline?: string;
}
export interface TaskWaitpointResolveRequest {
  expectedVersion: number; resolutionId: string; actor?: string; resolution: unknown;
}

export type TaskVerificationStatus = 'verified' | 'mismatch' | 'unverifiable';
export interface TaskVerificationFinding {
  ruleId: string;
  subjectType: string;
  subjectId: string;
  invariantVersion: number;
  /** Operator-safe URL produced by the application or RhinoQ Workbench. */
  deepLink?: string;
}
export interface TaskVerificationRecord {
  schemaVersion: 1;
  id: string;
  taskId: string;
  verifier: string;
  status: TaskVerificationStatus;
  summary?: string;
  evidence?: unknown;
  finding?: TaskVerificationFinding;
  verifiedAt: string;
  createdAt: string;
}
export interface TaskVerificationCreateRequest {
  id: string;
  verifier: string;
  status: TaskVerificationStatus;
  summary?: string;
  evidence?: unknown;
  finding?: TaskVerificationFinding;
  verifiedAt?: string;
}

export type TaskNotificationState = 'pending' | 'leased' | 'sent' | 'failed';
/** Durable handoff created by the Task profile; delivery transport stays host-owned. */
export interface TaskNotificationRecord {
  schemaVersion: 1;
  id: string;
  taskId: string;
  verificationId: string;
  verification: TaskVerificationRecord;
  finding: FindingRecord;
  deepLink?: string;
  state: TaskNotificationState;
  attempts: number;
  availableAt: string;
  leaseOwner?: string;
  leaseUntil?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}
export interface TaskNotificationCreateRequest {
  notificationId: string;
  verification: TaskVerificationRecord;
  finding: FindingRecord;
  deepLink?: string;
}

/** Browser-safe artifact metadata. Storage references are never included. */
export interface TaskArtifact {
  schemaVersion: 1;
  entityVersion: number;
  id: string;
  taskId: string;
  executionId?: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  expiresAt: string;
  lineage: string[];
  createdAt: string;
  updatedAt: string;
}
export interface TaskArtifactCreateRequest {
  id: string;
  executionId?: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  reference: string;
  expiresAt: string;
  /** IDs of source artifacts used to produce this artifact. */
  lineage?: string[];
}
export interface TaskArtifactRefreshRequest {
  expectedVersion: number;
  reference: string;
  expiresAt: string;
}
export interface TaskArtifactRecord extends TaskArtifact { reference: string; }

export type ProviderConfirmationPolicy = 'on-return' | 'readback' | 'webhook';
export type ProviderRetryPolicy = 'never' | 'when-not-happened';
export type ProviderOperationState =
  | 'pending' | 'accepted' | 'confirmed' | 'failed'
  | 'not_happened' | 'uncertain';

export interface ProviderOperationRequest {
  taskId?: string;
  provider: string;
  operation: string;
  idempotencyKey: string;
  /** SHA-256 of the command identity and request shape, when available. */
  requestFingerprint?: string;
  confirmation?: ProviderConfirmationPolicy;
  retryPolicy?: ProviderRetryPolicy;
}

export interface ProviderOperationRecord {
  id: string;
  taskId?: string;
  provider: string;
  operation: string;
  idempotencyKey: string;
  confirmation: ProviderConfirmationPolicy;
  retryPolicy: ProviderRetryPolicy;
  state: ProviderOperationState;
  providerId?: string;
  evidence?: string;
  reason?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderConfirmation {
  decision: 'confirmed' | 'pending' | 'failed' | 'not_happened' | 'unknown';
  evidence?: string;
  reason?: string;
}

export interface ProviderOperationEvidence {
  sequence: number;
  kind: string;
  payload: string;
  createdAt: string;
}

export interface ProviderOperationAttentionQuery {
  /** Only operations not updated before this instant are selected. Defaults to now. */
  before?: string;
  /** Bounded by the Go API to 1..500. Defaults to 100. */
  limit?: number;
}

export interface ProviderOperationOptions<T> extends Omit<ProviderOperationRequest, 'provider' | 'operation'> {
  /** `stripe.refund`, `storage.provision`, or another stable provider.operation name. */
  name: `${string}.${string}`;
  execute: (idempotencyKey: string) => Promise<T>;
  confirm?: (operation: ProviderOperationRecord) => Promise<ProviderConfirmation>;
  providerId?: (result: T) => string;
  evidence?: (result: T) => string | undefined;
}

/**
 * Effect Ledger Lite input. It keeps the provider callback ergonomic while
 * delegating all state transitions and unknown-result handling to Go.
 *
 * If no idempotencyKey is supplied, commandId or taskId becomes the stable
 * identity. `request` is JSON-shaped input used only to fingerprint the
 * command; it is never sent to RhinoQ or stored as business payload.
 */
export interface EffectOptions<T> {
  taskId?: string;
  provider: string;
  operation: string;
  commandId?: string;
  idempotencyKey?: string;
  request?: unknown;
  confirmation?: ProviderConfirmationPolicy;
  retryPolicy?: ProviderRetryPolicy;
  execute: (idempotencyKey: string) => Promise<T>;
  confirm?: (operation: ProviderOperationRecord) => Promise<ProviderConfirmation>;
  providerId?: (result: T) => string;
  evidence?: (result: T) => string | undefined;
}

export interface LeaseToken {
  jobId: string;
  owner: string;
  epoch: number;
}

export interface JobSummary {
  id: string;
  queueName: string;
  jobName: string;
  groupKey?: string;
  state: JobState;
  resourceClass: JobClass;
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
  queueName: string;
  jobName: string;
  groupKey?: string;
  payload: T;
  idempotencyKey?: string;
  correlationId?: string;
  priority?: number;
  resourceClass?: JobClass;
  runAfterMs?: number;
}

export interface JobQuery {
  /** Each filter narrows the result; omit one to match any value. */
  queueName?: string;
  jobName?: string;
  groupKey?: string;
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

export interface FindingObservation extends FindingKey {
  evidence?: string;
  observedAt: string;
}

export interface RepairProposalRequest {
  id?: string;
  finding: FindingKey;
  handler: string;
  parameters?: unknown;
  actor: string;
}

export interface RepairRecord {
  id: string;
  finding: FindingKey;
  handler: string;
  parameters?: unknown;
  state: 'proposed' | 'previewed' | 'approved' | 'running' | 'succeeded' | 'failed' | 'stale' | 'uncertain' | 'aborted';
  proposedBy: string;
  approvedBy?: string;
  approvalReason?: string;
  preview?: string;
  precondition?: string;
  outcome?: string;
  version: number;
  createdAt: string;
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
