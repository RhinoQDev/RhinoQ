import type {
  ProviderOperationRecord,
  TaskArtifact,
  TaskSnapshot,
  TaskVerificationRecord,
} from '../gateway/types.js';
import {
  taskFlightRecorder,
  type TaskFlightRecorderAttention,
  type TaskFlightRecorderInput,
} from './flight-recorder.js';

export type TaskTechnicalStatus = 'succeeded' | 'failed' | 'running' | 'cancelled' | 'unknown';
export type TaskExternalEffectStatus = 'confirmed' | 'not_applicable' | 'not_happened' | 'uncertain' | 'mixed';
export type TaskBusinessOutcomeStatus = 'verified' | 'mismatch' | 'unverifiable' | 'unknown';

export interface TaskEvidenceRecoveryEvent {
  id: string;
  state: string;
  observedAt: string;
}

export interface TaskEvidencePassportInput extends TaskFlightRecorderInput {
  /** Bounded operator recovery references; payloads and provider secrets stay outside the passport. */
  recoveryHistory?: readonly TaskEvidenceRecoveryEvent[];
}

export interface TaskEvidencePassport {
  schemaVersion: 1;
  taskId: string;
  generatedAt: string;
  technicalExecution: {
    status: TaskTechnicalStatus;
    taskState: TaskSnapshot['state'];
    currentAttemptCount: number;
    missingResultExecutionIds: string[];
  };
  externalEffect: {
    status: TaskExternalEffectStatus;
    operationIds: string[];
  };
  businessOutcome: {
    status: TaskBusinessOutcomeStatus;
    verificationId?: string;
    verifier?: string;
    summary?: string;
  };
  artifacts: Array<Pick<TaskArtifact, 'id' | 'name' | 'contentType' | 'sizeBytes' | 'checksumSha256' | 'expiresAt'> & {
    available: boolean;
  }>;
  recovery: {
    required: boolean;
    reasons: string[];
    history: TaskEvidenceRecoveryEvent[];
  };
  evidenceRefs: {
    executionIds: string[];
    providerOperationIds: string[];
    verificationIds: string[];
    artifactIds: string[];
  };
  attention: TaskFlightRecorderAttention[];
}

/**
 * Projects existing Task/effect/verification/artifact records into one
 * redaction-safe operator view. This is a read-only composition; it does not
 * infer business correctness or mutate any state.
 */
export function taskEvidencePassport(input: TaskEvidencePassportInput): TaskEvidencePassport {
  if (!input?.task?.id?.trim()) throw new TypeError('evidence passport requires a Task snapshot');
  const now = (input.now ?? (() => new Date()))();
  const recorder = taskFlightRecorder({ ...input, now: () => now });
  const latest = latestExecutions(input.task);
  const missingResultExecutionIds = latest
    .filter((execution) => execution.state === 'succeeded' && execution.hasResult === false)
    .map((execution) => execution.id)
    .slice(0, 100)
    .sort();
  const technicalStatus = technicalExecutionStatus(input.task, latest);
  const external = externalEffectStatus(input.providerOperations ?? []);
  const latestVerification = latestVerificationRecord(input.verifications ?? []);
  const businessStatus = latestVerification?.status ?? 'unknown';
  const reasons = recoveryReasons({
    task: input.task,
    technicalStatus,
    externalStatus: external.status,
    businessStatus,
    missingResultExecutionIds,
  });
  const artifacts = (input.artifacts ?? []).slice(0, 100).map((artifact) => ({
    id: artifact.id,
    name: artifact.name,
    contentType: artifact.contentType,
    sizeBytes: artifact.sizeBytes,
    checksumSha256: artifact.checksumSha256,
    expiresAt: artifact.expiresAt,
    available: Date.parse(artifact.expiresAt) > now.getTime(),
  }));

  return {
    schemaVersion: 1,
    taskId: input.task.id,
    generatedAt: now.toISOString(),
    technicalExecution: {
      status: technicalStatus,
      taskState: input.task.state,
      currentAttemptCount: latest.length,
      missingResultExecutionIds,
    },
    externalEffect: {
      status: external.status,
      operationIds: (input.providerOperations ?? []).slice(0, 100).map((operation) => operation.id),
    },
    businessOutcome: {
      status: businessStatus,
      ...(latestVerification?.id ? { verificationId: latestVerification.id } : {}),
      ...(latestVerification?.verifier ? { verifier: latestVerification.verifier } : {}),
      ...(latestVerification?.summary ? { summary: latestVerification.summary } : {}),
    },
    artifacts,
    recovery: {
      required: reasons.length > 0,
      reasons,
      history: normalizeRecoveryHistory(input.recoveryHistory),
    },
    evidenceRefs: {
      executionIds: latest.slice(0, 100).map((execution) => execution.id),
      providerOperationIds: (input.providerOperations ?? []).slice(0, 100).map((operation) => operation.id),
      verificationIds: (input.verifications ?? []).slice(0, 100).map((verification) => verification.id),
      artifactIds: artifacts.map((artifact) => artifact.id),
    },
    attention: recorder.attention.slice(0, 100),
  };
}

