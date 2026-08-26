import type { TaskSnapshot, TaskSummary } from '../gateway/types.js';
import type { TaskBrowserClient, TaskStoreOptions } from './store.js';
import type { TaskListClient, TaskListQuery } from './list-store.js';
import { createUseRhinoTask, createUseRhinoTasks, type ReactTaskHooks } from './react.js';
import { taskUIModel } from './ui.js';

export interface ReactElementFactory<Element> extends ReactTaskHooks {
  createElement(type: string | ((props: Record<string, unknown>) => Element), props?: Record<string, unknown> | null, ...children: unknown[]): Element;
}
export interface RhinoQTheme {
  accent?: string; background?: string; surface?: string; foreground?: string;
  muted?: string; border?: string; success?: string; warning?: string;
  danger?: string; radius?: string; fontFamily?: string;
}

interface StyledComponentProps {
  theme?: RhinoQTheme;
  /** Skip the zero-config stylesheet when the host supplies all styles. */
  unstyled?: boolean;
  className?: string;
}

export interface RhinoQTaskListProps extends StyledComponentProps {
  client: TaskListClient; query?: TaskListQuery; pollIntervalMs?: number;
  onSelectTask?(task: TaskSnapshot): void; emptyLabel?: string;
}
export interface RhinoQTaskDetailProps extends StyledComponentProps {
  client: TaskBrowserClient; taskId: string; options?: TaskStoreOptions;
  retryCommandId?(): string; onChanged?(task: TaskSummary | TaskSnapshot): void;
}
export interface RhinoQProgressProps extends StyledComponentProps { task: TaskSummary | TaskSnapshot; }

