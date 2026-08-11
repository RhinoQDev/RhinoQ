import type {
  FindingObservation,
  FindingRecord,
  TaskVerificationCreateRequest,
  TaskVerificationRecord,
} from '../gateway/types.js';
import type { PostgresTaskClient } from '../postgres/task-client.js';

export interface TaskVerificationChainOptions {
  tasks: Pick<PostgresTaskClient, 'recordTaskVerification'> &
    Partial<Pick<PostgresTaskClient, 'queueTaskNotification'>>;
  taskId: string;
  verification: TaskVerificationCreateRequest;
  /** Go Gateway's observeFinding method. Required for mismatch Findings. */
  observeFinding?: (observation: FindingObservation) => Promise<FindingRecord>;
  /** Must enqueue into a durable notification delivery path, not send inline. */
  queueNotification?: (input: {
    /** Stable delivery identity; durable queues must deduplicate on this key. */
    notificationId: string;
    verification: TaskVerificationRecord;
    finding: FindingRecord;
    deepLink?: string;
  }) => Promise<void>;
  /** Absolute Workbench URL used in both the record and queued notification. */
  findingBaseURL?: string;
}

/**
 * Connects business verification to the existing Finding and notification
 * boundaries without making delivery or recipient policy an SDK guess.
 */
export async function recordTaskVerificationChain(
  options: TaskVerificationChainOptions,
): Promise<{ verification: TaskVerificationRecord; finding?: FindingRecord }> {
  const { verification: input } = options;
  if (input.status === 'mismatch' && !options.observeFinding) {
    throw new TypeError('mismatch verification requires observeFinding');
  }
  if (input.status === 'mismatch' && !options.queueNotification && !options.tasks.queueTaskNotification) {
    throw new TypeError('mismatch verification requires a durable notification queue');
  }
  if (options.queueNotification && !options.observeFinding) {
    throw new TypeError('queueNotification requires observeFinding');
  }
  const findingKey = input.finding ?? (input.status === 'mismatch' ? {
    ruleId: `task.${input.verifier}`,
    subjectType: 'task',
    subjectId: options.taskId,
    invariantVersion: 1,
  } : undefined);
  const deepLink = findingKey ? findingLink(options.findingBaseURL, findingKey) : undefined;
  const verification = await options.tasks.recordTaskVerification(options.taskId, {
    ...input,
    ...(findingKey ? { finding: { ...findingKey, ...(deepLink ? { deepLink } : {}) } } : {}),
  });
  if (input.status !== 'mismatch' || !findingKey || !options.observeFinding) {
    return { verification };
  }
  const finding = await options.observeFinding({
    ruleId: findingKey.ruleId,
    subjectType: findingKey.subjectType,
    subjectId: findingKey.subjectId,
    invariantVersion: findingKey.invariantVersion,
    observedAt: verification.verifiedAt,
    evidence: JSON.stringify({ taskId: options.taskId, verificationId: verification.id, summary: verification.summary }),
  });
  const notification = {
    notificationId: `task-verification:${verification.id}`,
    verification,
    finding,
    ...(deepLink ? { deepLink } : {}),
  };
  if (options.queueNotification) {
    await options.queueNotification(notification);
  } else {
    await options.tasks.queueTaskNotification!(options.taskId, notification);
  }
  return { verification, finding };
}

function findingLink(base: string | undefined, key: { ruleId: string; subjectType: string; subjectId: string }): string | undefined {
  if (!base?.trim()) return undefined;
  let url: URL;
  try { url = new URL(base); } catch { throw new TypeError('findingBaseURL must be absolute'); }
  url.searchParams.set('ruleId', key.ruleId);
  url.searchParams.set('subjectType', key.subjectType);
  url.searchParams.set('subjectId', key.subjectId);
  return url.toString();
}
