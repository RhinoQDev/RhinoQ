import type {
  ProviderOperationRecord, TaskSnapshot, TaskVerificationRecord,
} from '../gateway/types.js';
import type { RuntimeAdapterReport } from '../runtime/contracts.js';
import type { DurableStepRecord } from './durable.js';

export interface IncidentExplanation {
  schemaVersion: 1;
  taskId: string;
  summary: string;
  technicalState: string;
  businessOutcome: 'verified' | 'violated' | 'unknown';
  evidence: Array<{ kind: string; statement: string }>;
  affected: { tasks: 1; items: number; owners?: 1 };
  likelyCauses: Array<{ id: string; statement: string; basis: string }>;
  recommendedActions: Array<{
    id: 'recheck-evidence' | 'inspect-runtime' | 'request-cancellation';
    label: string;
    availability: 'available' | 'unsupported' | 'unknown';
    reason: string;
    mutatesRuntime: boolean;
  }>;
}

export interface IncidentExplanationInput {
  task: TaskSnapshot;
  verifications?: TaskVerificationRecord[];
  steps?: DurableStepRecord[];
  providerOperations?: ProviderOperationRecord[];
  runtimeReports?: RuntimeAdapterReport[];
}

/** Deterministic explanation only; it never decides correctness from prose. */
export function explainTaskIncident(input: IncidentExplanationInput): IncidentExplanation {
  const { task } = input;
  const latestVerification = [...(input.verifications ?? [])]
    .sort((left, right) => right.verifiedAt.localeCompare(left.verifiedAt))[0];
  const businessOutcome = latestVerification?.status === 'verified'
    ? 'verified' as const
    : latestVerification?.status === 'mismatch'
      ? 'violated' as const
      : 'unknown' as const;
  const latest = latestAttempts(task);
  const failed = latest.filter((execution) => execution.state === 'failed');
  const stalled = latest.filter((execution) => execution.state === 'stalled');
  const succeededWithoutResult = latest.filter((execution) => execution.state === 'succeeded' && !execution.hasResult);
  const uncertainProvider = (input.providerOperations ?? []).filter((operation) => operation.state === 'uncertain');
  const failedSteps = (input.steps ?? []).filter((step) => step.state === 'failed');
  const runningSteps = (input.steps ?? []).filter((step) => step.state === 'running');
  const evidence: IncidentExplanation['evidence'] = [
    { kind: 'task_state', statement: `Task state is ${task.state}.` },
    { kind: 'task_snapshot', statement: `Authoritative Task snapshot version ${task.entityVersion}, updated ${task.updatedAt}.` },
    { kind: 'attempts', statement: `${latest.length} current item attempt(s): ${failed.length} failed, ${stalled.length} stalled, ${succeededWithoutResult.length} succeeded without a recorded result.` },
  ];
  if (input.steps?.length) evidence.push({
    kind: 'durable_steps', statement: `${input.steps.length} durable step(s): ${failedSteps.length} failed, ${runningSteps.length} running; each result is fenced by its attempt lease.`,
  });
  if (latestVerification) evidence.push({
    kind: 'verification',
    statement: `Latest verification ${latestVerification.verifier} is ${latestVerification.status}; readback recorded ${latestVerification.verifiedAt}${evidenceFields(latestVerification.evidence)}.`,
  });
  else evidence.push({ kind: 'verification', statement: 'No business outcome verification is recorded.' });
  if (uncertainProvider.length) evidence.push({
    kind: 'provider', statement: `${uncertainProvider.length} provider operation(s) have an uncertain outcome.`,
  });
  for (const operation of (input.providerOperations ?? []).slice(0, 5)) evidence.push({
    kind: 'provider_provenance',
    statement: `${operation.provider}.${operation.operation} is ${operation.state}; confirmation=${operation.confirmation}; retry=${operation.retryPolicy}; updated ${operation.updatedAt}.`,
  });

  const causes: IncidentExplanation['likelyCauses'] = [];
  if (failed.length) causes.push({ id: 'runtime-failure', statement: 'One or more current attempts failed.', basis: 'execution state' });
  if (stalled.length) causes.push({ id: 'event-gap', statement: 'Runtime evidence stopped before a terminal outcome was known.', basis: 'stalled execution' });
  if (succeededWithoutResult.length) causes.push({ id: 'missing-result', statement: 'Runtime completion was recorded without output evidence.', basis: 'succeeded execution without result' });
  if (uncertainProvider.length) causes.push({ id: 'provider-unknown', statement: 'A provider call may have happened but is not confirmed.', basis: 'provider operation state' });
  if (!latestVerification) causes.push({ id: 'verification-missing', statement: 'The business result has not been independently checked.', basis: 'verification history' });

  if (failedSteps.length) causes.push({ id: 'step-failure', statement: `Durable step(s) failed: ${failedSteps.slice(0, 3).map((step) => step.key).join(', ')}.`, basis: 'durable step state' });
  const cancel = cancellationAvailability(task, input.runtimeReports);
  const actions: IncidentExplanation['recommendedActions'] = [{
    id: 'recheck-evidence', label: 'Recheck outcome evidence', availability: 'available',
    reason: 'Read-only verification cannot duplicate runtime work.', mutatesRuntime: false,
  }];
  if (task.executions.some((execution) => execution.runtime)) actions.push({
    id: 'inspect-runtime', label: 'Inspect the runtime job', availability: 'available',
    reason: 'Read-only runtime inspection adds evidence without changing work.', mutatesRuntime: false,
  });
  if (['pending', 'queued', 'running'].includes(task.state)) actions.push({
    id: 'request-cancellation', label: 'Request cancellation', availability: cancel.availability,
    reason: cancel.reason, mutatesRuntime: true,
  });

  return {
    schemaVersion: 1,
    taskId: task.id,
    summary: summary(task.state, businessOutcome, failed.length, stalled.length),
    technicalState: `Task=${task.state}; current items=${latest.length}; durable steps=${input.steps?.length ?? 0}; cancellation=${task.cancellation?.status ?? 'none'}.`,
    businessOutcome,
    evidence: evidence.slice(0, 20),
    affected: { tasks: 1, items: latest.length, ...(task.ownerId ? { owners: 1 as const } : {}) },
    likelyCauses: causes.slice(0, 10),
    recommendedActions: actions,
  };
}

