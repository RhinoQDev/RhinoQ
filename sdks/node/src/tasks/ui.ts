import type { TaskSnapshot, TaskSummary } from '../gateway/types.js';

export type TaskAttentionKind =
  | 'uncertain'
  | 'cancel_too_late'
  | 'cannot_cancel_safely'
  | 'failed'
  | 'partial_failure';

export type TaskRecommendedActionKind = 'wait' | 'cancel' | 'retry' | 'download' | 'inspect';

export interface TaskExplanation {
  headline: string;
  explanation: string;
  progressText: string;
  retrySafety: 'safe' | 'unsafe' | 'review';
  recommendedAction?: { kind: TaskRecommendedActionKind; label: string };
}

export interface TaskUIModel {
  id: string;
  state: string;
  label: string;
  progress: { completed: number; total?: number; percent?: number; message?: string };
  canCancel: boolean;
  canRetry: boolean;
  hasResult: boolean;
  result: { recorded: boolean; availability: 'available' | 'not_configured' | 'not_recorded' };
  verification: { status: 'verified' | 'mismatch' | 'unknown' | 'not_configured' };
  explanation: TaskExplanation;
  attention?: { kind: TaskAttentionKind; message: string };
}

/** Stable, framework-neutral user-facing semantics for every Task state. */
export function taskUIModel(task: TaskSummary | TaskSnapshot): TaskUIModel {
  const total = task.progress.total;
  const percent = total && total > 0
    ? Math.min(100, Math.round((task.progress.completed / total) * 100))
    : undefined;
  const attention = taskAttention(task);
  return {
    id: task.id,
    state: task.state,
    label: label(task),
    progress: {
      completed: task.progress.completed,
      ...(total === undefined ? {} : { total }),
      ...(percent === undefined ? {} : { percent }),
      ...(task.progress.message ? { message: task.progress.message } : {}),
    },
    canCancel: task.state === 'queued' || task.state === 'running',
    canRetry: task.state === 'failed' || task.state === 'cancelled',
    hasResult: task.hasResult,
    result: { recorded: task.hasResult, availability: task.hasResult ? 'not_configured' : 'not_recorded' },
    verification: verificationModel(task),
    explanation: explainTask(task),
    ...(attention ? { attention } : {}),
  };
}

function verificationModel(task: TaskSummary | TaskSnapshot): TaskUIModel['verification'] {
  const records = (task as TaskSnapshot & { verifications?: Array<{ status: string }> }).verifications;
  const latest = records?.[0];
  if (!latest) return { status: 'not_configured' };
  return { status: latest.status === 'verified' ? 'verified' : latest.status === 'mismatch' ? 'mismatch' : 'unknown' };
}

/**
 * Plain-language answers for the three questions a Task UI must answer:
 * what is happening, what it means, and what the person should do next.
 *
 * This deliberately contains no runtime/provider guesses. A generic failed
 * Task is review-before-retry; only explicit evidence may upgrade that answer.
 */
export function explainTask(task: TaskSummary | TaskSnapshot): TaskExplanation {
  const progressText = taskProgressText(task);
  const resultAction = task.hasResult
    ? { kind: 'download' as const, label: 'Download result' }
    : undefined;

  if (task.cancellation?.status === 'cannot_cancel_safely') {
    return {
      headline: 'This work could not be stopped safely',
      explanation: task.cancellation.reason ?? 'Some work may already be running. Check what completed before taking another action.',
      progressText,
      retrySafety: 'unsafe',
      recommendedAction: { kind: 'inspect', label: 'Review completed work' },
    };
  }
  if (task.cancellation?.status === 'too_late') {
    return {
      headline: 'The work finished before cancellation',
      explanation: 'The cancellation request arrived after completion. Use the recorded result instead of starting the work again.',
      progressText,
      retrySafety: 'unsafe',
      recommendedAction: resultAction ?? { kind: 'inspect', label: 'Review the result' },
    };
  }
  if (task.state === 'uncertain') {
    return {
      headline: 'The result still needs confirmation',
      explanation: 'RhinoQ cannot yet prove whether the real-world result happened. Do not repeat the operation until it is checked.',
      progressText,
      retrySafety: 'unsafe',
      recommendedAction: { kind: 'inspect', label: 'Check confirmation' },
    };
  }

  const counts = userCounts(task);
  if (counts.failed > 0 && counts.succeeded > 0) {
    return {
      headline: `${counts.failed} item${counts.failed === 1 ? ' needs' : 's need'} attention`,
      explanation: `${counts.succeeded} completed successfully. Review the failed items before retrying only those items.`,
      progressText,
      retrySafety: 'review',
      recommendedAction: { kind: 'inspect', label: 'Review failed items' },
    };
  }

  switch (task.state) {
    case 'pending':
      return { headline: 'Getting ready', explanation: 'The task was accepted and is being prepared.', progressText, retrySafety: 'review', recommendedAction: { kind: 'wait', label: 'No action needed' } };
    case 'queued':
      return { headline: 'Waiting to start', explanation: 'The task is ready and waiting for execution capacity.', progressText, retrySafety: 'review', recommendedAction: { kind: 'cancel', label: 'Cancel if no longer needed' } };
    case 'running':
      return { headline: 'Work is in progress', explanation: progressText, progressText, retrySafety: 'review', recommendedAction: { kind: 'cancel', label: 'Cancel if no longer needed' } };
    case 'cancel_requested':
      return { headline: 'Cancellation is in progress', explanation: 'RhinoQ is waiting for the active work to report what could safely be stopped.', progressText, retrySafety: 'unsafe', recommendedAction: { kind: 'wait', label: 'Wait for the final outcome' } };
    case 'cancelled':
      return { headline: 'The task was stopped', explanation: 'Not all work completed. Review existing results before deciding whether to start again.', progressText, retrySafety: 'review', recommendedAction: resultAction ?? { kind: 'inspect', label: 'Review completed work' } };
    case 'failed':
      return { headline: 'The task did not finish', explanation: 'Review the failed attempt before retrying so an uncertain external action is not repeated.', progressText, retrySafety: 'review', recommendedAction: { kind: 'inspect', label: 'Review the failure' } };
    case 'succeeded':
      return { headline: task.hasResult ? 'Your result is ready' : 'The work completed', explanation: 'All recorded work completed successfully.', progressText, retrySafety: 'unsafe', ...(resultAction ? { recommendedAction: resultAction } : {}) };
    default:
      return { headline: 'Task status updated', explanation: `Current status: ${label(task)}.`, progressText, retrySafety: 'review', recommendedAction: { kind: 'inspect', label: 'Review task details' } };
  }
}