/** Zero-config styles shared by the React/Next.js components. */
export const RHINOQ_EMBED_CSS = `
/* Compact workspace defaults: one token system, clear hierarchy and restrained motion. */
.rhinoq-embed{--rq-accent:#2563eb;--rq-bg:#f5f7fa;--rq-surface:#fff;--rq-ink:#10233f;--rq-muted:#64748b;--rq-border:#dfe5ee;--rq-success:#15803d;--rq-warning:#c76b08;--rq-danger:#dc2626;--rq-radius:8px;--rq-font:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;box-sizing:border-box;color:var(--rq-ink);font:14px/1.45 var(--rq-font)}
.rhinoq-embed *{box-sizing:border-box}.rhinoq-embed button{font:inherit}
.rhinoq-embed-shell{padding:18px;border:1px solid var(--rq-border);border-radius:var(--rq-radius);background:var(--rq-surface);box-shadow:0 1px 3px rgba(15,35,63,.07)}
.rhinoq-embed-head,.rhinoq-detail-top{display:flex;align-items:center;justify-content:space-between;gap:16px}.rhinoq-embed-head{margin-bottom:14px}
.rhinoq-embed-eyebrow{display:flex;align-items:center;gap:6px;margin:0 0 3px;color:var(--rq-accent);font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase}
.rhinoq-embed-live{width:6px;height:6px;border-radius:50%;background:var(--rq-success);box-shadow:0 0 0 3px color-mix(in srgb,var(--rq-success) 10%,transparent);animation:rq-breathe 2.4s ease-in-out infinite}
.rhinoq-embed h2{margin:0;font-size:22px;line-height:1.2;letter-spacing:-.025em}
.rhinoq-embed-count{display:grid;place-items:center;min-width:38px;height:28px;padding:0 9px;border:1px solid color-mix(in srgb,var(--rq-accent) 22%,var(--rq-border));border-radius:6px;background:color-mix(in srgb,var(--rq-accent) 7%,var(--rq-surface));color:var(--rq-accent);font-size:12px;font-weight:800}
.rhinoq-embed-list{display:grid;gap:8px;margin:0;padding:0;list-style:none}.rhinoq-embed-item{animation:rq-enter .2s ease both}.rhinoq-embed-item:nth-child(2){animation-delay:35ms}.rhinoq-embed-item:nth-child(3){animation-delay:70ms}.rhinoq-embed-item:nth-child(4){animation-delay:105ms}
.rhinoq-task-card{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;width:100%;padding:12px 13px;border:1px solid var(--rq-border);border-radius:var(--rq-radius);background:var(--rq-surface);color:inherit;text-align:left;cursor:pointer;box-shadow:0 1px 2px rgba(15,35,63,.05);transition:border-color .14s ease,box-shadow .14s ease}
.rhinoq-task-card:hover{border-color:color-mix(in srgb,var(--rq-accent) 30%,var(--rq-border));box-shadow:0 3px 9px rgba(15,35,63,.08)}
.rhinoq-task-card:focus-visible,.rhinoq-action:focus-visible{outline:3px solid color-mix(in srgb,var(--rq-accent) 25%,transparent);outline-offset:2px}
.rhinoq-task-icon{display:grid;place-items:center;width:36px;height:36px;border-radius:7px;background:color-mix(in srgb,var(--rq-accent) 9%,var(--rq-surface));color:var(--rq-accent);font-size:10px;font-weight:900}
.rhinoq-task-copy{min-width:0}.rhinoq-task-copy strong,.rhinoq-task-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rhinoq-task-copy strong{font-size:14px;letter-spacing:-.01em}.rhinoq-task-copy small{margin-top:1px;color:var(--rq-muted);font-size:11px}
.rhinoq-state{align-self:center;padding:3px 7px;border-radius:4px;background:color-mix(in srgb,var(--rq-accent) 8%,var(--rq-surface));color:var(--rq-accent);font-size:9px;font-weight:800;letter-spacing:.04em;text-transform:uppercase}
.rhinoq-state[data-state="succeeded"]{background:color-mix(in srgb,var(--rq-success) 10%,var(--rq-surface));color:var(--rq-success)}.rhinoq-state[data-state="failed"],.rhinoq-state[data-state="cancelled"]{background:color-mix(in srgb,var(--rq-danger) 9%,var(--rq-surface));color:var(--rq-danger)}.rhinoq-state[data-state="uncertain"]{background:color-mix(in srgb,var(--rq-warning) 11%,var(--rq-surface));color:var(--rq-warning)}
.rhinoq-progress{grid-column:2/-1;display:grid;grid-template-columns:1fr auto;align-items:center;gap:5px 10px;color:var(--rq-muted);font-size:11px}.rhinoq-progress-track{position:relative;grid-column:1/-1;overflow:hidden;height:5px;border-radius:999px;background:color-mix(in srgb,var(--rq-border) 80%,var(--rq-bg))}.rhinoq-progress-fill{position:absolute;inset:0 auto 0 0;width:var(--rq-progress,0%);border-radius:inherit;background:var(--rq-accent);transition:width .45s cubic-bezier(.22,1,.36,1)}.rhinoq-progress-native{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.rhinoq-empty-state,.rhinoq-error-state{display:grid;place-items:center;min-height:140px;padding:22px;border:1px dashed var(--rq-border);border-radius:var(--rq-radius);background:var(--rq-bg);color:var(--rq-muted);text-align:center}.rhinoq-empty-state strong,.rhinoq-error-state strong{color:var(--rq-ink);font-size:15px}
.rhinoq-action{min-height:34px;padding:7px 11px;border:1px solid var(--rq-border);border-radius:6px;background:var(--rq-surface);color:var(--rq-ink);font-weight:750;cursor:pointer;transition:background .14s ease,border-color .14s ease}.rhinoq-action:hover{border-color:color-mix(in srgb,var(--rq-accent) 30%,var(--rq-border));background:color-mix(in srgb,var(--rq-accent) 4%,var(--rq-surface))}.rhinoq-action-primary{border-color:var(--rq-accent);background:var(--rq-accent);color:#fff}.rhinoq-action:disabled{opacity:.5;cursor:not-allowed}
.rhinoq-detail{padding:18px}.rhinoq-detail-top{align-items:flex-start}.rhinoq-detail-type{margin:0 0 4px;color:var(--rq-accent);font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase}.rhinoq-detail-lead{max-width:680px;margin:7px 0 14px;color:var(--rq-muted);font-size:13px}.rhinoq-detail-grid{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(230px,.6fr);gap:10px}.rhinoq-detail-panel{padding:13px;border:1px solid var(--rq-border);border-radius:7px;background:var(--rq-bg)}.rhinoq-detail-panel dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:7px 14px;margin:0}.rhinoq-detail-panel dt{color:var(--rq-muted);font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}.rhinoq-detail-panel dd{margin:0;text-align:right;font-weight:650}.rhinoq-attention{margin:10px 0 0;padding:9px 11px;border:1px solid color-mix(in srgb,var(--rq-warning) 34%,var(--rq-border));border-radius:6px;background:color-mix(in srgb,var(--rq-warning) 8%,var(--rq-surface))}.rhinoq-detail-actions{display:flex;gap:8px;margin-top:11px}.rhinoq-reconnect{margin:10px 0 0;color:var(--rq-warning);font-size:11px}
.rhinoq-skeleton-card{height:72px;border-radius:var(--rq-radius);background:linear-gradient(100deg,var(--rq-bg) 20%,color-mix(in srgb,var(--rq-accent) 7%,var(--rq-surface)) 40%,var(--rq-bg) 60%);background-size:220% 100%;animation:rq-skeleton 1.35s ease infinite}.rhinoq-skeleton-card+.rhinoq-skeleton-card{margin-top:8px}
@keyframes rq-enter{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}@keyframes rq-breathe{50%{box-shadow:0 0 0 6px color-mix(in srgb,var(--rq-success) 3%,transparent)}}@keyframes rq-skeleton{to{background-position:-220% 0}}
@media(max-width:640px){.rhinoq-embed-shell{padding:14px}.rhinoq-task-card{grid-template-columns:auto minmax(0,1fr)}.rhinoq-state{grid-column:2;justify-self:start}.rhinoq-progress{grid-column:1/-1}.rhinoq-detail-grid{grid-template-columns:1fr}.rhinoq-detail-top{display:block}.rhinoq-detail-top .rhinoq-state{display:inline-block;margin-top:8px}}
@media(prefers-reduced-motion:reduce){.rhinoq-embed *{animation:none!important;transition:none!important}}
`;