function latestAttempts(task: TaskSnapshot) {
  const latest = new Map<string, TaskSnapshot['executions'][number]>();
  for (const execution of task.executions) {
    const key = execution.itemKey ?? 'default';
    const previous = latest.get(key);
    if (!previous || execution.attempt > previous.attempt) latest.set(key, execution);
  }
  return [...latest.values()];
}

function summary(state: string, outcome: string, failed: number, stalled: number): string {
  if (outcome === 'violated') return 'The runtime record exists, but outcome verification found a mismatch.';
  if (outcome === 'verified') return 'The business outcome is independently verified.';
  if (state === 'uncertain' || stalled > 0) return 'RhinoQ cannot yet determine the real-world outcome.';
  if (failed > 0) return 'One or more current attempts failed; the business outcome is still unverified.';
  return 'Technical state is recorded, but the business outcome has not been verified.';
}

function cancellationAvailability(task: TaskSnapshot, reports: RuntimeAdapterReport[] | undefined) {
  if (!reports) return { availability: 'unknown' as const, reason: 'Runtime cancellation capability was not supplied.' };
  const identities = new Set(task.executions.map((execution) => `${execution.runtime}\0${execution.runtimeScope ?? ''}`));
  const matching = reports.filter((report) => identities.has(`${report.name}\0${report.scope}`));
  if (matching.length === 0) return { availability: 'unknown' as const, reason: 'No capability report matches the Task runtime.' };
  if (matching.some((report) => report.capabilities.cancel === 'unsupported')) {
    return { availability: 'unsupported' as const, reason: 'At least one Task runtime reports cancellation unsupported.' };
  }
  return { availability: 'available' as const, reason: matching.some((report) => report.capabilities.cancel === 'best_effort')
    ? 'Runtime cancellation is best effort and may still be refused safely.'
    : 'Every reported Task runtime supports cancellation.' };
}

function evidenceFields(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const fields = Object.keys(value as Record<string, unknown>).sort().slice(0, 8);
  return fields.length ? `; evidence fields: ${fields.join(', ')}` : '';
}
