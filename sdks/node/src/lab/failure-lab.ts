import { randomUUID } from 'node:crypto';
import type { TaskSnapshot } from '../gateway/types.js';
import type { TaskClient } from '../tasks/client.js';

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
