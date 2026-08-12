import { randomUUID } from 'node:crypto';
import type { RepairRecord, TaskSnapshot } from '../gateway/types.js';
import type { TaskClient } from '../tasks/client.js';
import { GuardedRecovery, type GuardedRecoveryResult } from '../recovery/guarded.js';

export type FailureLabScenario = 'completed-but-missing-output';

export interface FailureLabResult {
  schemaVersion: 1;
  scenario: FailureLabScenario;
  task: TaskSnapshot;
  explanation: {
    summary: string;
    technicalState: string;
    businessOutcome: 'unknown';
    evidence: Array<{ kind: 'runtime_state' | 'task_state' | 'result_check'; statement: string }>;
    affected: { tasks: 1; items: 1 };
    likelyCauses: string[];
    recommendedActions: Array<{
      id: 'recheck-output'; label: string; eligibility: 'safe'; mutatesRuntime: false;
    }>;
  };
}

export interface FailureLabRecoveryResult {
  schemaVersion: 1;
  scenario: FailureLabScenario;
  stages: readonly ['break', 'detect', 'explain', 'preview', 'repair', 'recheck', 'verified'];
  recovery: GuardedRecoveryResult;
  task: TaskSnapshot;
  incidentSummary: string;
}

type RecoverableFailureLabClient = TaskClient & {
  recordTaskVerification(taskId: string, request: {
    id: string; verifier: string; status: 'verified'; summary: string; evidence: unknown; verifiedAt: string;
  }): Promise<unknown>;
};

/** Creates one deterministic, additive lab incident through public Task commands. */
export async function runFailureLab(
  client: TaskClient,
  scenario: FailureLabScenario,
  options: { id?: string } = {},
): Promise<FailureLabResult> {
  if (!client) throw new TypeError('Failure Lab requires a Task client');
  if (scenario !== 'completed-but-missing-output') {
    throw new TypeError(`unsupported Failure Lab scenario ${JSON.stringify(scenario)}`);
  }
  const id = options.id?.trim() || `lab_${randomUUID()}`;
  const executionId = `${id}:execution`;
  const externalId = `${id}-runtime-job`;
  let task = await client.createTask({
    id, type: 'lab.completed-but-missing-output', ownerId: 'rhinoq-lab', definitionVersion: 1,
  });
  task = await client.createTaskExecution(id, {
    id: executionId, itemKey: 'expected-output', runtime: 'lab', runtimeScope: 'disposable',
  });
  task = await client.bindTaskExecution(executionId, {
    runtime: 'lab', runtimeScope: 'disposable', externalId,
  });
  let execution = await client.getTaskExecution(executionId);
  task = await client.transitionTask(id, task.entityVersion, 'queued');
  task = await client.transitionTask(id, task.entityVersion, 'running');
  await client.transitionTaskExecution(execution.id, execution.version, 'running');
  execution = await client.getTaskExecution(executionId);
  await client.transitionTaskExecution(execution.id, execution.version, 'succeeded');
  // No result is attached on purpose. Runtime success is evidence, not proof
  // that the expected artifact exists.
  task = await client.getTask(id);
  task = await client.transitionTask(id, task.entityVersion, 'uncertain');
  return {
    schemaVersion: 1,
    scenario,
    task,
    explanation: {
      summary: 'The runtime completed the work, but RhinoQ has no output evidence.',
      technicalState: 'Execution succeeded; Task is uncertain; expected result reference is absent.',
      businessOutcome: 'unknown',
      evidence: [
        { kind: 'runtime_state', statement: 'The recorded Execution is succeeded.' },
        { kind: 'result_check', statement: 'No result reference was recorded for the Task or Execution.' },
        { kind: 'task_state', statement: 'The Task is uncertain instead of falsely succeeded.' },
      ],
      affected: { tasks: 1, items: 1 },
      likelyCauses: [
        'the worker completed before persisting the artifact',
        'the artifact was written but its result reference was not recorded',
        'the external output has not yet been independently verified',
      ],
      recommendedActions: [{
        id: 'recheck-output', label: 'Recheck output evidence', eligibility: 'safe', mutatesRuntime: false,
      }],
    },
  };
}

