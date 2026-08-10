import type {
  TaskExecutionResult,
  TaskSnapshot,
  TaskWaitpoint,
} from '../gateway/types.js';
import { explainTask } from './ui.js';

export type TaskFlightRecorderEventKind =
  | 'task.created'
  | 'task.state'
  | 'execution.state'
  | 'execution.result'
  | 'waitpoint.state';

export type TaskFlightAttentionKind =
  | 'uncertain'
  | 'waitpoint_waiting'
  | 'waitpoint_expired'
  | 'failed'
  | 'partial_failure'
  | 'cancel_too_late'
  | 'cannot_cancel_safely';

export interface TaskFlightRecorderEvent {
  id: string;
  /** This is the source record's timestamp, not an invented queue timestamp. */
  observedAt: string;
  kind: TaskFlightRecorderEventKind;
  label: string;
  state?: string;
  message?: string;
  executionId?: string;
  itemKey?: string;
  attempt?: number;
  hasResult?: boolean;
}

export interface TaskFlightRecorderAttention {
  kind: TaskFlightAttentionKind;
  severity: 'info' | 'warning' | 'error';
  message: string;
  safeToRetry?: boolean;
  sourceId?: string;
}

export interface TaskFlightRecorder {
  schemaVersion: 1;
  taskId: string;
  generatedAt: string;
  explanation: string;
  attention: TaskFlightRecorderAttention[];
  events: TaskFlightRecorderEvent[];
}

export interface TaskFlightRecorderInput {
  task: TaskSnapshot;
  executionResults?: TaskExecutionResult[];
  waitpoints?: TaskWaitpoint[];
  now?: () => Date;
}

/**
 * Builds the small, stable operator narrative from authoritative Task reads.
 *
 * The Task snapshot intentionally does not pretend to be an append-only event
 * log. Events therefore say `observedAt`, and callers can extend this with
 * richer attempt/effect audit records when those records are available.
 */
export function taskFlightRecorder(input: TaskFlightRecorderInput): TaskFlightRecorder {
  const { task, executionResults = [], waitpoints = [] } = input;
  const generatedAt = (input.now ?? (() => new Date()))().toISOString();
  const resultByExecution = new Map(executionResults.map((result) => [result.executionId, result]));
  const events: TaskFlightRecorderEvent[] = [
    {
      id: `${task.id}:created`,
      observedAt: task.createdAt,
      kind: 'task.created' as const,
      label: 'Task accepted',
      state: 'pending',
    },
    {
      id: `${task.id}:state:${task.entityVersion}`,
      observedAt: task.updatedAt,
      kind: 'task.state' as const,
      label: taskStateLabel(task.state),
      state: task.state,
      ...(task.cancellation?.reason ? { message: task.cancellation.reason } : {}),
    },
    ...task.executions.flatMap((execution) => {
      const result = resultByExecution.get(execution.id);
      const observedAt = result?.updatedAt ?? task.updatedAt;
      const stateEvent: TaskFlightRecorderEvent = {
        id: `${execution.id}:state:${execution.version}`,
        observedAt,
        kind: 'execution.state',
        label: `${execution.itemKey ?? 'default'} attempt ${execution.attempt}`,
        state: execution.state,
        executionId: execution.id,
        itemKey: execution.itemKey,
        attempt: execution.attempt,
        ...(execution.failureReason ? { message: execution.failureReason } : {}),
        ...(execution.hasResult === undefined ? {} : { hasResult: execution.hasResult }),
      };
      const resultEvent = result?.reference
        ? [{
            id: `${execution.id}:result:${result.updatedAt}`,
            observedAt: result.updatedAt,
            kind: 'execution.result' as const,
            label: 'Execution result recorded',
            state: result.state,
            executionId: execution.id,
            itemKey: execution.itemKey,
            attempt: execution.attempt,
            hasResult: true,
          }]
        : [];
      return [stateEvent, ...resultEvent];
    }),
    ...waitpoints.flatMap((waitpoint) => [
      {
        id: `${waitpoint.id}:created`,
        observedAt: waitpoint.createdAt,
        kind: 'waitpoint.state' as const,
        label: `Waiting for ${waitpoint.kind}: ${waitpoint.key}`,
        state: 'created',
      },
      {
        id: `${waitpoint.id}:state:${waitpoint.entityVersion}`,
        observedAt: waitpoint.updatedAt,
        kind: 'waitpoint.state' as const,
        label: `Waitpoint ${waitpoint.state}`,
        state: waitpoint.state,
        message: waitpoint.state === 'waiting'
          ? `Waiting for ${waitpoint.kind} at ${waitpoint.key}`
          : undefined,
      },
    ]),
  ].sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id));

  const attention = taskAttention(task, waitpoints);
  const explanation = explainTask(task);
  return {
    schemaVersion: 1,
    taskId: task.id,
    generatedAt,
    explanation: `${explanation.headline}. ${explanation.explanation}`,
    attention,
    events,
  };
}

