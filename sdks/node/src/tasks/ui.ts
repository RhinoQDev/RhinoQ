import type { TaskSnapshot, TaskSummary } from '../gateway/types.js';

export type TaskAttentionKind =
  | 'uncertain'
  | 'cancel_too_late'
  | 'cannot_cancel_safely'
  | 'failed'
  | 'partial_failure';

export interface TaskUIModel {
  id: string;
  state: string;
  label: string;
  progress: { completed: number; total?: number; percent?: number; message?: string };
  canCancel: boolean;
  canRetry: boolean;
  hasResult: boolean;
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
    ...(attention ? { attention } : {}),
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
  const counts = 'executionCounts' in task ? task.executionCounts : undefined;
  if (counts && counts.failed > 0 && counts.succeeded > 0) {
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