function latestExecutions(task: TaskSnapshot): TaskSnapshot['executions'] {
  const latest = new Map<string, TaskSnapshot['executions'][number]>();
  for (const execution of task.executions) {
    const key = execution.itemKey ?? 'default';
    const previous = latest.get(key);
    if (!previous || execution.attempt > previous.attempt ||
        (execution.attempt === previous.attempt && execution.version > previous.version)) {
      latest.set(key, execution);
    }
  }
  return [...latest.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function technicalExecutionStatus(
  task: TaskSnapshot,
  latest: TaskSnapshot['executions'],
): TaskTechnicalStatus {
  if (task.state === 'uncertain') return 'unknown';
  if (task.state === 'cancelled') return 'cancelled';
  if (task.state === 'failed') return 'failed';
  if (task.state === 'succeeded') return 'succeeded';
  if (latest.some((execution) => execution.state === 'stalled')) return 'unknown';
  return 'running';
}

function externalEffectStatus(operations: readonly ProviderOperationRecord[]): { status: TaskExternalEffectStatus } {
  if (operations.length === 0) return { status: 'not_applicable' };
  if (operations.some((operation) => ['pending', 'accepted', 'uncertain'].includes(operation.state))) {
    return { status: 'uncertain' };
  }
  if (operations.every((operation) => operation.state === 'confirmed')) return { status: 'confirmed' };
  if (operations.every((operation) => operation.state === 'failed' || operation.state === 'not_happened')) {
    return { status: 'not_happened' };
  }
  return { status: 'mixed' };
}

function latestVerificationRecord(records: readonly TaskVerificationRecord[]): TaskVerificationRecord | undefined {
  return [...records].sort((left, right) => right.verifiedAt.localeCompare(left.verifiedAt) || right.id.localeCompare(left.id))[0];
}

function recoveryReasons(input: {
  task: TaskSnapshot;
  technicalStatus: TaskTechnicalStatus;
  externalStatus: TaskExternalEffectStatus;
  businessStatus: TaskBusinessOutcomeStatus;
  missingResultExecutionIds: string[];
}): string[] {
  const reasons: string[] = [];
  if (input.technicalStatus === 'unknown') reasons.push('technical execution evidence is incomplete');
  if (input.externalStatus === 'uncertain') reasons.push('external effect result is not confirmed');
  if (input.businessStatus === 'unknown' || input.businessStatus === 'unverifiable') reasons.push('business outcome is not independently verified');
  if (input.businessStatus === 'mismatch') reasons.push('business verification found a mismatch');
  if (input.missingResultExecutionIds.length > 0) reasons.push('one or more succeeded attempts have no result evidence');
  if (input.task.cancellation?.status === 'cannot_cancel_safely') reasons.push('cancellation was not safe to complete');
  return reasons.slice(0, 8);
}

function normalizeRecoveryHistory(history: readonly TaskEvidenceRecoveryEvent[] | undefined): TaskEvidenceRecoveryEvent[] {
  return (history ?? []).slice(0, 100).map((event) => ({
    id: boundedText(event?.id, 'recovery id', 256),
    state: boundedText(event?.state, 'recovery state', 64),
    observedAt: boundedText(event?.observedAt, 'recovery observedAt', 64),
  }));
}

function boundedText(value: string | undefined, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  if (value.length > maximum) throw new RangeError(`${label} must be at most ${maximum} characters`);
  return value;
}
