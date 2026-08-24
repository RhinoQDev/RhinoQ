import type {
  ProviderOperationRecord,
  TaskArtifact,
  TaskExecutionResults,
  TaskSnapshot,
  TaskVerificationRecord,
  TaskWaitpoint,
} from '../gateway/types.js';
import type { RuntimeAdapterReport } from '../runtime/contracts.js';
import type { DurableStepRecord } from './durable.js';
import { taskEvidencePassport, type TaskEvidencePassport } from './evidence-passport.js';
import { taskFlightRecorder, type TaskFlightRecorder } from './flight-recorder.js';
import { explainTaskIncident, type IncidentExplanation } from './incident-explanation.js';

export interface RhinoQOperatorInspectionSource {
  getTask(taskId: string): Promise<TaskSnapshot>;
  getTaskExecutionResults(taskId: string): Promise<TaskExecutionResults>;
  listTaskWaitpoints?(taskId: string): Promise<TaskWaitpoint[]>;
  listTaskVerifications?(taskId: string): Promise<TaskVerificationRecord[]>;
  listTaskArtifacts?(taskId: string): Promise<TaskArtifact[]>;
  listDurableSteps?(taskId: string, itemKey?: string): Promise<DurableStepRecord[]>;
  listProviderOperationsByTask?(taskId: string): Promise<ProviderOperationRecord[]>;
}

export interface RhinoQTaskInspection {
  schemaVersion: 1;
  task: TaskSnapshot;
  executionResults: TaskExecutionResults;
  steps: readonly DurableStepRecord[];
  waitpoints: readonly TaskWaitpoint[];
  verifications: readonly TaskVerificationRecord[];
  artifacts: readonly TaskArtifact[];
  providerOperations: readonly ProviderOperationRecord[];
  flightRecorder: TaskFlightRecorder;
  incidentExplanation: IncidentExplanation;
  evidencePassport: TaskEvidencePassport;
  missingEvidence: readonly string[];
}

/**
 * Shared, read-only operator projection for CLI and Workbench. Optional evidence
 * failures stay explicit; they never turn into an invented safe retry decision.
 */
export async function inspectRhinoQTask(
  source: RhinoQOperatorInspectionSource,
  taskId: string,
  options: {
    providerOperationsByTask?(taskId: string): Promise<ProviderOperationRecord[]>;
    runtimeReports?(): Promise<RuntimeAdapterReport[]>;
  } = {},
): Promise<RhinoQTaskInspection> {
  if (!source || typeof source.getTask !== 'function' || typeof source.getTaskExecutionResults !== 'function') {
    throw new TypeError('RhinoQ task inspection requires Task and Execution result reads');
  }
  if (!taskId?.trim()) throw new TypeError('task id is required');
  const task = await source.getTask(taskId.trim());
  const missingEvidence: string[] = [];
  const [executionResults, steps, waitpoints, verifications, artifacts, providerOperations, runtimeReports] = await Promise.all([
    optionalRead(
      'execution_results',
      source.getTaskExecutionResults.bind(source),
      [task.id],
      missingEvidence,
      { schemaVersion: 1 as const, entityVersion: task.entityVersion, taskId: task.id, executions: [] },
    ),
    optionalRead('durable_steps', source.listDurableSteps?.bind(source), [task.id], missingEvidence, []),
    optionalRead('waitpoints', source.listTaskWaitpoints?.bind(source), [task.id], missingEvidence, []),
    optionalRead('verifications', source.listTaskVerifications?.bind(source), [task.id], missingEvidence, []),
    optionalRead('artifacts', source.listTaskArtifacts?.bind(source), [task.id], missingEvidence, []),
    optionalRead('provider_operations', options.providerOperationsByTask ?? source.listProviderOperationsByTask?.bind(source), [task.id], missingEvidence, []),
    optionalRead('runtime_reports', options.runtimeReports, [], missingEvidence, []),
  ]);
  const flightRecorder = taskFlightRecorder({ task, executionResults: executionResults.executions, steps, waitpoints, verifications, artifacts, providerOperations });
  const incidentExplanation = explainTaskIncident({ task, steps, verifications, providerOperations, runtimeReports });
  const evidencePassport = taskEvidencePassport({ task, executionResults: executionResults.executions, waitpoints, verifications, artifacts, providerOperations });
  return Object.freeze({
    schemaVersion: 1 as const,
    task,
    executionResults,
    steps: Object.freeze(steps),
    waitpoints: Object.freeze(waitpoints),
    verifications: Object.freeze(verifications),
    artifacts: Object.freeze(artifacts),
    providerOperations: Object.freeze(providerOperations),
    flightRecorder,
    incidentExplanation,
    evidencePassport,
    missingEvidence: Object.freeze(missingEvidence),
  });
}

async function optionalRead<T, A extends readonly unknown[]>(
  label: string,
  reader: ((...args: A) => Promise<T>) | undefined,
  args: A,
  missing: string[],
  fallback: T,
): Promise<T> {
  if (!reader) {
    missing.push(`${label}: source does not expose this read`);
    return fallback;
  }
  try {
    return await reader(...args);
  } catch (error) {
    missing.push(`${label}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
    return fallback;
  }
}