function taskProgressText(task: TaskSummary | TaskSnapshot): string {
  const counts = userCounts(task);
  if (counts.total > 0) {
    const completed = counts.succeeded + counts.failed + counts.cancelled;
    return `${completed} of ${counts.total} item${counts.total === 1 ? '' : 's'} finished`;
  }
  if (task.progress.total !== undefined) {
    return `${task.progress.completed} of ${task.progress.total} completed`;
  }
  return task.progress.message ?? `${task.progress.completed} completed`;
}

function userCounts(task: TaskSummary | TaskSnapshot): { total: number; succeeded: number; failed: number; cancelled: number } {
  if ('executionCounts' in task) {
    const counts = task.itemCounts ?? task.executionCounts;
    return { total: counts.total, succeeded: counts.succeeded, failed: counts.failed, cancelled: counts.cancelled };
  }
  const latest = new Map<string, TaskSnapshot['executions'][number]>();
  for (const execution of task.executions) {
    const key = execution.itemKey ?? execution.id;
    const current = latest.get(key);
    if (!current || execution.attempt > current.attempt) latest.set(key, execution);
  }
  const executions = [...latest.values()];
  return {
    total: executions.length,
    succeeded: executions.filter((item) => item.state === 'succeeded').length,
    failed: executions.filter((item) => item.state === 'failed').length,
    cancelled: executions.filter((item) => item.state === 'cancelled').length,
  };
}

function taskAttention(task: TaskSummary | TaskSnapshot): TaskUIModel['attention'] {
  if (task.state === 'uncertain') {
    return { kind: 'uncertain', message: 'The real-world result is not confirmed yet. Do not repeat the operation blindly.' };
  }
  if (task.cancellation?.status === 'too_late') {
    return { kind: 'cancel_too_late', message: 'Cancellation arrived after the work had already completed.' };
  }
  if (task.cancellation?.status === 'cannot_cancel_safely') {
    return { kind: 'cannot_cancel_safely', message: task.cancellation.reason ?? 'The active operation cannot be stopped safely.' };
  }
  const counts = userCounts(task);
  if (counts.failed > 0 && counts.succeeded > 0) {
    return { kind: 'partial_failure', message: `${counts.failed} item(s) failed while ${counts.succeeded} succeeded.` };
  }
  if (task.state === 'failed') {
    return { kind: 'failed', message: 'The task failed. Review its attempts before retrying.' };
  }
  return undefined;
}

function label(task: TaskSummary | TaskSnapshot): string {
  if (task.cancellation?.status === 'too_late') return 'Completed before cancellation';
  if (task.cancellation?.status === 'cannot_cancel_safely') return 'Needs attention';
  const labels: Record<string, string> = {
    pending: 'Preparing', queued: 'Queued', running: 'Running', uncertain: 'Awaiting confirmation',
    succeeded: 'Completed', failed: 'Failed', cancel_requested: 'Cancelling', cancelled: 'Cancelled',
  };
  return labels[task.state] ?? task.state;
}