/** Dependency-injected components keep React optional for server-only users. */
export function createRhinoQComponents<Element>(react: ReactElementFactory<Element>) {
  if (typeof react?.createElement !== 'function') throw new TypeError('React createElement is required');
  const useTask = createUseRhinoTask(react);
  const useTasks = createUseRhinoTasks(react);
  const h = react.createElement.bind(react);
  const styles = (unstyled?: boolean): Element | null => unstyled ? null : h('style', { 'data-rhinoq-styles': 'embedded' }, RHINOQ_EMBED_CSS);
  function RhinoQStyles(): Element { return h('style', { 'data-rhinoq-styles': 'embedded' }, RHINOQ_EMBED_CSS); }

  function RhinoQProgress(props: RhinoQProgressProps): Element {
    const ui = taskUIModel(props.task);
    const percent = ui.progress.percent;
    const width = percent === undefined ? (props.task.state === 'running' ? 32 : 0) : Math.max(0, Math.min(100, percent));
    return h('div', { className: join('rhinoq-embed rhinoq-progress', props.className), style: { ...themeStyle(props.theme), '--rq-progress': `${width}%` } },
      styles(props.unstyled), h('span', { role: 'status', 'aria-live': 'polite' }, ui.explanation.progressText),
      h('span', { 'aria-hidden': true }, percent === undefined ? 'In progress' : `${Math.round(percent)}%`),
      h('span', { className: 'rhinoq-progress-track', 'aria-hidden': true }, h('span', { className: 'rhinoq-progress-fill' })),
      h('progress', { className: 'rhinoq-progress-native', max: percent === undefined ? undefined : 100, value: percent, 'aria-label': `Task progress: ${ui.explanation.progressText}` }));
  }

  function RhinoQTaskList(props: RhinoQTaskListProps): Element {
    const state = useTasks(props.client, props.query ?? {}, { pollIntervalMs: props.pollIntervalMs });
    const shell = (content: unknown, busy = false): Element => h('section', { className: join('rhinoq-embed rhinoq-embed-shell', props.className), style: themeStyle(props.theme), 'aria-busy': busy }, styles(props.unstyled), content);
    if ((state.status === 'idle' || state.status === 'loading') && state.tasks.length === 0) return shell(h('div', null,
      header('Your activity', 'Loading', h), h('div', { role: 'status', 'aria-label': 'Loading tasks' }, ...[1, 2, 3].map((key) => h('div', { key, className: 'rhinoq-skeleton-card', 'aria-hidden': true })))), true);
    if (state.error && state.tasks.length === 0) return shell(h('div', null, header('Your activity', 'Offline', h), h('div', { className: 'rhinoq-error-state', role: 'alert' }, h('div', null,
      h('strong', null, 'Tasks could not be loaded'), h('p', null, 'Check the connection and try again.'), h('button', { className: 'rhinoq-action', type: 'button', onClick: () => void state.refresh() }, 'Try again')))));
    if (state.tasks.length === 0) return shell(h('div', null, header('Your activity', '0', h), h('div', { className: 'rhinoq-empty-state', role: 'status' }, h('div', null,
      h('strong', null, 'Everything is quiet'), h('p', null, props.emptyLabel ?? 'New background work will appear here automatically.')))));
    return shell(h('div', null, header('Your activity', String(state.tasks.length), h),
      h('ul', { className: 'rhinoq-embed-list', role: 'list', 'aria-label': 'Background tasks' }, ...state.tasks.map((task) => taskCard(task, props, h))),
      state.status === 'reconnecting' ? h('p', { className: 'rhinoq-reconnect', role: 'status', 'aria-live': 'polite' }, 'Reconnecting… showing the latest saved status.') : null));
  }

  function RhinoQTaskDetail(props: RhinoQTaskDetailProps): Element {
    const state = useTask(props.client, props.taskId, props.options);
    const rootProps = { className: join('rhinoq-embed rhinoq-embed-shell rhinoq-detail', props.className), style: themeStyle(props.theme) };
    if (!state.snapshot && (state.status === 'idle' || state.status === 'loading')) return h('article', { ...rootProps, 'aria-busy': true }, styles(props.unstyled), h('div', { className: 'rhinoq-skeleton-card', role: 'status', 'aria-label': 'Loading task' }));
    if (!state.snapshot) return h('article', rootProps, styles(props.unstyled), h('div', { className: 'rhinoq-error-state', role: 'alert' }, h('strong', null, 'Task could not be loaded')));
    const task = state.snapshot;
    const ui = state.ui ?? taskUIModel(task);
    const action = ui.explanation.recommendedAction;
    const invoke = async () => {
      let changed: TaskSnapshot | undefined;
      if (action?.kind === 'cancel' && state.canCancel) changed = await state.cancel();
      else if (action?.kind === 'retry' && state.canRetry) { const commandId = props.retryCommandId?.(); if (!commandId) throw new TypeError('retryCommandId is required for retry'); changed = await state.retry(commandId); }
      else if (action?.kind === 'download') { await state.downloadResult(); return; }
      if (changed) props.onChanged?.(changed);
    };
    const actionable = action && ['cancel', 'retry', 'download'].includes(action.kind);
    return h('article', { ...rootProps, 'aria-labelledby': `rhinoq-task-${task.id}` }, styles(props.unstyled),
      h('div', { className: 'rhinoq-detail-top' }, h('div', null, h('p', { className: 'rhinoq-detail-type' }, task.type), h('h2', { id: `rhinoq-task-${task.id}` }, ui.explanation.headline)), h('span', { className: 'rhinoq-state', 'data-state': task.state }, ui.label)),
      h('p', { className: 'rhinoq-detail-lead' }, ui.explanation.explanation),
      h('div', { className: 'rhinoq-detail-grid' }, h('section', { className: 'rhinoq-detail-panel', 'aria-label': 'Task progress' }, RhinoQProgress({ task, theme: props.theme, unstyled: true })),
        h('section', { className: 'rhinoq-detail-panel', 'aria-label': 'Task facts' }, h('dl', null, h('dt', null, 'Status'), h('dd', null, ui.label), h('dt', null, 'Verification'), h('dd', null, humanize(ui.verification.status)), h('dt', null, 'Updated'), h('dd', null, relativeTime(task.updatedAt))))),
      state.attentionReason ? h('p', { className: 'rhinoq-attention', role: 'alert' }, state.attentionReason) : null,
      actionable ? h('div', { className: 'rhinoq-detail-actions' }, h('button', { className: join('rhinoq-action', action.kind === 'download' ? 'rhinoq-action-primary' : ''), type: 'button', onClick: () => void invoke(), disabled: action.kind === 'cancel' ? !state.canCancel : action.kind === 'retry' ? !state.canRetry : false }, action.label)) : null,
      state.status === 'reconnecting' ? h('p', { className: 'rhinoq-reconnect', role: 'status', 'aria-live': 'polite' }, 'Reconnecting… showing the latest saved status.') : null);
  }
  return { RhinoQStyles, RhinoQTaskList, RhinoQTaskDetail, RhinoQProgress, useRhinoTask: useTask, useRhinoTasks: useTasks };
}