function taskAttention(task: TaskSnapshot, waitpoints: TaskWaitpoint[]): TaskFlightRecorderAttention[] {
  const attention: TaskFlightRecorderAttention[] = [];
  if (task.state === 'uncertain') {
    attention.push({
      kind: 'uncertain', severity: 'error', safeToRetry: false,
      message: 'The real-world result is not confirmed. Reconcile before retrying.',
      sourceId: task.id,
    });
  }
  for (const waitpoint of waitpoints) {
    if (waitpoint.state === 'waiting') {
      attention.push({
        kind: 'waitpoint_waiting', severity: 'info',
        message: `Waiting for ${waitpoint.kind} ${waitpoint.key}${waitpoint.deadline ? ` until ${waitpoint.deadline}` : ''}.`,
        sourceId: waitpoint.id,
      });
    }
    if (waitpoint.state === 'expired') {
      attention.push({
        kind: 'waitpoint_expired', severity: 'error',
        message: `Waitpoint ${waitpoint.key} expired. Escalation is required before resuming.`,
        sourceId: waitpoint.id,
      });
    }
  }
  if (task.cancellation?.status === 'too_late') {
    attention.push({
      kind: 'cancel_too_late', severity: 'warning', safeToRetry: false,
      message: 'Cancellation arrived after the operation completed.', sourceId: task.id,
    });
  }
  if (task.cancellation?.status === 'cannot_cancel_safely') {
    attention.push({
      kind: 'cannot_cancel_safely', severity: 'error', safeToRetry: false,
      message: task.cancellation.reason ?? 'The active operation cannot be stopped safely.', sourceId: task.id,
    });
  }
  const latest = new Map<string, TaskSnapshot['executions'][number]>();
  for (const execution of task.executions) {
    const key = execution.itemKey ?? execution.id;
    const current = latest.get(key);
    if (!current || execution.attempt > current.attempt) latest.set(key, execution);
  }
  const executions = [...latest.values()];
  const failed = executions.filter((execution) => execution.state === 'failed').length;
  const succeeded = executions.filter((execution) => execution.state === 'succeeded').length;
  if (failed > 0 && succeeded > 0) {
    attention.push({
      kind: 'partial_failure', severity: 'warning',
      message: `${failed} item(s) failed while ${succeeded} succeeded. Review failed attempts before retrying only those items.`, sourceId: task.id,
    });
  } else if (task.state === 'failed') {
    attention.push({
      kind: 'failed', severity: 'error',
      message: 'The Task failed. Review the attempt timeline and external effect evidence before retrying.', sourceId: task.id,
    });
  }
  return attention;
}

function taskStateLabel(state: string): string {
  return ({
    pending: 'Task created', queued: 'Task queued', running: 'Task running',
    uncertain: 'Task needs confirmation', succeeded: 'Task completed',
    failed: 'Task failed', cancel_requested: 'Cancellation requested',
    cancelled: 'Task cancelled',
  } as Record<string, string>)[state] ?? state;
}
