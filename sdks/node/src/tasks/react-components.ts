import type { TaskSnapshot, TaskSummary } from '../gateway/types.js';
import type { TaskBrowserClient, TaskStoreOptions } from './store.js';
import type { TaskListClient, TaskListQuery } from './list-store.js';
import { createUseRhinoTask, createUseRhinoTasks, type ReactTaskHooks } from './react.js';
import { taskUIModel } from './ui.js';

export interface ReactElementFactory<Element> extends ReactTaskHooks {
  createElement(type: string | ((props: Record<string, unknown>) => Element), props?: Record<string, unknown> | null, ...children: unknown[]): Element;
}

export interface RhinoQTheme {
  accent?: string;
  background?: string;
  foreground?: string;
  muted?: string;
  border?: string;
  radius?: string;
}

export interface RhinoQTaskListProps {
  client: TaskListClient;
  query?: TaskListQuery;
  pollIntervalMs?: number;
  onSelectTask?(task: TaskSnapshot): void;
  emptyLabel?: string;
  theme?: RhinoQTheme;
}

export interface RhinoQTaskDetailProps {
  client: TaskBrowserClient;
  taskId: string;
  options?: TaskStoreOptions;
  retryCommandId?(): string;
  onChanged?(task: TaskSummary | TaskSnapshot): void;
  theme?: RhinoQTheme;
}

export interface RhinoQProgressProps {
  task: TaskSummary | TaskSnapshot;
  theme?: RhinoQTheme;
}

/** Dependency-injected components keep React optional for server-only users. */
export function createRhinoQComponents<Element>(react: ReactElementFactory<Element>) {
  if (typeof react?.createElement !== 'function') throw new TypeError('React createElement is required');
  const useTask = createUseRhinoTask(react);
  const useTasks = createUseRhinoTasks(react);
  const h = react.createElement.bind(react);

  function RhinoQProgress(props: RhinoQProgressProps): Element {
    const ui = taskUIModel(props.task);
    const percent = ui.progress.percent;
    return h('div', { className: 'rhinoq-progress', style: themeStyle(props.theme) },
      h('div', { role: 'status', 'aria-live': 'polite' }, ui.explanation.progressText),
      h('progress', {
        max: percent === undefined ? undefined : 100,
        value: percent,
        'aria-label': `Task progress: ${ui.explanation.progressText}`,
      }),
    );
  }

  function RhinoQTaskList(props: RhinoQTaskListProps): Element {
    const state = useTasks(props.client, props.query ?? {}, { pollIntervalMs: props.pollIntervalMs });
    const style = themeStyle(props.theme);
    if ((state.status === 'idle' || state.status === 'loading') && state.tasks.length === 0) {
      return h('section', { className: 'rhinoq-task-list', style, 'aria-busy': true }, h('p', { role: 'status' }, 'Loading tasks…'));
    }
    if (state.error && state.tasks.length === 0) {
      return h('section', { className: 'rhinoq-task-list', style },
        h('p', { role: 'alert' }, 'Tasks could not be loaded.'),
        h('button', { type: 'button', onClick: () => void state.refresh() }, 'Try again'));
    }
    if (state.tasks.length === 0) {
      return h('section', { className: 'rhinoq-task-list', style }, h('p', { role: 'status' }, props.emptyLabel ?? 'No tasks yet.'));
    }
    return h('section', { className: 'rhinoq-task-list', style, 'aria-label': 'Background tasks' },
      h('ul', { role: 'list' }, ...state.tasks.map((task) => {
        const ui = taskUIModel(task);
        return h('li', { key: task.id },
          h('button', { type: 'button', onClick: () => props.onSelectTask?.(task), 'aria-label': `Open ${task.type}: ${ui.label}` },
            h('strong', null, task.type), h('span', null, ui.label), h('span', null, ui.explanation.progressText)));
      })),
      state.status === 'reconnecting' ? h('p', { role: 'status', 'aria-live': 'polite' }, 'Reconnecting… showing the latest saved status.') : null,
    );
  }

  function RhinoQTaskDetail(props: RhinoQTaskDetailProps): Element {
    const state = useTask(props.client, props.taskId, props.options);
    const style = themeStyle(props.theme);
    if (!state.snapshot && (state.status === 'idle' || state.status === 'loading')) return h('article', { style, 'aria-busy': true }, h('p', { role: 'status' }, 'Loading task…'));
    if (!state.snapshot) return h('article', { style }, h('p', { role: 'alert' }, 'Task could not be loaded.'));
    const task = state.snapshot;
    const ui = state.ui ?? taskUIModel(task);
    const action = ui.explanation.recommendedAction;
    const invoke = async () => {
      let changed: TaskSnapshot | undefined;
      if (action?.kind === 'cancel' && state.canCancel) changed = await state.cancel();
      else if (action?.kind === 'retry' && state.canRetry) {
        const commandId = props.retryCommandId?.();
        if (!commandId) throw new TypeError('retryCommandId is required for retry');
        changed = await state.retry(commandId);
      } else if (action?.kind === 'download') { await state.downloadResult(); return; }
      if (changed) props.onChanged?.(changed);
    };
    return h('article', { className: 'rhinoq-task-detail', style, 'aria-labelledby': `rhinoq-task-${task.id}` },
      h('p', null, task.type),
      h('h2', { id: `rhinoq-task-${task.id}` }, ui.explanation.headline),
      h('p', null, ui.explanation.explanation),
      RhinoQProgress({ task, theme: props.theme }),
      h('dl', null, h('dt', null, 'Status'), h('dd', null, ui.label), h('dt', null, 'Verification'), h('dd', null, ui.verification.status)),
      state.attentionReason ? h('p', { role: 'alert' }, state.attentionReason) : null,
      action && ['cancel', 'retry', 'download'].includes(action.kind)
        ? h('button', { type: 'button', onClick: () => void invoke(), disabled: action.kind === 'cancel' ? !state.canCancel : action.kind === 'retry' ? !state.canRetry : false }, action.label)
        : null,
      state.status === 'reconnecting' ? h('p', { role: 'status', 'aria-live': 'polite' }, 'Reconnecting… showing the latest saved status.') : null,
    );
  }

  return { RhinoQTaskList, RhinoQTaskDetail, RhinoQProgress, useRhinoTask: useTask, useRhinoTasks: useTasks };
}

function themeStyle(theme: RhinoQTheme = {}): Record<string, string> {
  return {
    '--rhinoq-accent': theme.accent ?? '#2563eb',
    '--rhinoq-background': theme.background ?? '#ffffff',
    '--rhinoq-foreground': theme.foreground ?? '#111827',
    '--rhinoq-muted': theme.muted ?? '#6b7280',
    '--rhinoq-border': theme.border ?? '#d1d5db',
    '--rhinoq-radius': theme.radius ?? '0.75rem',
  };
}