function header<Element>(title: string, count: string, h: ReactElementFactory<Element>['createElement']): Element {
  return h('header', { className: 'rhinoq-embed-head' }, h('div', null, h('p', { className: 'rhinoq-embed-eyebrow' }, h('span', { className: 'rhinoq-embed-live', 'aria-hidden': true }), 'Live updates'), h('h2', null, title)), h('span', { className: 'rhinoq-embed-count', 'aria-label': `${count} tasks` }, count));
}
function taskCard<Element>(task: TaskSnapshot, props: RhinoQTaskListProps, h: ReactElementFactory<Element>['createElement']): Element {
  const ui = taskUIModel(task);
  return h('li', { className: 'rhinoq-embed-item', key: task.id }, h('button', { className: 'rhinoq-task-card', type: 'button', onClick: () => props.onSelectTask?.(task), 'aria-label': `Open ${task.type}: ${ui.label}` },
    h('span', { className: 'rhinoq-task-icon', 'aria-hidden': true }, initials(task.type)), h('span', { className: 'rhinoq-task-copy' }, h('strong', null, humanize(task.type)), h('small', null, `${ui.explanation.progressText} · Updated ${relativeTime(task.updatedAt)}`)), h('span', { className: 'rhinoq-state', 'data-state': task.state }, ui.label),
    h('span', { className: 'rhinoq-progress', style: { '--rq-progress': `${ui.progress.percent ?? (task.state === 'running' ? 32 : 0)}%` } }, h('span', { className: 'rhinoq-progress-track', 'aria-hidden': true }, h('span', { className: 'rhinoq-progress-fill' })), h('progress', { className: 'rhinoq-progress-native', max: ui.progress.percent === undefined ? undefined : 100, value: ui.progress.percent, 'aria-label': `Task progress: ${ui.explanation.progressText}` }))));
}
function themeStyle(theme: RhinoQTheme = {}): Record<string, string> { return {
  '--rq-accent': theme.accent ?? '#2563eb', '--rq-bg': theme.background ?? '#f5f7fa', '--rq-surface': theme.surface ?? '#ffffff', '--rq-ink': theme.foreground ?? '#10233f', '--rq-muted': theme.muted ?? '#68768b', '--rq-border': theme.border ?? '#dde3ec', '--rq-success': theme.success ?? '#159a65', '--rq-warning': theme.warning ?? '#c77b0a', '--rq-danger': theme.danger ?? '#cf415a', '--rq-radius': theme.radius ?? '8px', '--rq-font': theme.fontFamily ?? 'Inter, ui-sans-serif, system-ui, sans-serif',
}; }
function humanize(value: string): string { return value.replace(/[._-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function initials(value: string): string { return value.split(/[._-]+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || 'T'; }
function relativeTime(value: string): string { const elapsed = Date.now() - Date.parse(value); if (!Number.isFinite(elapsed) || elapsed < 60_000) return 'just now'; const minutes = Math.floor(elapsed / 60_000); if (minutes < 60) return `${minutes}m ago`; const hours = Math.floor(minutes / 60); return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`; }
function join(...values: Array<string | undefined>): string { return values.filter(Boolean).join(' '); }