/** Completes the disposable lab loop through preview, approval, repair and post-check. */
export async function recoverFailureLab(
  client: RecoverableFailureLabClient,
  taskId: string,
  options: { requestedBy?: string; approvedBy?: string; approvalReason?: string } = {},
): Promise<FailureLabRecoveryResult> {
  if (!client || typeof client.recordTaskVerification !== 'function') {
    throw new TypeError('Failure Lab recovery requires Task verification support');
  }
  const task = await client.getTask(taskId);
  if (task.type !== 'lab.completed-but-missing-output' || task.state !== 'uncertain' || task.hasResult) {
    throw new TypeError('Failure Lab recovery requires an unresolved completed-but-missing-output Task');
  }
  const now = new Date().toISOString();
  const finding = { ruleId: 'lab.output-exists', subjectType: 'task', subjectId: taskId, invariantVersion: 1 };
  let plan: RepairRecord = {
    id: '', finding, handler: 'lab.create-disposable-output', parameters: { taskId },
    state: 'proposed' as const, proposedBy: options.requestedBy ?? 'lab-operator', version: 1,
    createdAt: now, updatedAt: now,
  };
  const recovery = new GuardedRecovery({
    async proposeRepair(request) { plan = { ...plan, id: request.id, proposedBy: request.actor }; return plan; },
    async previewRepair() {
      plan = { ...plan, state: 'previewed', version: plan.version + 1,
        preview: `Create disposable output for ${taskId} and attach its evidence`,
        precondition: 'Task remains uncertain and has no result reference' };
      return plan;
    },
    async approveRepair(_id, actor, reason) {
      plan = { ...plan, state: 'approved', approvedBy: actor, approvalReason: reason, version: plan.version + 1 };
      return plan;
    },
    async executeRepair() {
      const current = await client.getTask(taskId);
      if (current.state !== 'uncertain' || current.hasResult) throw new Error('lab repair precondition changed');
      await client.attachTaskResult(taskId, current.entityVersion, `lab://outputs/${taskId}.json`);
      await client.recordTaskVerification(taskId, {
        id: `${taskId}:output-exists`, verifier: 'lab.output-exists', status: 'verified',
        summary: 'Disposable output exists and its reference is recorded.',
        evidence: { reference: `lab://outputs/${taskId}.json`, disposable: true }, verifiedAt: new Date().toISOString(),
      });
      const verified = await client.getTask(taskId);
      await client.transitionTask(taskId, verified.entityVersion, 'succeeded');
      plan = { ...plan, state: 'succeeded', outcome: 'output attached and independently rechecked', version: plan.version + 1 };
      return plan;
    },
  }, {
    postCheck: async () => {
      const checked = await client.getTask(taskId);
      return checked.state === 'succeeded' && checked.hasResult
        ? { status: 'verified', evidence: 'Task is succeeded with durable output evidence' }
        : { status: 'unknown', evidence: 'Task did not converge to succeeded with output evidence' };
    },
  });
  const request = {
    finding, handler: 'lab.create-disposable-output', parameters: { taskId },
    idempotencyKey: `failure-lab:${taskId}:recover-v1`,
    requestedBy: options.requestedBy ?? 'lab-operator',
    approvedBy: options.approvedBy ?? 'lab-approver',
    approvalReason: options.approvalReason ?? 'complete the disposable recovery rehearsal',
  };
  await recovery.preview(request);
  const result = await recovery.execute({ ...request, confirm: true });
  const recovered = await client.getTask(taskId);
  return {
    schemaVersion: 1, scenario: 'completed-but-missing-output',
    stages: ['break', 'detect', 'explain', 'preview', 'repair', 'recheck', 'verified'],
    recovery: result, task: recovered,
    incidentSummary: JSON.stringify({ taskId, before: 'uncertain/no-output', after: `${recovered.state}/output-recorded`, repairId: result.repairId }),
  };
}
